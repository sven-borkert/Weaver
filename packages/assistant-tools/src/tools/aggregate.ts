import {
  aggregateRows,
  aggregateSpecsSchema,
  assertAggregateSpecs,
  assertGroupBy,
  groupAndAggregate,
  groupBySchema,
  type AggregateGroup,
  type AggregateResult,
  type AggregateSpec,
} from "@weaver/core/tables/aggregate";
import {
  columnsById,
  filterRows,
  tableFiltersSchema,
  type TableFilter,
} from "@weaver/core/tables/query";
import { getTableAtSnapshot } from "@weaver/core/services/tables";
import { z } from "zod";
import {
  boundItems,
  defineTool,
  newOutputBudget,
  requireScope,
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  type ToolOutcome,
  utf8Bytes,
} from "../contract";
import {
  atCommitShaInput,
  continuationCursor,
  cursorInput,
  resolvePinnedRequest,
} from "./snapshotReads";
import { citedColumnIds } from "./tables";

type AggregateTableQuery = {
  filters: TableFilter[];
  groupBy: string[];
  aggregates: AggregateSpec[];
};

type AggregateTableCommon = {
  tableId: string;
  snapshotCommitSha: string;
  baseCommitSha: string;
  commitSha: string;
  matched: number;
  query: AggregateTableQuery;
};

/** A group is skipped, not silently dropped, when its own JSON (its key, not
 * just its aggregates) alone exceeds the page budget — see the comment above
 * `skipped` below. Its position, not its key: the key is the thing that is
 * too large to return. */
type SkippedGroup = { position: number; reason: "GROUP_TOO_LARGE" };

type AggregateTableOutput =
  | (AggregateTableCommon & {
      aggregates: AggregateResult[];
      nextCursor: null;
      hasMore: false;
      truncated: boolean;
    })
  | (AggregateTableCommon & {
      groups: AggregateGroup[];
      groupCount: number;
      nextCursor: string | null;
      hasMore: boolean;
      truncated: boolean;
      skipped?: SkippedGroup;
    });

/**
 * Charges the whole envelope — including the echoed query, which
 * `tableFiltersSchema` alone permits up to 20 filters × 2000 chars — against
 * the transport's hard cap before any item is added to it. `newPageBudget`'s
 * fixed reserve assumed a small, roughly constant envelope; that assumption
 * holds for tools that don't echo their query back, but this one does, so a
 * wide query alone can already exceed the cap. Measuring first means a
 * request whose envelope can never fit fails with a clear BAD_REQUEST
 * instead of reaching the transport's own clamp (`clampText` /
 * `jsonSafeOutput`), which would otherwise silently replace the entire
 * result — `nextCursor`, `matched`, `groupCount` included — with
 * `{truncated: true, partialJson}`.
 */
function requireEnvelopeBudget(envelope: unknown): number {
  const available = MAX_TOOL_OUTPUT_CHARS - utf8Bytes(JSON.stringify(envelope));
  if (available <= 0)
    throw new ToolError(
      "BAD_REQUEST",
      "the query's filters, groupBy or aggregates are too large to return a page; narrow the query",
      "PAYLOAD_TOO_LARGE",
    );
  return available;
}

export const aggregateTableTool = defineTool({
  name: "aggregate_table",
  kind: "read",
  capability: "content:read",
  description:
    "Compute aggregates over every row of a table matching typed filters, at one pinned snapshot — not SQL. Functions: count, countNonEmpty, sum, avg, min, max, distinctCount. groupBy returns one result per distinct value combination, paged by cursor; group-by on a multiselect column counts a row once per selected option, so its rows can land in more than one bucket. sum and avg require number columns; empty cells are excluded and zero is a value. A group key over 2000 chars is cut to 2000 with valueTruncated true; grouping itself always uses the whole cell. skipped means one group alone exceeded the budget: it names that group's position, not its key, and paging continues past it. Without groupBy, truncated true means fewer aggregates fit than were asked for, with hasMore false and nextCursor null — request the rest in a second call.",
  inputSchema: z.object({
    projectId: z.uuid(),
    tableId: z.uuid(),
    atCommitSha: atCommitShaInput,
    cursor: cursorInput,
    filters: tableFiltersSchema.optional(),
    groupBy: groupBySchema.optional(),
    aggregates: aggregateSpecsSchema,
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async execute(input, ctx): Promise<ToolOutcome<AggregateTableOutput>> {
    requireScope(ctx, input.projectId);
    const query = {
      filters: input.filters ?? [],
      groupBy: input.groupBy ?? [],
      aggregates: input.aggregates,
    };
    const pinned = resolvePinnedRequest({
      kind: "groups",
      projectId: input.projectId,
      resourceId: input.tableId,
      atCommitSha: input.atCommitSha,
      cursor: input.cursor,
      query,
    });
    const table = await getTableAtSnapshot(
      ctx.db,
      {
        projectId: input.projectId,
        tableId: input.tableId,
        atCommitSha: pinned.atCommitSha,
      },
      ctx.actor,
    );
    const byId = columnsById(table.columns);
    assertAggregateSpecs(byId, query.aggregates);
    assertGroupBy(byId, query.groupBy);
    // The fold runs over every matching row before anything is paged, so
    // `matched` and every contributing count are complete totals (concept §8).
    const matching = filterRows(byId, table.rows, query.filters);
    const citation = {
      kind: "aggregate" as const,
      projectId: input.projectId,
      tableId: table.id,
      commitSha: table.baseCommitSha,
      columnIds: citedColumnIds([
        ...new Set([
          ...query.groupBy,
          ...query.filters.map((filter) => filter.columnId),
          ...query.aggregates.flatMap((spec) =>
            spec.columnId ? [spec.columnId] : [],
          ),
        ]),
      ]),
      query,
    };
    const common = {
      tableId: table.id,
      snapshotCommitSha: table.snapshotCommitSha,
      baseCommitSha: table.baseCommitSha,
      commitSha: table.baseCommitSha,
      matched: matching.length,
      query,
    };

    if (query.groupBy.length === 0) {
      const aggregates = aggregateRows(byId, matching, query.aggregates);
      const available = requireEnvelopeBudget({
        ...common,
        aggregates: [] as AggregateResult[],
        nextCursor: null,
        hasMore: false as const,
        truncated: true,
      });
      const bounded = boundItems(aggregates, newOutputBudget(available));
      return {
        output: {
          ...common,
          aggregates: bounded.items,
          nextCursor: null,
          hasMore: false,
          truncated: bounded.truncated,
        },
        citations: [citation],
      };
    }

    const all = groupAndAggregate(
      byId,
      matching,
      query.groupBy,
      query.aggregates,
    );
    const cursorBinding = {
      kind: "groups" as const,
      projectId: input.projectId,
      resourceId: input.tableId,
      snapshotCommitSha: table.snapshotCommitSha,
      query: pinned.query,
    };
    // Probed at position 0 purely to size the envelope: the cursor's own
    // payload binds to `pinned.query`, a fixed-size hash
    // (cursorQueryIdentity), so its encoded length does not depend on the
    // position it carries. The worst-case `skipped` marker is included too,
    // so the charge is conservative whether or not this call ends up
    // needing one.
    const available = requireEnvelopeBudget({
      ...common,
      groups: [] as AggregateGroup[],
      groupCount: all.length,
      nextCursor: continuationCursor(cursorBinding, 0),
      hasMore: true,
      truncated: true,
      skipped: { position: 0, reason: "GROUP_TOO_LARGE" as const },
    });
    const page = all.slice(pinned.position, pinned.position + input.limit);
    const bounded = boundItems(page, newOutputBudget(available));
    // A rendered key is capped at MAX_GROUP_KEY_CHARS per part (keyPart in
    // core/tables/aggregate.ts), but a group is still not guaranteed to fit:
    // the envelope charge above can leave very little room when the echoed
    // query is itself wide. When that happens `boundItems` returns zero items
    // for a non-empty page:
    // report the oversized group's position — never its key, which is the
    // thing that is too large to return — and skip past it so the cursor
    // still advances next call (mirrors query_table_rows' ROW_TOO_LARGE).
    const skipped =
      bounded.items.length === 0 && page[0]
        ? { position: pinned.position, reason: "GROUP_TOO_LARGE" as const }
        : undefined;
    const groups = bounded.items;
    const nextPosition = pinned.position + groups.length + (skipped ? 1 : 0);
    return {
      output: {
        ...common,
        groups,
        groupCount: all.length,
        nextCursor: continuationCursor(
          cursorBinding,
          nextPosition < all.length ? nextPosition : null,
        ),
        hasMore: nextPosition < all.length,
        truncated: bounded.truncated,
        ...(skipped ? { skipped } : {}),
      },
      citations: [citation],
    };
  },
});

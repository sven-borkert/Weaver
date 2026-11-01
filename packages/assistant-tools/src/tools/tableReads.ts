import { getTableAtSnapshot } from "@weaver/core/services/tables";
import { hasOptions } from "@weaver/core/tables/types";
import { z } from "zod";
import {
  boundItems,
  clampText,
  defineTool,
  newPageBudget,
  requireScope,
  ToolError,
  utf8Bytes,
} from "../contract";
import {
  atCommitShaInput,
  continuationCursor,
  cursorInput,
  fitTextChunk,
  resolvePinnedRequest,
  textChunkBudget,
} from "./snapshotReads";
import { citedColumnIds, summarizeColumn } from "./tables";

const MAX_CELL_CHUNK = 8_000;

/**
 * Pages a multiselect cell's option ids (with their labels) starting at
 * `offset`, keeping only as many as fit `newPageBudget()` — a 200-id cell
 * with 100-char labels can exceed MAX_TOOL_OUTPUT_CHARS on its own, same as
 * an oversized text cell. `nextOffset` is null once every remaining id was
 * returned.
 *
 * If even the first remaining entry alone doesn't fit (an option label can
 * be longer than a normal page budget), `boundItems` returns zero items and
 * a naive `offset + 0` would hand back an empty page whose cursor never
 * advances — an infinite loop for the caller. Instead the page holds that
 * one entry with its label clamped to fit, same as an oversized text cell is
 * chunked rather than dropped, and `nextOffset` still advances past it.
 */
export function pageListCell(
  ids: readonly string[],
  labelById: ReadonlyMap<string, string>,
  offset: number,
): { values: string[]; labels: string[]; nextOffset: number | null } {
  const remaining = ids.slice(offset);
  const budget = newPageBudget();
  const { items: kept } = boundItems(
    remaining.map((id) => ({ id, label: labelById.get(id) ?? id })),
    budget,
  );
  if (kept.length === 0 && remaining.length > 0) {
    const id = remaining[0]!;
    const label = labelById.get(id) ?? id;
    // budget.remaining is untouched here (boundItems only ever debits it for
    // an item it actually keeps), so it still reflects the whole page
    // budget; reserve room for the id and the item's own JSON punctuation
    // before clamping the label into what's left.
    const overhead = utf8Bytes(JSON.stringify({ id, label: "" })) + 1;
    const maxLabelChars = Math.max(0, budget.remaining - overhead);
    const nextOffset = offset + 1;
    return {
      values: [id],
      labels: [clampText(label, maxLabelChars).text],
      nextOffset: nextOffset < ids.length ? nextOffset : null,
    };
  }
  const nextOffset = offset + kept.length;
  return {
    values: kept.map((entry) => entry.id),
    labels: kept.map((entry) => entry.label),
    nextOffset: nextOffset < ids.length ? nextOffset : null,
  };
}

export type TextCellPage = {
  kind: "text";
  text: string;
  offset: number;
  totalChars: number;
  nextCursor: string | null;
  hasMore: boolean;
};

/** Pages a text cell so the whole serialized result, not just the raw string, fits the transport cap: `outer` is everything read_table_cell returns around the value. */
export function pageTextCell(
  raw: string,
  offset: number,
  maxChars: number,
  binding: Parameters<typeof continuationCursor>[0],
  outer: Record<string, unknown>,
): TextCellPage {
  const page = { kind: "text" as const, offset, totalChars: raw.length };
  const { text, end } = fitTextChunk(
    raw,
    offset,
    maxChars,
    textChunkBudget({
      ...outer,
      value: {
        ...page,
        text: "",
        nextCursor: continuationCursor(binding, raw.length),
        hasMore: false,
      },
    }),
  );
  const nextCursor = continuationCursor(binding, end < raw.length ? end : null);
  return { ...page, text, nextCursor, hasMore: nextCursor !== null };
}

export const listTableColumnsTool = defineTool({
  name: "list_table_columns",
  kind: "read",
  capability: "content:read",
  description:
    "Pages a table's columns (id, name, type, optionCount) at one snapshot, or looks up specific columnIds; options come from list_table_column_options. nextCursor continues. skipped means that column alone exceeded the budget: fetch it via columnIds.",
  inputSchema: z.object({
    projectId: z.uuid(),
    tableId: z.uuid(),
    atCommitSha: atCommitShaInput,
    columnIds: z.array(z.string()).max(100).optional(),
    cursor: cursorInput,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const query = { columnIds: input.columnIds ?? null };
    const pinned = resolvePinnedRequest({
      kind: "columns",
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
    const byId = new Map(table.columns.map((column) => [column.id, column]));
    const all = input.columnIds
      ? input.columnIds.map((id) => {
          const column = byId.get(id);
          if (!column)
            throw new ToolError("BAD_REQUEST", `unknown column ${id}`);
          return column;
        })
      : table.columns;
    const page = all.slice(pinned.position, pinned.position + input.limit);
    const { items: columns, truncated } = boundItems(
      page.map(summarizeColumn),
      newPageBudget(),
    );
    // Never an empty page with an unchanged cursor (concept §4.2): a column
    // that cannot fit alone is reported and skipped so the next page advances.
    const skipped =
      truncated && columns.length === 0 && page[0]
        ? { columnId: page[0].id, reason: "COLUMN_TOO_LARGE" as const }
        : undefined;
    const nextPosition = pinned.position + columns.length + (skipped ? 1 : 0);
    const nextCursor = continuationCursor(
      {
        kind: "columns",
        projectId: input.projectId,
        resourceId: input.tableId,
        snapshotCommitSha: table.snapshotCommitSha,
        query: pinned.query,
      },
      nextPosition < all.length ? nextPosition : null,
    );
    return {
      output: {
        tableId: table.id,
        snapshotCommitSha: table.snapshotCommitSha,
        baseCommitSha: table.baseCommitSha,
        columnCount: all.length,
        columns,
        nextCursor,
        hasMore: nextCursor !== null,
        ...(skipped ? { skipped } : {}),
      },
      citations: [
        {
          kind: "table",
          projectId: input.projectId,
          tableId: table.id,
          commitSha: table.baseCommitSha,
          rowIds: [],
          columnIds: citedColumnIds(columns.map((c) => c.id)),
        },
      ],
    };
  },
});

export const listTableColumnOptionsTool = defineTool({
  name: "list_table_column_options",
  kind: "read",
  capability: "content:read",
  description:
    "Pages the option ids and labels of one select or multiselect column at one snapshot; a select cell stores one option id, a multiselect cell an array of them. nextCursor continues. skipped means that option alone exceeded the budget: lower limit or continue paging.",
  inputSchema: z.object({
    projectId: z.uuid(),
    tableId: z.uuid(),
    columnId: z.string(),
    atCommitSha: atCommitShaInput,
    cursor: cursorInput,
    limit: z.number().int().min(1).max(200).default(100),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const query = { columnId: input.columnId };
    const pinned = resolvePinnedRequest({
      kind: "options",
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
    const column = table.columns.find((c) => c.id === input.columnId);
    if (!column)
      throw new ToolError("BAD_REQUEST", `unknown column ${input.columnId}`);
    if (!hasOptions(column.type))
      throw new ToolError(
        "BAD_REQUEST",
        `column ${input.columnId} is ${column.type}, not select or multiselect; it has no options`,
      );
    const all = column.options ?? [];
    const page = all.slice(pinned.position, pinned.position + input.limit);
    const { items: options, truncated } = boundItems(page, newPageBudget());
    // Never an empty page with an unchanged cursor (concept §4.2): an option
    // that cannot fit alone is reported and skipped so the next page advances.
    const skipped =
      truncated && options.length === 0 && page[0]
        ? { optionId: page[0].id, reason: "OPTION_TOO_LARGE" as const }
        : undefined;
    const nextPosition = pinned.position + options.length + (skipped ? 1 : 0);
    const nextCursor = continuationCursor(
      {
        kind: "options",
        projectId: input.projectId,
        resourceId: input.tableId,
        snapshotCommitSha: table.snapshotCommitSha,
        query: pinned.query,
      },
      nextPosition < all.length ? nextPosition : null,
    );
    return {
      output: {
        tableId: table.id,
        snapshotCommitSha: table.snapshotCommitSha,
        baseCommitSha: table.baseCommitSha,
        column: { id: column.id, name: column.name, type: column.type },
        optionCount: all.length,
        options,
        nextCursor,
        hasMore: nextCursor !== null,
        ...(skipped ? { skipped } : {}),
      },
      citations: [
        {
          kind: "table",
          projectId: input.projectId,
          tableId: table.id,
          commitSha: table.baseCommitSha,
          rowIds: [],
          columnIds: [column.id],
        },
      ],
    };
  },
});

export const readTableCellTool = defineTool({
  name: "read_table_cell",
  kind: "read",
  capability: "content:read",
  description:
    "Reads one cell losslessly at one snapshot. value.kind is absent (no value), scalar (number/boolean), list (a multiselect cell: values are option ids, labels their current text, same order; paged like text if it doesn't fit in one call), or text (chunked; continue with value.nextCursor). Use for oversizedCells from query_table_rows.",
  inputSchema: z.object({
    projectId: z.uuid(),
    tableId: z.uuid(),
    rowId: z.string(),
    columnId: z.string(),
    atCommitSha: atCommitShaInput,
    cursor: cursorInput,
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(MAX_CELL_CHUNK)
      .default(MAX_CELL_CHUNK),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const query = { rowId: input.rowId, columnId: input.columnId };
    const pinned = resolvePinnedRequest({
      kind: "cell",
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
    const column = table.columns.find((c) => c.id === input.columnId);
    if (!column)
      throw new ToolError("BAD_REQUEST", `unknown column ${input.columnId}`);
    const row = table.rows.find((r) => r.id === input.rowId);
    if (!row)
      throw new ToolError("NOT_FOUND", "row not found at this snapshot");
    const raw = row.cells[input.columnId];
    const binding = {
      kind: "cell" as const,
      projectId: input.projectId,
      resourceId: input.tableId,
      snapshotCommitSha: table.snapshotCommitSha,
      query: pinned.query,
    };
    const ids = {
      tableId: table.id,
      rowId: row.id,
      columnId: input.columnId,
      snapshotCommitSha: table.snapshotCommitSha,
      baseCommitSha: table.baseCommitSha,
    };
    let value:
      | { kind: "absent" }
      | { kind: "scalar"; value: number | boolean }
      // A multiselect cell: values are the stored option ids, labels their
      // current text at this snapshot, same order and length as values.
      // Paged the same way as text (below): a 200-id cell with 100-char
      // labels can exceed MAX_TOOL_OUTPUT_CHARS on its own.
      | {
          kind: "list";
          values: string[];
          labels: string[];
          nextCursor: string | null;
          hasMore: boolean;
        }
      | TextCellPage;
    if (raw === undefined) value = { kind: "absent" };
    else if (Array.isArray(raw)) {
      const labelById = new Map(
        (column.options ?? []).map((option) => [option.id, option.label]),
      );
      const page = pageListCell(raw, labelById, pinned.position);
      const nextCursor = continuationCursor(binding, page.nextOffset);
      value = {
        kind: "list",
        values: page.values,
        labels: page.labels,
        nextCursor,
        hasMore: nextCursor !== null,
      };
    } else if (typeof raw !== "string") value = { kind: "scalar", value: raw };
    else
      value = pageTextCell(raw, pinned.position, input.maxChars, binding, ids);
    return {
      output: { ...ids, value },
      citations: [
        {
          kind: "table",
          projectId: input.projectId,
          tableId: table.id,
          commitSha: table.baseCommitSha,
          rowIds: [row.id],
          columnIds: [input.columnId],
        },
      ],
    };
  },
});

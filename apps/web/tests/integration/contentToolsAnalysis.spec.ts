import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import { createTable, saveTable } from "@weaver/core/services/tables";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import { validateSourceLocators } from "@weaver/core/assistant/citations";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import type { TableColumn, TableRow } from "@weaver/core/tables/types";
import { MAX_TOOL_OUTPUT_CHARS } from "@weaver/assistant-tools/contract";
import { MAX_GROUP_KEY_CHARS } from "@weaver/core/tables/aggregate";

const AUTHOR = { name: "Editor", email: "editor@test.local" };
const C_NAME = "11111111-1111-4111-8111-111111111111";
const C_SIZE = "22222222-2222-4222-8222-222222222222";
const C_STAGE = "33333333-3333-4333-8333-333333333333";
const O_DRAFT = "44444444-4444-4444-8444-444444444444";
const O_LIVE = "55555555-5555-4555-8555-555555555555";

const columns: TableColumn[] = [
  { id: C_NAME, name: "Name", type: "text" },
  { id: C_SIZE, name: "Size", type: "number" },
  {
    id: C_STAGE,
    name: "Stage",
    type: "select",
    options: [
      { id: O_DRAFT, label: "Draft" },
      { id: O_LIVE, label: "Live" },
    ],
  },
];

const rowId = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString().padStart(12, "0")}`;

const rows: TableRow[] = [
  { id: rowId(1), cells: { [C_NAME]: "a", [C_SIZE]: 2, [C_STAGE]: O_DRAFT } },
  { id: rowId(2), cells: { [C_NAME]: "b", [C_SIZE]: 0, [C_STAGE]: O_LIVE } },
  { id: rowId(3), cells: { [C_NAME]: "c", [C_SIZE]: 10, [C_STAGE]: O_DRAFT } },
  { id: rowId(4), cells: { [C_NAME]: "d" } },
];

let queue: FakeJobQueue;

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  await resetDb();
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

async function fixture(
  suffix: string,
  rowsOverride: TableRow[] = rows,
  columnsOverride: TableColumn[] = columns,
) {
  const owner = await makeUser("User", `owner-${suffix}`);
  const project = await makeProject(`Analysis ${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  const db = getPrisma();
  const actor = { ...securityContextFor(owner), ...AUTHOR, email: owner.email };
  const table = await createTable(
    db,
    {
      projectId: project.id,
      title: "Items",
      folderPath: [],
      columns: columnsOverride,
      rows: rowsOverride,
    },
    actor,
  );
  const scope = await resolveScopeSnapshot(db, actor, {
    kind: "project",
    projectId: project.id,
  });
  return { db, project, actor, table, scope };
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Record<string, unknown>,
) {
  const { aggregateTableTool } =
    await import("@weaver/assistant-tools/tools/aggregate");
  return aggregateTableTool.execute(
    {
      projectId: f.project.id,
      tableId: f.table.id,
      limit: 50,
      ...input,
    } as never,
    {
      db: f.db,
      actor: f.actor,
      scope: f.scope,
      profile: { name: AUTHOR.name, email: f.actor.email },
      run: null,
    } as never,
  );
}

describe("aggregate_table", () => {
  it("folds over every row, keeping zero a value and an absent cell out", async () => {
    const f = await fixture("plain");
    const result = (await run(f, {
      aggregates: [
        { fn: "count" },
        { fn: "sum", columnId: C_SIZE },
        { fn: "avg", columnId: C_SIZE },
        { fn: "countNonEmpty", columnId: C_SIZE },
        { fn: "distinctCount", columnId: C_STAGE },
      ],
    })) as { output: { matched: number; aggregates: unknown[] } };

    expect(result.output.matched).toBe(4);
    expect(result.output.aggregates).toEqual([
      { fn: "count", columnId: null, value: 4, contributing: 4 },
      { fn: "sum", columnId: C_SIZE, value: 12, contributing: 3 },
      { fn: "avg", columnId: C_SIZE, value: 4, contributing: 3 },
      { fn: "countNonEmpty", columnId: C_SIZE, value: 3, contributing: 3 },
      { fn: "distinctCount", columnId: C_STAGE, value: 2, contributing: 3 },
    ]);
  });

  it("folds only matching rows and reports the filtered total", async () => {
    const f = await fixture("filtered");
    const result = (await run(f, {
      filters: [{ columnId: C_SIZE, op: "gt", value: 0 }],
      aggregates: [{ fn: "sum", columnId: C_SIZE }],
    })) as { output: { matched: number; aggregates: { value: number }[] } };

    expect(result.output.matched).toBe(2);
    expect(result.output.aggregates[0]!.value).toBe(12);
  });

  it("stays coherent when the filter matches nothing", async () => {
    const f = await fixture("zero-match");
    const result = (await run(f, {
      filters: [{ columnId: C_SIZE, op: "gt", value: 1_000 }],
      groupBy: [C_STAGE],
      aggregates: [{ fn: "count" }],
    })) as {
      output: {
        matched: number;
        groups: unknown[];
        groupCount: number;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };

    expect(result.output.matched).toBe(0);
    expect(result.output.groups).toEqual([]);
    expect(result.output.groupCount).toBe(0);
    expect(result.output.hasMore).toBe(false);
    expect(result.output.nextCursor).toBeNull();
  });

  it("groups with a labelled select bucket and a separate absent bucket", async () => {
    const f = await fixture("grouped");
    const result = (await run(f, {
      groupBy: [C_STAGE],
      aggregates: [{ fn: "count" }, { fn: "sum", columnId: C_SIZE }],
    })) as {
      output: {
        groupCount: number;
        groups: {
          key: { value: unknown; label?: string }[];
          matched: number;
          aggregates: { value: unknown }[];
        }[];
      };
    };

    expect(result.output.groupCount).toBe(3);
    expect(
      result.output.groups.map((g) => [g.key[0]!.value, g.key[0]!.label]),
    ).toEqual([
      [O_DRAFT, "Draft"],
      [O_LIVE, "Live"],
      [null, undefined],
    ]);
    expect(result.output.groups.map((g) => g.matched)).toEqual([2, 1, 1]);
    expect(result.output.groups.map((g) => g.aggregates[1]!.value)).toEqual([
      12, 0, 0,
    ]);
  });

  it("groups by a multiselect column, counting a row once per selected option", async () => {
    const C_TAGS = "66666666-6666-4666-8666-666666666666";
    const O_URGENT = "77777777-7777-4777-8777-777777777777";
    const O_BLOCKED = "88888888-8888-4888-8888-888888888888";
    const tagColumns: TableColumn[] = [
      { id: C_NAME, name: "Name", type: "text" },
      {
        id: C_TAGS,
        name: "Tags",
        type: "multiselect",
        options: [
          { id: O_URGENT, label: "Urgent" },
          { id: O_BLOCKED, label: "Blocked" },
        ],
      },
    ];
    const tagRows: TableRow[] = [
      { id: rowId(1), cells: { [C_NAME]: "a", [C_TAGS]: [O_URGENT] } },
      {
        id: rowId(2),
        cells: { [C_NAME]: "b", [C_TAGS]: [O_URGENT, O_BLOCKED] },
      },
    ];
    const f = await fixture("multiselect-group", tagRows, tagColumns);
    const result = (await run(f, {
      groupBy: [C_TAGS],
      aggregates: [{ fn: "count" }],
    })) as {
      output: {
        groupCount: number;
        groups: {
          key: { value: unknown; label?: string }[];
          matched: number;
        }[];
      };
    };

    expect(result.output.groupCount).toBe(2);
    expect(
      result.output.groups.map((g) => [g.key[0]!.value, g.key[0]!.label]),
    ).toEqual([
      [O_URGENT, "Urgent"],
      [O_BLOCKED, "Blocked"],
    ]);
    // Row b holds both tags, so it is counted once per option it holds and
    // lands in both buckets; row a (Urgent only) lands in one.
    expect(result.output.groups.map((g) => g.matched)).toEqual([2, 1]);
  });

  it("pages groups without ever making a total look partial", async () => {
    const f = await fixture("paged");
    const first = (await run(f, {
      groupBy: [C_NAME],
      limit: 2,
      aggregates: [{ fn: "count" }],
    })) as {
      output: {
        matched: number;
        groupCount: number;
        groups: { key: { value: unknown }[] }[];
        nextCursor: string | null;
        hasMore: boolean;
      };
    };

    expect(first.output.matched).toBe(4);
    expect(first.output.groupCount).toBe(4);
    expect(first.output.groups).toHaveLength(2);
    expect(first.output.hasMore).toBe(true);

    const second = (await run(f, {
      cursor: first.output.nextCursor,
      aggregates: [{ fn: "count" }],
      groupBy: [C_NAME],
      limit: 2,
    })) as {
      output: {
        matched: number;
        groups: { key: { value: unknown }[] }[];
        hasMore: boolean;
        nextCursor: string | null;
      };
    };

    // The scan was complete on both pages; only the group list was sliced.
    expect(second.output.matched).toBe(4);
    expect(second.output.groups).toHaveLength(2);
    expect(second.output.hasMore).toBe(false);
    // hasMore false must mean genuinely exhausted, not just an unchecked cursor.
    expect(second.output.nextCursor).toBeNull();
    expect([
      ...first.output.groups.map((g) => g.key[0]!.value),
      ...second.output.groups.map((g) => g.key[0]!.value),
    ]).toEqual(["a", "b", "c", "d"]);
  });

  it("renders a long group key cut to the cap and flagged, without merging two keys that share that prefix", async () => {
    // A cell may be up to MAX_TEXT_CHARS (10,000, core/services/tables.ts)
    // long; what a key RENDERS is capped at MAX_GROUP_KEY_CHARS while the
    // bucket keeps its identity on the whole cell, so two cells differing
    // only past the cap must still be two groups with separate totals.
    const SHARED = "z".repeat(MAX_GROUP_KEY_CHARS);
    const wideRows: TableRow[] = [
      { id: rowId(11), cells: { [C_NAME]: `${SHARED}-alpha`, [C_SIZE]: 1 } },
      { id: rowId(12), cells: { [C_NAME]: `${SHARED}-beta`, [C_SIZE]: 10 } },
      { id: rowId(13), cells: { [C_NAME]: `${SHARED}-beta`, [C_SIZE]: 100 } },
    ];
    const f = await fixture("wide-group-key", wideRows);
    const { output } = (await run(f, {
      groupBy: [C_NAME],
      aggregates: [{ fn: "sum", columnId: C_SIZE }],
    })) as {
      output: {
        groupCount: number;
        groups: {
          key: { value: unknown; valueTruncated?: boolean }[];
          matched: number;
          aggregates: { value: unknown }[];
        }[];
      };
    };
    expect(output.groupCount).toBe(2);
    expect(output.groups.map((g) => g.aggregates[0]!.value)).toEqual([1, 110]);
    for (const group of output.groups)
      expect(group.key).toEqual([
        {
          columnId: C_NAME,
          value: SHARED,
          valueTruncated: true,
        },
      ]);
  });

  it("skips a group whose key alone exceeds the page budget, keeping the envelope, matched total and cursor intact", async () => {
    // A rendered key is capped per part (MAX_GROUP_KEY_CHARS), but two
    // grouped text columns at that cap still make a ~4 KB key, and the
    // echoed query is charged against MAX_TOOL_OUTPUT_CHARS before any group
    // is added — so a wide query plus a wide key still leaves a group that
    // cannot fit. The filters below match every row (no cell equals a
    // 2,000-character `z` run) and exist only to consume the envelope.
    const C_NAME2 = "66666666-6666-4666-8666-666666666666";
    const bigColumns: TableColumn[] = [
      ...columns,
      { id: C_NAME2, name: "Name2", type: "text" },
    ];
    const HUGE = "z".repeat(9_000);
    const bigRows: TableRow[] = [
      { id: rowId(11), cells: { [C_NAME]: HUGE, [C_NAME2]: HUGE } },
      { id: rowId(12), cells: { [C_NAME]: "a", [C_NAME2]: "a" } },
      { id: rowId(13), cells: { [C_NAME]: "b", [C_NAME2]: "b" } },
    ];
    const wideFilters = Array.from({ length: 6 }, (_, index) => ({
      columnId: C_NAME,
      op: "neq" as const,
      value: `${index}${"z".repeat(MAX_GROUP_KEY_CHARS - 1)}`,
    }));
    const f = await fixture("oversized-group", bigRows, bigColumns);

    let cursor: string | undefined;
    let sawSkip = false;
    let pages = 0;
    for (let guard = 0; guard < 10; guard++) {
      const { output } = (await run(f, {
        filters: wideFilters,
        groupBy: [C_NAME, C_NAME2],
        aggregates: [{ fn: "count" }],
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })) as {
        output: {
          matched: number;
          groupCount: number;
          groups: unknown[];
          skipped?: { position: number; reason: string };
          truncated: boolean;
          hasMore: boolean;
          nextCursor: string | null;
        };
      };
      pages += 1;
      // The envelope survives every page: the complete-scan totals never
      // shrink to reflect only what fit, oversized group included or not.
      expect(output.matched).toBe(3);
      expect(output.groupCount).toBe(3);
      // The whole point: this tool's own response never grows past the
      // transport's hard cap, so clampText/jsonSafeOutput never have to
      // replace it wholesale with {truncated:true, partialJson} — which
      // would have taken nextCursor, matched and groupCount down with it.
      expect(JSON.stringify(output).length).toBeLessThanOrEqual(
        MAX_TOOL_OUTPUT_CHARS,
      );
      if (output.skipped) {
        sawSkip = true;
        expect(output.groups).toEqual([]);
        expect(output.truncated).toBe(true);
        expect(output.skipped).toEqual({
          position: expect.any(Number),
          reason: "GROUP_TOO_LARGE",
        });
      } else {
        // A surviving page still makes progress: it carries a real group.
        expect(output.groups).toHaveLength(1);
      }
      if (!output.hasMore) {
        expect(output.nextCursor).toBeNull();
        break;
      }
      // The defect this guards: a page that keeps nothing while hasMore is
      // true, and hands back a cursor that decodes to the same position,
      // reads as the same dead page forever.
      expect(typeof output.nextCursor).toBe("string");
      expect(output.nextCursor).not.toBe(cursor ?? null);
      cursor = output.nextCursor!;
    }
    expect(sawSkip).toBe(true);
    // One page per group: two ordinary pages and one skip.
    expect(pages).toBe(3);
  });

  it("rejects a query whose own envelope cannot fit, on both the grouped and ungrouped branch", async () => {
    const f = await fixture("envelope-too-large");
    const hugeFilters = Array.from({ length: 20 }, () => ({
      columnId: C_NAME,
      op: "eq" as const,
      value: "x".repeat(2_000),
    }));

    await expect(
      run(f, { filters: hugeFilters, aggregates: [{ fn: "count" }] }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "PAYLOAD_TOO_LARGE",
    });

    await expect(
      run(f, {
        filters: hugeFilters,
        groupBy: [C_STAGE],
        aggregates: [{ fn: "count" }],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "PAYLOAD_TOO_LARGE",
    });
  });

  it("truncates rather than silently completing when the echoed query leaves little room for the ungrouped results", async () => {
    // Ten distinct (fn, columnId) pairs is the schema's own cap and is also
    // the most columns/fns this fixture's three columns can combine into
    // without repeating a pair (assertAggregateSpecs forbids repeats).
    const AGG_SPECS = [
      { fn: "count" },
      { fn: "countNonEmpty", columnId: C_NAME },
      { fn: "countNonEmpty", columnId: C_SIZE },
      { fn: "countNonEmpty", columnId: C_STAGE },
      { fn: "sum", columnId: C_SIZE },
      { fn: "avg", columnId: C_SIZE },
      { fn: "min", columnId: C_SIZE },
      { fn: "max", columnId: C_SIZE },
      { fn: "distinctCount", columnId: C_NAME },
      { fn: "distinctCount", columnId: C_SIZE },
    ] as const;
    const FILTER_COUNT = 8;
    const bigFilters = (valueLen: number) =>
      Array.from({ length: FILTER_COUNT }, () => ({
        columnId: C_NAME,
        op: "eq" as const,
        value: "x".repeat(valueLen),
      }));
    // Predicts the tool's own envelope charge using fixed-width placeholders
    // for the ids the real call will fill in (a uuid is always 36 chars, a
    // git sha always 40 hex chars) — no DB round trip needed to calibrate.
    const predictAvailable = (valueLen: number) =>
      MAX_TOOL_OUTPUT_CHARS -
      JSON.stringify({
        tableId: "x".repeat(36),
        snapshotCommitSha: "0".repeat(40),
        baseCommitSha: "0".repeat(40),
        commitSha: "0".repeat(40),
        matched: 9_999,
        query: {
          filters: bigFilters(valueLen),
          groupBy: [] as string[],
          aggregates: AGG_SPECS,
        },
        aggregates: [] as unknown[],
        nextCursor: null,
        hasMore: false,
        truncated: true,
      }).length;
    // Smallest filter value that predicts a small, positive remainder — big
    // enough for the envelope alone to fit, too small for all ten results.
    let lo = 1;
    let hi = 2_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (predictAvailable(mid) <= 300) hi = mid;
      else lo = mid + 1;
    }
    const available = predictAvailable(lo);
    expect(available).toBeGreaterThan(0);
    expect(available).toBeLessThanOrEqual(300);

    const f = await fixture("ungrouped-truncated");
    const result = (await run(f, {
      filters: bigFilters(lo),
      aggregates: AGG_SPECS,
    })) as {
      output: {
        matched: number;
        aggregates: unknown[];
        truncated: boolean;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };

    expect(result.output.truncated).toBe(true);
    expect(result.output.aggregates.length).toBeLessThan(AGG_SPECS.length);
    expect(result.output.hasMore).toBe(false);
    expect(result.output.nextCursor).toBeNull();
    // The envelope — matched included — survives even though the results
    // it was asked for did not all fit.
    expect(typeof result.output.matched).toBe("number");
  });

  it("rejects a cursor replayed against a different aggregates or filters list", async () => {
    const f = await fixture("cursor-binding");
    const minted = (await run(f, {
      groupBy: [C_NAME],
      limit: 2,
      aggregates: [{ fn: "count" }],
    })) as { output: { nextCursor: string | null } };
    expect(typeof minted.output.nextCursor).toBe("string");
    const cursor = minted.output.nextCursor!;

    await expect(
      run(f, {
        cursor,
        groupBy: [C_NAME],
        limit: 2,
        aggregates: [{ fn: "count" }, { fn: "sum", columnId: C_SIZE }],
      }),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });

    await expect(
      run(f, {
        cursor,
        groupBy: [C_NAME],
        limit: 2,
        aggregates: [{ fn: "count" }],
        filters: [{ columnId: C_SIZE, op: "gt", value: 0 }],
      }),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
  });

  it("stays on its snapshot when the table changes underneath", async () => {
    const f = await fixture("pinned");
    const before = (await run(f, {
      aggregates: [{ fn: "sum", columnId: C_SIZE }],
    })) as {
      output: { snapshotCommitSha: string; aggregates: { value: number }[] };
    };
    expect(before.output.aggregates[0]!.value).toBe(12);

    await saveTable(
      f.db,
      {
        projectId: f.project.id,
        tableId: f.table.id,
        baseCommitSha: f.table.headCommitSha,
        title: "Items",
        columns,
        rows: [...rows, { id: rowId(5), cells: { [C_SIZE]: 100 } }],
      },
      f.actor,
    );

    const pinnedAgain = (await run(f, {
      atCommitSha: before.output.snapshotCommitSha,
      aggregates: [{ fn: "sum", columnId: C_SIZE }],
    })) as { output: { aggregates: { value: number }[] } };
    expect(pinnedAgain.output.aggregates[0]!.value).toBe(12);

    const current = (await run(f, {
      aggregates: [{ fn: "sum", columnId: C_SIZE }],
    })) as { output: { aggregates: { value: number }[] } };
    expect(current.output.aggregates[0]!.value).toBe(112);
  });

  it("refuses the mistyped, the ambiguous and the unknown", async () => {
    const f = await fixture("errors");
    await expect(
      run(f, { aggregates: [{ fn: "sum", columnId: C_NAME }] }),
    ).rejects.toThrow(/number/);
    await expect(
      run(f, { aggregates: [{ fn: "count", columnId: C_SIZE }] }),
    ).rejects.toThrow(/count/);
    await expect(
      run(f, {
        aggregates: [
          { fn: "sum", columnId: C_SIZE },
          { fn: "sum", columnId: C_SIZE },
        ],
      }),
    ).rejects.toThrow(/twice/);
    await expect(
      run(f, {
        aggregates: [{ fn: "count" }],
        groupBy: ["99999999-9999-4999-8999-999999999999"],
      }),
    ).rejects.toThrow(/unknown column/);
  });

  it("emits an aggregate citation that validates and carries the query", async () => {
    const f = await fixture("citation");
    const result = (await run(f, {
      filters: [{ columnId: C_SIZE, op: "gt", value: 0 }],
      groupBy: [C_STAGE],
      aggregates: [{ fn: "sum", columnId: C_SIZE }],
    })) as { citations: unknown[] };

    const [locator] = result.citations as [
      { kind: string; columnIds: string[]; query: unknown },
    ];
    expect(locator.kind).toBe("aggregate");
    expect(locator.columnIds.sort()).toEqual([C_SIZE, C_STAGE].sort());
    expect(locator.query).toEqual({
      filters: [{ columnId: C_SIZE, op: "gt", value: 0 }],
      groupBy: [C_STAGE],
      aggregates: [{ fn: "sum", columnId: C_SIZE }],
    });

    const [validated] = await validateSourceLocators(f.db, f.actor, [locator]);
    // The locator is an aggregate; the citation it becomes is a table citation,
    // so no AssistantCitationKind migration and no UI change.
    expect(validated).toMatchObject({
      kind: "table",
      resourceId: f.table.id,
      label: "Items",
    });
  });

  it("is the same contract on the MCP surface", async () => {
    const { mcpToolByName, toolByName } =
      await import("@weaver/assistant-tools/registry");
    expect(mcpToolByName("aggregate_table")).toBe(
      toolByName("aggregate_table"),
    );
  });
});

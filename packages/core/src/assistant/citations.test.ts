import { beforeEach, describe, expect, it, vi } from "vitest";

// citations.ts reaches out to the project repo and to project-access
// resolution; double both so validateSourceLocators can be exercised without
// a real database or git repository (see task-3 fix-round-1 report).
const gitStoreDoubles = vi.hoisted(() => ({
  openProjectRepo: vi.fn(),
  repoDir: vi.fn(),
}));
vi.mock("@weaver/git-store", () => gitStoreDoubles);
const projectAccessDoubles = vi.hoisted(() => ({
  resolveProjectAccess: vi.fn(),
}));
vi.mock("../services/projectAccess", () => projectAccessDoubles);

import type { PrismaClient } from "@weaver/db/client";
import { z } from "zod";
import { createSessionSecurityContext } from "../security/context";
import {
  resolveCitationInputSchema,
  resolvableLocatorSchema,
  sourceLocatorSchema,
  validateSourceLocators,
} from "./citations";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TABLE = "22222222-2222-4222-8222-222222222222";
const COLUMN = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(40);

const aggregate = {
  kind: "aggregate",
  projectId: PROJECT,
  tableId: TABLE,
  commitSha: SHA,
  columnIds: ["c1"],
  query: {
    filters: [{ columnId: "c1", op: "gt", value: 3 }],
    groupBy: ["c2"],
    aggregates: [{ fn: "sum", columnId: "c1" }],
  },
};

describe("sourceLocatorSchema", () => {
  it("keeps the four original variants in order and appends aggregate last", () => {
    expect(
      sourceLocatorSchema.options.map((option) => option.shape.kind.value),
    ).toEqual(["document", "table", "graph", "search", "aggregate"]);
  });

  it("accepts an aggregate locator carrying its normalized query", () => {
    const parsed = sourceLocatorSchema.safeParse(aggregate);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected success");
    // The claim is that the query survives parsing intact, not merely that
    // parsing succeeds — assert the parsed data, not just parsed.success.
    expect(parsed.data).toEqual(aggregate);
  });

  it("defaults columnIds, filters, and groupBy to an empty array when omitted", () => {
    const minimal = {
      kind: "aggregate",
      projectId: PROJECT,
      tableId: TABLE,
      commitSha: SHA,
      query: { aggregates: [{ fn: "count" }] },
    };
    const parsed = sourceLocatorSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected success");
    expect(parsed.data).toEqual({
      kind: "aggregate",
      projectId: PROJECT,
      tableId: TABLE,
      commitSha: SHA,
      columnIds: [],
      query: {
        filters: [],
        groupBy: [],
        aggregates: [{ fn: "count" }],
      },
    });
  });

  it("requires at least one aggregate in the persisted query", () => {
    expect(
      sourceLocatorSchema.safeParse({
        ...aggregate,
        query: { ...aggregate.query, aggregates: [] },
      }).success,
    ).toBe(false);
  });
});

describe("resolvableLocatorSchema", () => {
  it("is exactly the four variants a model may hand-construct", () => {
    expect(
      resolvableLocatorSchema.options.map((option) => option.shape.kind.value),
    ).toEqual(["document", "table", "graph", "search"]);
  });

  it("refuses an aggregate locator, so provenance cannot be minted by hand", () => {
    expect(resolvableLocatorSchema.safeParse(aggregate).success).toBe(false);
  });

  it("still accepts a table locator", () => {
    expect(
      resolvableLocatorSchema.safeParse({
        kind: "table",
        projectId: PROJECT,
        tableId: TABLE,
        commitSha: SHA,
        rowIds: [],
        columnIds: ["c1"],
      }).success,
    ).toBe(true);
  });
});

describe("resolveCitationInputSchema", () => {
  const DOCUMENT = "44444444-4444-4444-8444-444444444444";

  it("is a top-level JSON Schema object, as function-calling providers require", () => {
    expect(
      (
        z.toJSONSchema(resolveCitationInputSchema, { io: "input" }) as {
          type?: unknown;
        }
      ).type,
    ).toBe("object");
  });

  it("parses a flat locator into the same resolvable locator", () => {
    const input = {
      kind: "document",
      projectId: PROJECT,
      documentId: DOCUMENT,
      commitSha: SHA,
    };

    expect(resolveCitationInputSchema.parse(input)).toEqual(
      resolvableLocatorSchema.parse(input),
    );
  });

  it("keeps each kind's required fields and still refuses aggregates", () => {
    expect(
      resolveCitationInputSchema.safeParse({
        kind: "document",
        projectId: PROJECT,
        commitSha: SHA,
      }).success,
    ).toBe(false);
    expect(resolveCitationInputSchema.safeParse(aggregate).success).toBe(false);
  });
});

describe("validateSourceLocators — aggregate dedupe", () => {
  const actor = createSessionSecurityContext({
    userId: "u1",
    globalRole: "User",
    sessionId: "s1",
  });

  function fakeDb(): PrismaClient {
    return {
      dataTable: {
        findFirst: vi.fn().mockResolvedValue({ path: "tables/t.table" }),
      },
    } as unknown as PrismaClient;
  }

  function fakeRepo() {
    const schema = {
      id: TABLE,
      title: "Test Table",
      sourceOfTruth: "git" as const,
      columns: [{ id: COLUMN, name: "C1", type: "number" as const }],
      created: "2024-01-01T00:00:00.000Z",
      updated: "2024-01-01T00:00:00.000Z",
    };
    const schemaJson = JSON.stringify(schema);
    return {
      listTrackedFiles: vi
        .fn()
        .mockResolvedValue([
          "tables/t.table/schema.json",
          "tables/t.table/data.jsonl",
        ]),
      blobSizeAt: vi
        .fn()
        .mockImplementation(async (_sha: string, path: string) =>
          path.endsWith("schema.json") ? schemaJson.length : 0,
        ),
      showFileAt: vi
        .fn()
        .mockImplementation(async (_sha: string, path: string) =>
          path.endsWith("schema.json") ? schemaJson : "",
        ),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    gitStoreDoubles.openProjectRepo.mockResolvedValue(fakeRepo());
    projectAccessDoubles.resolveProjectAccess.mockResolvedValue(undefined);
  });

  const tableLocator = {
    kind: "table" as const,
    projectId: PROJECT,
    tableId: TABLE,
    commitSha: SHA,
    rowIds: [],
    columnIds: [COLUMN],
  };
  const aggregateLocator = {
    kind: "aggregate" as const,
    projectId: PROJECT,
    tableId: TABLE,
    commitSha: SHA,
    columnIds: [COLUMN],
    query: {
      filters: [],
      groupBy: [],
      aggregates: [{ fn: "count" as const }],
    },
  };

  it("keeps a table citation and an aggregate citation over the same table@commit distinct", async () => {
    const validated = await validateSourceLocators(fakeDb(), actor, [
      tableLocator,
      aggregateLocator,
    ]);
    // Both must survive: the aggregate's normalized query is the entire
    // reason this locator kind exists, and a dedupe keyed only on the
    // emitted citation.kind ("table" for both, by design) would silently
    // drop it in favor of the plain table citation seen first.
    expect(validated).toHaveLength(2);
    expect(validated.map((c) => c.locator.kind)).toEqual([
      "table",
      "aggregate",
    ]);
    expect(validated.every((c) => c.kind === "table")).toBe(true);
  });

  it("still collapses two identical table locators into one", async () => {
    const validated = await validateSourceLocators(fakeDb(), actor, [
      tableLocator,
      { ...tableLocator },
    ]);
    expect(validated).toHaveLength(1);
  });

  it("keeps two aggregate locators over the same table@commit whose queries differ distinct", async () => {
    const sumOverColumn = {
      ...aggregateLocator,
      query: {
        filters: [],
        groupBy: [],
        aggregates: [{ fn: "sum" as const, columnId: COLUMN }],
      },
    };
    const validated = await validateSourceLocators(fakeDb(), actor, [
      aggregateLocator, // count
      sumOverColumn, // sum(COLUMN) — a different query over the same table@commit
    ]);
    // Both must survive: this is the defect fix round 1's dedupe key still
    // had one level deeper — two different aggregates over the same table
    // at the same commit collided (both citations report kind "table",
    // same resourceId, commitSha and label), so the second query's
    // provenance was silently discarded.
    expect(validated).toHaveLength(2);
  });

  it("still collapses two identical aggregate locators (same query) into one", async () => {
    const validated = await validateSourceLocators(fakeDb(), actor, [
      aggregateLocator,
      { ...aggregateLocator, query: { ...aggregateLocator.query } },
    ]);
    expect(validated).toHaveLength(1);
  });

  it("collapses two aggregate locators whose queries are the same but differently ordered or defaulted", async () => {
    // Same query as aggregateLocator.query, but its keys are written in a
    // different order in the object literal.
    const reorderedKeys = {
      ...aggregateLocator,
      query: {
        aggregates: [{ fn: "count" as const }],
        groupBy: [],
        filters: [],
      },
    };
    // Same query again, but with filters/groupBy omitted entirely instead
    // of written out as an explicit empty array — both default to [].
    const omittedDefaults = {
      ...aggregateLocator,
      query: { aggregates: [{ fn: "count" as const }] },
    };
    const validated = await validateSourceLocators(fakeDb(), actor, [
      aggregateLocator,
      reorderedKeys,
      omittedDefaults,
    ]);
    // All three collapse into one citation: however the caller spelled the
    // query, the dedupe key sees a single one. This does NOT isolate
    // cursorQueryIdentity's canonicalization — validateSourceLocators parses
    // with sourceLocatorSchema first, and zod's object reconstruction already
    // normalizes key order and fills in the defaults before the key is built,
    // so a plain JSON.stringify would pass here identically. What this pins is
    // the end-to-end behaviour at this call site.
    expect(validated).toHaveLength(1);
  });
});

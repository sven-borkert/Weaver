import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import type { TableColumn, TableRow } from "../tables/types";
import {
  applyTableRowChanges,
  applyTableSchemaChanges,
  assertProposalFolderListed,
  proposalKind,
  proposalOperationSchema,
  type ProposalOperation,
} from "./assistantProposals";

const columns: TableColumn[] = [
  { id: "c1", name: "Name", type: "text" },
  { id: "c2", name: "Done", type: "boolean" },
];
const rows: TableRow[] = [
  { id: "r1", cells: { c1: "A", c2: false } },
  { id: "r2", cells: { c1: "B", c2: true } },
];

describe("applyTableSchemaChanges", () => {
  it("adds, renames, and removes columns and drops removed cells", () => {
    const next = applyTableSchemaChanges(columns, rows, [
      { op: "add", column: { id: "c3", name: "Owner", type: "text" } },
      { op: "rename", columnId: "c1", name: "Title" },
      { op: "remove", columnId: "c2" },
    ]);
    expect(next.columns).toEqual([
      { id: "c1", name: "Title", type: "text" },
      { id: "c3", name: "Owner", type: "text" },
    ]);
    expect(next.rows[0]!.cells).toEqual({ c1: "A" });
  });
  it("rejects duplicate column ids and removing the last column", () => {
    expect(() =>
      applyTableSchemaChanges(columns, rows, [
        { op: "add", column: { id: "c1", name: "Other", type: "text" } },
      ]),
    ).toThrow(/duplicate column id/);
    expect(() =>
      applyTableSchemaChanges(columns, rows, [
        { op: "remove", columnId: "c1" },
        { op: "remove", columnId: "c2" },
      ]),
    ).toThrow(/at least one column/);
  });
  it("rejects unknown column ids and duplicate names", () => {
    expect(() =>
      applyTableSchemaChanges(columns, rows, [
        { op: "rename", columnId: "zz", name: "X" },
      ]),
    ).toThrow(/unknown column/);
    expect(() =>
      applyTableSchemaChanges(columns, rows, [
        { op: "add", column: { id: "c9", name: "Name", type: "text" } },
      ]),
    ).toThrow(/duplicate column name/);
  });
});

describe("applyTableRowChanges", () => {
  it("inserts, updates by merging cells, and deletes", () => {
    const next = applyTableRowChanges(columns, rows, {
      inserts: [{ id: "r3", cells: { c1: "C", c2: false } }],
      updates: [{ rowId: "r1", cells: { c2: true } }],
      deletes: ["r2"],
    });
    expect(next.rows).toEqual([
      { id: "r1", cells: { c1: "A", c2: true } },
      { id: "r3", cells: { c1: "C", c2: false } },
    ]);
  });
  it("drops a row that is updated and then deleted, and rejects duplicate inserts", () => {
    const next = applyTableRowChanges(columns, rows, {
      inserts: [],
      updates: [{ rowId: "r2", cells: { c1: "B2" } }],
      deletes: ["r2"],
    });
    expect(next.rows.map((row) => row.id)).toEqual(["r1"]);
    expect(() =>
      applyTableRowChanges(columns, rows, {
        inserts: [{ id: "r1", cells: { c1: "dup" } }],
        updates: [],
        deletes: [],
      }),
    ).toThrow(/duplicate row id/);
  });
  it("rejects unknown rows and invalid cell values", () => {
    expect(() =>
      applyTableRowChanges(columns, rows, {
        inserts: [],
        updates: [{ rowId: "nope", cells: {} }],
        deletes: [],
      }),
    ).toThrow(/unknown row/);
    expect(() =>
      applyTableRowChanges(columns, rows, {
        inserts: [],
        updates: [{ rowId: "r1", cells: { c2: "yes" } }],
        deletes: [],
      }),
    ).toThrow(/invalid cell/);
  });
});

describe("proposalOperationSchema", () => {
  it("parses each kind", () => {
    const pid = "11111111-1111-4111-8111-111111111111";
    expect(
      proposalOperationSchema.parse({
        kind: "document.create",
        projectId: pid,
        folderPath: [],
        title: "T",
        markdown: "# T",
      }).kind,
    ).toBe("document.create");
    expect(
      proposalOperationSchema.parse({
        kind: "table.rows",
        projectId: pid,
        tableId: pid,
        baseCommitSha: "a".repeat(40),
        inserts: [],
        updates: [],
        deletes: ["r1"],
      }).kind,
    ).toBe("table.rows");
    expect(() =>
      proposalOperationSchema.parse({ kind: "table.drop" }),
    ).toThrow();
  });
});

describe("assertProposalFolderListed", () => {
  const listed = new Set(["specs", "specs/drafts"]);

  it("accepts the root and any listed folder", () => {
    expect(() =>
      assertProposalFolderListed(listed, "folderPath", []),
    ).not.toThrow();
    expect(() =>
      assertProposalFolderListed(listed, "newParentPath", ["specs", "drafts"]),
    ).not.toThrow();
  });

  const refusalFor = (
    field: Parameters<typeof assertProposalFolderListed>[1],
  ): CoreError => {
    try {
      assertProposalFolderListed(listed, field, ["missing"]);
    } catch (error) {
      if (error instanceof CoreError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it.each(["folderPath", "parentPath", "newParentPath", "path"] as const)(
    "pins the refusal to %s and points at list_content_folders",
    (field) => {
      const error = refusalFor(field);
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toMatch(
        new RegExp(`^${field} .*list_content_folders`),
      );
      expect(error.details).toEqual({ field });
    },
  );

  it("offers the root and creating the folder only where the field allows them", () => {
    expect(refusalFor("folderPath").message).toContain(
      "propose_content_lifecycle",
    );
    expect(refusalFor("path").message).not.toContain(
      "propose_content_lifecycle",
    );
  });
});

describe("proposalKind for lifecycle operations", () => {
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const RESOURCE = "22222222-2222-4222-8222-222222222222";
  const SHA = "a".repeat(40);

  const operations: ProposalOperation[] = (
    ["document", "table"] as const
  ).flatMap((resourceType) => [
    {
      kind: "content.lifecycle",
      projectId: PROJECT,
      action: "folder_create",
      resourceType,
      baseProjectCommitSha: SHA,
      parentPath: [],
      name: "Archive",
    },
    {
      kind: "content.lifecycle",
      projectId: PROJECT,
      action: "folder_rename",
      resourceType,
      baseProjectCommitSha: SHA,
      path: ["archive"],
      name: "Attic",
    },
    {
      kind: "content.lifecycle",
      projectId: PROJECT,
      action: "folder_move",
      resourceType,
      baseProjectCommitSha: SHA,
      path: ["archive"],
      newParentPath: [],
    },
    {
      kind: "content.lifecycle",
      projectId: PROJECT,
      action: "folder_delete",
      resourceType,
      baseProjectCommitSha: SHA,
      path: ["archive"],
    },
    {
      kind: "content.lifecycle",
      projectId: PROJECT,
      action: "item_move",
      resourceType,
      resourceId: RESOURCE,
      expectedHeadCommitSha: SHA,
      folderPath: [],
    },
    {
      kind: "content.lifecycle",
      projectId: PROJECT,
      action: "item_delete",
      resourceType,
      resourceId: RESOURCE,
      expectedHeadCommitSha: SHA,
    },
  ]);

  it("names the resource type for an item action so a table never links as a document", () => {
    expect(
      proposalKind({
        kind: "content.lifecycle",
        projectId: PROJECT,
        action: "item_move",
        resourceType: "table",
        resourceId: RESOURCE,
        expectedHeadCommitSha: SHA,
        folderPath: [],
      }),
    ).toBe("content.lifecycle.item_move.table");
  });

  it("leaves a folder action's kind free of a resource type, since it has no target", () => {
    expect(
      proposalKind({
        kind: "content.lifecycle",
        projectId: PROJECT,
        action: "folder_delete",
        resourceType: "table",
        baseProjectCommitSha: SHA,
        path: ["metrics"],
      }),
    ).toBe("content.lifecycle.folder_delete");
  });

  it("keeps every kind inside the AssistantProposal.kind VarChar(40) column", () => {
    for (const operation of operations)
      expect(proposalKind(operation).length).toBeLessThanOrEqual(40);
  });
});

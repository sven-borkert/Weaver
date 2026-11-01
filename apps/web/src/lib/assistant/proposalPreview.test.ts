import { describe, expect, it } from "vitest";
import {
  acceptErrorAction,
  capDiffSections,
  isProposalExpired,
  parsePreview,
  pendingProposalCount,
  PREVIEW_LINE_LIMIT,
  proposalKindLabel,
  truncationNote,
} from "./proposalPreview";

// The literal shapes below are the ones `prepare()` in
// packages/core/src/services/assistantProposals.ts actually stores:
// `linePreview` for document.create AND document.edit, `{ kind: "table",
// columns, rowCount, sampleRows }` for table.create, `{ kind: "table", diff }`
// for table.schema/table.rows, and boundedJson's `{ truncated: true }`
// fallback when even a shrunk payload overflows MAX_PREVIEW_CHARS.
describe("parsePreview", () => {
  it("recognises linePreview, which backs both document.create and document.edit", () => {
    const parsed = parsePreview({
      kind: "document",
      lines: [
        { type: "add", text: "Rollback" },
        { type: "same", text: "" },
        { type: "bogus", text: "dropped" },
        { type: "del", text: 7 },
      ],
      truncated: true,
    });
    expect(parsed).toEqual({
      kind: "document",
      lines: [
        { type: "add", text: "Rollback" },
        { type: "same", text: "" },
      ],
      truncated: true,
    });
  });

  it("recognises the table.schema / table.rows diff preview", () => {
    const parsed = parsePreview({
      kind: "table",
      diff: {
        titleChange: null,
        columnChanges: [
          { kind: "added", column: { id: "c1", name: "Owner", type: "text" } },
          { kind: "renamed", columnId: "c2", from: "Cost", to: "Budget" },
        ],
        addedRows: ["r1"],
        removedRows: [],
        changedCells: [{ rowId: "r2", columnId: "c1", from: null, to: "Ada" }],
      },
    });
    expect(parsed.kind).toBe("table-diff");
    if (parsed.kind !== "table-diff") throw new Error("unreachable");
    expect(parsed.diff.columnChanges).toHaveLength(2);
    expect(parsed.diff.changedCells).toEqual([
      { rowId: "r2", columnId: "c1", from: null, to: "Ada" },
    ]);
    expect(parsed.truncated).toBe(false);
  });

  it("drops column and cell changes it cannot narrow, so presentTableDiff never meets an unknown kind", () => {
    const parsed = parsePreview({
      kind: "table",
      diff: {
        titleChange: { from: 1, to: "New" },
        columnChanges: [
          { kind: "moved", columnId: "c1" },
          { kind: "added", column: { id: "c2", name: "Owner", type: "wat" } },
          { kind: "retyped", columnId: "c3", from: "text", to: "number" },
        ],
        addedRows: ["r1", 5],
        removedRows: "nope",
        changedCells: [{ rowId: "r1", columnId: "c1", from: {}, to: "b" }],
      },
    });
    if (parsed.kind !== "table-diff") throw new Error("unreachable");
    expect(parsed.diff.titleChange).toBeNull();
    expect(parsed.diff.columnChanges).toEqual([
      { kind: "retyped", columnId: "c3", from: "text", to: "number" },
    ]);
    expect(parsed.diff.addedRows).toEqual(["r1"]);
    expect(parsed.diff.removedRows).toEqual([]);
    expect(parsed.diff.changedCells).toEqual([]);
  });

  it("recognises the table.create sample preview", () => {
    const parsed = parsePreview({
      kind: "table",
      columns: [
        { id: "c1", name: "Name", type: "text" },
        { id: "c2", name: "Broken", type: "nope" },
      ],
      rowCount: 42,
      sampleRows: [
        { id: "r1", cells: { c1: "Ada" } },
        { id: "r2", cells: { c1: { bad: true } } },
        "junk",
      ],
    });
    expect(parsed).toEqual({
      kind: "table-create",
      columns: [{ id: "c1", name: "Name", type: "text" }],
      rowCount: 42,
      sampleRows: [
        { id: "r1", cells: { c1: "Ada" } },
        { id: "r2", cells: {} },
      ],
      truncated: false,
    });
  });

  it("carries boundedJson's truncation marker through a recognised shape", () => {
    const parsed = parsePreview({
      kind: "table",
      columns: [],
      rowCount: 0,
      sampleRows: [],
      truncated: true,
    });
    if (parsed.kind !== "table-create") throw new Error("unreachable");
    expect(parsed.truncated).toBe(true);
  });

  it("recognises the lifecycle preview", () => {
    expect(
      parsePreview({
        kind: "lifecycle",
        action: "folder_move",
        resourceType: "document",
        from: "archive",
        to: "store/archive",
        title: null,
        affected: { documents: 3, tables: 0 },
      }),
    ).toEqual({
      kind: "lifecycle",
      action: "folder_move",
      resourceType: "document",
      from: "archive",
      to: "store/archive",
      title: null,
      affected: { documents: 3, tables: 0 },
      truncated: false,
    });
  });

  it("degrades a lifecycle preview with unusable counts rather than rendering NaN", () => {
    expect(
      parsePreview({
        kind: "lifecycle",
        action: "item_delete",
        resourceType: "table",
        from: "tables/roster.table",
        to: null,
        title: "Roster",
        affected: { documents: "many", tables: null },
      }),
    ).toMatchObject({
      kind: "lifecycle",
      affected: { documents: 0, tables: 0 },
    });
  });

  it("degrades to unknown for boundedJson's bare fallback and for anything else", () => {
    expect(parsePreview({ truncated: true }).kind).toBe("unknown");
    expect(parsePreview({ kind: "table" }).kind).toBe("unknown");
    expect(parsePreview({ kind: "create", title: "New" }).kind).toBe("unknown");
    expect(parsePreview(null).kind).toBe("unknown");
    expect(parsePreview("nope").kind).toBe("unknown");
    expect(parsePreview([]).kind).toBe("unknown");
  });
});

describe("proposalKindLabel", () => {
  it("names every operation kind the backend can propose", () => {
    expect(
      [
        "document.create",
        "document.edit",
        "table.create",
        "table.schema",
        "table.rows",
        "content.restore.document",
        "content.restore.table",
        "content.lifecycle.folder_create",
        "content.lifecycle.folder_rename",
        "content.lifecycle.folder_move",
        "content.lifecycle.folder_delete",
        "content.lifecycle.item_move.document",
        "content.lifecycle.item_move.table",
        "content.lifecycle.item_delete.document",
        "content.lifecycle.item_delete.table",
      ].map(proposalKindLabel),
    ).toEqual([
      "New document",
      "Document edit",
      "New table",
      "Table schema change",
      "Table rows",
      "Restore document",
      "Restore table",
      "New folder",
      "Rename folder",
      "Move folder",
      "Delete folder",
      "Move document",
      "Move table",
      "Delete document",
      "Delete table",
    ]);
  });

  it("falls back to the raw kind rather than rendering nothing", () => {
    expect(proposalKindLabel("chart.create")).toBe("chart.create");
  });
});

describe("isProposalExpired", () => {
  const soon = new Date(1_000);
  it("is true for the stored expired status regardless of the clock", () => {
    expect(
      isProposalExpired({ status: "expired", expiresAt: soon }, null),
    ).toBe(true);
  });
  it("is true once the client clock passes expiresAt", () => {
    expect(
      isProposalExpired({ status: "pending", expiresAt: soon }, 2_000),
    ).toBe(true);
  });
  it("is false before expiry", () => {
    expect(isProposalExpired({ status: "pending", expiresAt: soon }, 500)).toBe(
      false,
    );
  });
  it("never guesses before mount, so the server render matches the client's first paint", () => {
    expect(
      isProposalExpired({ status: "pending", expiresAt: soon }, null),
    ).toBe(false);
  });
});

describe("pendingProposalCount", () => {
  const rows = [
    { status: "pending", expiresAt: new Date(5_000) },
    { status: "pending", expiresAt: new Date(500) },
    { status: "accepted", expiresAt: new Date(5_000) },
  ];
  it("counts only proposals still awaiting a decision", () => {
    expect(pendingProposalCount(rows, 1_000)).toBe(1);
  });
  it("counts every pending row before mount", () => {
    expect(pendingProposalCount(rows, null)).toBe(2);
  });
});

describe("capDiffSections", () => {
  it("caps each section's items and reports how many it hid", () => {
    const capped = capDiffSections(
      [
        { kind: "columns", heading: "Columns", items: ["a", "b"] },
        {
          kind: "cells",
          heading: "Cells",
          items: Array.from({ length: 55 }, (_, i) => `cell ${i}`),
        },
      ],
      50,
    );
    expect(capped[0]).toEqual({
      kind: "columns",
      heading: "Columns",
      items: ["a", "b"],
      hidden: 0,
    });
    expect(capped[1]!.items).toHaveLength(50);
    expect(capped[1]!.hidden).toBe(5);
  });
});

describe("truncationNote", () => {
  it("says nothing when the preview is whole", () => {
    expect(truncationNote(40, false)).toBeNull();
  });
  it("names the line limit only when the lines actually reach it", () => {
    expect(truncationNote(PREVIEW_LINE_LIMIT, true)).toBe(
      "Preview limited to 2,000 lines",
    );
  });
  it("stays generic when boundedJson's byte budget cut the array short", () => {
    // linePreview slices to exactly PREVIEW_LINE_LIMIT when it fires, so a
    // truncated preview holding fewer lines was shrunk for size, not lines —
    // claiming a 2,000-line limit here would be a false statement.
    expect(truncationNote(37, true)).toBe("Preview shortened");
  });
});

describe("acceptErrorAction", () => {
  it("refreshes the role on FORBIDDEN so Accept cannot survive to fail again", () => {
    expect(acceptErrorAction("FORBIDDEN", "nope")).toEqual({
      toast: "You no longer have Editor access here",
      refreshProposal: false,
      refreshRole: true,
    });
  });
  it("re-fetches silently on CONFLICT and lets the server's decision render", () => {
    expect(acceptErrorAction("CONFLICT", "proposal is expired")).toEqual({
      toast: null,
      refreshProposal: true,
      refreshRole: false,
    });
  });
  it("surfaces any other message, falling back to its own copy", () => {
    expect(acceptErrorAction("INTERNAL_SERVER_ERROR", "boom").toast).toBe(
      "boom",
    );
    expect(acceptErrorAction(undefined, undefined).toast).toBe(
      "Couldn’t accept the proposal",
    );
  });
  it("never toasts a bare CoreError code", () => {
    // CoreError's message defaults to its own code, so a stale precondition
    // would otherwise show the literal string "PRECONDITION_FAILED".
    expect(
      acceptErrorAction("PRECONDITION_FAILED", "PRECONDITION_FAILED").toast,
    ).toBe("Couldn’t accept the proposal");
  });
});

import { describe, expect, it } from "vitest";
import {
  applyTableEditorUpdate,
  appendColumn,
  appendRow,
  draftFromSnapshot,
  isDraftDirty,
  moveColumn,
  pinLatestTableEditorState,
  pinTableEditorState,
  removeColumn,
  removeRows,
  replaceColumn,
  retypeDraftColumn,
  rowsInvalidForColumn,
  setDraftCell,
  shouldPreserveTableEditorState,
  snapshotFromGet,
  snapshotFromWrite,
} from "./draft";
import type { TableEditorState, TableSnapshot } from "./draft";
import {
  acceptedTableWriteState,
  refreshAfterAcceptedTableWrite,
} from "./save";

const ROW_1 = "11111111-1111-4111-8111-111111111111";
const ROW_2 = "22222222-2222-4222-8222-222222222222";
const COL_TEXT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COL_NUMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COL_SELECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPTION_ONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPTION_TWO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const snapshot = {
  title: "Budget",
  columns: [{ id: COL_TEXT, name: "Amount", type: "text" as const }],
  rows: [{ id: ROW_1, cells: { [COL_TEXT]: "42" } }],
  baseCommitSha: "a".repeat(40),
};

describe("table drafts", () => {
  it("shares unchanged rows and ignores cell key ordering", () => {
    const original: TableSnapshot = {
      ...snapshot,
      rows: [
        { id: ROW_1, cells: { [COL_TEXT]: "42", [COL_NUMBER]: 3 } },
        { id: ROW_2, cells: {} },
      ],
    };
    const cleared = setDraftCell(
      draftFromSnapshot(original),
      ROW_1,
      COL_TEXT,
      undefined,
    );
    const retyped = setDraftCell(cleared, ROW_1, COL_TEXT, "42");
    expect(retyped.rows[1]).toBe(cleared.rows[1]);
    expect(isDraftDirty(original, retyped)).toBe(false);
    expect(original.rows[0]?.cells[COL_TEXT]).toBe("42");
  });
  it("deep-clones canonical state and detects ordered changes", () => {
    const draft = draftFromSnapshot(snapshot);
    expect(draft).not.toBe(snapshot);
    expect(isDraftDirty(snapshot, draft)).toBe(false);
    expect(isDraftDirty(snapshot, { ...draft, title: "Forecast" })).toBe(true);
  });

  it("adds/removes rows and removes empty sparse cells", () => {
    const added = appendRow(draftFromSnapshot(snapshot), ROW_2);
    const edited = setDraftCell(added, ROW_2, COL_TEXT, "hello");
    expect(edited.rows[1]).toEqual({
      id: ROW_2,
      cells: { [COL_TEXT]: "hello" },
    });
    expect(
      setDraftCell(edited, ROW_2, COL_TEXT, undefined).rows[1]?.cells,
    ).toEqual({});
    expect(
      removeRows(edited, new Set([ROW_1])).rows.map((row) => row.id),
    ).toEqual([ROW_2]);
  });

  it("adds, moves, removes, and atomically retypes columns", () => {
    const withNumber = appendColumn(draftFromSnapshot(snapshot), {
      id: COL_NUMBER,
      name: "Count",
      type: "number",
    });
    expect(moveColumn(withNumber, COL_NUMBER, "left").columns[0]?.id).toBe(
      COL_NUMBER,
    );
    expect(removeColumn(withNumber, COL_TEXT).rows[0]?.cells).toEqual({});

    const converted = retypeDraftColumn(snapshot, COL_TEXT, {
      id: COL_TEXT,
      name: "Amount",
      type: "number",
    });
    expect(converted).toMatchObject({
      ok: true,
      draft: { rows: [{ cells: { [COL_TEXT]: 42 } }] },
    });

    const invalidDraft = setDraftCell(
      snapshot,
      ROW_1,
      COL_TEXT,
      "not-a-number",
    );
    const failed = retypeDraftColumn(invalidDraft, COL_TEXT, {
      id: COL_TEXT,
      name: "Amount",
      type: "number",
    });
    expect(failed).toMatchObject({ ok: false, failures: [ROW_1] });
    if (!failed.ok) expect(failed.draft).toBe(invalidDraft);
  });

  it("treats setting the same array cell content as a no-op and a reorder as dirty", () => {
    const COL_TAGS = "12121212-1212-4121-8121-121212121212";
    const OPTION_A = "34343434-3434-4343-8343-343434343434";
    const OPTION_B = "56565656-5656-4565-8565-565656565656";
    const multiselectSnapshot: TableSnapshot = {
      title: "Tags",
      columns: [
        {
          id: COL_TAGS,
          name: "Tags",
          type: "multiselect" as const,
          options: [
            { id: OPTION_A, label: "A" },
            { id: OPTION_B, label: "B" },
          ],
        },
      ],
      rows: [{ id: ROW_1, cells: { [COL_TAGS]: [OPTION_A, OPTION_B] } }],
      baseCommitSha: "a".repeat(40),
    };
    const draft = draftFromSnapshot(multiselectSnapshot);

    const sameContent = setDraftCell(draft, ROW_1, COL_TAGS, [
      OPTION_A,
      OPTION_B,
    ]);
    expect(sameContent).toBe(draft);
    expect(isDraftDirty(multiselectSnapshot, sameContent)).toBe(false);

    const reordered = setDraftCell(draft, ROW_1, COL_TAGS, [
      OPTION_B,
      OPTION_A,
    ]);
    expect(reordered).not.toBe(draft);
    expect(isDraftDirty(multiselectSnapshot, reordered)).toBe(true);
  });

  it("normalizes a write result to the next base SHA", () => {
    expect(
      snapshotFromWrite({ ...snapshot, headCommitSha: "b".repeat(40) })
        .baseCommitSha,
    ).toBe("b".repeat(40));
  });

  it("copies get results and replaces or moves columns without mutating rows", () => {
    const copied = snapshotFromGet(snapshot);
    copied.columns[0]!.name = "Changed";
    copied.rows[0]!.cells[COL_TEXT] = "changed";
    expect(snapshot).toMatchObject({
      columns: [{ name: "Amount" }],
      rows: [{ cells: { [COL_TEXT]: "42" } }],
    });

    const withNumber = appendColumn(draftFromSnapshot(snapshot), {
      id: COL_NUMBER,
      name: "Count",
      type: "number",
    });
    const replaced = replaceColumn(withNumber, {
      id: COL_NUMBER,
      name: "Total",
      type: "number",
    });
    expect(replaced.columns[1]).toMatchObject({ name: "Total" });
    expect(
      moveColumn(replaced, COL_TEXT, "right").columns.map(({ id }) => id),
    ).toEqual([COL_NUMBER, COL_TEXT]);
  });

  it("does not append a duplicate column id", () => {
    const draft = draftFromSnapshot(snapshot);
    const result = appendColumn(draft, {
      id: COL_TEXT,
      name: "Duplicate",
      type: "number",
    });

    expect(result.columns).toEqual(snapshot.columns);
  });

  it("keeps boundary columns in place", () => {
    const draft = appendColumn(draftFromSnapshot(snapshot), {
      id: COL_NUMBER,
      name: "Count",
      type: "number",
    });

    expect(moveColumn(draft, COL_TEXT, "left")).toEqual(draft);
    expect(moveColumn(draft, COL_NUMBER, "right")).toEqual(draft);
  });

  it("removes a deleted column cell from every row", () => {
    const draft = {
      ...draftFromSnapshot(snapshot),
      rows: [
        snapshot.rows[0]!,
        { id: ROW_2, cells: { [COL_TEXT]: "84", [COL_NUMBER]: 2 } },
      ],
    };

    expect(removeColumn(draft, COL_TEXT).rows).toEqual([
      { id: ROW_1, cells: {} },
      { id: ROW_2, cells: { [COL_NUMBER]: 2 } },
    ]);
  });

  it("reports rows invalidated by removed select options before replacement", () => {
    const selectColumn = {
      id: COL_SELECT,
      name: "Status",
      type: "select" as const,
      options: [
        { id: OPTION_ONE, label: "One" },
        { id: OPTION_TWO, label: "Two" },
      ],
    };
    const draft = {
      title: "Statuses",
      columns: [selectColumn],
      rows: [
        { id: ROW_1, cells: { [COL_SELECT]: OPTION_ONE } },
        { id: ROW_2, cells: { [COL_SELECT]: OPTION_TWO } },
      ],
    };
    const nextColumn = {
      ...selectColumn,
      options: [{ id: OPTION_ONE, label: "Renamed one" }],
    };

    expect(rowsInvalidForColumn(draft, nextColumn)).toEqual([ROW_2]);
    expect(replaceColumn(draft, nextColumn).rows[0]?.cells[COL_SELECT]).toBe(
      OPTION_ONE,
    );
  });

  it("returns the exact draft when retyping any populated row fails", () => {
    const draft = setDraftCell(snapshot, ROW_1, COL_TEXT, "not-a-number");
    const result = retypeDraftColumn(draft, COL_TEXT, {
      id: COL_TEXT,
      name: "Amount",
      type: "number",
    });

    expect(result.ok).toBe(false);
    expect(result.draft).toBe(draft);
  });

  it("rejects retyping to a different column id without changing the draft", () => {
    const draft = draftFromSnapshot(snapshot);
    const result = retypeDraftColumn(draft, COL_TEXT, {
      id: COL_SELECT,
      name: "Amount",
      type: "number",
    });

    expect(result).toEqual({ ok: false, failures: [], draft });
    expect(result.draft).toBe(draft);
    expect(draft).toEqual(draftFromSnapshot(snapshot));
  });

  it("rejects retyping to another existing column id", () => {
    const draft = appendColumn(draftFromSnapshot(snapshot), {
      id: COL_NUMBER,
      name: "Count",
      type: "number",
    });
    const result = retypeDraftColumn(draft, COL_TEXT, {
      id: COL_NUMBER,
      name: "Amount",
      type: "number",
    });

    expect(result).toEqual({ ok: false, failures: [], draft });
    expect(result.draft).toBe(draft);
    expect(draft.columns.map((column) => column.id)).toEqual([
      COL_TEXT,
      COL_NUMBER,
    ]);
    expect(draft.rows[0]?.cells).toEqual({ [COL_TEXT]: "42" });
  });

  it("keeps the saved snapshot intact when retyping a value-preserving column", () => {
    const saved: TableSnapshot = {
      ...snapshot,
      columns: [{ id: COL_TEXT, name: "Amount", type: "text" }],
      rows: [{ id: ROW_1, cells: {} }],
    };
    const result = retypeDraftColumn(draftFromSnapshot(saved), COL_TEXT, {
      id: COL_TEXT,
      name: "Amount",
      type: "number",
    });

    expect(result.ok).toBe(true);
    expect(saved.columns[0]?.type).toBe("text");
    expect(result.draft.columns).not.toBe(saved.columns);
    expect(isDraftDirty(saved, result.draft)).toBe(true);
  });
});

describe("table editor canonical adoption", () => {
  const currentBaseCommitSha = "a".repeat(40);
  const differentBaseCommitSha = "b".repeat(40);
  const laterBaseCommitSha = "c".repeat(40);

  it.each([
    {
      name: "adopts a different clean snapshot when interactions are closed",
      dirty: false,
      interactionOpen: false,
      incomingBaseCommitSha: differentBaseCommitSha,
      expected: false,
    },
    {
      name: "preserves a clean snapshot while an interaction is open",
      dirty: false,
      interactionOpen: true,
      incomingBaseCommitSha: differentBaseCommitSha,
      expected: true,
    },
    {
      name: "preserves a dirty snapshot",
      dirty: true,
      interactionOpen: false,
      incomingBaseCommitSha: differentBaseCommitSha,
      expected: true,
    },
    {
      name: "preserves a clean snapshot at the same SHA",
      dirty: false,
      interactionOpen: false,
      incomingBaseCommitSha: currentBaseCommitSha,
      expected: true,
    },
    {
      name: "preserves an accepted save while the exact pre-save cache remains",
      dirty: false,
      interactionOpen: false,
      currentBaseCommitSha: differentBaseCommitSha,
      incomingBaseCommitSha: currentBaseCommitSha,
      staleIncomingBaseCommitSha: currentBaseCommitSha,
      expected: true,
    },
    {
      name: "adopts a later canonical snapshot after an accepted save",
      dirty: false,
      interactionOpen: false,
      currentBaseCommitSha: differentBaseCommitSha,
      incomingBaseCommitSha: laterBaseCommitSha,
      staleIncomingBaseCommitSha: currentBaseCommitSha,
      expected: false,
    },
  ])("$name", (testCase) => {
    const { dirty, interactionOpen, incomingBaseCommitSha, expected } =
      testCase;
    expect(
      shouldPreserveTableEditorState({
        dirty,
        interactionOpen,
        currentBaseCommitSha:
          "currentBaseCommitSha" in testCase &&
          typeof testCase.currentBaseCommitSha === "string"
            ? testCase.currentBaseCommitSha
            : currentBaseCommitSha,
        incomingBaseCommitSha,
        staleIncomingBaseCommitSha:
          "staleIncomingBaseCommitSha" in testCase
            ? testCase.staleIncomingBaseCommitSha
            : undefined,
      }),
    ).toBe(expected);
  });

  it("rejects the exact pre-save cache after a failed refresh and a dialog round trip", async () => {
    const accepted = acceptedTableWriteState(
      {
        title: "Accepted title",
        columns: snapshot.columns,
        rows: snapshot.rows,
        headCommitSha: differentBaseCommitSha,
      },
      currentBaseCommitSha,
    );

    await expect(
      refreshAfterAcceptedTableWrite(() =>
        Promise.reject(new Error("refresh failed")),
      ),
    ).resolves.toBe("failed");
    const afterDialogClosed = pinTableEditorState({
      tableId: "table-1",
      ...accepted,
    });

    expect(afterDialogClosed.staleIncomingBaseCommitSha).toBe(
      currentBaseCommitSha,
    );
    expect(
      shouldPreserveTableEditorState({
        dirty: false,
        interactionOpen: false,
        currentBaseCommitSha: afterDialogClosed.snapshot.baseCommitSha,
        incomingBaseCommitSha: currentBaseCommitSha,
        staleIncomingBaseCommitSha:
          afterDialogClosed.staleIncomingBaseCommitSha,
      }),
    ).toBe(true);
  });
});

describe("table editor updates", () => {
  const twoRowSnapshot = {
    ...snapshot,
    rows: [...snapshot.rows, { id: ROW_2, cells: {} }],
  };

  it("adopts and pins the incoming snapshot when current state is undefined", () => {
    const result = pinLatestTableEditorState({
      current: undefined,
      tableId: "table-1",
      incomingSnapshot: twoRowSnapshot,
      interactionOpen: false,
    });

    expect(result).toMatchObject({
      tableId: "table-1",
      snapshot: twoRowSnapshot,
      draft: {
        title: twoRowSnapshot.title,
        columns: twoRowSnapshot.columns,
        rows: twoRowSnapshot.rows,
      },
    });
    expect(result?.draft).not.toBe(twoRowSnapshot);
  });

  it("adopts and pins a newer incoming snapshot over a clean stale mirror", () => {
    const current: TableEditorState = {
      tableId: "table-1",
      snapshot: twoRowSnapshot,
      draft: draftFromSnapshot(twoRowSnapshot),
    };
    const incomingSnapshot = {
      ...twoRowSnapshot,
      title: "Current budget",
      baseCommitSha: "b".repeat(40),
    };

    const result = pinLatestTableEditorState({
      current,
      tableId: "table-1",
      incomingSnapshot,
      interactionOpen: false,
    });

    expect(result).not.toBe(current);
    expect(result?.snapshot).toBe(incomingSnapshot);
    expect(result?.draft.title).toBe("Current budget");
  });

  it("pins a dirty same-table mirror instead of adopting a newer snapshot", () => {
    const dirtyDraft = setDraftCell(
      draftFromSnapshot(twoRowSnapshot),
      ROW_1,
      COL_TEXT,
      "local edit",
    );
    const current: TableEditorState = {
      tableId: "table-1",
      snapshot: twoRowSnapshot,
      draft: dirtyDraft,
    };
    const incomingSnapshot = {
      ...twoRowSnapshot,
      title: "Current budget",
      baseCommitSha: "b".repeat(40),
    };

    const result = pinLatestTableEditorState({
      current,
      tableId: "table-1",
      incomingSnapshot,
      interactionOpen: false,
    });

    expect(result).not.toBe(current);
    expect(result?.snapshot).toBe(twoRowSnapshot);
    expect(result?.draft).toBe(dirtyDraft);
    expect(result?.draft.rows[0]?.cells[COL_TEXT]).toBe("local edit");
  });

  it("composes two cell updates on the latest editor state before a render", () => {
    let current: TableEditorState | undefined;
    current = applyTableEditorUpdate({
      current,
      tableId: "table-1",
      incomingSnapshot: twoRowSnapshot,
      interactionOpen: false,
      update: (draft) => setDraftCell(draft, ROW_1, COL_TEXT, "first"),
    });
    current = applyTableEditorUpdate({
      current,
      tableId: "table-1",
      incomingSnapshot: twoRowSnapshot,
      interactionOpen: false,
      update: (draft) => setDraftCell(draft, ROW_2, COL_TEXT, "second"),
    });

    expect(current?.draft.rows[0]?.cells[COL_TEXT]).toBe("first");
    expect(current?.draft.rows[1]?.cells[COL_TEXT]).toBe("second");
  });

  it("does not replace a dirty current draft with a clean incoming snapshot", () => {
    const dirty = applyTableEditorUpdate({
      current: undefined,
      tableId: "table-1",
      incomingSnapshot: twoRowSnapshot,
      interactionOpen: false,
      update: (draft) => setDraftCell(draft, ROW_1, COL_TEXT, "local"),
    });
    const refreshed = { ...twoRowSnapshot, title: "Background title" };

    const result = applyTableEditorUpdate({
      current: dirty,
      tableId: "table-1",
      incomingSnapshot: refreshed,
      interactionOpen: false,
      update: (draft) => setDraftCell(draft, ROW_2, COL_TEXT, "next"),
    });

    expect(result?.draft.title).toBe(snapshot.title);
    expect(result?.draft.rows[0]?.cells[COL_TEXT]).toBe("local");
    expect(result?.draft.rows[1]?.cells[COL_TEXT]).toBe("next");
  });
});

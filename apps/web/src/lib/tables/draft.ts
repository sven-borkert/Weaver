import {
  cellValuesEqual,
  isValidCellValue,
  retypeColumn,
} from "@weaver/core/tables/cellValues";
import type {
  CellValue,
  TableColumn,
  TableData,
  TableRow,
} from "@weaver/core/tables/types";

export type TableSnapshot = TableData & { baseCommitSha: string };
export type TableDraft = TableData;
export type TableEditorState = {
  tableId: string;
  snapshot: TableSnapshot;
  draft: TableDraft;
  staleIncomingBaseCommitSha?: string;
};

export type ApplyTableEditorUpdateInput = {
  current: TableEditorState | undefined;
  tableId: string;
  incomingSnapshot: TableSnapshot | undefined;
  interactionOpen: boolean;
  update: (draft: TableDraft) => TableDraft;
};

function copyColumn(column: TableColumn): TableColumn {
  return {
    ...column,
    ...(column.options
      ? { options: column.options.map((option) => ({ ...option })) }
      : {}),
  };
}

function copyRow(row: TableRow): TableRow {
  return { ...row, cells: { ...row.cells } };
}

function copyTableData({ title, columns, rows }: TableData): TableData {
  return {
    title,
    columns: columns.map(copyColumn),
    rows: rows.map(copyRow),
  };
}

export function snapshotFromGet(input: TableSnapshot): TableSnapshot {
  return { ...copyTableData(input), baseCommitSha: input.baseCommitSha };
}

export function snapshotFromWrite(
  input: TableData & { headCommitSha: string },
): TableSnapshot {
  return { ...copyTableData(input), baseCommitSha: input.headCommitSha };
}

export function draftFromSnapshot(snapshot: TableSnapshot): TableDraft {
  return {
    title: snapshot.title,
    columns: snapshot.columns,
    rows: snapshot.rows,
  };
}

export function isDraftDirty(
  snapshot: TableSnapshot,
  draft: TableDraft,
): boolean {
  if (
    snapshot.title !== draft.title ||
    snapshot.columns.length !== draft.columns.length ||
    snapshot.rows.length !== draft.rows.length
  )
    return true;
  if (
    snapshot.columns !== draft.columns &&
    snapshot.columns.some(
      (column, index) =>
        column !== draft.columns[index] &&
        JSON.stringify(column) !== JSON.stringify(draft.columns[index]),
    )
  )
    return true;
  return (
    snapshot.rows !== draft.rows &&
    snapshot.rows.some((row, index) => {
      const other = draft.rows[index];
      if (row === other) return false;
      return (
        row.id !== other?.id ||
        Object.keys(row.cells).length !== Object.keys(other.cells).length ||
        Object.keys(row.cells).some(
          (key) => !cellValuesEqual(row.cells[key], other.cells[key]),
        )
      );
    })
  );
}

export function pinTableEditorState(state: TableEditorState): TableEditorState {
  return { ...state };
}

export function appendRow(draft: TableDraft, rowId: string): TableDraft {
  const next = { ...draft };
  return { ...next, rows: [...next.rows, { id: rowId, cells: {} }] };
}

export function removeRows(
  draft: TableDraft,
  rowIds: ReadonlySet<string>,
): TableDraft {
  const next = { ...draft };
  return { ...next, rows: next.rows.filter((row) => !rowIds.has(row.id)) };
}

export function setDraftCell(
  draft: TableDraft,
  rowId: string,
  columnId: string,
  value: CellValue | undefined,
): TableDraft {
  const index = draft.rows.findIndex((entry) => entry.id === rowId);
  const current = draft.rows[index];
  if (!current || cellValuesEqual(current.cells[columnId], value)) return draft;
  const row = copyRow(current);
  if (value === undefined) delete row.cells[columnId];
  else row.cells[columnId] = value;
  const rows = [...draft.rows];
  rows[index] = row;
  return { ...draft, rows };
}

export function appendColumn(
  draft: TableDraft,
  column: TableColumn,
): TableDraft {
  const next = { ...draft };
  if (next.columns.some((entry) => entry.id === column.id)) return next;
  return { ...next, columns: [...next.columns, copyColumn(column)] };
}

export function replaceColumn(
  draft: TableDraft,
  column: TableColumn,
): TableDraft {
  const next = { ...draft, columns: [...draft.columns] };
  const index = next.columns.findIndex((entry) => entry.id === column.id);
  if (index !== -1) next.columns[index] = copyColumn(column);
  return next;
}

export function moveColumn(
  draft: TableDraft,
  columnId: string,
  direction: "left" | "right",
): TableDraft {
  const next = { ...draft, columns: [...draft.columns] };
  const index = next.columns.findIndex((column) => column.id === columnId);
  const targetIndex = direction === "left" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= next.columns.length)
    return next;

  const [column] = next.columns.splice(index, 1);
  next.columns.splice(targetIndex, 0, column!);
  return next;
}

export function removeColumn(draft: TableDraft, columnId: string): TableDraft {
  const next = { ...draft };
  return {
    ...next,
    columns: next.columns.filter((column) => column.id !== columnId),
    rows: next.rows.map((row) => {
      if (!(columnId in row.cells)) return row;
      const nextRow = copyRow(row);
      delete nextRow.cells[columnId];
      return nextRow;
    }),
  };
}

export function rowsInvalidForColumn(
  draft: TableDraft,
  column: TableColumn,
): string[] {
  return draft.rows.flatMap((row) => {
    const value = row.cells[column.id];
    return value !== undefined && !isValidCellValue(value, column)
      ? [row.id]
      : [];
  });
}

export function shouldPreserveTableEditorState({
  dirty,
  interactionOpen,
  currentBaseCommitSha,
  incomingBaseCommitSha,
  staleIncomingBaseCommitSha,
}: {
  dirty: boolean;
  interactionOpen: boolean;
  currentBaseCommitSha: string;
  incomingBaseCommitSha: string | undefined;
  staleIncomingBaseCommitSha?: string;
}): boolean {
  return (
    dirty ||
    interactionOpen ||
    incomingBaseCommitSha === undefined ||
    currentBaseCommitSha === incomingBaseCommitSha ||
    staleIncomingBaseCommitSha === incomingBaseCommitSha
  );
}

export function applyTableEditorUpdate({
  current,
  tableId,
  incomingSnapshot,
  interactionOpen,
  update,
}: ApplyTableEditorUpdateInput): TableEditorState | undefined {
  const keepCurrent = Boolean(
    current?.tableId === tableId &&
    shouldPreserveTableEditorState({
      dirty: isDraftDirty(current.snapshot, current.draft),
      interactionOpen,
      currentBaseCommitSha: current.snapshot.baseCommitSha,
      incomingBaseCommitSha: incomingSnapshot?.baseCommitSha,
      staleIncomingBaseCommitSha: current.staleIncomingBaseCommitSha,
    }),
  );
  const active =
    current && keepCurrent
      ? current
      : incomingSnapshot
        ? {
            tableId,
            snapshot: incomingSnapshot,
            draft: draftFromSnapshot(incomingSnapshot),
          }
        : undefined;
  return active ? { ...active, draft: update(active.draft) } : current;
}

export function pinLatestTableEditorState(
  input: Omit<ApplyTableEditorUpdateInput, "update">,
): TableEditorState | undefined {
  const latest = applyTableEditorUpdate({
    ...input,
    update: (draft) => draft,
  });
  return latest ? pinTableEditorState(latest) : latest;
}

export function retypeDraftColumn(
  draft: TableDraft,
  columnId: string,
  nextColumn: TableColumn,
):
  | { ok: true; draft: TableDraft }
  | { ok: false; failures: string[]; draft: TableDraft } {
  if (nextColumn.id !== columnId) return { ok: false, failures: [], draft };
  const currentColumn = draft.columns.find((column) => column.id === columnId);
  if (!currentColumn) return { ok: false, failures: [], draft };

  const result = retypeColumn(draft.rows, currentColumn, nextColumn);
  if (!result.ok) return { ok: false, failures: result.failures, draft };

  const next = { ...draft, columns: [...draft.columns] };
  const columnIndex = next.columns.findIndex(
    (column) => column.id === columnId,
  );
  next.columns[columnIndex] = copyColumn(nextColumn);
  next.rows = result.rows.map(copyRow);
  return { ok: true, draft: next };
}

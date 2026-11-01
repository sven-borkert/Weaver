import { cellValuesEqual, validateRows } from "./cellValues";
import type { CellValue, TableColumn, TableData, TableRow } from "./types";

export type MergeConflict =
  | { kind: "row"; rowId: string }
  | { kind: "cell"; rowId: string; columnId: string }
  | { kind: "column"; columnId: string }
  | { kind: "title" };

export type MergeResult =
  { ok: true; merged: TableData } | { ok: false; conflicts: MergeConflict[] };

function columnsEqual(a: TableColumn, b: TableColumn): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null)
  );
}

function cellsEqual(
  a: Record<string, CellValue>,
  b: Record<string, CellValue>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => cellValuesEqual(a[key], b[key]));
}

function mergeOrder<T extends { id: string }>(
  winner: T[],
  loser: T[],
  survivors: ReadonlySet<string>,
  resolve: (id: string) => T,
): T[] {
  const out = winner
    .filter((item) => survivors.has(item.id))
    .map((item) => resolve(item.id));
  const seen = new Set(out.map((item) => item.id));
  for (let i = 0; i < loser.length; i++) {
    const item = loser[i]!;
    if (!survivors.has(item.id) || seen.has(item.id)) continue;
    const next = loser.slice(i + 1).find((candidate) => seen.has(candidate.id));
    const index = next
      ? out.findIndex((candidate) => candidate.id === next.id)
      : out.length;
    out.splice(index, 0, resolve(item.id));
    seen.add(item.id);
  }
  return out;
}

function hasReorderedBaseItems<T extends { id: string }>(
  items: T[],
  baseIds: ReadonlySet<string>,
  baseOrder: string[],
): boolean {
  const surviving = items
    .filter((item) => baseIds.has(item.id))
    .map((item) => item.id);
  const present = new Set(surviving);
  return (
    surviving.join("\0") !==
    baseOrder.filter((id) => present.has(id)).join("\0")
  );
}

function dedupeConflicts(conflicts: MergeConflict[]): MergeConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = JSON.stringify(conflict);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeTables(
  base: TableData,
  theirs: TableData,
  ours: TableData,
): MergeResult {
  const conflicts: MergeConflict[] = [];
  const baseRows = new Map(base.rows.map((entry) => [entry.id, entry]));
  const theirRows = new Map(theirs.rows.map((entry) => [entry.id, entry]));
  const ourRows = new Map(ours.rows.map((entry) => [entry.id, entry]));
  const theirColumnIds = new Set(theirs.columns.map((column) => column.id));
  const ourColumnIds = new Set(ours.columns.map((column) => column.id));
  const theirTouchedColumns = new Set<string>();
  const ourTouchedColumns = new Set<string>();
  const mergedRows = new Map<string, TableRow>();

  for (const rowId of new Set([
    ...baseRows.keys(),
    ...theirRows.keys(),
    ...ourRows.keys(),
  ])) {
    const b = baseRows.get(rowId);
    const t = theirRows.get(rowId);
    const o = ourRows.get(rowId);
    if (!b) {
      if (t && o) {
        if (cellsEqual(t.cells, o.cells)) {
          mergedRows.set(rowId, t);
          for (const columnId of Object.keys(t.cells)) {
            theirTouchedColumns.add(columnId);
            ourTouchedColumns.add(columnId);
          }
        } else conflicts.push({ kind: "row", rowId });
      } else {
        const added = t ?? o;
        if (added) {
          mergedRows.set(rowId, added);
          const touched = t ? theirTouchedColumns : ourTouchedColumns;
          for (const columnId of Object.keys(added.cells))
            touched.add(columnId);
        }
      }
      continue;
    }

    const theirChanged = t !== undefined && !cellsEqual(b.cells, t.cells);
    const ourChanged = o !== undefined && !cellsEqual(b.cells, o.cells);
    const cellIds = new Set([
      ...Object.keys(b.cells),
      ...Object.keys(t?.cells ?? {}),
      ...Object.keys(o?.cells ?? {}),
    ]);
    for (const columnId of cellIds) {
      if (t && !cellValuesEqual(b.cells[columnId], t.cells[columnId]))
        theirTouchedColumns.add(columnId);
      if (o && !cellValuesEqual(b.cells[columnId], o.cells[columnId]))
        ourTouchedColumns.add(columnId);
    }

    if (!t && !o) continue;
    if (!t) {
      if (ourChanged) conflicts.push({ kind: "row", rowId });
      continue;
    }
    if (!o) {
      if (theirChanged) conflicts.push({ kind: "row", rowId });
      continue;
    }
    if (!theirChanged && !ourChanged) {
      mergedRows.set(rowId, b);
      continue;
    }
    if (!theirChanged) {
      mergedRows.set(rowId, o);
      continue;
    }
    if (!ourChanged) {
      mergedRows.set(rowId, t);
      continue;
    }

    const cells: Record<string, CellValue> = { ...b.cells };
    let hasCellConflict = false;
    for (const columnId of cellIds) {
      const baseValue = b.cells[columnId];
      const theirValue = t.cells[columnId];
      const ourValue = o.cells[columnId];
      const theirDiff = !cellValuesEqual(baseValue, theirValue);
      const ourDiff = !cellValuesEqual(baseValue, ourValue);
      if (
        theirDiff &&
        ourDiff &&
        !cellValuesEqual(theirValue, ourValue) &&
        theirColumnIds.has(columnId) &&
        ourColumnIds.has(columnId)
      ) {
        conflicts.push({ kind: "cell", rowId, columnId });
        hasCellConflict = true;
        continue;
      }
      const value = theirDiff ? theirValue : ourDiff ? ourValue : baseValue;
      if (value === undefined) delete cells[columnId];
      else cells[columnId] = value;
    }
    if (!hasCellConflict) mergedRows.set(rowId, { id: rowId, cells });
  }

  const baseColumns = new Map(base.columns.map((entry) => [entry.id, entry]));
  const theirColumns = new Map(
    theirs.columns.map((entry) => [entry.id, entry]),
  );
  const ourColumns = new Map(ours.columns.map((entry) => [entry.id, entry]));
  const mergedColumns = new Map<string, TableColumn>();
  for (const columnId of new Set([
    ...baseColumns.keys(),
    ...theirColumns.keys(),
    ...ourColumns.keys(),
  ])) {
    const b = baseColumns.get(columnId);
    const t = theirColumns.get(columnId);
    const o = ourColumns.get(columnId);
    if (!b) {
      if (t && o && !columnsEqual(t, o)) {
        conflicts.push({ kind: "column", columnId });
      } else {
        const added = t ?? o;
        if (added) mergedColumns.set(columnId, added);
      }
      continue;
    }

    const theirChanged = t !== undefined && !columnsEqual(b, t);
    const ourChanged = o !== undefined && !columnsEqual(b, o);
    if (!t && !o) continue;
    if (!t || !o) {
      const otherChanged = t ? theirChanged : ourChanged;
      const otherTouched = t
        ? theirTouchedColumns.has(columnId)
        : ourTouchedColumns.has(columnId);
      if (otherChanged || otherTouched)
        conflicts.push({ kind: "column", columnId });
      continue;
    }
    if (theirChanged && ourChanged) {
      if (columnsEqual(t, o)) mergedColumns.set(columnId, t);
      else conflicts.push({ kind: "column", columnId });
    } else {
      mergedColumns.set(columnId, theirChanged ? t : ourChanged ? o : b);
    }
  }

  const baseColumnIds = new Set(base.columns.map((column) => column.id));
  const theirsReordered = hasReorderedBaseItems(
    theirs.columns,
    baseColumnIds,
    base.columns.map((column) => column.id),
  );
  const oursReordered = hasReorderedBaseItems(
    ours.columns,
    baseColumnIds,
    base.columns.map((column) => column.id),
  );
  if (
    theirsReordered &&
    oursReordered &&
    theirs.columns
      .filter((c) => ourColumnIds.has(c.id) && baseColumnIds.has(c.id))
      .map((c) => c.id)
      .join() !==
      ours.columns
        .filter((c) => theirColumnIds.has(c.id) && baseColumnIds.has(c.id))
        .map((c) => c.id)
        .join()
  )
    conflicts.push(
      ...base.columns.map((column) => ({
        kind: "column" as const,
        columnId: column.id,
      })),
    );
  const [columnWinner, columnLoser] = theirsReordered
    ? [theirs.columns, ours.columns]
    : oursReordered
      ? [ours.columns, theirs.columns]
      : [theirs.columns, ours.columns];
  const columns = mergeOrder(
    columnWinner,
    columnLoser,
    new Set(mergedColumns.keys()),
    (id) => mergedColumns.get(id)!,
  );

  const baseRowIds = new Set(base.rows.map((row) => row.id));
  const theirsRowsReordered = hasReorderedBaseItems(
    theirs.rows,
    baseRowIds,
    base.rows.map((row) => row.id),
  );
  const oursRowsReordered = hasReorderedBaseItems(
    ours.rows,
    baseRowIds,
    base.rows.map((row) => row.id),
  );
  if (
    theirsRowsReordered &&
    oursRowsReordered &&
    theirs.rows
      .filter((r) => ourRows.has(r.id) && baseRowIds.has(r.id))
      .map((r) => r.id)
      .join() !==
      ours.rows
        .filter((r) => theirRows.has(r.id) && baseRowIds.has(r.id))
        .map((r) => r.id)
        .join()
  )
    conflicts.push(
      ...base.rows.map((row) => ({ kind: "row" as const, rowId: row.id })),
    );
  const [rowWinner, rowLoser] = theirsRowsReordered
    ? [theirs.rows, ours.rows]
    : oursRowsReordered
      ? [ours.rows, theirs.rows]
      : [theirs.rows, ours.rows];
  const rows = mergeOrder(
    rowWinner,
    rowLoser,
    new Set(mergedRows.keys()),
    (id) => mergedRows.get(id)!,
  );

  let title = ours.title;
  if (base.title === theirs.title) title = ours.title;
  else if (base.title === ours.title || theirs.title === ours.title)
    title = theirs.title;
  else conflicts.push({ kind: "title" });

  if (conflicts.length > 0)
    return { ok: false, conflicts: dedupeConflicts(conflicts) };

  const validColumnIds = new Set(columns.map((column) => column.id));
  const scrubbedRows = rows.map((row) => ({
    id: row.id,
    cells: Object.fromEntries(
      Object.entries(row.cells).filter(([columnId]) =>
        validColumnIds.has(columnId),
      ),
    ),
  }));
  const check = validateRows(columns, scrubbedRows);
  if (!check.ok) {
    const invalidColumnIds = new Set(
      check.errors.map((error) => error.columnId).filter(Boolean),
    );
    return {
      ok: false,
      conflicts: [...invalidColumnIds].map((columnId) => ({
        kind: "column",
        columnId,
      })),
    };
  }
  return { ok: true, merged: { title, columns, rows: scrubbedRows } };
}

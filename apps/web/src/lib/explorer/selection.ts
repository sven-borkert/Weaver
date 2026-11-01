import type { ExplorerEntry, ExplorerItem } from "./entries";

export function entryKey(entry: ExplorerEntry<ExplorerItem>): string {
  return entry.kind === "folder"
    ? `folder:${entry.path.join("/")}`
    : `item:${entry.id}`;
}

export function withinFolder(path: string[], folder: string[]): boolean {
  return folder.every((segment, index) => path[index] === segment);
}

export function moveRoots<I extends ExplorerItem>(
  entries: ExplorerEntry<I>[],
): ExplorerEntry<I>[] {
  return entries.filter(
    (entry) =>
      !entries.some(
        (parent) =>
          parent !== entry &&
          parent.kind === "folder" &&
          withinFolder(
            entry.kind === "folder" ? entry.path : entry.folderPath,
            parent.path,
          ),
      ),
  );
}

export function canMoveEntries(
  entries: ExplorerEntry<ExplorerItem>[],
  target: string[],
): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) => {
      const source =
        entry.kind === "folder" ? entry.path.slice(0, -1) : entry.folderPath;
      return (
        source.join("/") !== target.join("/") &&
        (entry.kind !== "folder" || !withinFolder(target, entry.path))
      );
    })
  );
}

export type BatchResult = { succeeded: string[]; failed: string[] };

export async function runEntryBatch<I extends ExplorerItem>(
  entries: ExplorerEntry<I>[],
  run: (entry: ExplorerEntry<I>) => Promise<void>,
): Promise<BatchResult> {
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const entry of entries) {
    try {
      await run(entry);
      result.succeeded.push(entryKey(entry));
    } catch {
      result.failed.push(entryKey(entry));
    }
  }
  return result;
}

export type SelectionGesture = "toggle" | "range";

type Modifiers = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** Shift extends from the anchor; Ctrl (Cmd on macOS, where Ctrl-click is the context menu) toggles one entry. */
export function selectionGesture(
  modifiers: Modifiers,
): SelectionGesture | undefined {
  if (modifiers.shiftKey) return "range";
  if (modifiers.ctrlKey || modifiers.metaKey) return "toggle";
  return undefined;
}

export function applySelectionGesture<I extends ExplorerItem>(
  entries: ExplorerEntry<I>[],
  selected: ReadonlySet<string>,
  anchorKey: string | undefined,
  key: string,
  gesture: SelectionGesture,
): Set<string> {
  const next = new Set(selected);
  if (gesture === "toggle") {
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }
  const keys = entries.map(entryKey);
  const to = keys.indexOf(key);
  if (to === -1) return next;
  const from = anchorKey === undefined ? to : keys.indexOf(anchorKey);
  const start = from === -1 ? to : Math.min(from, to);
  const end = from === -1 ? to : Math.max(from, to);
  for (const candidate of keys.slice(start, end + 1)) next.add(candidate);
  return next;
}

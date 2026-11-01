import type { Appearance } from "@weaver/core/appearance/metadata";

/** `id` is null and `email` absent for a document author outside Weaver. */
export type ExplorerEditor = {
  id: string | null;
  name: string;
  email?: string;
} | null;

export type ExplorerItem = {
  id: string;
  title: string;
  path: string;
  lastEditedAt: Date;
  lastEditedBy: ExplorerEditor;
  appearance?: Appearance | null;
};

/** Create/update stamps of a folder; null where its metadata does not record them. */
export type FolderStamps = {
  createdAt: Date | null;
  createdBy: ExplorerEditor;
  updatedAt: Date | null;
  updatedBy: ExplorerEditor;
};

export type ExplorerTree<I extends ExplorerItem> = {
  folders: string[];
  /** Display names keyed by folder path; folders without one show their slug. */
  folderNames?: Record<string, string>;
  folderAppearances?: Record<string, Appearance>;
  /** Stamps keyed by folder path; folders without metadata are absent. */
  folderStamps?: Record<string, FolderStamps>;
  items: I[];
};

export type FolderEntry = Partial<FolderStamps> & {
  kind: "folder";
  name: string;
  path: string[];
  itemCount: number;
  appearance?: Appearance | null;
};

export type ItemEntry<I extends ExplorerItem> = I & {
  kind: "item";
  folderPath: string[];
};

export type ExplorerEntry<I extends ExplorerItem> = FolderEntry | ItemEntry<I>;

export type ExplorerSort = "title" | "lastEditedAt";
export type ExplorerDir = "asc" | "desc";
export type ExplorerView = "list" | "icons";
export type ExplorerIconSize = "standard" | "compact";

export function readExplorerIconSize(
  storage: Pick<Storage, "getItem">,
  key: string,
): ExplorerIconSize {
  try {
    return storage.getItem(`${key}:iconSize`) === "compact"
      ? "compact"
      : "standard";
  } catch {
    return "standard";
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function startsWithPath(path: string[], prefix: string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function toItemEntry<I extends ExplorerItem>(item: I): ItemEntry<I> {
  const segments = segmentsOf(item.path);
  segments.pop();
  return { ...item, kind: "item", folderPath: segments };
}

export function parentFolder(path: string[]): string[] {
  return path.slice(0, -1);
}

/** The folder's display name, else its last slug segment; the root is "". */
export function folderDisplayName(
  folderNames: Record<string, string> | undefined,
  path: string[],
): string {
  if (path.length === 0) return "";
  return folderNames?.[path.join("/")] ?? path.at(-1)!;
}

/** "Guides / Setup" with each segment's display name. */
export function folderPathLabel(
  folderNames: Record<string, string> | undefined,
  path: string[],
): string {
  return path
    .map((_, index) => folderDisplayName(folderNames, path.slice(0, index + 1)))
    .join(" / ");
}

export function folderExists<I extends ExplorerItem>(
  tree: ExplorerTree<I>,
  folderPath: string[],
): boolean {
  if (folderPath.length === 0) return true;
  const key = folderPath.join("/");
  return tree.folders.some(
    (folder) => folder === key || folder.startsWith(`${key}/`),
  );
}

export function listFolderEntries<I extends ExplorerItem>(
  tree: ExplorerTree<I>,
  folderPath: string[],
): { folders: FolderEntry[]; items: ItemEntry<I>[] } {
  const depth = folderPath.length;
  const childNames = new Set<string>();
  for (const folder of tree.folders) {
    const segments = segmentsOf(folder);
    if (segments.length > depth && startsWithPath(segments, folderPath)) {
      childNames.add(segments[depth]!);
    }
  }
  const items: ItemEntry<I>[] = [];
  const counts = new Map<string, number>();
  for (const item of tree.items) {
    const entry = toItemEntry(item);
    if (!startsWithPath(entry.folderPath, folderPath)) continue;
    if (entry.folderPath.length === depth) {
      items.push(entry);
    } else {
      const child = entry.folderPath[depth]!;
      childNames.add(child);
      counts.set(child, (counts.get(child) ?? 0) + 1);
    }
  }
  const folders: FolderEntry[] = [...childNames]
    .map((segment) => {
      const path = [...folderPath, segment];
      return {
        kind: "folder" as const,
        name: folderDisplayName(tree.folderNames, path),
        path,
        itemCount: counts.get(segment) ?? 0,
        appearance: tree.folderAppearances?.[path.join("/")],
        ...tree.folderStamps?.[path.join("/")],
      };
    })
    .sort((a, b) => collator.compare(a.name, b.name));
  return { folders, items: sortEntries(items, "title", "asc") };
}

export function searchFolderEntries<I extends ExplorerItem>(
  tree: ExplorerTree<I>,
  folderPath: string[],
  query: string,
): ItemEntry<I>[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hits = tree.items
    .map(toItemEntry)
    .filter(
      (entry) =>
        startsWithPath(entry.folderPath, folderPath) &&
        entry.title.toLocaleLowerCase().includes(needle),
    );
  return sortEntries(hits, "title", "asc");
}

export function sortEntries<E extends FolderEntry | ItemEntry<ExplorerItem>>(
  entries: E[],
  sort: ExplorerSort,
  dir: ExplorerDir,
): E[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.kind === "folder" && b.kind === "folder")
      return sign * collator.compare(a.name, b.name);
    if (a.kind === "folder") return -1;
    if (b.kind === "folder") return 1;
    if (sort === "lastEditedAt") {
      const delta = a.lastEditedAt.getTime() - b.lastEditedAt.getTime();
      if (delta !== 0) return sign * delta;
    }
    return sign * collator.compare(a.title, b.title);
  });
}

/** Where an Up-button drop moves the dragged item: its own parent folder, not the viewed one. */
export function upDropTarget(
  entries: readonly ExplorerEntry<ExplorerItem>[],
  draggedId: string,
): string[] | undefined {
  const item = entries.find(
    (entry): entry is ItemEntry<ExplorerItem> =>
      entry.kind === "item" && entry.id === draggedId,
  );
  return item ? parentFolder(item.folderPath) : undefined;
}

export function relativeFolderLabel(
  entry: ItemEntry<ExplorerItem>,
  folderPath: string[],
): string {
  const relative = entry.folderPath.slice(folderPath.length);
  return relative.length ? relative.join(" / ") : "—";
}

const FOLDER_SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_FOLDER_DEPTH = 10;

/** The validated folder path from a `?folder=` value; anything malformed is the root. */
export function parseFolderParam(
  value: string | string[] | undefined,
): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  const segments = value.split("/");
  if (segments.length > MAX_FOLDER_DEPTH) return [];
  return segments.every((segment) => FOLDER_SEGMENT_RE.test(segment))
    ? segments
    : [];
}

export function folderHref(base: string, path: string[]): string {
  return path.length
    ? `${base}?folder=${encodeURIComponent(path.join("/"))}`
    : base;
}

/** Drag payload for moving an explorer item (document or table) into a folder. */
export const EXPLORER_ITEM_MIME = "application/x-weaver-explorer-item";

export type DraggedExplorerItem = { kind: "documents" | "tables"; id: string };

export function setDraggedItem(
  dataTransfer: Pick<DataTransfer, "setData"> & { effectAllowed: string },
  item: DraggedExplorerItem,
): void {
  dataTransfer.setData(EXPLORER_ITEM_MIME, JSON.stringify(item));
  dataTransfer.effectAllowed = "move";
}

export type DragDownload = { fileName: string; href: string };

/** Chromium only: dropping the item outside the browser saves it as a file. */
export function setDragDownload(
  dataTransfer: Pick<DataTransfer, "setData"> & { effectAllowed: string },
  download: DragDownload,
  origin: string,
): void {
  // The value is "<mime>:<file name>:<url>", so the name may hold no separator.
  const fileName = download.fileName.replace(/[:/\\]/g, "_");
  dataTransfer.setData(
    "DownloadURL",
    `text/markdown:${fileName}:${new URL(download.href, origin).href}`,
  );
  dataTransfer.effectAllowed =
    dataTransfer.effectAllowed === "move" ? "copyMove" : "copy";
}

export function carriesExplorerItem(
  dataTransfer: Pick<DataTransfer, "types"> | null,
): boolean {
  return Boolean(
    dataTransfer && [...dataTransfer.types].includes(EXPLORER_ITEM_MIME),
  );
}

export function carriesFiles(
  dataTransfer: Pick<DataTransfer, "types"> | null,
): boolean {
  return Boolean(dataTransfer && [...dataTransfer.types].includes("Files"));
}

export function readDraggedItem(
  dataTransfer: Pick<DataTransfer, "getData"> | null,
  kind: DraggedExplorerItem["kind"],
): DraggedExplorerItem | null {
  if (!dataTransfer) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataTransfer.getData(EXPLORER_ITEM_MIME) || "null");
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { kind?: unknown }).kind !== kind ||
    typeof (parsed as { id?: unknown }).id !== "string"
  )
    return null;
  return { kind, id: (parsed as { id: string }).id };
}

export type DraggedEntry =
  { kind: "item"; id: string } | { kind: "folder"; path: string[] };

export function setDraggedEntries(
  transfer: Pick<DataTransfer, "setData"> & { effectAllowed: string },
  kind: DraggedExplorerItem["kind"],
  projectId: string,
  entries: DraggedEntry[],
): void {
  transfer.setData(
    EXPLORER_ITEM_MIME,
    JSON.stringify({ kind, projectId, entries }),
  );
  transfer.effectAllowed = "move";
}

export function readDraggedEntries(
  transfer: Pick<DataTransfer, "getData"> | null,
  kind: DraggedExplorerItem["kind"],
  projectId: string,
): DraggedEntry[] {
  try {
    const value = JSON.parse(
      transfer?.getData(EXPLORER_ITEM_MIME) ?? "null",
    ) as { kind?: unknown; projectId?: unknown; entries?: unknown } | null;
    if (
      value?.kind !== kind ||
      value.projectId !== projectId ||
      !Array.isArray(value.entries) ||
      value.entries.length > 10000
    )
      return [];
    if (
      !value.entries.every((entry: unknown) => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as {
          kind?: unknown;
          id?: unknown;
          path?: unknown;
        };
        return candidate.kind === "item"
          ? typeof candidate.id === "string"
          : candidate.kind === "folder" &&
              Array.isArray(candidate.path) &&
              candidate.path.length > 0 &&
              candidate.path.length <= 10 &&
              candidate.path.every(
                (part) =>
                  typeof part === "string" &&
                  /^[a-z0-9][a-z0-9-]{0,79}$/.test(part),
              );
      })
    )
      return [];
    return value.entries as DraggedEntry[];
  } catch {
    return [];
  }
}

"use client";

import type { AppearanceTarget } from "@weaver/core/appearance/metadata";
import { AppearanceDialog } from "~/components/appearance/AppearanceDialog";
import { AppearanceIcon } from "~/components/appearance/AppearanceIcon";
import { appearanceStyle } from "~/components/appearance/appearance-style";
import { ArrowDown, ArrowUp, Folder } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  folderHref,
  relativeFolderLabel,
  type ExplorerDir,
  type ExplorerEditor,
  type ExplorerEntry,
  type ExplorerItem,
  type ExplorerSort,
  type ExplorerView,
  type ExplorerIconSize,
  type ItemEntry,
} from "~/lib/explorer/entries";
import {
  carriesExplorerItem,
  readDraggedItem,
  setDragDownload,
  setDraggedItem,
  setDraggedEntries,
  readDraggedEntries,
} from "~/lib/explorer/drag";
import { useRovingFocus } from "~/lib/documents/use-roving-focus";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";
import type { ExplorerAdapter } from "./adapter";
import {
  applySelectionGesture,
  canMoveEntries,
  entryKey,
  selectionGesture,
  type SelectionGesture,
} from "~/lib/explorer/selection";

export type ContentExplorerProps<I extends ExplorerItem> = {
  projectId: string;
  folderPath: string[];
  entries: ExplorerEntry<I>[];
  view: ExplorerView;
  iconSize?: ExplorerIconSize;
  searchActive: boolean;
  sort: ExplorerSort;
  dir: ExplorerDir;
  onSortChange: (sort: ExplorerSort, dir: ExplorerDir) => void;
  onNavigateUp: () => void;
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  adapter: ExplorerAdapter<I>;
  /** Present when Editors may drag items onto folders. */
  onMoveItem?: (item: ItemEntry<I>, folderPath: string[]) => void;
  onMoveEntries?: (entries: ExplorerEntry<I>[], folderPath: string[]) => void;
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  busy?: boolean;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function entryHref<I extends ExplorerItem>(
  projectId: string,
  entry: ExplorerEntry<I>,
  adapter: ExplorerAdapter<I>,
): string {
  return entry.kind === "folder"
    ? folderHref(adapter.base(projectId), entry.path)
    : adapter.itemHref(projectId, entry);
}

function editorLabel(editor: ExplorerEditor | undefined): string {
  if (!editor) return "—";
  // A table editor without a display name shows their email.
  return editor.name !== "" ? editor.name : (editor.email ?? "—");
}

export function ContentExplorer<I extends ExplorerItem>(
  props: ContentExplorerProps<I>,
) {
  const {
    projectId,
    entries,
    view,
    iconSize = "standard",
    canEdit,
    folders,
    folderNames,
    folderPath,
    searchActive,
    adapter,
    onMoveItem,
    onMoveEntries,
    selectedKeys = new Set<string>(),
    onSelectionChange,
    busy = false,
  } = props;
  const router = useRouter();
  const mounted = useMounted();
  const [openMenuKey, setOpenMenuKey] = useState<string>();
  const [appearanceTarget, setAppearanceTarget] = useState<AppearanceTarget>();
  if (
    appearanceTarget &&
    (!canEdit || appearanceTarget.projectId !== projectId)
  )
    setAppearanceTarget(undefined);
  const [dropKey, setDropKey] = useState<string>();
  const movable =
    canEdit &&
    !busy &&
    (onMoveItem !== undefined || onMoveEntries !== undefined);
  const selectable = onSelectionChange !== undefined;
  const selected = entries.filter((entry) => selectedKeys.has(entryKey(entry)));
  const [anchorKey, setAnchorKey] = useState<string>();
  const select = (entry: ExplorerEntry<I>, gesture: SelectionGesture) => {
    if (!onSelectionChange || busy) return;
    const key = entryKey(entry);
    onSelectionChange(
      applySelectionGesture(entries, selectedKeys, anchorKey, key, gesture),
    );
    if (gesture === "toggle") setAnchorKey(key);
  };
  // Ctrl/Cmd/Shift-clicks select instead of opening; plain clicks keep navigating.
  const onEntryClick = (entry: ExplorerEntry<I>) => (event: MouseEvent) => {
    const gesture = selectable ? selectionGesture(event) : undefined;
    if (!gesture) return false;
    event.preventDefault();
    event.stopPropagation();
    select(entry, gesture);
    return true;
  };
  const onEntryMouseDown = (event: MouseEvent) => {
    // Shift-click would otherwise extend the browser's text selection across rows.
    if (selectable && event.shiftKey) event.preventDefault();
  };
  const draggedEntries = (event: DragEvent) => {
    const payload = readDraggedEntries(
      event.dataTransfer,
      adapter.kind,
      projectId,
    );
    const keys = new Set(
      payload.map((entry) =>
        entry.kind === "folder"
          ? `folder:${entry.path.join("/")}`
          : `item:${entry.id}`,
      ),
    );
    return entries.filter((entry) => keys.has(entryKey(entry)));
  };

  // Resolve drop identities against this project’s current entries.
  const dragProps = (entry: ExplorerEntry<I>) => {
    if (entry.kind === "folder" && !onMoveEntries) return {};
    const download =
      entry.kind === "item"
        ? adapter.itemDownload?.(projectId, entry)
        : undefined;
    if (!movable && !download) return {};
    return {
      draggable: true,
      onDragEnd: () => setDropKey(undefined),
      onDragStart: (event: DragEvent) => {
        const group =
          movable && selectedKeys.has(entryKey(entry)) ? selected : [entry];
        if (movable && onMoveEntries) {
          setDraggedEntries(
            event.dataTransfer,
            adapter.kind,
            projectId,
            group.map((candidate) =>
              candidate.kind === "folder"
                ? { kind: "folder", path: candidate.path }
                : { kind: "item", id: candidate.id },
            ),
          );
        } else if (movable && entry.kind === "item") {
          setDraggedItem(event.dataTransfer, {
            kind: adapter.kind,
            id: entry.id,
          });
        }
        if (download && group.length === 1)
          setDragDownload(event.dataTransfer, download, window.location.origin);
      },
    };
  };
  const dropProps = (entry: ExplorerEntry<I>) =>
    movable && entry.kind === "folder"
      ? {
          "data-drop-target": dropKey === entryKey(entry) ? "true" : undefined,
          onDragOver: (event: DragEvent) => {
            if (!carriesExplorerItem(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropKey(entryKey(entry));
          },
          onDragLeave: (event: DragEvent) => {
            if (event.currentTarget.contains(event.relatedTarget as Node))
              return;
            setDropKey((key) => (key === entryKey(entry) ? undefined : key));
          },
          onDrop: (event: DragEvent) => {
            const group = draggedEntries(event);
            const dragged = readDraggedItem(event.dataTransfer, adapter.kind);
            if (!group.length && !dragged) return;
            event.preventDefault();
            event.stopPropagation();
            setDropKey(undefined);
            if (group.length && onMoveEntries) {
              if (canMoveEntries(group, entry.path))
                onMoveEntries(group, entry.path);
            } else {
              const item = entries.find(
                (candidate): candidate is ItemEntry<I> =>
                  candidate.kind === "item" && candidate.id === dragged?.id,
              );
              if (item) onMoveItem?.(item, entry.path);
            }
          },
        }
      : {};
  const gridRef = useRef<HTMLUListElement>(null);
  const roving = useRovingFocus({
    count: entries.length,
    columns:
      view === "icons"
        ? () => {
            const el = gridRef.current;
            if (!el) return 1;
            const cols = window
              .getComputedStyle(el)
              .gridTemplateColumns.split(" ")
              .filter(Boolean).length;
            return Math.max(1, cols);
          }
        : 1,
    onActivate: (index) => {
      const entry = entries[index];
      if (entry) router.push(entryHref(projectId, entry, adapter));
    },
    onNavigateUp: props.onNavigateUp,
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const key = (event.target as HTMLElement).dataset?.explorerEntry;
    const entry = entries.find((candidate) => entryKey(candidate) === key);
    if (selectable && entry) {
      if (event.key === " ") {
        event.preventDefault();
        select(entry, event.shiftKey ? "range" : "toggle");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        if (!busy) onSelectionChange(new Set(entries.map(entryKey)));
        return;
      }
      if (event.key === "Escape" && selectedKeys.size > 0) {
        event.preventDefault();
        if (!busy) onSelectionChange(new Set());
        return;
      }
    }
    roving.onKeyDown(event);
  };

  // Viewers get a menu only where the adapter offers a download.
  const hasActions = (entry: ExplorerEntry<I>) =>
    canEdit ||
    (entry.kind === "folder"
      ? adapter.folderDownloadHref !== undefined
      : adapter.itemDownload !== undefined);
  const actions = (entry: ExplorerEntry<I>) =>
    hasActions(entry) ? (
      entry.kind === "folder" ? (
        <adapter.FolderActions
          projectId={projectId}
          path={entry.path}
          folders={folders}
          folderNames={folderNames}
          canEdit={canEdit}
          onAppearance={() =>
            setAppearanceTarget({
              projectId,
              kind: "folder",
              scope: adapter.kind,
              path: entry.path,
            })
          }
          open={openMenuKey === entryKey(entry)}
          onOpenChange={(open) =>
            setOpenMenuKey(open ? entryKey(entry) : undefined)
          }
        />
      ) : (
        <adapter.ItemActions
          projectId={projectId}
          item={entry}
          folderPath={entry.folderPath}
          folders={folders}
          folderNames={folderNames}
          canEdit={canEdit}
          onAppearance={() =>
            setAppearanceTarget({
              projectId,
              kind: adapter.kind === "documents" ? "document" : "table",
              id: entry.id,
            })
          }
          open={openMenuKey === entryKey(entry)}
          onOpenChange={(open) =>
            setOpenMenuKey(open ? entryKey(entry) : undefined)
          }
        />
      )
    ) : null;

  const onContextMenu = (entry: ExplorerEntry<I>) => (event: MouseEvent) => {
    if (!hasActions(entry)) return;
    // Right-clicks inside the row's portaled menu/dialogs bubble here through React; leave them native.
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    setOpenMenuKey(entryKey(entry));
  };

  const sortAriaValue = (
    key: ExplorerSort,
  ): "ascending" | "descending" | undefined =>
    props.sort === key
      ? props.dir === "asc"
        ? "ascending"
        : "descending"
      : undefined;

  const sortButton = (key: ExplorerSort, label: string) => {
    const active = props.sort === key;
    const Icon = props.dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        className="hover:text-text inline-flex items-center gap-1"
        onClick={() =>
          props.onSortChange(
            key,
            active && props.dir === "asc" ? "desc" : "asc",
          )
        }
      >
        {label}
        {active ? <Icon className="size-3.5" aria-hidden="true" /> : null}
      </button>
    );
  };

  if (view === "icons") {
    return (
      <>
        {canEdit && appearanceTarget ? (
          <AppearanceDialog
            target={appearanceTarget}
            open
            onOpenChange={(open) => {
              if (!open) setAppearanceTarget(undefined);
            }}
          />
        ) : null}
        <ul
          ref={gridRef}
          aria-label={adapter.listLabel}
          data-explorer-focus
          tabIndex={-1}
          className={
            iconSize === "compact"
              ? "grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6"
              : "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          }
          onKeyDown={onKeyDown}
        >
          {entries.map((entry, index) => {
            const { ref, ...itemProps } = roving.itemProps(index);
            const formatted =
              entry.kind === "item"
                ? mounted
                  ? dateTimeFormatter.format(entry.lastEditedAt)
                  : "—"
                : undefined;
            return (
              <li
                key={entryKey(entry)}
                data-selected={
                  selectedKeys.has(entryKey(entry)) ? "true" : undefined
                }
                className={cn(
                  "relative rounded-[10px]",
                  selectedKeys.has(entryKey(entry)) && "ring-brand ring-2",
                  dropKey === entryKey(entry) && "ring-brand ring-2",
                )}
                onContextMenu={onContextMenu(entry)}
                onMouseDown={onEntryMouseDown}
                {...dragProps(entry)}
                {...dropProps(entry)}
              >
                <Link
                  {...itemProps}
                  ref={ref}
                  href={entryHref(projectId, entry, adapter)}
                  data-explorer-entry={entryKey(entry)}
                  onClick={onEntryClick(entry)}
                  style={appearanceStyle(entry.appearance ?? null)}
                  className={cn(
                    "border-line bg-surface focus-visible:ring-brand flex h-full flex-col items-center gap-2 rounded-[10px] border text-center outline-none focus-visible:ring-2",
                    entry.appearance?.backgroundColor
                      ? "text-inherit hover:border-current hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                      : "hover:bg-hover",
                    iconSize === "compact" ? "p-2" : "p-4",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex",
                      !entry.appearance?.backgroundColor && "text-text-2",
                    )}
                  >
                    <AppearanceIcon
                      projectId={projectId}
                      appearance={entry.appearance}
                      fallback={
                        entry.kind === "folder"
                          ? Folder
                          : adapter.itemIcon(entry)
                      }
                      size={iconSize === "compact" ? 24 : 40}
                    />
                  </span>
                  <span className="line-clamp-2 text-[13px] font-medium break-words">
                    {entry.kind === "folder" ? entry.name : entry.title}
                  </span>
                  {entry.kind === "item" && adapter.itemBadge ? (
                    <span
                      className={cn(
                        entry.appearance?.backgroundColor &&
                          "bg-surface text-text rounded px-1",
                      )}
                    >
                      {adapter.itemBadge(entry)}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "text-[12px]",
                      !entry.appearance?.backgroundColor && "text-text-3",
                    )}
                  >
                    {entry.kind === "folder"
                      ? `${entry.itemCount} ${
                          entry.itemCount === 1
                            ? adapter.itemNoun[0]
                            : adapter.itemNoun[1]
                        }`
                      : adapter.tileMeta
                        ? adapter.tileMeta(entry, formatted ?? "—")
                        : formatted}
                  </span>
                </Link>
                <div
                  className={cn(
                    "absolute top-1 right-1",
                    entry.appearance?.backgroundColor &&
                      "bg-surface text-text rounded",
                  )}
                >
                  {actions(entry)}
                </div>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <>
      {canEdit && appearanceTarget ? (
        <AppearanceDialog
          target={appearanceTarget}
          open
          onOpenChange={(open) => {
            if (!open) setAppearanceTarget(undefined);
          }}
        />
      ) : null}
      <div
        data-explorer-focus
        tabIndex={-1}
        className="border-line bg-surface overflow-hidden rounded-[10px] border"
        onKeyDown={onKeyDown}
      >
        <Table aria-label={adapter.listLabel}>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={sortAriaValue("title")}>
                {sortButton("title", "Name")}
              </TableHead>
              {searchActive ? <TableHead>Folder</TableHead> : null}
              {adapter.columns?.map((column) => (
                <TableHead key={column.key} className={column.className}>
                  {column.header}
                </TableHead>
              ))}
              <TableHead aria-sort={sortAriaValue("lastEditedAt")}>
                {sortButton(
                  "lastEditedAt",
                  adapter.editedHeaders?.at ?? "Last edited",
                )}
              </TableHead>
              <TableHead>{adapter.editedHeaders?.by ?? "By"}</TableHead>
              <TableHead className="w-12 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => {
              const { ref, ...itemProps } = roving.itemProps(index);
              return (
                <TableRow
                  style={appearanceStyle(entry.appearance ?? null)}
                  key={entryKey(entry)}
                  className={cn(
                    "cursor-pointer",
                    selectedKeys.has(entryKey(entry)) &&
                      "bg-brand-bg outline-brand outline-2 -outline-offset-2",
                    entry.appearance?.backgroundColor &&
                      "hover:shadow-[inset_0_0_0_1px_currentColor] [&_a]:text-inherit [&_td]:text-inherit",
                    dropKey === entryKey(entry) && "bg-brand-bg",
                    dropKey === entryKey(entry) &&
                      entry.appearance?.backgroundColor &&
                      "outline-2 -outline-offset-2 outline-current",
                  )}
                  data-selected={
                    selectedKeys.has(entryKey(entry)) ? "true" : undefined
                  }
                  onContextMenu={onContextMenu(entry)}
                  onMouseDown={onEntryMouseDown}
                  {...dragProps(entry)}
                  {...dropProps(entry)}
                  onClick={(event) => {
                    if (
                      (event.target as Element).closest(
                        "a,button,input,label,[role=menu]",
                      )
                    )
                      return;
                    if (onEntryClick(entry)(event)) return;
                    router.push(entryHref(projectId, entry, adapter));
                  }}
                >
                  <TableCell className="w-full max-w-0 truncate font-medium">
                    <Link
                      {...itemProps}
                      ref={ref}
                      href={entryHref(projectId, entry, adapter)}
                      data-explorer-entry={entryKey(entry)}
                      onClick={onEntryClick(entry)}
                      className={cn(
                        "inline-flex items-center gap-2 outline-none focus-visible:underline",
                        entry.appearance?.backgroundColor
                          ? "text-inherit hover:underline"
                          : "text-text hover:text-brand-text",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex shrink-0",
                          !entry.appearance?.backgroundColor && "text-text-2",
                        )}
                      >
                        <AppearanceIcon
                          projectId={projectId}
                          appearance={entry.appearance}
                          fallback={
                            entry.kind === "folder"
                              ? Folder
                              : adapter.itemIcon(entry)
                          }
                          size={16}
                        />
                      </span>
                      <span className="truncate">
                        {entry.kind === "folder" ? entry.name : entry.title}
                      </span>
                      {entry.kind === "item" && adapter.itemBadge ? (
                        <span
                          className={cn(
                            "ml-1 inline-flex shrink-0",
                            entry.appearance?.backgroundColor &&
                              "bg-surface text-text rounded px-1",
                          )}
                        >
                          {adapter.itemBadge(entry)}
                        </span>
                      ) : null}
                    </Link>
                  </TableCell>
                  {searchActive ? (
                    <TableCell className="text-text-2 max-w-48 truncate">
                      {entry.kind === "item"
                        ? relativeFolderLabel(entry, folderPath)
                        : "—"}
                    </TableCell>
                  ) : null}
                  {adapter.columns?.map((column) => (
                    <TableCell key={column.key} className={column.className}>
                      {entry.kind === "item"
                        ? column.cell(entry)
                        : (column.folderCell?.(entry) ?? "—")}
                    </TableCell>
                  ))}
                  <TableCell className="text-text-2 whitespace-nowrap">
                    {entry.kind === "item"
                      ? mounted
                        ? dateTimeFormatter.format(entry.lastEditedAt)
                        : "—"
                      : mounted && entry.updatedAt
                        ? dateTimeFormatter.format(entry.updatedAt)
                        : "—"}
                  </TableCell>
                  <TableCell className="text-text-2 max-w-48 truncate">
                    {entry.kind === "item"
                      ? editorLabel(entry.lastEditedBy)
                      : editorLabel(entry.updatedBy)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div
                      className={cn(
                        "flex justify-end",
                        entry.appearance?.backgroundColor &&
                          "bg-surface text-text rounded",
                      )}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {actions(entry)}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

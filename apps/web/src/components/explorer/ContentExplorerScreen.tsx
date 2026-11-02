"use client";

import { ArrowUp, LayoutGrid, List } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { projectRoleAtLeast } from "@weaver/core/roles";
import {
  carriesExplorerItem,
  carriesFiles,
  readDraggedItem,
  readDraggedEntries,
} from "~/lib/explorer/drag";
import {
  folderDisplayName,
  folderExists,
  folderHref,
  listFolderEntries,
  parentFolder,
  searchFolderEntries,
  sortEntries,
  upDropTarget,
  type ExplorerDir,
  type ExplorerItem,
  type ExplorerEntry,
  type ExplorerSort,
  type ExplorerView,
  type ExplorerIconSize,
  readExplorerIconSize,
} from "~/lib/explorer/entries";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import {
  WorkspaceEmpty,
  WorkspaceError,
  WorkspaceLoading,
  WorkspaceNotFound,
} from "~/app/(workspace)/projects/[projectId]/documents/_components/DocumentStates";
import { DocumentsWorkspace } from "~/app/(workspace)/projects/[projectId]/documents/_components/DocumentsWorkspace";
import type { ExplorerAdapter, ExplorerFilter } from "./adapter";
import { ContentExplorer } from "./ContentExplorer";
import { toast } from "sonner";
import { ExplorerBulkActions } from "./ExplorerBulkActions";
import type { BulkAction } from "./useExplorerOperations";
import {
  canMoveEntries,
  entryKey,
  moveRoots,
  runEntryBatch,
  withinFolder,
} from "~/lib/explorer/selection";
import { FolderDownloadButton } from "./FolderDownloadButton";

const ALL_VALUES = "__all__";

function filterValues<I extends ExplorerItem>(
  filter: ExplorerFilter<I>,
  items: I[],
): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const item of items) {
    const value = filter.value(item)?.trim();
    if (value && !seen.has(value.toLowerCase()))
      seen.set(value.toLowerCase(), value);
  }
  return [...seen]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function readStoredView(key: string): ExplorerView {
  try {
    return window.localStorage.getItem(key) === "icons" ? "icons" : "list";
  } catch {
    return "list";
  }
}

export function ContentExplorerScreen<I extends ExplorerItem>({
  projectId,
  folderPath,
  adapter,
}: {
  projectId: string;
  folderPath: string[];
  adapter: ExplorerAdapter<I>;
}) {
  const router = useRouter();
  const [view, setView] = useState<ExplorerView>("list");
  const [iconSize, setIconSize] = useState<ExplorerIconSize>("standard");
  const [search, setSearch] = useState("");
  const [valueFilter, setValueFilter] = useState(ALL_VALUES);
  const [sort, setSort] = useState<ExplorerSort>("title");
  const [dir, setDir] = useState<ExplorerDir>("asc");
  const [dragging, setDragging] = useState(false);
  const [itemDragging, setItemDragging] = useState(false);
  const [upDropActive, setUpDropActive] = useState(false);
  const projectQuery = api.project.get.useQuery(
    { projectId },
    { enabled: projectId.length > 0 },
  );
  const canEdit = projectQuery.data
    ? projectRoleAtLeast(projectQuery.data.myRole, "Editor")
    : false;
  const importer = adapter.useImport(projectId, folderPath, canEdit);
  const moveItem = adapter.useMove(projectId);
  const operations = adapter.useOperations?.(projectId);
  const canSelect = Boolean(
    operations && (canEdit || adapter.kind === "documents"),
  );
  const selectionScope = JSON.stringify([
    projectId,
    adapter.kind,
    folderPath,
    search,
    valueFilter,
    canEdit,
  ]);
  const [selection, setSelection] = useState<{
    scope: string;
    keys: Set<string>;
  }>({ scope: selectionScope, keys: new Set() });
  if (selection.scope !== selectionScope)
    setSelection({ scope: selectionScope, keys: new Set() });
  const selectedKeys =
    selection.scope === selectionScope ? selection.keys : new Set<string>();
  const batchLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const treeQuery = adapter.useTree(projectId, Boolean(projectQuery.data));

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setView(readStoredView(adapter.viewStorageKey));
      try {
        setIconSize(
          readExplorerIconSize(window.localStorage, adapter.viewStorageKey),
        );
      } catch {
        setIconSize("standard");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [adapter.viewStorageKey]);

  const changeView = (next: ExplorerView) => {
    setView(next);
    try {
      window.localStorage.setItem(adapter.viewStorageKey, next);
    } catch {
      // The toggle still works without persistence.
    }
  };

  const changeIconSize = (next: ExplorerIconSize) => {
    setIconSize(next);
    try {
      window.localStorage.setItem(`${adapter.viewStorageKey}:iconSize`, next);
    } catch {
      /* The control works without persistence. */
    }
  };

  const navigateTo = (path: string[]) =>
    router.push(folderHref(adapter.base(projectId), path));
  const navigateUp = () => {
    if (folderPath.length) navigateTo(parentFolder(folderPath));
  };
  const onMoveItem = (
    item: ExplorerItem & { folderPath: string[] },
    path: string[],
  ) => {
    if (item.folderPath.join("/") === path.join("/")) return;
    void moveItem(item.id, path);
  };

  const upTarget = itemDragging && canEdit && folderPath.length > 0;

  const tree = treeQuery.data;
  const filterOptions = useMemo(
    () =>
      adapter.filter && tree ? filterValues(adapter.filter, tree.items) : [],
    [adapter.filter, tree],
  );
  const activeFilter =
    adapter.filter && valueFilter !== ALL_VALUES ? valueFilter : null;
  const searchActive = search.trim().length > 0 || activeFilter !== null;
  const { folders, items } = useMemo(
    () =>
      tree ? listFolderEntries(tree, folderPath) : { folders: [], items: [] },
    [tree, folderPath],
  );
  const entries = useMemo(() => {
    if (!tree) return [];
    if (searchActive) {
      const filter = adapter.filter;
      const matches =
        filter && activeFilter !== null
          ? (item: I) => filter.value(item)?.toLowerCase() === activeFilter
          : undefined;
      return sortEntries(
        searchFolderEntries(tree, folderPath, search, matches),
        sort,
        dir,
      );
    }
    return sortEntries([...folders, ...items], sort, dir);
  }, [
    tree,
    folders,
    items,
    searchActive,
    search,
    activeFilter,
    adapter.filter,
    folderPath,
    sort,
    dir,
  ]);

  const shownAdapter = useMemo(
    () =>
      adapter.columns && tree
        ? {
            ...adapter,
            columns: adapter.columns.filter(
              (column) => !column.visible || column.visible(tree.items),
            ),
          }
        : adapter,
    [adapter, tree],
  );

  const selectedEntries = entries.filter((entry) =>
    selectedKeys.has(entryKey(entry)),
  );
  const runSelection = async (
    action: BulkAction,
    input: ExplorerEntry<ExplorerItem>[],
    target: string[],
    revisions: Record<string, string>,
    moveUp = false,
  ) => {
    if (!operations || (!canEdit && action !== "review") || batchLock.current)
      return;
    const roots = action === "move" ? moveRoots(input) : [...input];
    const destination = (entry: ExplorerEntry<ExplorerItem>) =>
      moveUp
        ? parentFolder(
            entry.kind === "folder"
              ? parentFolder(entry.path)
              : entry.folderPath,
          )
        : target;
    if (
      action === "move" &&
      !roots.every((entry) => canMoveEntries([entry], destination(entry)))
    )
      return;
    if (action === "delete")
      roots.sort((a, b) =>
        a.kind === "item"
          ? b.kind === "item"
            ? 0
            : -1
          : b.kind === "item"
            ? 1
            : b.path.length - a.path.length,
      );
    batchLock.current = true;
    setBusy(true);
    setProgress({ done: 0, total: roots.length });
    const scope = selectionScope;
    try {
      const result = await runEntryBatch(roots, async (entry) => {
        try {
          await operations.run(action, entry, destination(entry), revisions);
        } finally {
          setProgress((current) =>
            current ? { ...current, done: current.done + 1 } : current,
          );
        }
      });
      const succeeded = new Set(result.succeeded);
      if (action === "move") {
        for (const entry of input) {
          if (
            roots.some(
              (root) =>
                root.kind === "folder" &&
                succeeded.has(entryKey(root)) &&
                withinFolder(
                  entry.kind === "folder" ? entry.path : entry.folderPath,
                  root.path,
                ),
            )
          )
            succeeded.add(entryKey(entry));
        }
      }
      setSelection((current) =>
        current.scope === scope
          ? {
              ...current,
              keys: new Set(
                [...current.keys, ...result.failed].filter(
                  (key) => !succeeded.has(key),
                ),
              ),
            }
          : current,
      );
      if (result.succeeded.length)
        toast.success(
          `${result.succeeded.length} objects ${action === "move" ? "moved" : action === "delete" ? "deleted" : "marked as reviewed"}`,
        );
      if (result.failed.length)
        toast.error(
          `${result.failed.length} objects could not be ${action === "move" ? "moved" : action === "delete" ? "deleted (folders must be empty)" : "marked as reviewed"}. Failed objects remain selected for retry.`,
        );
      try {
        await operations.refresh();
      } catch {
        toast.error(
          "Changes were saved, but refresh failed. Reload the page before continuing.",
        );
      }
    } finally {
      batchLock.current = false;
      setBusy(false);
      setProgress(undefined);
    }
  };
  const onMoveEntries = operations
    ? (input: ExplorerEntry<I>[], target: string[]) => {
        void runSelection("move", input, target, {});
      }
    : undefined;
  const droppedEntries = (event: DragEvent) => {
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
  const upDropProps =
    canEdit && !busy && folderPath.length
      ? {
          onDragOver: (event: DragEvent) => {
            if (!carriesExplorerItem(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setUpDropActive(true);
          },
          onDragLeave: (event: DragEvent) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setUpDropActive(false);
          },
          onDrop: (event: DragEvent) => {
            const group = droppedEntries(event);
            const dragged = readDraggedItem(event.dataTransfer, adapter.kind);
            if (!group.length && !dragged) return;
            event.preventDefault();
            event.stopPropagation();
            setUpDropActive(false);
            setItemDragging(false);
            if (group.length && onMoveEntries) {
              void runSelection(
                "move",
                group,
                parentFolder(folderPath),
                {},
                true,
              );
            } else if (dragged) {
              const target = upDropTarget(entries, dragged.id);
              if (target) void moveItem(dragged.id, target);
            }
          },
        }
      : {};

  const sortPrefix = adapter.searchInputId.replace(/-search$/, "");

  if (projectQuery.isLoading) return <WorkspaceLoading />;
  if (projectQuery.error) {
    return projectQuery.error.data?.code === "NOT_FOUND" ? (
      <WorkspaceNotFound />
    ) : (
      <WorkspaceError
        title="Could not load project"
        description="Refresh the page to try loading this project again."
      />
    );
  }
  if (!projectQuery.data) return <WorkspaceNotFound />;

  const project = projectQuery.data;
  const folderName =
    folderDisplayName(tree?.folderNames, folderPath) || project.name;

  let body: React.ReactNode;
  if (treeQuery.isLoading) {
    body = (
      <WorkspaceLoading
        title={adapter.copy.loadingTitle}
        description={adapter.copy.loadingDescription}
      />
    );
  } else if (treeQuery.error || !tree) {
    body = (
      <WorkspaceError
        title={adapter.copy.errorTitle}
        description="Try again."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void treeQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (!folderExists(tree, folderPath)) {
    body = (
      <WorkspaceNotFound
        title="Folder not found"
        description="This folder may have been moved or deleted."
        action={
          <Button asChild variant="outline">
            <Link href={folderHref(adapter.base(projectId), [])}>
              {adapter.copy.notFoundBackLabel}
            </Link>
          </Button>
        }
      />
    );
  } else if (entries.length === 0) {
    body = searchActive ? (
      <WorkspaceEmpty
        title={adapter.copy.emptySearchTitle}
        description={adapter.copy.emptySearchDescription}
      />
    ) : folderPath.length ? (
      <WorkspaceEmpty
        title={adapter.copy.emptyFolderTitle}
        description={adapter.copy.emptyFolderDescription}
      />
    ) : adapter.copy.emptyRootTitle ? (
      <WorkspaceEmpty
        title={adapter.copy.emptyRootTitle}
        description={adapter.copy.emptyRootDescription}
      />
    ) : (
      <WorkspaceEmpty />
    );
  } else {
    body = (
      <ContentExplorer
        projectId={projectId}
        folderPath={folderPath}
        entries={entries}
        view={view}
        iconSize={iconSize}
        searchActive={searchActive}
        sort={sort}
        dir={dir}
        onSortChange={(nextSort, nextDir) => {
          setSort(nextSort);
          setDir(nextDir);
        }}
        onNavigateUp={navigateUp}
        folders={tree.folders}
        folderNames={tree.folderNames}
        canEdit={canEdit}
        adapter={shownAdapter}
        onMoveItem={onMoveItem}
        onMoveEntries={onMoveEntries}
        selectedKeys={selectedKeys}
        onSelectionChange={
          canSelect
            ? (keys) => setSelection({ scope: selectionScope, keys })
            : undefined
        }
        busy={busy}
      />
    );
  }

  return (
    <DocumentsWorkspace canvasLabel={adapter.copy.workspaceLabel}>
      <div
        className={cn(
          "flex min-h-full w-full flex-col gap-4 p-6",
          dragging && "ring-brand rounded-[10px] ring-2 ring-inset",
        )}
        data-explorer-workspace-focus
        tabIndex={-1}
        data-testid={adapter.copy.dropZoneTestId}
        onDragStart={(event) => {
          if (carriesExplorerItem(event.dataTransfer)) setItemDragging(true);
        }}
        onDragEnd={() => {
          setItemDragging(false);
          setUpDropActive(false);
        }}
        onDragOver={(event) => {
          if (!canEdit || !importer) return;
          if (!carriesFiles(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          if (!carriesFiles(event.dataTransfer)) return;
          event.preventDefault();
          if (!canEdit || !importer) return;
          setDragging(false);
          void importer.run([...event.dataTransfer.files]);
        }}
      >
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-1">
            <h1 className="text-text m-0 text-[20px] font-semibold break-words">
              {folderName}
            </h1>
            <p className="text-text-3 m-0 text-[13px]">
              {folders.length} folder{folders.length === 1 ? "" : "s"} ·{" "}
              {items.length}{" "}
              {items.length === 1 ? adapter.itemNoun[0] : adapter.itemNoun[1]}
              {importer ? ` · ${importer.hint}` : null}
            </p>
            {importer?.importing ? (
              <p role="status" className="text-text-3 text-[13px]">
                {importer.status}
              </p>
            ) : null}
            {importer?.dialog}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {folderPath.length === 0
              ? adapter.rootActions?.({ projectId })
              : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={folderPath.length === 0}
              onClick={navigateUp}
              className={cn(
                upTarget && "border-brand text-brand-text border-dashed",
                upTarget && upDropActive && "bg-brand-bg border-solid",
              )}
              data-drop-target={upTarget && upDropActive ? "true" : undefined}
              {...upDropProps}
            >
              <ArrowUp data-icon="inline-start" aria-hidden="true" />
              {upTarget ? "Move up one level" : "Up"}
            </Button>
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(value) =>
                value && changeView(value as ExplorerView)
              }
              aria-label="View"
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="list" aria-label="List view">
                <List aria-hidden="true" />
              </ToggleGroupItem>
              <ToggleGroupItem value="icons" aria-label="Icons view">
                <LayoutGrid aria-hidden="true" />
              </ToggleGroupItem>
            </ToggleGroup>
            {view === "icons" ? (
              <ToggleGroup
                type="single"
                value={iconSize}
                onValueChange={(value) => {
                  if (value) changeIconSize(value as ExplorerIconSize);
                }}
                aria-label="Icon size"
                variant="outline"
                size="sm"
              >
                <ToggleGroupItem value="standard">Standard</ToggleGroupItem>
                <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            {adapter.folderDownloadHref &&
            tree &&
            folderExists(tree, folderPath) ? (
              <FolderDownloadButton
                href={adapter.folderDownloadHref(projectId, folderPath)}
                folderName={folderName}
              />
            ) : null}
            {canEdit ? (
              <>
                <adapter.CreateFolderDialog
                  projectId={projectId}
                  parentPath={folderPath}
                  // Stay on this level so the new folder can be filled by drag and drop.
                  onFolderCreated={() => undefined}
                />
                <adapter.CreateItemDialog
                  projectId={projectId}
                  folderPath={folderPath}
                  folders={tree?.folders ?? []}
                  folderNames={tree?.folderNames}
                />
              </>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label
              htmlFor={adapter.searchInputId}
              className="text-text-2 text-[12px] font-medium"
            >
              Search in {folderName}
            </label>
            <Input
              id={adapter.searchInputId}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by title"
            />
          </div>
          <div className="flex gap-2">
            {adapter.filter && filterOptions.length > 0 ? (
              <div className="flex flex-1 flex-col gap-1.5 sm:flex-none">
                <label
                  htmlFor={`${sortPrefix}-${adapter.filter.id}`}
                  className="text-text-2 text-[12px] font-medium"
                >
                  {adapter.filter.label}
                </label>
                <Select value={valueFilter} onValueChange={setValueFilter}>
                  <SelectTrigger
                    id={`${sortPrefix}-${adapter.filter.id}`}
                    className="w-full sm:w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_VALUES}>
                      {adapter.filter.allLabel}
                    </SelectItem>
                    {filterOptions.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="flex flex-1 flex-col gap-1.5 sm:flex-none">
              <label
                htmlFor={`${sortPrefix}-sort`}
                className="text-text-2 text-[12px] font-medium"
              >
                Sort by
              </label>
              <Select
                value={sort}
                onValueChange={(value: ExplorerSort) => setSort(value)}
              >
                <SelectTrigger
                  id={`${sortPrefix}-sort`}
                  className="w-full sm:w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="title">Title</SelectItem>
                  <SelectItem value="lastEditedAt">Last edited</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5 sm:flex-none">
              <label
                htmlFor={`${sortPrefix}-direction`}
                className="text-text-2 text-[12px] font-medium"
              >
                Order
              </label>
              <Select
                value={dir}
                onValueChange={(value: ExplorerDir) => setDir(value)}
              >
                <SelectTrigger
                  id={`${sortPrefix}-direction`}
                  className="w-full sm:w-32"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">Ascending</SelectItem>
                  <SelectItem value="desc">Descending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {canSelect && operations && tree && !treeQuery.error ? (
          <ExplorerBulkActions
            key={selectionScope}
            entries={selectedEntries}
            folders={tree.folders}
            folderNames={tree.folderNames}
            kind={adapter.kind}
            canEdit={canEdit}
            busy={busy}
            operations={operations}
            onRun={runSelection}
            total={entries.length}
            onSelectAll={() =>
              setSelection({
                scope: selectionScope,
                keys: new Set(entries.map(entryKey)),
              })
            }
            onClear={() =>
              setSelection({ scope: selectionScope, keys: new Set() })
            }
          />
        ) : null}
        {progress ? (
          <p role="status" className="text-text-2 text-[13px]">
            Processing {progress.done} of {progress.total} objects…
          </p>
        ) : null}
        {body}
      </div>
    </DocumentsWorkspace>
  );
}

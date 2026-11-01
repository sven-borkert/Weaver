"use client";

import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

import { resolveQueryPresentation } from "~/lib/query-presentation";
import { projectRoleAtLeast } from "@weaver/core/roles";
import {
  applyTableEditorUpdate,
  appendColumn,
  appendRow,
  draftFromSnapshot,
  isDraftDirty,
  moveColumn,
  pinLatestTableEditorState,
  removeColumn,
  removeRows,
  replaceColumn,
  retypeDraftColumn,
  rowsInvalidForColumn,
  setDraftCell,
  shouldPreserveTableEditorState,
  snapshotFromGet,
  type TableDraft,
  type TableEditorState,
} from "~/lib/tables/draft";
import type { MergeConflict } from "@weaver/core/tables/merge";
import {
  readTablePanelPreference,
  shouldMountTableContextData,
  writeTablePanelPreference,
} from "~/lib/tables/panel-state";
import { parseTableConflicts } from "~/lib/tables/presentation";
import {
  acceptedTableWriteState,
  refreshAfterAcceptedTableWrite,
} from "~/lib/tables/save";
import { invalidateTableCaches } from "~/lib/tables/table-cache-invalidation";
import type { CellValue, TableColumn } from "@weaver/core/tables/types";
import {
  shouldProceedWithNavigation,
  UNSAVED_CHANGES_CONFIRMATION,
  useUnsavedChangesGuard,
} from "~/lib/use-unsaved-changes-guard";
import { api } from "~/trpc/react";
import { SendToRemoteDialog } from "../../_components/SendToRemoteDialog";
import {
  TableColumnDialogs,
  type TableColumnDialogOperation,
} from "./TableColumnDialogs";
import { TableConflictDialog } from "./TableConflictDialog";
import { TableBacklinksPanel } from "./TableBacklinksPanel";
import { TableContextRail } from "./TableContextRail";
import { TableDiff } from "./TableDiff";
import { TableGrid, type TableGridHandle } from "./TableGrid";
import { TableHistoryPanel } from "./TableHistoryPanel";
import {
  WorkspaceError,
  WorkspaceLoading,
  WorkspaceNotFound,
  WorkspaceRefreshError,
} from "./TableStates";
import { TableToolbar } from "./TableToolbar";
import { TablesWorkspace } from "./TablesWorkspace";
import {
  focusTableDialogTrigger,
  tableDialogValueForAccess,
  tableQueryFailureKind,
  tableSaveFailurePresentation,
} from "./table-polish";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

type TableConflictState = {
  tableId: string;
  conflicts: MergeConflict[];
  headCommitSha: string;
};

export function TableScreen({
  projectId,
  tableId,
}: {
  projectId: string;
  tableId: string;
}) {
  const utils = api.useUtils();
  const columnDialogTriggerRef = useRef<HTMLElement | null>(null);
  const deleteRowsTriggerRef = useRef<HTMLElement | null>(null);
  const saveTriggerRef = useRef<HTMLElement | null>(null);
  const tableGridRef = useRef<TableGridHandle>(null);
  const saveCommitPendingRef = useRef(false);
  const [editorState, publishEditorState] = useState<TableEditorState>();
  const editorStateRef = useRef<TableEditorState | undefined>(undefined);
  const setLatestEditorState = useCallback(
    (action: SetStateAction<TableEditorState | undefined>) => {
      const next =
        typeof action === "function" ? action(editorStateRef.current) : action;
      editorStateRef.current = next;
      publishEditorState(next);
    },
    [],
  );
  const [selectionState, setSelectionState] = useState<{
    tableId: string;
    rowIds: string[];
  }>();
  const [columnDialogState, setColumnDialogState] = useState<{
    tableId: string;
    operation: TableColumnDialogOperation;
    accessToken: object;
  }>();
  const [deleteRowsState, setDeleteRowsState] = useState<{
    tableId: string;
    accessToken: object;
  }>();
  const [conflictState, setConflictState] = useState<TableConflictState>();
  const [saveErrorState, setSaveErrorState] = useState<{
    tableId: string;
    message: string;
  }>();
  const [reloadingTableId, setReloadingTableId] = useState<string>();
  const [reloadErrorState, setReloadErrorState] = useState<{
    tableId: string;
    message: string;
  }>();
  const [selectedVersionState, setSelectedVersionState] = useState<{
    tableId: string;
    sha: string;
  }>();
  const [restoreErrorState, setRestoreErrorState] = useState<{
    tableId: string;
    message: string;
  }>();
  const [cacheRefreshErrorState, setCacheRefreshErrorState] = useState<{
    tableId: string;
    message: string;
  }>();
  const [contextRailOpen, setContextRailOpen] = useState(false);
  const [contextTab, setContextTab] = useState<"history" | "backlinks">(
    "history",
  );
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [gridEditing, setGridEditing] = useState(false);
  const [gridCommitPending, setGridCommitPending] = useState(false);
  const selectedRowIds =
    selectionState?.tableId === tableId ? selectionState.rowIds : [];
  const conflict =
    conflictState?.tableId === tableId ? conflictState : undefined;
  const saveError =
    saveErrorState?.tableId === tableId ? saveErrorState.message : undefined;
  const reloading = reloadingTableId === tableId;
  const reloadError =
    reloadErrorState?.tableId === tableId
      ? reloadErrorState.message
      : undefined;
  const selectedVersionSha =
    selectedVersionState?.tableId === tableId
      ? selectedVersionState.sha
      : undefined;
  const restoreError =
    restoreErrorState?.tableId === tableId
      ? restoreErrorState.message
      : undefined;
  const cacheRefreshError =
    cacheRefreshErrorState?.tableId === tableId
      ? cacheRefreshErrorState.message
      : undefined;
  const projectQuery = api.project.get.useQuery(
    { projectId },
    { enabled: projectId.length > 0 },
  );
  const tableQuery = api.table.get.useQuery(
    { projectId, tableId },
    {
      enabled: Boolean(projectQuery.data) && tableId.length > 0,
      // A focus refetch must not replace a cell edit still open in the grid.
      refetchOnWindowFocus: projectQuery.data
        ? !projectRoleAtLeast(projectQuery.data.myRole, "Editor")
        : false,
    },
  );
  const folderTreeQuery = api.tableFolder.tree.useQuery(
    { projectId },
    { enabled: Boolean(projectQuery.data) },
  );
  const canEdit = Boolean(
    projectQuery.data && projectRoleAtLeast(projectQuery.data.myRole, "Editor"),
  );
  const editAccessToken = useMemo(
    () => ({ project: projectQuery.data }),
    [projectQuery.data],
  );
  const columnOperation =
    tableDialogValueForAccess(
      columnDialogState?.tableId === tableId
        ? {
            accessToken: columnDialogState.accessToken,
            value: columnDialogState.operation,
          }
        : undefined,
      canEdit,
      editAccessToken,
    ) ?? null;
  const deleteRowsOpen = Boolean(
    tableDialogValueForAccess(
      deleteRowsState?.tableId === tableId
        ? { accessToken: deleteRowsState.accessToken, value: true }
        : undefined,
      canEdit,
      editAccessToken,
    ),
  );
  const interactionOpen = columnOperation !== null || deleteRowsOpen;
  // An open cell editor must survive a snapshot refresh like an open dialog.
  const preserveInteraction = interactionOpen || gridEditing;
  const currentEditorState =
    editorState?.tableId === tableId ? editorState : undefined;
  const currentDraftDirty = useMemo(
    () =>
      Boolean(
        currentEditorState &&
        isDraftDirty(currentEditorState.snapshot, currentEditorState.draft),
      ),
    [currentEditorState],
  );
  useUnsavedChangesGuard(currentDraftDirty || gridEditing);

  useEffect(() => {
    saveCommitPendingRef.current = false;
    const resetFrame = window.requestAnimationFrame(() => {
      setGridEditing(false);
      setGridCommitPending(false);
    });
    return () => window.cancelAnimationFrame(resetFrame);
  }, [tableId]);

  useEffect(() => {
    const initializeFrame = window.requestAnimationFrame(() => {
      setContextRailOpen(
        readTablePanelPreference(window.sessionStorage) ?? false,
      );
    });
    return () => window.cancelAnimationFrame(initializeFrame);
  }, []);
  const incomingSnapshot = useMemo(
    () =>
      tableQuery.data && !currentDraftDirty
        ? snapshotFromGet({
            title: tableQuery.data.title,
            columns: tableQuery.data.columns,
            rows: tableQuery.data.rows,
            baseCommitSha: tableQuery.data.baseCommitSha,
          })
        : undefined,
    [currentDraftDirty, tableQuery.data],
  );

  const saveTable = api.table.save.useMutation({
    onMutate: () => ({
      staleIncomingBaseCommitSha: tableQuery.data?.baseCommitSha,
    }),
    onSuccess: (result, variables, mutationState) => {
      const accepted = acceptedTableWriteState(
        result,
        mutationState.staleIncomingBaseCommitSha,
      );
      setLatestEditorState({
        tableId: variables.tableId,
        ...accepted,
      });
      setConflictState(undefined);
      setSaveErrorState(undefined);
      setReloadErrorState(undefined);
      setCacheRefreshErrorState(undefined);
      toast.success("Table saved");
      void refreshAfterAcceptedTableWrite(() =>
        invalidateTableCaches(utils, variables.projectId, variables.tableId),
      ).then((outcome) => {
        if (outcome === "failed") {
          setCacheRefreshErrorState({
            tableId: variables.tableId,
            message:
              "The saved table is visible, but related data could not refresh.",
          });
          toast.warning("Table saved, but the workspace could not refresh");
        }
      });
    },
    onError: (err, variables) => {
      if (err.data?.code === "CONFLICT") {
        const conflicts = parseTableConflicts(err.data.conflicts);
        const headCommitSha = err.data.headCommitSha;
        if (
          (conflicts || err.data.conflicts === undefined) &&
          typeof headCommitSha === "string" &&
          COMMIT_SHA_RE.test(headCommitSha)
        ) {
          setSaveErrorState(undefined);
          setReloadErrorState(undefined);
          setConflictState({
            tableId: variables.tableId,
            conflicts: conflicts ?? [],
            headCommitSha,
          });
          return;
        }
      }

      setSaveErrorState({
        tableId: variables.tableId,
        message: tableSaveFailurePresentation(err.data?.code, err.message)
          .message,
      });
      toast.error("Could not save the table");
    },
  });

  const restoreTable = api.table.restore.useMutation({
    onMutate: () => ({
      staleIncomingBaseCommitSha: tableQuery.data?.baseCommitSha,
    }),
    onSuccess: (result, variables, mutationState) => {
      const accepted = acceptedTableWriteState(
        result,
        mutationState.staleIncomingBaseCommitSha,
      );
      setLatestEditorState({ tableId: variables.tableId, ...accepted });
      setSelectionState({ tableId: variables.tableId, rowIds: [] });
      setColumnDialogState(undefined);
      setDeleteRowsState(undefined);
      setConflictState(undefined);
      setSaveErrorState(undefined);
      setReloadErrorState(undefined);
      setRestoreErrorState(undefined);
      setSelectedVersionState(undefined);
      setCacheRefreshErrorState(undefined);
      toast.success("Table version restored");
      void refreshAfterAcceptedTableWrite(() =>
        invalidateTableCaches(utils, variables.projectId, variables.tableId),
      ).then((outcome) => {
        if (outcome === "failed") {
          setCacheRefreshErrorState({
            tableId: variables.tableId,
            message:
              "The restored table is visible, but related data could not refresh.",
          });
          toast.warning("Table restored, but the workspace could not refresh");
        }
      });
    },
    onError: (error, variables) => {
      setRestoreErrorState({
        tableId: variables.tableId,
        message:
          error.data?.code === "CONFLICT"
            ? "The table changed. Reload before restoring."
            : "Could not restore the table version. Try again.",
      });
      toast.error("Could not restore the table version");
    },
  });

  const updateDraft = useCallback(
    (update: (draft: TableDraft) => TableDraft) => {
      setLatestEditorState((current) =>
        applyTableEditorUpdate({
          current,
          tableId,
          incomingSnapshot,
          interactionOpen: preserveInteraction,
          update,
        }),
      );
    },
    [incomingSnapshot, preserveInteraction, setLatestEditorState, tableId],
  );

  const handleCellChange = useCallback(
    ({
      rowId,
      columnId,
      value,
    }: {
      rowId: string;
      columnId: string;
      value: CellValue | undefined;
    }) => {
      updateDraft((draft) => setDraftCell(draft, rowId, columnId, value));
    },
    [updateDraft],
  );

  const projectPresentation = resolveQueryPresentation(projectQuery);
  const tablePresentation = resolveQueryPresentation(tableQuery);
  const projectFailure = tableQueryFailureKind({
    error: projectQuery.error,
    hasCachedData: Boolean(projectQuery.data),
  });
  const treeFailure = tableQueryFailureKind({
    error: folderTreeQuery.error,
    hasCachedData: Boolean(folderTreeQuery.data),
  });
  const tableFailure = tableQueryFailureKind({
    error: tableQuery.error,
    hasCachedData: Boolean(tableQuery.data),
    detectCorruption: true,
  });

  if (projectFailure === "access" || treeFailure === "access") {
    return <WorkspaceNotFound />;
  }

  if (tableFailure === "access") {
    return (
      <WorkspaceNotFound
        title="Table not found"
        description="This table may have been deleted, or you do not have access to it."
      />
    );
  }

  if (tableFailure === "corrupt") {
    return (
      <WorkspaceError
        title="Table data is corrupt"
        description="A project maintainer can rebuild the table index. If the problem remains, the committed table data needs manual repair."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void tableQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (projectPresentation === "loading") {
    return <WorkspaceLoading />;
  }

  if (projectPresentation === "error" && projectQuery.error) {
    return (
      <WorkspaceError
        title="Could not load project"
        description="Refresh the page to try loading this project again."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void projectQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (!projectQuery.data) {
    return <WorkspaceNotFound />;
  }

  if (tablePresentation === "loading") {
    return (
      <WorkspaceLoading
        title="Loading table"
        description="Retrieving the latest table data and workspace."
      />
    );
  }

  if (tablePresentation === "error" && tableQuery.error) {
    return (
      <WorkspaceError
        title="Could not load table"
        description="Refresh the page to retrieve the latest table data."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void tableQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (!tableQuery.data) {
    return (
      <WorkspaceNotFound
        title="Table not found"
        description="This table may have been deleted, or you do not have access to it."
      />
    );
  }

  const preserveCurrentDraft = Boolean(
    currentEditorState &&
    shouldPreserveTableEditorState({
      dirty: currentDraftDirty,
      interactionOpen: preserveInteraction,
      currentBaseCommitSha: currentEditorState.snapshot.baseCommitSha,
      incomingBaseCommitSha: incomingSnapshot?.baseCommitSha,
      staleIncomingBaseCommitSha: currentEditorState.staleIncomingBaseCommitSha,
    }),
  );
  const activeState =
    currentEditorState && preserveCurrentDraft
      ? currentEditorState
      : incomingSnapshot
        ? {
            tableId,
            snapshot: incomingSnapshot,
            draft: draftFromSnapshot(incomingSnapshot),
          }
        : undefined;
  if (!activeState) {
    return (
      <WorkspaceLoading
        title="Preparing table"
        description="Preparing the table grid."
      />
    );
  }

  const draft = activeState.draft;
  const dirty = activeState === currentEditorState && currentDraftDirty;
  const hasUnsavedChanges = dirty || gridEditing;
  const pinActiveEditorState = () => {
    setLatestEditorState((current) =>
      pinLatestTableEditorState({
        current,
        tableId,
        incomingSnapshot,
        interactionOpen: preserveInteraction,
      }),
    );
  };
  const openColumnDialog = (
    operation: TableColumnDialogOperation,
    returnFocusTarget: HTMLElement | null,
  ) => {
    pinActiveEditorState();
    columnDialogTriggerRef.current = returnFocusTarget;
    setColumnDialogState({ tableId, operation, accessToken: editAccessToken });
  };
  const closeColumnDialog = () => {
    setColumnDialogState(undefined);
    focusTableDialogTrigger(
      columnDialogTriggerRef.current,
      document.querySelector<HTMLElement>("[data-table-workspace-focus]"),
    );
    columnDialogTriggerRef.current = null;
  };
  const closeDeleteRowsDialog = () => {
    setDeleteRowsState(undefined);
    focusTableDialogTrigger(
      deleteRowsTriggerRef.current,
      document.querySelector<HTMLElement>("[data-table-workspace-focus]"),
    );
    deleteRowsTriggerRef.current = null;
  };
  const applyDeleteRows = () => {
    const selected = new Set(selectedRowIds);
    updateDraft((current) => removeRows(current, selected));
    setSelectionState({ tableId, rowIds: [] });
    closeDeleteRowsDialog();
  };
  const handleDeleteRowsRequest = (returnFocusTarget: HTMLElement | null) => {
    if (selectedRowIds.length === 1) applyDeleteRows();
    else if (selectedRowIds.length > 1) {
      pinActiveEditorState();
      deleteRowsTriggerRef.current = returnFocusTarget;
      setDeleteRowsState({ tableId, accessToken: editAccessToken });
    }
  };
  const handleReplaceColumn = (column: TableColumn): string[] => {
    const failures = rowsInvalidForColumn(draft, column);
    if (failures.length === 0) {
      updateDraft((current) => replaceColumn(current, column));
    }
    return failures;
  };
  const handleRetypeColumn = (column: TableColumn): string[] => {
    const result = retypeDraftColumn(draft, column.id, column);
    if (!result.ok) return result.failures;
    updateDraft(() => result.draft);
    return [];
  };
  const handleSave = async (returnFocusTarget: HTMLElement | null) => {
    if (saveCommitPendingRef.current || saveTable.isPending) return;
    saveCommitPendingRef.current = true;
    setGridCommitPending(true);
    saveTriggerRef.current = returnFocusTarget;
    setSaveErrorState(undefined);
    try {
      await tableGridRef.current?.commitPendingEdit();
      const latest = editorStateRef.current;
      if (latest?.tableId !== tableId) return;
      if (!isDraftDirty(latest.snapshot, latest.draft)) return;
      try {
        await saveTable.mutateAsync({
          projectId,
          tableId,
          baseCommitSha: latest.snapshot.baseCommitSha,
          title: latest.draft.title,
          columns: latest.draft.columns,
          rows: latest.draft.rows,
        });
      } catch {
        // The mutation callback owns the persistent error presentation.
      }
    } finally {
      saveCommitPendingRef.current = false;
      setGridCommitPending(false);
    }
  };
  const handleRestore = () => {
    if (!selectedVersionSha || !activeState) return;
    if (
      !shouldProceedWithNavigation(hasUnsavedChanges, () =>
        window.confirm(UNSAVED_CHANGES_CONFIRMATION),
      )
    ) {
      return;
    }

    setRestoreErrorState(undefined);
    restoreTable.mutate({
      projectId,
      tableId,
      sha: selectedVersionSha,
      expectedHeadCommitSha: activeState.snapshot.baseCommitSha,
    });
  };
  const handleContextRailCollapsedChange = (collapsed: boolean) => {
    const open = !collapsed;
    setContextRailOpen(open);
    writeTablePanelPreference(window.sessionStorage, open);
  };
  const handleReloadCommitted = async () => {
    if (
      !shouldProceedWithNavigation(hasUnsavedChanges, () =>
        window.confirm(UNSAVED_CHANGES_CONFIRMATION),
      )
    ) {
      return;
    }

    setReloadingTableId(tableId);
    setReloadErrorState(undefined);
    try {
      const input = { projectId, tableId };
      await utils.table.get.invalidate(input);
      const committed = await utils.table.get.fetch(input);
      const next = snapshotFromGet({
        title: committed.title,
        columns: committed.columns,
        rows: committed.rows,
        baseCommitSha: committed.baseCommitSha,
      });
      setLatestEditorState({
        tableId,
        snapshot: next,
        draft: draftFromSnapshot(next),
      });
      setSelectionState({ tableId, rowIds: [] });
      setConflictState(undefined);
      setSaveErrorState(undefined);
      setReloadErrorState(undefined);
      setCacheRefreshErrorState(undefined);
      toast.success("Committed version loaded");
      focusTableDialogTrigger(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Table title"]',
        ),
      );
      saveTriggerRef.current = null;
    } catch {
      setReloadErrorState({
        tableId,
        message: "Could not load the committed table. Try again.",
      });
      toast.error("Could not load the committed table");
    } finally {
      setReloadingTableId((current) =>
        current === tableId ? undefined : current,
      );
    }
  };
  const dialogBusy = interactionOpen || reloading || restoreTable.isPending;
  const retryWorkspaceRefresh = async () => {
    if (!cacheRefreshError) {
      await tableQuery.refetch();
      return;
    }
    const outcome = await refreshAfterAcceptedTableWrite(() =>
      invalidateTableCaches(utils, projectId, tableId),
    );
    if (outcome === "refreshed") {
      setCacheRefreshErrorState(undefined);
    } else {
      toast.error("The table workspace still could not refresh");
    }
  };
  const contextDataMounted = shouldMountTableContextData({
    railOpen: contextRailOpen,
    drawerOpen: contextDrawerOpen,
  });

  const context = (
    <TableContextRail
      collapsed={!contextRailOpen}
      onCollapsedChange={handleContextRailCollapsedChange}
      activeTab={contextTab}
      onActiveTabChange={setContextTab}
      history={
        contextDataMounted ? (
          <TableHistoryPanel
            key={`${tableId}:${activeState.snapshot.baseCommitSha}`}
            projectId={projectId}
            tableId={tableId}
            currentSha={activeState.snapshot.baseCommitSha}
            selectedSha={selectedVersionSha}
            onSelectVersion={(sha) => {
              setRestoreErrorState(undefined);
              setSelectedVersionState({ tableId, sha });
              setContextTab("history");
              setContextDrawerOpen(false);
            }}
          />
        ) : null
      }
      backlinks={
        contextDataMounted ? (
          <TableBacklinksPanel projectId={projectId} tableId={tableId} />
        ) : null
      }
    />
  );

  return (
    <TablesWorkspace
      context={context}
      contextRailCollapsed={!contextRailOpen}
      contextDrawerOpen={contextDrawerOpen}
      onContextDrawerOpenChange={setContextDrawerOpen}
    >
      {selectedVersionSha ? (
        <TableDiff
          projectId={projectId}
          tableId={tableId}
          fromSha={selectedVersionSha}
          toSha={activeState.snapshot.baseCommitSha}
          columns={activeState.snapshot.columns}
          canEdit={canEdit}
          editAccessToken={editAccessToken}
          restorePending={restoreTable.isPending}
          restoreError={restoreError}
          onBack={() => {
            if (restoreTable.isPending) return;
            setRestoreErrorState(undefined);
            setSelectedVersionState(undefined);
          }}
          onRestore={handleRestore}
        />
      ) : (
        <div
          className="flex h-full min-h-0 flex-col"
          aria-busy={saveTable.isPending || reloading || restoreTable.isPending}
        >
          <TableToolbar
            title={draft.title}
            dirty={hasUnsavedChanges}
            canEdit={canEdit}
            selectedRowCount={selectedRowIds.length}
            rowCount={draft.rows.length}
            columns={draft.columns}
            busy={dialogBusy}
            savePending={saveTable.isPending || gridCommitPending}
            onTitleChange={(title) =>
              updateDraft((current) => ({ ...current, title }))
            }
            onAddRow={() =>
              updateDraft((current) =>
                appendRow(current, window.crypto.randomUUID()),
              )
            }
            onDeleteRows={handleDeleteRowsRequest}
            onAddColumnRequest={(returnFocusTarget) =>
              openColumnDialog({ kind: "add" }, returnFocusTarget)
            }
            onRenameColumnRequest={(column, returnFocusTarget) =>
              openColumnDialog({ kind: "rename", column }, returnFocusTarget)
            }
            onRetypeColumnRequest={(column, returnFocusTarget) =>
              openColumnDialog({ kind: "retype", column }, returnFocusTarget)
            }
            onOptionsColumnRequest={(column, returnFocusTarget) =>
              openColumnDialog({ kind: "options", column }, returnFocusTarget)
            }
            onDeleteColumnRequest={(column, returnFocusTarget) =>
              openColumnDialog({ kind: "delete", column }, returnFocusTarget)
            }
            onMoveColumn={(columnId, direction) =>
              updateDraft((current) => moveColumn(current, columnId, direction))
            }
            onSaveRequest={handleSave}
            extraActions={
              <SendToRemoteDialog
                kind="table"
                projectId={projectId}
                itemId={tableId}
                itemTitle={draft.title}
                dirty={dirty}
                triggerClassName="h-7"
              />
            }
            compactExtraActions={
              <SendToRemoteDialog
                kind="table"
                projectId={projectId}
                itemId={tableId}
                itemTitle={draft.title}
                dirty={dirty}
                compact
              />
            }
          />
          {saveError ? (
            <div
              role="alert"
              className="border-danger/30 bg-danger/10 text-danger border-b px-4 py-2 text-[13px] sm:px-6"
            >
              {saveError}
            </div>
          ) : null}
          {cacheRefreshError || tableFailure === "cached-transient" ? (
            <WorkspaceRefreshError
              title="Table could not refresh"
              description={
                cacheRefreshError ??
                "Showing the cached table and preserving your local draft."
              }
              onRetry={() => void retryWorkspaceRefresh()}
            />
          ) : null}
          <TableGrid
            ref={tableGridRef}
            title={draft.title}
            columns={draft.columns}
            rows={draft.rows}
            canEdit={canEdit && !saveTable.isPending && !reloading}
            onCellChange={handleCellChange}
            onSelectionChange={(rowIds) =>
              setSelectionState({ tableId, rowIds })
            }
            onEditingChange={setGridEditing}
          />
        </div>
      )}
      <TableColumnDialogs
        rows={draft.rows}
        operation={canEdit ? columnOperation : null}
        onClose={closeColumnDialog}
        onAdd={(column) =>
          updateDraft((current) => appendColumn(current, column))
        }
        onReplace={handleReplaceColumn}
        onRetype={handleRetypeColumn}
        onDelete={(columnId) =>
          updateDraft((current) => removeColumn(current, columnId))
        }
      />
      <Dialog
        open={canEdit && deleteRowsOpen}
        onOpenChange={(open) =>
          open
            ? setDeleteRowsState({ tableId, accessToken: editAccessToken })
            : closeDeleteRowsDialog()
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete selected rows</DialogTitle>
            <DialogDescription>
              Delete {selectedRowIds.length} selected rows from the local draft
              for <strong>{draft.title}</strong>?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={applyDeleteRows}
            >
              Delete rows
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TableConflictDialog
        onExport={() => {
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(draft, null, 2)], {
              type: "application/json",
            }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = "table-draft.json";
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
        open={Boolean(conflict)}
        conflicts={conflict?.conflicts ?? []}
        columns={draft.columns}
        rows={draft.rows}
        headCommitSha={conflict?.headCommitSha ?? ""}
        reloading={reloading}
        reloadError={reloadError}
        onKeepEditing={() => {
          if (reloading) return;
          setConflictState(undefined);
          setReloadErrorState(undefined);
          focusTableDialogTrigger(saveTriggerRef.current);
          saveTriggerRef.current = null;
        }}
        onReload={() => void handleReloadCommitted()}
      />
    </TablesWorkspace>
  );
}

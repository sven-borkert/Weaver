"use client";

import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { FolderPicker } from "~/app/(workspace)/projects/[projectId]/documents/_components/FolderPicker";
import type { ExplorerEntry, ExplorerItem } from "~/lib/explorer/entries";
import { canMoveEntries, entryKey, moveRoots } from "~/lib/explorer/selection";
import { focusDialogTarget } from "~/lib/dialog-focus";
import type {
  BulkAction,
  ExplorerOperations,
  PreparedSelection,
} from "./useExplorerOperations";

export function ExplorerBulkActions({
  entries,
  folders,
  folderNames,
  kind,
  canEdit = true,
  busy,
  operations,
  onRun,
  onSelectAll,
  onClear,
  total,
}: {
  entries: ExplorerEntry<ExplorerItem>[];
  /** Visible entries; Select all covers exactly these. */
  total: number;
  folders: string[];
  folderNames?: Record<string, string>;
  kind: "documents" | "tables";
  canEdit?: boolean;
  busy: boolean;
  operations: ExplorerOperations;
  onRun: (
    action: BulkAction,
    entries: ExplorerEntry<ExplorerItem>[],
    target: string[],
    revisions: Record<string, string>,
  ) => Promise<void>;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const [dialog, setDialog] = useState<{
    action: BulkAction;
    entries: ExplorerEntry<ExplorerItem>[];
  }>();
  const [prepared, setPrepared] = useState<PreparedSelection>();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState(false);
  const [target, setTarget] = useState<string[]>([]);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const prepareLock = useRef(false);
  const locked = busy || preparing;
  const open = async (action: BulkAction, button: HTMLButtonElement) => {
    if (prepareLock.current || busy) return;
    prepareLock.current = true;
    trigger.current = button;
    const snapshot = [...entries];
    setDialog({ action, entries: snapshot });
    setTarget([]);
    setPrepared(undefined);
    setError(false);
    setPreparing(true);
    try {
      setPrepared(await operations.prepare(action, snapshot));
    } catch {
      setError(true);
    } finally {
      prepareLock.current = false;
      setPreparing(false);
    }
  };
  const eligible =
    dialog?.entries.filter((entry) => prepared?.keys.has(entryKey(entry))) ??
    [];
  const action = dialog?.action;
  const label =
    action === "move"
      ? "Move selected"
      : action === "delete"
        ? "Delete selected"
        : "Mark as reviewed";
  const moving = action === "move" ? moveRoots(eligible) : [];
  const validTarget = action !== "move" || canMoveEntries(moving, target);
  return (
    <>
      <div
        role="toolbar"
        aria-label="Selection actions"
        className="border-line bg-surface flex flex-wrap items-center gap-2 rounded-[10px] border p-2"
      >
        <span role="status" className="text-text-2 mr-2 text-[13px]">
          {entries.length
            ? `${entries.length} selected`
            : "Ctrl+click selects objects, Shift+click a range."}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || total === 0 || entries.length === total}
          onClick={onSelectAll}
        >
          Select all
        </Button>
        {canEdit ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || !entries.length}
              onClick={(event) => void open("move", event.currentTarget)}
            >
              Move selected
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={locked || !entries.length}
              onClick={(event) => void open("delete", event.currentTarget)}
            >
              Delete selected
            </Button>
          </>
        ) : null}
        {kind === "documents" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={locked || !entries.some((entry) => entry.kind === "item")}
            onClick={(event) => void open("review", event.currentTarget)}
          >
            Mark as reviewed
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || !entries.length}
          onClick={onClear}
        >
          Clear selection
        </Button>
      </div>
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(next) => {
          if (!next && !locked) setDialog(undefined);
        }}
      >
        <DialogContent
          aria-busy={locked || undefined}
          showCloseButton={!locked}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(
              trigger.current,
              document.querySelector<HTMLElement>(
                "[data-explorer-workspace-focus]",
              ),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {action === "move"
                ? `Choose a destination for ${dialog?.entries.length ?? 0} selected objects. Folders move with their contents.`
                : action === "delete"
                  ? `Delete ${dialog?.entries.length ?? 0} selected objects? Documents and tables are deleted before folders. Only empty folders can be deleted.`
                  : "Mark the selected documents you are permitted to review as reviewed. This records you as reviewer and sets their next review dates. Folders are skipped."}
            </DialogDescription>
          </DialogHeader>
          {preparing ? (
            <p role="status">Checking selection…</p>
          ) : error ? (
            <p role="alert" className="text-danger">
              Could not check the selection. Close this dialog and try again.
            </p>
          ) : (
            <>
              {action === "move" ? (
                <FolderPicker
                  folders={folders.filter((path) =>
                    canMoveEntries(moving, path.split("/")),
                  )}
                  folderNames={folderNames}
                  value={target}
                  onValueChange={setTarget}
                  disabled={busy}
                />
              ) : null}
              {action === "review" ? (
                <p role="status">
                  {eligible.length}{" "}
                  {eligible.length === 1 ? "document" : "documents"} will be
                  marked as reviewed.{" "}
                  {(dialog?.entries.length ?? 0) - eligible.length} selected{" "}
                  {(dialog?.entries.length ?? 0) - eligible.length === 1
                    ? "object"
                    : "objects"}{" "}
                  skipped.
                </p>
              ) : null}
              {action === "move" && !validTarget ? (
                <p className="text-text-2 text-[13px]">
                  Choose a different destination. A folder cannot move into
                  itself or its descendants.
                </p>
              ) : null}
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => setDialog(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant={action === "delete" ? "destructive" : "default"}
              disabled={locked || error || !eligible.length || !validTarget}
              onClick={async () => {
                if (!action || locked || !prepared) return;
                await onRun(action, eligible, target, prepared.revisions);
                setDialog(undefined);
              }}
            >
              {busy ? "Processing…" : label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

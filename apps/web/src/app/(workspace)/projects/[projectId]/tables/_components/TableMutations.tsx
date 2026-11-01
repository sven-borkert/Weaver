"use client";

import { MoreHorizontal, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  AppearanceDialog,
  AppearanceMenuAction,
  appearanceTriggerKey,
} from "~/components/appearance/AppearanceDialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { invalidateTableCaches } from "~/lib/tables/table-cache-invalidation";
import { api } from "~/trpc/react";
import {
  focusTableDialogTrigger,
  tableDialogValuesForAccess,
} from "./table-polish";
import { TableFolderPicker } from "./TableFolderPicker";

type TableMutationsProps = {
  projectId: string;
  tableId: string;
  headCommitSha?: string;
  tableTitle: string;
  tableFolderPath: string[];
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  onAppearance?: () => void;
  editAccessToken: object;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function TableMutations({
  projectId,
  tableId,
  headCommitSha,
  tableTitle,
  tableFolderPath,
  folders,
  folderNames,
  canEdit,
  onAppearance,
  editAccessToken,
  open,
  onOpenChange,
}: TableMutationsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const utils = api.useUtils();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  if (!canEdit && appearanceOpen) setAppearanceOpen(false);
  const [appearanceAccessToken, setAppearanceAccessToken] = useState<object>();
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveAccessToken, setMoveAccessToken] = useState<object>();
  const [moveTarget, setMoveTarget] = useState(tableFolderPath);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteAccessToken, setDeleteAccessToken] = useState<object>();
  const visibleDialogs = tableDialogValuesForAccess(
    {
      move:
        moveOpen && moveAccessToken
          ? { accessToken: moveAccessToken, value: true as const }
          : undefined,
      delete:
        deleteOpen && deleteAccessToken
          ? { accessToken: deleteAccessToken, value: true as const }
          : undefined,
    },
    canEdit,
    editAccessToken,
  );
  const moveDialogOpen = visibleDialogs.move === true;
  const deleteDialogOpen = visibleDialogs.delete === true;
  const workspaceFocusTarget = () =>
    document.querySelector<HTMLElement>("[data-table-workspace-focus]");
  const closeMoveDialog = () => {
    setMoveOpen(false);
    focusTableDialogTrigger(actionsTriggerRef.current, workspaceFocusTarget());
  };
  const closeDeleteDialog = () => {
    setDeleteOpen(false);
    focusTableDialogTrigger(actionsTriggerRef.current, workspaceFocusTarget());
  };

  const moveTable = api.table.move.useMutation({
    onSuccess: async () => {
      await invalidateTableCaches(utils, projectId, tableId);
      toast.success("Table moved");
      closeMoveDialog();
    },
    onError: () => toast.error("Could not move the table"),
  });
  const deleteTable = api.table.delete.useMutation({
    onSuccess: async () => {
      await invalidateTableCaches(utils, projectId, tableId);
      toast.success("Table deleted");
      closeDeleteDialog();
      if (pathname === `/projects/${projectId}/tables/${tableId}`) {
        router.push(`/projects/${projectId}/tables`);
      }
    },
    onError: () => toast.error("Could not delete the table"),
  });

  const deleteSnapshot = api.table.get.useQuery(
    { projectId, tableId },
    {
      enabled: canEdit && deleteDialogOpen && !headCommitSha,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  );
  const expectedDeleteSha = headCommitSha ?? deleteSnapshot.data?.baseCommitSha;

  if (!canEdit) return null;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={actionsTriggerRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            data-appearance-trigger={appearanceTriggerKey({
              projectId,
              kind: "table",
              id: tableId,
            })}
            aria-label={`Actions for ${tableTitle}`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <AppearanceMenuAction
            onAppearance={() => {
              if (onAppearance) onAppearance();
              else {
                setAppearanceAccessToken(editAccessToken);
                setAppearanceOpen(true);
              }
            }}
          />
          <DropdownMenuItem
            onSelect={() => {
              moveTable.reset();
              setMoveTarget(tableFolderPath);
              setMoveAccessToken(editAccessToken);
              setMoveOpen(true);
            }}
          >
            Move
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              deleteTable.reset();
              setDeleteAccessToken(editAccessToken);
              setDeleteOpen(true);
            }}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {appearanceOpen && appearanceAccessToken === editAccessToken ? (
        <AppearanceDialog
          target={{ projectId, kind: "table", id: tableId }}
          open
          onOpenChange={setAppearanceOpen}
        />
      ) : null}

      <Dialog
        open={moveDialogOpen}
        onOpenChange={(nextOpen) => {
          if (moveTable.isPending) return;
          if (nextOpen) {
            setMoveAccessToken(editAccessToken);
            setMoveOpen(true);
          } else closeMoveDialog();
        }}
      >
        <DialogContent
          showCloseButton={!moveTable.isPending}
          aria-busy={moveTable.isPending}
        >
          <DialogHeader>
            <DialogTitle>Move table</DialogTitle>
            <DialogDescription>
              Choose a destination for <strong>{tableTitle}</strong>.
            </DialogDescription>
          </DialogHeader>
          <TableFolderPicker
            folders={folders}
            folderNames={folderNames}
            value={moveTarget}
            onValueChange={setMoveTarget}
            disabled={moveTable.isPending}
            label="Destination folder"
          />
          {moveTable.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not move the table. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={moveTable.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={moveTable.isPending}
              aria-busy={moveTable.isPending}
              onClick={() =>
                moveTable.mutate({
                  projectId,
                  tableId,
                  folderPath: moveTarget,
                })
              }
            >
              {moveTable.isPending ? "Moving…" : "Move table"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(nextOpen) => {
          if (deleteTable.isPending) return;
          if (nextOpen) {
            setDeleteAccessToken(editAccessToken);
            setDeleteOpen(true);
          } else closeDeleteDialog();
        }}
      >
        <DialogContent
          showCloseButton={!deleteTable.isPending}
          aria-busy={deleteTable.isPending}
        >
          <DialogHeader>
            <DialogTitle>Delete table</DialogTitle>
            <DialogDescription>
              Delete <strong>{tableTitle}</strong>? Its Git history remains
              available for manual recovery.
            </DialogDescription>
          </DialogHeader>
          {deleteTable.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {deleteTable.error.data?.code === "CONFLICT"
                ? "The table changed. Close this dialog, reload the list, and try again."
                : "Could not delete the table. Try again."}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleteTable.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteTable.isPending || !expectedDeleteSha}
              aria-busy={deleteTable.isPending}
              onClick={() =>
                expectedDeleteSha &&
                deleteTable.mutate({
                  projectId,
                  tableId,
                  expectedHeadCommitSha: expectedDeleteSha,
                })
              }
            >
              {deleteTable.isPending ? "Deleting…" : "Delete table"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

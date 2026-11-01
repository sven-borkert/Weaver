"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { projectRoleAtLeast } from "@weaver/core/roles";
import { FolderDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { invalidateDocumentReferenceCaches } from "~/lib/documents/document-cache-invalidation";
import { folderArchiveHref } from "~/lib/documents/download";
import { folderDisplayName } from "~/lib/explorer/entries";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import {
  FolderReviewDialog,
  folderReviewTriggerKey,
} from "./FolderReviewDialog";
import { FolderPicker } from "./FolderPicker";
import { MarkFolderReviewedDialog } from "./MarkFolderReviewedDialog";

/** Client-side mirror of the server's folder.rename name field. */
const folderNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a folder name")
    .max(120, "Folder name must be at most 120 characters"),
});

type FolderNameValues = z.infer<typeof folderNameSchema>;

type FolderMutationsProps = {
  projectId: string;
  path: string[];
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  onAppearance?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function FolderMutations({
  projectId,
  path,
  folders,
  folderNames,
  canEdit,
  onAppearance,
  open,
  onOpenChange,
}: FolderMutationsProps) {
  const utils = api.useUtils();
  const canManage = useCanManageReviewers(projectId);
  const [reviewOpen, setReviewOpen] = useState(false);
  if (!canManage && reviewOpen) setReviewOpen(false);
  const [markOpen, setMarkOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  if (!canEdit && appearanceOpen) setAppearanceOpen(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState(path.slice(0, -1));
  const folderName = folderDisplayName(folderNames, path) || "folder";

  const invalidateFolderTreeAndList = () => {
    void utils.folder.tree.invalidate({ projectId });
    void utils.document.list.invalidate({ projectId });
  };
  const invalidateChangedDocuments = () => {
    void utils.document.get.invalidate();
    void utils.document.history.invalidate();
    void utils.document.backlinks.invalidate();
    void invalidateDocumentReferenceCaches(utils, projectId);
  };

  const moveFolder = api.folder.move.useMutation({
    onSuccess: () => {
      toast.success("Folder moved");
      invalidateFolderTreeAndList();
      invalidateChangedDocuments();
      setMoveOpen(false);
    },
    onError: () => toast.error("Could not move the folder"),
  });
  const deleteFolder = api.folder.delete.useMutation({
    onSuccess: () => {
      toast.success("Folder deleted");
      invalidateFolderTreeAndList();
      setDeleteOpen(false);
    },
    onError: (err) => {
      if (err.data?.code === "PRECONDITION_FAILED") {
        toast.error("Move or delete the folder's documents first");
      } else {
        toast.error("Could not delete the folder");
      }
    },
  });

  // Viewers keep the menu for its download.
  const menu = (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-review-trigger={folderReviewTriggerKey(projectId, path)}
          data-appearance-trigger={appearanceTriggerKey({
            projectId,
            kind: "folder",
            scope: "documents",
            path,
          })}
          aria-label={`Actions for ${folderName}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setMarkOpen(true)}>
          Mark all as reviewed
        </DropdownMenuItem>
        {canManage ? (
          <DropdownMenuItem onSelect={() => setReviewOpen(true)}>
            Set reviewers recursively
          </DropdownMenuItem>
        ) : null}
        {canEdit ? (
          <>
            <AppearanceMenuAction
              onAppearance={() => {
                if (onAppearance) onAppearance();
                else {
                  setAppearanceOpen(true);
                }
              }}
            />
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                moveFolder.reset();
                setMoveTarget(path.slice(0, -1));
                setMoveOpen(true);
              }}
            >
              Move
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem asChild>
          <a
            href={folderArchiveHref(projectId, path)}
            download={`${path.at(-1) ?? "folder"}.zip`}
          >
            <FolderDown />
            Download as ZIP
          </a>
        </DropdownMenuItem>
        {canEdit ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                deleteFolder.reset();
                setDeleteOpen(true);
              }}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const markDialog = (
    <MarkFolderReviewedDialog
      projectId={projectId}
      path={path}
      open={markOpen}
      onOpenChange={setMarkOpen}
      triggerSelector={`[data-review-trigger="${folderReviewTriggerKey(projectId, path)}"]`}
    />
  );
  if (!canEdit)
    return (
      <>
        {menu}
        {markDialog}
      </>
    );

  return (
    <>
      {menu}
      {markDialog}
      <FolderReviewDialog
        projectId={projectId}
        path={path}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
      />
      {appearanceOpen ? (
        <AppearanceDialog
          target={{ projectId, kind: "folder", scope: "documents", path }}
          open
          onOpenChange={setAppearanceOpen}
        />
      ) : null}

      <RenameFolderDialog
        key={`${path.join("/")}:${renameOpen}`}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        projectId={projectId}
        path={path}
        folderName={folderName}
        onSuccess={() => {
          toast.success("Folder renamed");
          invalidateFolderTreeAndList();
          invalidateChangedDocuments();
        }}
      />

      <Dialog
        open={moveOpen}
        onOpenChange={(nextOpen) => {
          if (!moveFolder.isPending) setMoveOpen(nextOpen);
        }}
      >
        <DialogContent showCloseButton={!moveFolder.isPending}>
          <DialogHeader>
            <DialogTitle>Move folder</DialogTitle>
            <DialogDescription>
              Choose a new parent folder for <strong>{folderName}</strong>.
            </DialogDescription>
          </DialogHeader>
          <FolderPicker
            folders={folders}
            folderNames={folderNames}
            value={moveTarget}
            onValueChange={setMoveTarget}
            excludeSubtree={path}
            disabled={moveFolder.isPending}
          />
          {moveFolder.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not move the folder. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={moveFolder.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={moveFolder.isPending}
              aria-busy={moveFolder.isPending}
              onClick={() =>
                moveFolder.mutate({
                  projectId,
                  path,
                  newParentPath: moveTarget,
                })
              }
            >
              {moveFolder.isPending ? "Moving…" : "Move folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(nextOpen) => {
          if (!deleteFolder.isPending) setDeleteOpen(nextOpen);
        }}
      >
        <DialogContent showCloseButton={!deleteFolder.isPending}>
          <DialogHeader>
            <DialogTitle>Delete folder</DialogTitle>
            <DialogDescription>
              Delete <strong>{folderName}</strong>? Only empty folders can be
              deleted. Move or delete its documents first.
            </DialogDescription>
          </DialogHeader>
          {deleteFolder.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {deleteFolder.error.data?.code === "PRECONDITION_FAILED"
                ? "Move or delete the folder’s documents first."
                : "Could not delete the folder. Try again."}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleteFolder.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteFolder.isPending}
              aria-busy={deleteFolder.isPending}
              onClick={() => deleteFolder.mutate({ projectId, path })}
            >
              {deleteFolder.isPending ? "Deleting…" : "Delete folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RenameFolderDialog({
  open,
  onOpenChange,
  projectId,
  path,
  folderName,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  path: string[];
  folderName: string;
  onSuccess: (folder: { path: string[] }) => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<FolderNameValues>({
    resolver: zodResolver(folderNameSchema),
    defaultValues: { name: folderName },
  });
  const renameFolder = api.folder.rename.useMutation({
    onSuccess: (folder) => {
      onSuccess(folder);
      onOpenChange(false);
    },
    onError: (err) => {
      if (err.data?.code === "PRECONDITION_FAILED") {
        toast.error("Move or delete the folder's documents first");
      } else if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error("Could not rename the folder");
      }
    },
  });
  const onSubmit = handleSubmit((values) => {
    renameFolder.mutate({ projectId, path, name: values.name });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!renameFolder.isPending) {
          if (nextOpen) renameFolder.reset();
          onOpenChange(nextOpen);
          if (!nextOpen) reset({ name: folderName });
        }
      }}
    >
      <DialogContent showCloseButton={!renameFolder.isPending}>
        <DialogHeader>
          <DialogTitle>Rename folder</DialogTitle>
          <DialogDescription>Choose a new folder name.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
          aria-busy={renameFolder.isPending}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rename-folder-${path.join("-")}`}>Name</Label>
            <Input
              id={`rename-folder-${path.join("-")}`}
              autoFocus
              disabled={renameFolder.isPending}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={
                errors.name
                  ? `rename-folder-${path.join("-")}-error`
                  : undefined
              }
              {...register("name")}
            />
            {errors.name ? (
              <p
                id={`rename-folder-${path.join("-")}-error`}
                role="alert"
                className="text-danger text-[12px]"
              >
                {errors.name.message}
              </p>
            ) : null}
          </div>
          {renameFolder.error && !renameFolder.error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {renameFolder.error.data?.code === "PRECONDITION_FAILED"
                ? "Move or delete the folder’s documents first."
                : "Could not rename the folder. Try again."}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={renameFolder.isPending}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={renameFolder.isPending}
              aria-busy={renameFolder.isPending}
            >
              {renameFolder.isPending ? "Renaming…" : "Rename folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useCanManageReviewers(projectId: string) {
  const query = api.project.get.useQuery({ projectId });
  const project = dataUnlessAccessError(query.data, query.error);
  return project ? projectRoleAtLeast(project.myRole, "Maintainer") : false;
}

export function DocumentRootReviewAction({ projectId }: { projectId: string }) {
  const canManage = useCanManageReviewers(projectId);
  const [open, setOpen] = useState(false);
  if (!canManage && open) setOpen(false);
  const [markOpen, setMarkOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-mark-reviewed-trigger={projectId}
        onClick={() => setMarkOpen(true)}
      >
        Mark all as reviewed
      </Button>
      <MarkFolderReviewedDialog
        projectId={projectId}
        path={[]}
        open={markOpen}
        onOpenChange={setMarkOpen}
        triggerSelector={`[data-mark-reviewed-trigger="${projectId}"]`}
      />
      {canManage ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-review-trigger={folderReviewTriggerKey(projectId, [])}
            onClick={() => setOpen(true)}
          >
            Set reviewers recursively
          </Button>
          <FolderReviewDialog
            projectId={projectId}
            path={[]}
            open={open}
            onOpenChange={setOpen}
          />
        </>
      ) : null}
    </>
  );
}

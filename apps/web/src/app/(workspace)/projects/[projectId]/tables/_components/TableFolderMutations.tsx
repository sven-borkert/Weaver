"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FolderPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
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
  DialogTrigger,
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
import { invalidateTableCaches } from "~/lib/tables/table-cache-invalidation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import { folderDisplayName } from "~/lib/explorer/entries";
import { TableFolderPicker } from "./TableFolderPicker";
import {
  focusTableDialogTrigger,
  tableDialogValuesForAccess,
} from "./table-polish";

/** Client-side mirror of the server's tableFolder create/rename name field. */
const folderNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a folder name")
    .max(120, "Folder name must be at most 120 characters"),
});

type FolderNameValues = z.infer<typeof folderNameSchema>;

const defaultFolderValues: FolderNameValues = { name: "" };

export function CreateTableFolderDialog({
  projectId,
  parentPath,
  onFolderCreated,
}: {
  projectId: string;
  parentPath: string[];
  onFolderCreated?: (path: string[]) => void;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<FolderNameValues>({
    resolver: zodResolver(folderNameSchema),
    defaultValues: defaultFolderValues,
  });
  const createFolder = api.tableFolder.create.useMutation({
    onSuccess: async (folder) => {
      await invalidateTableCaches(utils, projectId);
      toast.success("Folder created");
      setOpen(false);
      reset(defaultFolderValues);
      onFolderCreated?.(folder.path);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error("Could not create the folder");
      }
    },
  });
  const onSubmit = handleSubmit((values) => {
    createFolder.mutate({ projectId, parentPath, name: values.name });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (createFolder.isPending) return;
        if (nextOpen) createFolder.reset();
        setOpen(nextOpen);
        if (!nextOpen) reset(defaultFolderValues);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FolderPlus data-icon="inline-start" aria-hidden="true" />
          New folder
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={!createFolder.isPending}
        aria-busy={createFolder.isPending}
      >
        <DialogHeader>
          <DialogTitle>New table folder</DialogTitle>
          <DialogDescription>
            Create a folder in{" "}
            {parentPath.length ? parentPath.join(" / ") : "the tables root"}.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
          aria-busy={createFolder.isPending}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-table-folder-name">Name</Label>
            <Input
              id="create-table-folder-name"
              autoFocus
              disabled={createFolder.isPending}
              placeholder="Planning"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={
                errors.name ? "create-table-folder-name-error" : undefined
              }
              {...register("name")}
            />
            {errors.name ? (
              <p
                id="create-table-folder-name-error"
                role="alert"
                className="text-danger m-0 text-[12px]"
              >
                {errors.name.message}
              </p>
            ) : null}
          </div>
          {createFolder.error && !createFolder.error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not create the folder. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={createFolder.isPending}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={createFolder.isPending}
              aria-busy={createFolder.isPending}
            >
              {createFolder.isPending ? "Creating…" : "Create folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type TableFolderMutationsProps = {
  projectId: string;
  path: string[];
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  onAppearance?: () => void;
  editAccessToken: object;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function TableFolderMutations({
  projectId,
  path,
  folders,
  folderNames,
  canEdit,
  onAppearance,
  editAccessToken,
  open,
  onOpenChange,
}: TableFolderMutationsProps) {
  const utils = api.useUtils();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  if (!canEdit && appearanceOpen) setAppearanceOpen(false);
  const [appearanceAccessToken, setAppearanceAccessToken] = useState<object>();
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameAccessToken, setRenameAccessToken] = useState<object>();
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveAccessToken, setMoveAccessToken] = useState<object>();
  const [moveTarget, setMoveTarget] = useState(path.slice(0, -1));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteAccessToken, setDeleteAccessToken] = useState<object>();
  const visibleDialogs = tableDialogValuesForAccess(
    {
      rename:
        renameOpen && renameAccessToken
          ? { accessToken: renameAccessToken, value: true as const }
          : undefined,
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
  const renameDialogOpen = visibleDialogs.rename === true;
  const moveDialogOpen = visibleDialogs.move === true;
  const deleteDialogOpen = visibleDialogs.delete === true;
  const folderName = folderDisplayName(folderNames, path) || "folder";
  const workspaceFocusTarget = () =>
    document.querySelector<HTMLElement>("[data-table-workspace-focus]");
  const closeMutationDialog = (setOpen: (open: boolean) => void): void => {
    setOpen(false);
    focusTableDialogTrigger(actionsTriggerRef.current, workspaceFocusTarget());
  };

  const moveFolder = api.tableFolder.move.useMutation({
    onSuccess: async () => {
      await invalidateTableCaches(utils, projectId);
      toast.success("Folder moved");
      closeMutationDialog(setMoveOpen);
    },
    onError: (err) => {
      toast.error(
        err.data?.code === "PRECONDITION_FAILED"
          ? "Move or delete contained tables first"
          : "Could not move the folder",
      );
    },
  });
  const deleteFolder = api.tableFolder.delete.useMutation({
    onSuccess: async () => {
      await invalidateTableCaches(utils, projectId);
      toast.success("Folder deleted");
      closeMutationDialog(setDeleteOpen);
    },
    onError: (err) => {
      toast.error(
        err.data?.code === "PRECONDITION_FAILED"
          ? "Move or delete contained tables first"
          : "Could not delete the folder",
      );
    },
  });

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
              kind: "folder",
              scope: "tables",
              path,
            })}
            aria-label={`Actions for ${folderName}`}
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
              setRenameAccessToken(editAccessToken);
              setRenameOpen(true);
            }}
          >
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              moveFolder.reset();
              setMoveTarget(path.slice(0, -1));
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
              deleteFolder.reset();
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
          target={{ projectId, kind: "folder", scope: "tables", path }}
          open
          onOpenChange={setAppearanceOpen}
        />
      ) : null}

      <RenameTableFolderDialog
        key={`${path.join("/")}:${renameDialogOpen}`}
        open={renameDialogOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setRenameAccessToken(editAccessToken);
            setRenameOpen(true);
          } else closeMutationDialog(setRenameOpen);
        }}
        projectId={projectId}
        path={path}
        folderName={folderName}
        onSuccess={async () => {
          await invalidateTableCaches(utils, projectId);
          toast.success("Folder renamed");
        }}
      />

      <Dialog
        open={moveDialogOpen}
        onOpenChange={(nextOpen) => {
          if (moveFolder.isPending) return;
          if (nextOpen) {
            setMoveAccessToken(editAccessToken);
            setMoveOpen(true);
          } else closeMutationDialog(setMoveOpen);
        }}
      >
        <DialogContent
          showCloseButton={!moveFolder.isPending}
          aria-busy={moveFolder.isPending}
        >
          <DialogHeader>
            <DialogTitle>Move table folder</DialogTitle>
            <DialogDescription>
              Choose a new parent folder for <strong>{folderName}</strong>.
            </DialogDescription>
          </DialogHeader>
          <TableFolderPicker
            folders={folders}
            folderNames={folderNames}
            value={moveTarget}
            onValueChange={setMoveTarget}
            excludeSubtree={path}
            disabled={moveFolder.isPending}
            label="Parent folder"
          />
          {moveFolder.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {moveFolder.error.data?.code === "PRECONDITION_FAILED"
                ? "Move or delete contained tables first."
                : "Could not move the folder. Try again."}
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
        open={deleteDialogOpen}
        onOpenChange={(nextOpen) => {
          if (deleteFolder.isPending) return;
          if (nextOpen) {
            setDeleteAccessToken(editAccessToken);
            setDeleteOpen(true);
          } else closeMutationDialog(setDeleteOpen);
        }}
      >
        <DialogContent
          showCloseButton={!deleteFolder.isPending}
          aria-busy={deleteFolder.isPending}
        >
          <DialogHeader>
            <DialogTitle>Delete table folder</DialogTitle>
            <DialogDescription>
              Delete <strong>{folderName}</strong>? Move or delete contained
              tables first.
            </DialogDescription>
          </DialogHeader>
          {deleteFolder.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {deleteFolder.error.data?.code === "PRECONDITION_FAILED"
                ? "Move or delete contained tables first."
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

function RenameTableFolderDialog({
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
  onSuccess: (path: string[]) => Promise<void>;
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
  const renameFolder = api.tableFolder.rename.useMutation({
    onSuccess: async (folder) => {
      await onSuccess(folder.path);
      onOpenChange(false);
    },
    onError: (err) => {
      if (err.data?.code === "PRECONDITION_FAILED") {
        toast.error("Move or delete contained tables first");
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
      <DialogContent
        showCloseButton={!renameFolder.isPending}
        aria-busy={renameFolder.isPending}
      >
        <DialogHeader>
          <DialogTitle>Rename table folder</DialogTitle>
          <DialogDescription>Choose a new folder name.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
          aria-busy={renameFolder.isPending}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rename-table-folder-${path.join("-")}`}>
              Name
            </Label>
            <Input
              id={`rename-table-folder-${path.join("-")}`}
              autoFocus
              disabled={renameFolder.isPending}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={
                errors.name
                  ? `rename-table-folder-${path.join("-")}-error`
                  : undefined
              }
              {...register("name")}
            />
            {errors.name ? (
              <p
                id={`rename-table-folder-${path.join("-")}-error`}
                role="alert"
                className="text-danger m-0 text-[12px]"
              >
                {errors.name.message}
              </p>
            ) : null}
          </div>
          {renameFolder.error && !renameFolder.error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {renameFolder.error.data?.code === "PRECONDITION_FAILED"
                ? "Move or delete contained tables first."
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

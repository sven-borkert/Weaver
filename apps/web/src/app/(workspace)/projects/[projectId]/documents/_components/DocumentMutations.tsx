"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Download,
  FolderArchive,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
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
import { Skeleton } from "~/components/ui/skeleton";
import { buildRenameChangeSummary } from "~/lib/documents/change-summary";
import { invalidateDocumentReferenceCaches } from "~/lib/documents/document-cache-invalidation";
import type { DragDownload } from "~/lib/explorer/drag";
import type { DocumentGet } from "~/lib/documents/use-document-session";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import { FolderPicker } from "./FolderPicker";

/** Client-side mirror of the server's document.update title field. */
const renameDocumentSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Enter a title")
    .max(200, "Title must be at most 200 characters")
    .refine((value) => !value.includes("\n"), {
      message: "Title must be a single line",
    }),
});

type RenameDocumentValues = z.infer<typeof renameDocumentSchema>;

type DocumentMutationsProps = {
  projectId: string;
  documentId: string;
  documentTitle: string;
  documentFolderPath: string[];
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  onAppearance?: () => void;
  /** The stored file as a download; the one action a Viewer gets. */
  download?: DragDownload;
  /** The document with its images as a ZIP. */
  archive?: DragDownload;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function DocumentMutations({
  projectId,
  documentId,
  documentTitle,
  documentFolderPath,
  folders,
  folderNames,
  canEdit,
  onAppearance,
  download,
  archive,
  open,
  onOpenChange,
}: DocumentMutationsProps) {
  const utils = api.useUtils();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  if (!canEdit && appearanceOpen) setAppearanceOpen(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renamePending, setRenamePending] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState(documentFolderPath);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const documentQuery = api.document.get.useQuery(
    { projectId, documentId },
    { enabled: renameOpen },
  );

  const invalidate = () => {
    void utils.document.list.invalidate({ projectId });
    void utils.document.get.invalidate({ projectId, documentId });
    void utils.folder.tree.invalidate({ projectId });
    void utils.document.history.invalidate({ projectId, documentId });
    void utils.document.backlinks.invalidate({ projectId });
    void invalidateDocumentReferenceCaches(utils, projectId);
  };

  const moveDocument = api.document.move.useMutation({
    onSuccess: () => {
      toast.success("Document moved");
      invalidate();
      setMoveOpen(false);
    },
    onError: () => toast.error("Could not move the document"),
  });
  const deleteDocument = api.document.delete.useMutation({
    onSuccess: () => {
      toast.success("Document deleted");
      invalidate();
      setDeleteOpen(false);
    },
    onError: () => toast.error("Could not delete the document"),
  });

  if (!canEdit && !download) return null;

  const menu = (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-appearance-trigger={appearanceTriggerKey({
            projectId,
            kind: "document",
            id: documentId,
          })}
          aria-label={`Actions for ${documentTitle}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
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
                moveDocument.reset();
                setMoveTarget(documentFolderPath);
                setMoveOpen(true);
              }}
            >
              Move
            </DropdownMenuItem>
          </>
        ) : null}
        {download ? (
          <DropdownMenuItem asChild>
            <a href={download.href} download={download.fileName}>
              <Download />
              Download
            </a>
          </DropdownMenuItem>
        ) : null}
        {archive ? (
          <DropdownMenuItem asChild>
            <a href={archive.href} download={archive.fileName}>
              <FolderArchive />
              Download as ZIP (with images)
            </a>
          </DropdownMenuItem>
        ) : null}
        {canEdit ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                deleteDocument.reset();
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
  if (!canEdit) return menu;

  return (
    <>
      {menu}
      {appearanceOpen ? (
        <AppearanceDialog
          target={{ projectId, kind: "document", id: documentId }}
          open
          onOpenChange={setAppearanceOpen}
        />
      ) : null}

      <RenameDocumentDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        projectId={projectId}
        documentId={documentId}
        documentTitle={documentTitle}
        document={dataUnlessAccessError(
          documentQuery.data,
          documentQuery.error,
        )}
        isLoading={documentQuery.isLoading}
        error={Boolean(documentQuery.error)}
        isPending={renamePending}
        onPendingChange={setRenamePending}
        onInvalidated={invalidate}
      />

      <Dialog
        open={moveOpen}
        onOpenChange={(nextOpen) => {
          if (!moveDocument.isPending) setMoveOpen(nextOpen);
        }}
      >
        <DialogContent showCloseButton={!moveDocument.isPending}>
          <DialogHeader>
            <DialogTitle>Move document</DialogTitle>
            <DialogDescription>
              Choose a destination for <strong>{documentTitle}</strong>.
            </DialogDescription>
          </DialogHeader>
          <FolderPicker
            folders={folders}
            folderNames={folderNames}
            value={moveTarget}
            onValueChange={setMoveTarget}
            disabled={moveDocument.isPending}
          />
          {moveDocument.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not move the document. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={moveDocument.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={moveDocument.isPending}
              aria-busy={moveDocument.isPending}
              onClick={() =>
                moveDocument.mutate({
                  projectId,
                  documentId,
                  folderPath: moveTarget,
                })
              }
            >
              {moveDocument.isPending ? "Moving…" : "Move document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(nextOpen) => {
          if (!deleteDocument.isPending) setDeleteOpen(nextOpen);
        }}
      >
        <DialogContent showCloseButton={!deleteDocument.isPending}>
          <DialogHeader>
            <DialogTitle>Delete document</DialogTitle>
            <DialogDescription>
              Delete <strong>{documentTitle}</strong>? Its Git history remains
              available for manual recovery.
            </DialogDescription>
          </DialogHeader>
          {deleteDocument.error ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not delete the document. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleteDocument.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteDocument.isPending}
              aria-busy={deleteDocument.isPending}
              onClick={() => deleteDocument.mutate({ projectId, documentId })}
            >
              {deleteDocument.isPending ? "Deleting…" : "Delete document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RenameDocumentDialog({
  open,
  onOpenChange,
  projectId,
  documentId,
  documentTitle,
  document,
  isLoading,
  error,
  isPending,
  onPendingChange,
  onInvalidated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  documentId: string;
  documentTitle: string;
  document:
    | { title: string; content: DocumentGet["content"]; baseCommitSha: string }
    | undefined;
  isLoading: boolean;
  error: boolean;
  isPending: boolean;
  onPendingChange: (pending: boolean) => void;
  onInvalidated: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>Rename document</DialogTitle>
          <DialogDescription>
            Choose a new title for <strong>{documentTitle}</strong>.
          </DialogDescription>
        </DialogHeader>
        {document ? (
          <RenameDocumentForm
            key={String(open)}
            projectId={projectId}
            documentId={documentId}
            document={document}
            onOpenChange={onOpenChange}
            onPendingChange={onPendingChange}
            onInvalidated={onInvalidated}
          />
        ) : isLoading ? (
          <div role="status" aria-label="Loading document">
            <span className="sr-only">Loading document…</span>
            <Skeleton className="h-9 w-full" />
          </div>
        ) : error ? (
          <p role="alert" className="text-danger m-0 text-[13px]">
            Could not load the document for renaming. Try again.
          </p>
        ) : (
          <p role="alert" className="text-danger m-0 text-[13px]">
            Document not found. It may have been deleted.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameDocumentForm({
  projectId,
  documentId,
  document,
  onOpenChange,
  onPendingChange,
  onInvalidated,
}: {
  projectId: string;
  documentId: string;
  document: {
    title: string;
    content: DocumentGet["content"];
    baseCommitSha: string;
  };
  onOpenChange: (open: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onInvalidated: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<RenameDocumentValues>({
    resolver: zodResolver(renameDocumentSchema),
    // A background refetch refreshes an untouched title but keeps a typed one.
    values: { title: document.title },
    resetOptions: { keepDirtyValues: true },
  });
  const renameDocument = api.document.update.useMutation({
    onSuccess: () => {
      toast.success("Document renamed");
      onInvalidated();
      onPendingChange(false);
      onOpenChange(false);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error("Could not rename the document");
      }
    },
    onSettled: () => onPendingChange(false),
  });

  const onSubmit = handleSubmit((values) => {
    onPendingChange(true);
    renameDocument.mutate({
      projectId,
      documentId,
      content: document.content,
      baseCommitSha: document.baseCommitSha,
      title: values.title,
      changeSummary: buildRenameChangeSummary(values.title),
    });
  });

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3"
      aria-busy={renameDocument.isPending}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rename-document-title">Title</Label>
        <Input
          id="rename-document-title"
          autoFocus
          disabled={renameDocument.isPending}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={
            errors.title ? "rename-document-title-error" : undefined
          }
          {...register("title")}
        />
        {errors.title ? (
          <p
            id="rename-document-title-error"
            role="alert"
            className="text-danger text-[12px]"
          >
            {errors.title.message}
          </p>
        ) : null}
      </div>
      {renameDocument.error && !renameDocument.error.data?.field ? (
        <p role="alert" className="text-danger m-0 text-[12px]">
          Could not rename the document. Try again.
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            disabled={renameDocument.isPending}
          >
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          disabled={renameDocument.isPending}
          aria-busy={renameDocument.isPending}
        >
          {renameDocument.isPending ? "Renaming…" : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  );
}

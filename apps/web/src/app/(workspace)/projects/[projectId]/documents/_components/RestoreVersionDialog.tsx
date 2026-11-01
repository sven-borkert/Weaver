"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
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
  DialogTrigger,
} from "~/components/ui/dialog";
import { invalidateDocumentReferenceCaches } from "~/lib/documents/document-cache-invalidation";
import { api } from "~/trpc/react";

type RestoreVersionDialogProps = {
  projectId: string;
  documentId: string;
  sha: string;
  expectedHeadCommitSha: string;
  canEdit: boolean;
  onRestored: () => void;
};

export function RestoreVersionDialog({
  projectId,
  documentId,
  sha,
  expectedHeadCommitSha,
  canEdit,
  onRestored,
}: RestoreVersionDialogProps) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const restoreVersion = api.document.restore.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.document.get.invalidate({ projectId, documentId }),
        utils.document.list.invalidate({ projectId }),
        utils.folder.tree.invalidate({ projectId }),
        utils.document.history.invalidate({ projectId, documentId }),
        utils.document.backlinks.invalidate({ projectId }),
        invalidateDocumentReferenceCaches(utils, projectId),
      ]);
      setOpen(false);
      onRestored();
      toast.success("Version restored");
    },
    onError: () => {
      toast.error("Could not restore the version");
    },
  });

  if (!canEdit) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!restoreVersion.isPending) {
          if (nextOpen) restoreVersion.reset();
          setOpen(nextOpen);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <RotateCcw data-icon="inline-start" />
          Restore this version
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!restoreVersion.isPending}>
        <DialogHeader>
          <DialogTitle>Restore this version?</DialogTitle>
          <DialogDescription>
            Restoring version <strong>{sha.slice(0, 7)}</strong> creates a new
            version. The current version and all existing history remain
            available.
          </DialogDescription>
        </DialogHeader>
        {restoreVersion.error ? (
          <p role="alert" className="text-danger m-0 text-[12px]">
            {restoreVersion.error.data?.code === "CONFLICT"
              ? "The document changed. Reload before restoring."
              : "Could not restore the version. Try again."}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              disabled={restoreVersion.isPending}
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={restoreVersion.isPending}
            aria-busy={restoreVersion.isPending}
            onClick={() =>
              restoreVersion.mutate({
                projectId,
                documentId,
                sha,
                expectedHeadCommitSha,
              })
            }
          >
            {restoreVersion.isPending ? "Restoring…" : "Restore version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

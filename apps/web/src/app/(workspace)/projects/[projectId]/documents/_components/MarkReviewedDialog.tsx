"use client";

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
} from "~/components/ui/dialog";
import { focusDialogTarget } from "~/lib/dialog-focus";
import {
  invalidateDocumentReview,
  RELOAD_BEFORE_EDITING_HINT,
} from "~/lib/documents/review-cache-invalidation";
import { api } from "~/trpc/react";

export function MarkReviewedDialog({
  projectId,
  documentId,
  baseCommitSha,
  open,
  onOpenChange: setOpen,
  triggerRef,
}: {
  projectId: string;
  documentId: string;
  baseCommitSha: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: { current: HTMLButtonElement | null };
}) {
  const utils = api.useUtils();
  const [settling, setSettling] = useState(false);
  const markReviewed = api.document.markReviewed.useMutation({
    onSuccess: async () => {
      setSettling(true);
      try {
        await invalidateDocumentReview(utils, projectId, documentId);
      } catch {
        toast.error(RELOAD_BEFORE_EDITING_HINT);
      } finally {
        setSettling(false);
      }
      toast.success("Marked as reviewed");
      setOpen(false);
    },
    onError: (err) => {
      setOpen(false);
      if (err.data?.code === "CONFLICT") {
        toast.error("The document changed. Reload and try again.");
        void utils.document.get.invalidate({ projectId, documentId });
      } else {
        toast.error(err.message || "Could not mark the document as reviewed");
      }
    },
  });
  const busy = markReviewed.isPending || settling;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
      }}
    >
      <DialogContent
        aria-busy={busy || undefined}
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(triggerRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>Mark as reviewed</DialogTitle>
          <DialogDescription>
            Mark this document as reviewed? This records you as the reviewer and
            sets the next review date.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              markReviewed.mutate({
                projectId,
                documentId,
                expectedHeadCommitSha: baseCommitSha,
              })
            }
          >
            {busy ? "Saving…" : "Mark as reviewed"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import { invalidateFolderReview } from "~/lib/documents/review-cache-invalidation";
import { api } from "~/trpc/react";

type Props = {
  projectId: string;
  path: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** CSS selector of the control that regains focus on close. */
  triggerSelector: string;
};

const documents = (count: number) =>
  `${count} ${count === 1 ? "document" : "documents"}`;

export function MarkFolderReviewedDialog(props: Props) {
  return props.open ? <OpenMarkFolderReviewedDialog {...props} /> : null;
}

function OpenMarkFolderReviewedDialog({
  projectId,
  path,
  open,
  onOpenChange,
  triggerSelector,
}: Props) {
  const utils = api.useUtils();
  const preview = api.folder.previewMarkReviewed.useQuery(
    { projectId, path },
    { refetchOnMount: "always" },
  );
  const [settling, setSettling] = useState(false);
  const mark = api.folder.markReviewedRecursively.useMutation({
    onSuccess: async (result) => {
      setSettling(true);
      try {
        await invalidateFolderReview(utils, projectId);
      } catch {
        toast.error(
          "The reviews were saved, but refresh failed. Reload before editing documents.",
        );
      } finally {
        setSettling(false);
      }
      toast.success(
        `Marked ${documents(result.changedDocumentCount)} as reviewed`,
      );
      onOpenChange(false);
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT") {
        toast.error("The project changed. Check the documents and try again.");
        void preview.refetch();
      } else {
        toast.error(err.message || "Could not mark the folder as reviewed");
      }
    },
  });
  const busy = mark.isPending || settling;
  const data = preview.isFetching ? undefined : preview.data;
  const eligible = data?.eligibleDocumentCount ?? 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        aria-busy={busy || preview.isFetching || undefined}
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(
            document.querySelector<HTMLElement>(triggerSelector),
            document.querySelector<HTMLElement>("[data-explorer-focus]") ??
              document.querySelector<HTMLElement>(
                "[data-explorer-workspace-focus]",
              ),
          );
        }}
      >
        <DialogHeader>
          <DialogTitle>Mark all as reviewed</DialogTitle>
          <DialogDescription>
            Marks the documents you review in{" "}
            {path.length ? "this folder and its subfolders" : "this project"} as
            reviewed. This records you as the reviewer and sets their next
            review dates.
          </DialogDescription>
        </DialogHeader>
        {preview.isFetching ? (
          <p role="status" className="text-text-2 m-0 text-[13px]">
            Checking documents…
          </p>
        ) : !data ? (
          <div className="flex items-center gap-3">
            <p role="alert" className="text-danger m-0 text-[13px]">
              Could not check the documents.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void preview.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : data.exceedsLimits ? (
          <p role="alert" className="text-danger m-0 text-[13px]">
            This would rewrite more than 1,000 documents or 50 MiB. Select a
            smaller folder.
          </p>
        ) : data.documentCount === 0 ? (
          <p className="m-0 text-[13px]">There are no documents here.</p>
        ) : eligible === 0 ? (
          <p className="m-0 text-[13px]">
            None of the {documents(data.documentCount)} here{" "}
            {data.documentCount === 1 ? "is" : "are"} assigned to you for
            review.
          </p>
        ) : (
          <div className="flex flex-col gap-1 text-[13px]">
            <p className="m-0">
              {eligible} of {documents(data.documentCount)} will be marked as
              reviewed.
            </p>
            {data.skippedDocumentCount > 0 ? (
              <p className="text-text-2 m-0">
                {documents(data.skippedDocumentCount)}{" "}
                {data.skippedDocumentCount === 1 ? "is" : "are"} not assigned to
                you and {data.skippedDocumentCount === 1 ? "stays" : "stay"}{" "}
                unchanged.
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy || !data || data.exceedsLimits || eligible === 0}
            onClick={() => {
              if (data)
                mark.mutate({
                  projectId,
                  path,
                  expectedHeadCommitSha: data.baseProjectCommitSha,
                });
            }}
          >
            {busy ? "Saving…" : "Mark as reviewed"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

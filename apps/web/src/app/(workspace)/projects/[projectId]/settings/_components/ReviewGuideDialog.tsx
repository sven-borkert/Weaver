"use client";

import { useState } from "react";
import { toast } from "sonner";

import { GUIDE_MAX_BYTES } from "@weaver/core/wiki/guideText";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";
import { InlineDiff } from "../../documents/_components/DocumentDiff";

type Review = RouterOutputs["wiki"]["reviewGuide"];

export function GuideReviewBody({ review }: { review: Review }) {
  return (
    <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
      {review.tooLarge ? (
        <p role="alert" className="text-danger m-0 text-[13px]">
          This guide is {review.bytes.toLocaleString("en-US")} bytes. The limit
          is {GUIDE_MAX_BYTES.toLocaleString("en-US")} bytes, and Weaver never
          shortens it. Edit the guide page, then review it again.
        </p>
      ) : (
        <>
          {review.removed.length > 0 ? (
            <div
              role="status"
              className="border-line bg-surface-2 rounded-[10px] border p-3 text-[13px]"
            >
              <p className="text-text m-0 font-medium">
                Removed from the text below
              </p>
              <ul className="text-text-2 m-0 mt-1 list-disc pl-5">
                {review.removed.map((item) => (
                  <li key={item.kind}>
                    {item.count} {item.kind}
                    {item.count === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {review.flags.length > 0 ? (
            <div
              role="status"
              className="border-line bg-surface-2 rounded-[10px] border p-3 text-[13px]"
            >
              <p className="text-text m-0 font-medium">
                Lines that hand rules to somewhere else
              </p>
              <p className="text-text-3 m-0 text-[12px]">
                Advisory only. The guide cannot widen what the agent may do.
              </p>
              <ul className="text-text-2 m-0 mt-1 list-disc pl-5">
                {review.flags.map((flag) => (
                  <li key={flag.line}>
                    Line {flag.line}: {flag.reason}.{" "}
                    <span className="font-mono text-[12px] break-words">
                      {flag.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="text-text m-0 text-[13px] font-medium">
              Exact text every run receives
            </p>
            <pre
              aria-label="Guide text to approve"
              tabIndex={0}
              className="border-line bg-surface text-text m-0 max-h-72 overflow-auto rounded-[10px] border p-3 font-mono text-[12px] break-words whitespace-pre-wrap"
            >
              {review.text}
            </pre>
          </div>
          {review.matchesApproved ? (
            <p className="text-text-2 m-0 text-[13px]">
              This text is already approved.
            </p>
          ) : review.diff.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-text m-0 text-[13px] font-medium">
                Changes since the approved text
              </p>
              <InlineDiff lines={review.diff} />
            </div>
          ) : (
            <p className="text-text-2 m-0 text-[13px]">
              No guide has been approved yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function ReviewGuideDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = api.useUtils();
  const [error, setError] = useState<string | null>(null);
  const query = api.wiki.reviewGuide.useQuery(
    { projectId },
    { enabled: open, staleTime: 0, gcTime: 0, retry: false },
  );
  const approve = api.wiki.approveGuide.useMutation({
    onSuccess: () => {
      toast.success("Wiki guide approved");
      void utils.wiki.settings.invalidate({ projectId });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        err.data?.code === "CONFLICT"
          ? "The guide or settings changed while you were reviewing. Review the new text before approving."
          : "Could not approve the guide. Check your access and try again.",
      );
      void query.refetch();
    },
  });
  const review = query.data;
  const canApprove =
    review !== undefined &&
    !review.tooLarge &&
    !review.matchesApproved &&
    !approve.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (approve.isPending) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent aria-busy={approve.isPending} className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review wiki guide</DialogTitle>
          <DialogDescription>
            Approve the exact text below. Wiki runs follow only the approved
            text, and any edit to the guide page needs a new approval.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : review === undefined ? (
          <p role="alert" className="text-danger m-0 text-[13px]">
            The guide could not be loaded. Maintainer access and a guide page
            are required.
          </p>
        ) : (
          <GuideReviewBody review={review} />
        )}
        {error ? (
          <p role="alert" className="text-danger m-0 text-[13px]">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={approve.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canApprove}
            onClick={() => {
              if (!review) return;
              setError(null);
              approve.mutate({
                projectId,
                expectedRevision: review.revision,
                expectedDigest: review.digest,
              });
            }}
          >
            {approve.isPending ? "Approving…" : "Approve guide"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

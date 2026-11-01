"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import {
  REVIEW_MONTHS_DEFAULT,
  REVIEW_MONTHS_MAX,
  REVIEW_MONTHS_MIN,
} from "@weaver/core/documents/review";
import { ReviewerPicker } from "~/components/review/ReviewerPicker";
import {
  pruneTargets,
  reviewerOptions,
  sameTargets,
  type ReviewerOption,
} from "~/components/review/reviewer-options";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { focusDialogTarget } from "~/lib/dialog-focus";
import {
  invalidateDocumentReview,
  RELOAD_BEFORE_EDITING_HINT,
} from "~/lib/documents/review-cache-invalidation";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";

type Document = RouterOutputs["document"]["get"];
type Unresolved = { type: "user" | "group"; id: string; name: string };

/** Client-side mirror of the server's document.setReview input (minus the ids). */
const formSchema = z.object({
  everyMonths: z
    .number("Enter a number of months")
    .int("Enter a whole number of months")
    .min(REVIEW_MONTHS_MIN, "Use at least 1 month")
    .max(REVIEW_MONTHS_MAX, "Use at most 120 months"),
  reviewers: z
    .array(z.object({ type: z.enum(["user", "group"]), id: z.string() }))
    .max(50, "Select at most 50 reviewers"),
});
type FormValues = z.infer<typeof formSchema>;

export function ReviewSettingsDialog({
  projectId,
  document,
  baseCommitSha,
  open,
  onOpenChange,
  triggerRef,
}: {
  projectId: string;
  document: Document;
  baseCommitSha: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: { current: HTMLButtonElement | null };
}) {
  const groupsQuery = api.reviewerGroup.list.useQuery(
    { projectId },
    { enabled: open },
  );
  const membersQuery = api.projectMember.list.useQuery(
    { projectId },
    { enabled: open },
  );
  const needsDefaults = open && document.review === null;
  const defaultsQuery = api.reviewerGroup.getDefaults.useQuery(
    { projectId },
    { enabled: needsDefaults },
  );
  const groups = dataUnlessAccessError(groupsQuery.data, groupsQuery.error);
  const members = dataUnlessAccessError(membersQuery.data, membersQuery.error);
  const presentations = [
    resolveQueryPresentation(groupsQuery),
    resolveQueryPresentation(membersQuery),
    ...(needsDefaults ? [resolveQueryPresentation(defaultsQuery)] : []),
  ];
  const failed = presentations.some((p) => p !== "data" && p !== "loading");
  const options = useMemo(
    () =>
      groups && members
        ? [
            ...reviewerOptions([], groups),
            ...reviewerOptions(
              members.map((member) => ({
                userId: member.userId,
                name: member.user.name,
                email: member.email,
              })),
              [],
            ),
          ]
        : null,
    [groups, members],
  );
  const defaults = needsDefaults ? (defaultsQuery.data ?? null) : null;
  const [pending, setPending] = useState(false);
  const retry = () => {
    for (const query of [groupsQuery, membersQuery, defaultsQuery])
      if (query.isError) void query.refetch();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-busy={pending || undefined}
        showCloseButton={!pending}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(triggerRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>Review settings</DialogTitle>
          <DialogDescription>
            Who reviews this document, and how often.
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-text-2 m-0 text-[13px]">
              Could not load the project members and reviewer groups.
            </p>
            <Button type="button" variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : options && (document.review !== null || defaults) ? (
          <SettingsForm
            projectId={projectId}
            document={document}
            baseCommitSha={baseCommitSha}
            options={options}
            defaults={defaults}
            onPendingChange={setPending}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({
  projectId,
  document,
  baseCommitSha,
  options,
  defaults,
  onPendingChange,
  onDone,
}: {
  projectId: string;
  document: Document;
  baseCommitSha: string;
  options: ReviewerOption[];
  defaults: {
    everyMonths: number;
    reviewers: { type: "user" | "group"; id: string }[];
  } | null;
  onPendingChange: (pending: boolean) => void;
  onDone: () => void;
}) {
  const utils = api.useUtils();
  const review = document.review;
  const original = useMemo(() => {
    const reviewers = review
      ? review.reviewers
          .filter((reviewer) => reviewer.resolved)
          .map(({ type, id }) => ({ type, id }))
      : (defaults?.reviewers ?? []).map(({ type, id }) => ({ type, id }));
    return {
      everyMonths:
        review?.everyMonths ?? defaults?.everyMonths ?? REVIEW_MONTHS_DEFAULT,
      reviewers: pruneTargets(reviewers, options),
    };
  }, [review, defaults, options]);
  const [busy, setBusy] = useState(false);
  const [unresolved, setUnresolved] = useState<Unresolved[]>(() =>
    (review?.reviewers ?? []).filter((reviewer) => !reviewer.resolved),
  );
  const unresolvedCount = (review?.reviewers ?? []).filter(
    (reviewer) => !reviewer.resolved,
  ).length;
  const {
    register,
    control,
    setError,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      ...original,
    },
  });
  const save = api.document.setReview.useMutation({
    onMutate: () => {
      setBusy(true);
      onPendingChange(true);
    },
    onSuccess: async () => {
      try {
        await invalidateDocumentReview(utils, projectId, document.id);
      } catch {
        toast.error(RELOAD_BEFORE_EDITING_HINT);
      }
      toast.success("Review settings saved");
      setBusy(false);
      onPendingChange(false);
      onDone();
    },
    onError: (err) => {
      setBusy(false);
      onPendingChange(false);
      if (
        err.data?.field === "reviewers" ||
        err.data?.field === "everyMonths"
      ) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as keyof FormValues, error),
        );
      } else if (err.data?.code === "CONFLICT") {
        toast.error("The document changed. Reload and try again.");
        void utils.document.get.invalidate({
          projectId,
          documentId: document.id,
        });
      } else {
        toast.error(err.message || "Could not save the review settings");
      }
    },
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={handleSubmit((values) => {
        if (busy) return;
        const reviewers = pruneTargets(values.reviewers, options);
        const establishing = review === null;
        const reviewersChanged =
          establishing ||
          !sameTargets(reviewers, original.reviewers) ||
          unresolved.length !== unresolvedCount;
        const everyMonthsChanged =
          establishing || !Object.is(values.everyMonths, original.everyMonths);
        if (!reviewersChanged && !everyMonthsChanged) {
          onDone();
          return;
        }
        save.mutate({
          projectId,
          documentId: document.id,
          expectedHeadCommitSha: baseCommitSha,
          ...(reviewersChanged && { reviewers }),
          ...(everyMonthsChanged && { everyMonths: values.everyMonths }),
        });
      })}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="document-review-every-months">
          Review every (months)
        </Label>
        <Input
          id="document-review-every-months"
          type="number"
          min={REVIEW_MONTHS_MIN}
          max={REVIEW_MONTHS_MAX}
          step={1}
          className="w-32"
          disabled={busy}
          aria-invalid={errors.everyMonths ? true : undefined}
          {...register("everyMonths", { valueAsNumber: true })}
        />
        {errors.everyMonths ? (
          <p className="text-danger text-[12px]">
            {errors.everyMonths.message}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Reviewers</Label>
        <Controller
          control={control}
          name="reviewers"
          render={({ field }) => (
            <ReviewerPicker
              aria-label="Reviewers"
              options={options}
              value={field.value}
              onChange={field.onChange}
              disabled={busy}
              unresolved={unresolved}
              onRemoveUnresolved={(id) =>
                setUnresolved((current) =>
                  current.filter((entry) => entry.id !== id),
                )
              }
            />
          )}
        />
        {unresolved.length > 0 ? (
          <p className="text-text-3 m-0 text-[12px]">
            Reviewers who are no longer in this project are removed when you
            save a change to the reviewers.
          </p>
        ) : null}
        <p className="text-text-3 m-0 text-[12px]">
          With no reviewer, the project Owners review.
        </p>
        {errors.reviewers ? (
          <p className="text-danger text-[12px]">{errors.reviewers.message}</p>
        ) : null}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

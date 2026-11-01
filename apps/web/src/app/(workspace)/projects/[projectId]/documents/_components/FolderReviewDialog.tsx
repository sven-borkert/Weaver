"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { MAX_REVIEWERS } from "@weaver/core/documents/review";
import { ReviewerPicker } from "~/components/review/ReviewerPicker";
import {
  reviewerOptions,
  type ReviewerOption,
} from "~/components/review/reviewer-options";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { invalidateFolderReview } from "~/lib/documents/review-cache-invalidation";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";

// Client-side mirror of folder.reviewers target validation.
const schema = z.object({
  reviewers: z
    .array(z.object({ type: z.enum(["user", "group"]), id: z.string() }))
    .max(MAX_REVIEWERS, "Select at most 50 reviewers"),
});
const SAVED_REFRESH_FAILED_HINT =
  "Reviewers were saved, but refresh failed. Reload before editing documents.";
type Values = z.infer<typeof schema>;
type Defaults = RouterOutputs["folder"]["reviewDefaults"];
type Props = {
  projectId: string;
  path: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function folderReviewTriggerKey(projectId: string, path: string[]) {
  return encodeURIComponent(JSON.stringify({ projectId, path }));
}

export function FolderReviewDialog(props: Props) {
  return props.open ? (
    <OpenFolderReviewDialog
      key={folderReviewTriggerKey(props.projectId, props.path)}
      {...props}
    />
  ) : null;
}

function OpenFolderReviewDialog({
  projectId,
  path,
  open,
  onOpenChange,
}: Props) {
  const defaultsQuery = api.folder.reviewDefaults.useQuery(
    { projectId, path },
    { refetchOnMount: "always" },
  );
  const membersQuery = api.projectMember.list.useQuery({ projectId });
  const groupsQuery = api.reviewerGroup.list.useQuery({ projectId });
  const defaults = dataUnlessAccessError(
    defaultsQuery.data,
    defaultsQuery.error,
  );
  const members = dataUnlessAccessError(membersQuery.data, membersQuery.error);
  const groups = dataUnlessAccessError(groupsQuery.data, groupsQuery.error);
  const [pending, setPending] = useState(false);
  const [writeAccepted, setWriteAccepted] = useState(false);
  const trigger = useRef(
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLElement>(
          `[data-review-trigger="${folderReviewTriggerKey(projectId, path)}"]`,
        ),
  );
  const restoreFocus = useCallback((event: Event) => {
    event.preventDefault();
    focusDialogTarget(
      trigger.current,
      typeof document === "undefined"
        ? null
        : (document.querySelector<HTMLElement>("[data-explorer-focus]") ??
            document.querySelector<HTMLElement>(
              "[data-explorer-workspace-focus]",
            )),
    );
  }, []);
  const options = useMemo(
    () =>
      members && groups
        ? reviewerOptions(
            members.map((member) => ({
              userId: member.userId,
              name: member.user.name,
              email: member.email,
            })),
            groups,
          )
        : null,
    [members, groups],
  );
  const refreshing =
    defaultsQuery.isFetching ||
    membersQuery.isFetching ||
    groupsQuery.isFetching;
  const reload = async () => {
    await Promise.all([
      defaultsQuery.refetch(),
      membersQuery.refetch(),
      groupsQuery.refetch(),
    ]);
  };
  const failed = defaultsQuery.error ?? membersQuery.error ?? groupsQuery.error;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        aria-busy={pending}
        showCloseButton={!pending}
        onCloseAutoFocus={restoreFocus}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Set reviewers recursively</DialogTitle>
          <DialogDescription>
            Replace reviewers on existing documents and set the default for
            future documents in{" "}
            {path.length
              ? "this folder and its subfolders"
              : "the document root and all folders"}
            . Descendant folder defaults will be removed. Review intervals and
            review history are preserved.
          </DialogDescription>
        </DialogHeader>
        {defaults && options ? (
          <FolderReviewForm
            projectId={projectId}
            path={path}
            defaults={defaults}
            options={options}
            refreshing={refreshing}
            writeAccepted={writeAccepted}
            onWriteAccepted={() => setWriteAccepted(true)}
            onPendingChange={setPending}
            onDone={() => onOpenChange(false)}
            onReload={reload}
          />
        ) : (
          <>
            <p role={failed ? "alert" : "status"}>
              {failed
                ? "Could not load folder defaults, members and reviewer groups."
                : "Loading reviewers…"}
            </p>
            {writeAccepted && !pending ? (
              <p role="alert" className="text-danger text-sm">
                {SAVED_REFRESH_FAILED_HINT}
              </p>
            ) : null}
            {failed ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void reload()}
              >
                Retry
              </Button>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FolderReviewForm({
  projectId,
  path,
  defaults,
  options,
  refreshing,
  writeAccepted,
  onWriteAccepted,
  onPendingChange,
  onDone,
  onReload,
}: {
  projectId: string;
  path: string[];
  defaults: Defaults;
  options: ReviewerOption[];
  refreshing: boolean;
  writeAccepted: boolean;
  onWriteAccepted: () => void;
  onPendingChange: (pending: boolean) => void;
  onDone: () => void;
  onReload: () => Promise<void>;
}) {
  const utils = api.useUtils();
  const {
    control,
    setValue,
    setError,
    clearErrors,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    values: {
      reviewers: defaults.configuredReviewers.map(({ type, id }) => ({
        type,
        id,
      })),
    },
    resetOptions: { keepDirtyValues: true },
  });
  const reviewers = useWatch({ control, name: "reviewers" });
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<string | undefined>(
    writeAccepted ? SAVED_REFRESH_FAILED_HINT : undefined,
  );
  const pathKey = path.join("/");
  const input = useMemo(
    () => ({
      projectId,
      path: pathKey ? pathKey.split("/") : [],
      reviewers: reviewers.map(({ type, id }) => ({ type, id })),
    }),
    [projectId, pathKey, reviewers],
  );
  const unresolved = reviewers
    .filter(
      (ref) =>
        !options.some(
          (option) => option.type === ref.type && option.id === ref.id,
        ),
    )
    .map((ref) => ({
      ...ref,
      name:
        defaults.configuredReviewers.find(
          (stored) => stored.type === ref.type && stored.id === ref.id,
        )?.name ?? ref.id,
    }));
  const preview = api.folder.previewReview.useQuery(input, {
    enabled:
      !blocked &&
      !writeAccepted &&
      !unresolved.length &&
      reviewers.length <= MAX_REVIEWERS,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    trpc: { abortOnUnmount: true },
  });
  useEffect(
    () => () => {
      void utils.folder.previewReview.cancel(input);
    },
    [utils, input],
  );
  const assign = api.folder.setReviewRecursively.useMutation();
  const clear = api.folder.clearReviewDefault.useMutation();
  const disabled = pending || refreshing || !defaults.canManage;
  const writeDisabled = disabled || writeAccepted;
  const preflight = dataUnlessAccessError(preview.data, preview.error);
  const applyDisabled =
    writeDisabled ||
    blocked ||
    preview.isFetching ||
    Boolean(preview.error) ||
    !preflight ||
    preflight.exceedsLimits ||
    unresolved.length > 0 ||
    reviewers.length > MAX_REVIEWERS;
  const finish = async (write: () => Promise<unknown>) => {
    setPending(true);
    onPendingChange(true);
    setMessage(undefined);
    clearErrors();
    let saved = false;
    try {
      await write();
      saved = true;
      onWriteAccepted();
      await invalidateFolderReview(utils, projectId);
      toast.success("Folder reviewers saved");
      onDone();
    } catch (error) {
      setBlocked(true);
      const err = error as Parameters<typeof applyTrpcErrorToForm>[0];
      if (err.data?.field === "reviewers")
        applyTrpcErrorToForm(err, (name, fieldError) =>
          setError(name as keyof Values, fieldError),
        );
      setMessage(
        saved
          ? SAVED_REFRESH_FAILED_HINT
          : err.data?.code === "CONFLICT"
            ? "The project changed. Refresh the preview, check the counts, and apply again."
            : err.data?.field === "reviewers"
              ? undefined
              : "Could not save folder reviewers. Refresh and try again.",
      );
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  };
  const refreshPreview = async () => {
    if (disabled) return;
    setBlocked(true);
    if (writeAccepted) {
      setPending(true);
      onPendingChange(true);
      try {
        await invalidateFolderReview(utils, projectId);
        toast.success("Folder reviewers saved");
        onDone();
      } catch {
        setMessage(SAVED_REFRESH_FAILED_HINT);
      } finally {
        setPending(false);
        onPendingChange(false);
      }
      return;
    }
    try {
      await onReload();
      const refreshed = await preview.refetch();
      if (refreshed.error) return;
      setBlocked(false);
      setMessage(undefined);
      clearErrors();
    } catch {
      setMessage("Could not refresh the preview. Try again.");
    }
  };
  const source = defaults.hasOwnDefault
    ? path.length
      ? "This folder"
      : "This document root"
    : defaults.inheritedFrom === null
      ? "Project default"
      : defaults.inheritedFrom.length === 0
        ? "Inherited from document root"
        : `Inherited from ${defaults.inheritedFrom.join(" / ")}`;
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={handleSubmit(() => {
        if (applyDisabled || !preflight) return;
        void finish(() =>
          assign.mutateAsync({
            ...input,
            expectedHeadCommitSha: preflight.baseProjectCommitSha,
          }),
        );
      })}
    >
      <div className="text-text-2 flex flex-col gap-1 text-sm">
        <p>{source}</p>
        <p>
          Effective reviewers:{" "}
          {defaults.reviewers.map((ref) => ref.name).join(", ") ||
            "Project Owners"}
        </p>
      </div>
      <Controller
        control={control}
        name="reviewers"
        render={({ field }) => (
          <ReviewerPicker
            options={options}
            value={field.value}
            disabled={writeDisabled}
            unresolved={unresolved}
            onChange={(next) => {
              if (writeDisabled) return;
              clearErrors("reviewers");
              field.onChange(next.map(({ type, id }) => ({ type, id })));
            }}
            onRemoveUnresolved={(id) => {
              if (writeDisabled) return;
              setValue(
                "reviewers",
                reviewers.filter((ref) => ref.id !== id),
                { shouldDirty: true },
              );
              clearErrors("reviewers");
            }}
          />
        )}
      />
      <p className="text-text-3 text-xs">
        With no reviewer selected, project Owners review. Remove unavailable
        targets before applying.
      </p>
      {errors.reviewers ? (
        <p role="alert" className="text-danger text-sm">
          {errors.reviewers.message}
        </p>
      ) : null}
      {preview.isFetching ? (
        <p role="status">Loading preview…</p>
      ) : preflight && !blocked && !preview.error && !unresolved.length ? (
        <div role="status" className="text-text-2 text-sm">
          <p>
            {preflight.documentCount} documents in this subtree;{" "}
            {preflight.changedDocumentCount} documents will change;{" "}
            {preflight.descendantDefaultOverrideCount} descendant defaults will
            be removed.
          </p>
          {preflight.exceedsLimits ? (
            <p role="alert" className="text-danger">
              This batch exceeds 1,000 document rewrites or 50 MiB. Choose a
              smaller folder.
            </p>
          ) : null}
        </div>
      ) : null}
      {preview.error ? (
        <p role="alert" className="text-danger text-sm">
          Could not preview this change. Refresh and try again.
        </p>
      ) : null}
      {message ? (
        <p role="alert" className="text-danger text-sm">
          {message}
        </p>
      ) : null}
      {!defaults.canManage ? (
        <p role="alert">You no longer have permission to manage reviewers.</p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => void refreshPreview()}
      >
        Refresh preview
      </Button>
      {defaults.hasOwnDefault ? (
        <div className="flex flex-col gap-2">
          <p className="text-text-3 text-xs">
            Use parent default clears only this folder’s default. Existing
            documents keep their reviewers.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={writeDisabled || blocked}
            onClick={() => {
              if (writeDisabled || blocked) return;
              void finish(() =>
                clear.mutateAsync({
                  projectId,
                  path,
                  expectedHeadCommitSha: defaults.baseProjectCommitSha,
                }),
              );
            }}
          >
            Use parent default
          </Button>
        </div>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={applyDisabled}>
          {pending ? "Saving…" : "Apply"}
        </Button>
      </DialogFooter>
    </form>
  );
}

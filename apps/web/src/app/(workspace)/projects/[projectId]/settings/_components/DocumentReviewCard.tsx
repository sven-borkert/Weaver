"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ReviewerPicker } from "~/components/review/ReviewerPicker";
import {
  pruneTargets,
  reviewerOptions,
  sameTargets,
} from "~/components/review/reviewer-options";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
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
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";
import { ReviewerGroupDialog } from "./ReviewerGroupDialog";

type Defaults = RouterOutputs["reviewerGroup"]["getDefaults"];
type Group = RouterOutputs["reviewerGroup"]["list"][number];

/** Client-side mirror of the server's reviewerGroup.setDefaults input (minus projectId). */
const defaultsFormSchema = z.object({
  everyMonths: z
    .number("Enter a number of months")
    .int("Enter a whole number of months")
    .min(1, "Use at least 1 month")
    .max(120, "Use at most 120 months"),
  reviewers: z
    .array(z.object({ type: z.enum(["user", "group"]), id: z.string() }))
    .max(50, "Select at most 50 reviewers"),
});
type DefaultsFormValues = z.infer<typeof defaultsFormSchema>;

const toFormValues = (defaults: Defaults): DefaultsFormValues => ({
  everyMonths: defaults.everyMonths,
  reviewers: defaults.reviewers.map(({ type, id }) => ({ type, id })),
});

const prunedValues = (
  values: DefaultsFormValues,
  options: ReturnType<typeof reviewerOptions>,
): DefaultsFormValues => ({
  ...values,
  reviewers: pruneTargets(values.reviewers, options),
});

const sameValues = (a: DefaultsFormValues, b: DefaultsFormValues) =>
  Object.is(a.everyMonths, b.everyMonths) &&
  sameTargets(a.reviewers, b.reviewers);

export function DocumentReviewCard({ projectId }: { projectId: string }) {
  const defaultsQuery = api.reviewerGroup.getDefaults.useQuery({ projectId });
  const groupsQuery = api.reviewerGroup.list.useQuery({ projectId });
  const membersQuery = api.projectMember.list.useQuery({ projectId });
  const presentations = [
    resolveQueryPresentation(defaultsQuery),
    resolveQueryPresentation(groupsQuery),
    resolveQueryPresentation(membersQuery),
  ];
  const defaults = dataUnlessAccessError(
    defaultsQuery.data,
    defaultsQuery.error,
  );
  const groups = dataUnlessAccessError(groupsQuery.data, groupsQuery.error);
  const members = dataUnlessAccessError(membersQuery.data, membersQuery.error);
  const fetching =
    defaultsQuery.isFetching ||
    groupsQuery.isFetching ||
    membersQuery.isFetching;
  const loading = presentations.includes("loading");
  const failed = presentations.some((p) => p !== "data" && p !== "loading");

  return (
    <Card role="region" aria-label="Document review" tabIndex={-1}>
      <CardHeader>
        <CardTitle>Document review</CardTitle>
        <CardDescription>
          How often documents are reviewed, and who reviews them by default.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failed ? (
          <div className="flex flex-col items-start gap-2" role="alert">
            <p className="text-text-2 m-0 text-[13px]">
              Could not load the document review settings.
            </p>
            <Button
              variant="outline"
              disabled={fetching}
              onClick={() => {
                void defaultsQuery.refetch();
                void groupsQuery.refetch();
                void membersQuery.refetch();
              }}
            >
              {fetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : loading || !defaults || !groups || !members ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <ReviewSettings
            projectId={projectId}
            defaults={defaults}
            groups={groups}
            members={members}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ReviewSettings({
  projectId,
  defaults,
  groups,
  members,
}: {
  projectId: string;
  defaults: Defaults;
  groups: Group[];
  members: RouterOutputs["projectMember"]["list"];
}) {
  const utils = api.useUtils();
  const { canManage } = defaults;
  const sectionRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const deletedRef = useRef(false);
  const [editor, setEditor] = useState<
    { open: boolean; group: Group | null } | undefined
  >();
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null);

  const memberRows = useMemo(
    () =>
      members.map((member) => ({
        userId: member.userId,
        name: member.user.name,
        email: member.email,
      })),
    [members],
  );
  const memberOptions = useMemo(
    () => reviewerOptions(memberRows, []),
    [memberRows],
  );
  const pickerOptions = useMemo(
    () => [...reviewerOptions([], groups), ...memberOptions],
    [memberOptions, groups],
  );

  const removeGroup = api.reviewerGroup.delete.useMutation({
    onSuccess: () => {
      toast.success("Reviewer group deleted");
      deletedRef.current = true;
      setDeleteTarget(null);
      void utils.reviewerGroup.list.invalidate({ projectId });
      void utils.reviewerGroup.getDefaults.invalidate({ projectId });
    },
    onError: (err) => {
      toast.error(err.message || "Could not delete the reviewer group");
      setDeleteTarget(null);
      void utils.reviewerGroup.list.invalidate({ projectId });
      void utils.reviewerGroup.getDefaults.invalidate({ projectId });
    },
  });

  return (
    <div ref={sectionRef} className="flex flex-col gap-5">
      <DefaultsForm
        projectId={projectId}
        defaults={defaults}
        options={pickerOptions}
      />

      <section
        className="border-line flex flex-col gap-3 border-t pt-4"
        aria-label="Reviewer groups"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-text m-0 text-[14px] font-medium">
            Reviewer groups
          </h3>
          {canManage ? (
            <Button
              size="sm"
              variant="outline"
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                setEditor({ open: true, group: null });
              }}
            >
              New group
            </Button>
          ) : null}
        </div>
        {groups.length === 0 ? (
          <p className="text-text-3 m-0 text-[13px]">No reviewer groups yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {groups.map((group) => (
              <li
                key={group.id}
                className="border-line flex items-start justify-between gap-3 rounded-[6px] border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-text text-[13px] font-medium">
                    {group.name}
                  </span>
                  <span className="text-text-3 text-[12px]">
                    {group.members.length}{" "}
                    {group.members.length === 1 ? "member" : "members"}
                    {group.members.length > 0
                      ? `: ${group.members.map((m) => m.name).join(", ")}`
                      : ""}
                  </span>
                </div>
                {canManage ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Edit ${group.name}`}
                      onClick={(event) => {
                        triggerRef.current = event.currentTarget;
                        setEditor({ open: true, group });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Delete ${group.name}`}
                      disabled={removeGroup.isPending}
                      onClick={(event) => {
                        triggerRef.current = event.currentTarget;
                        deletedRef.current = false;
                        setDeleteTarget(group);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && editor ? (
        <ReviewerGroupDialog
          projectId={projectId}
          group={editor.group}
          memberOptions={memberOptions}
          open={editor.open}
          onOpenChange={(open) =>
            setEditor((current) => current && { ...current, open })
          }
        />
      ) : null}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (removeGroup.isPending) return;
          if (!nextOpen) setDeleteTarget(null);
        }}
      >
        <DialogContent
          aria-busy={removeGroup.isPending || undefined}
          showCloseButton={!removeGroup.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(
              deletedRef.current ? null : triggerRef.current,
              sectionRef.current,
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete reviewer group</DialogTitle>
            <DialogDescription>
              Delete reviewer group {deleteTarget?.name}? Documents assigned to
              it fall back to their other reviewers, or to the project Owners.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={removeGroup.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={removeGroup.isPending || deleteTarget === null}
              onClick={() => {
                if (deleteTarget) {
                  removeGroup.mutate({ projectId, groupId: deleteTarget.id });
                }
              }}
            >
              {removeGroup.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DefaultsForm({
  projectId,
  defaults,
  options,
}: {
  projectId: string;
  defaults: Defaults;
  options: ReturnType<typeof reviewerOptions>;
}) {
  const utils = api.useUtils();
  const { canManage } = defaults;
  const {
    register,
    control,
    setError,
    reset,
    setValue,
    getValues,
    handleSubmit,
    formState: { errors },
  } = useForm<DefaultsFormValues>({
    resolver: zodResolver(defaultsFormSchema),
    defaultValues: toFormValues(defaults),
  });
  const baseline = useRef(toFormValues(defaults));

  // Adopt fresh server defaults only while pristine; always drop targets that vanished from the options.
  useEffect(() => {
    const previous = prunedValues(baseline.current, options);
    const next = prunedValues(toFormValues(defaults), options);
    const current = prunedValues(getValues(), options);
    baseline.current = next;
    if (sameValues(current, previous)) {
      reset(next);
    } else if (current.reviewers.length !== getValues().reviewers.length) {
      setValue("reviewers", current.reviewers);
    }
  }, [defaults, options, getValues, reset, setValue]);

  const save = api.reviewerGroup.setDefaults.useMutation({
    onSuccess: (_saved, variables) => {
      toast.success("Review defaults saved");
      const saved = {
        everyMonths: variables.everyMonths,
        reviewers: variables.reviewers,
      };
      baseline.current = saved;
      reset(saved);
      void utils.reviewerGroup.getDefaults.invalidate({ projectId });
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as keyof DefaultsFormValues, error),
        );
      } else {
        toast.error(err.message || "Could not save the review defaults");
      }
    },
  });

  return (
    <form
      aria-label="Review defaults"
      noValidate
      onSubmit={handleSubmit((values) => {
        if (!canManage || save.isPending) return;
        save.mutate({
          projectId,
          ...values,
          reviewers: pruneTargets(values.reviewers, options),
        });
      })}
    >
      <fieldset
        disabled={!canManage || save.isPending}
        className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
      >
        <p className="text-text-3 m-0 text-[12px]">
          New documents get these reviewers and this interval. With no default
          reviewer, the project Owners review.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="review-every-months">Review every (months)</Label>
          <Input
            id="review-every-months"
            type="number"
            min={1}
            max={120}
            step={1}
            className="w-32"
            disabled={!canManage || save.isPending}
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
          <Label>Default reviewers</Label>
          <Controller
            control={control}
            name="reviewers"
            render={({ field }) => (
              <ReviewerPicker
                aria-label="Default reviewers"
                options={options}
                value={field.value}
                onChange={field.onChange}
                disabled={!canManage || save.isPending}
              />
            )}
          />
          {errors.reviewers ? (
            <p className="text-danger text-[12px]">
              {errors.reviewers.message}
            </p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex justify-end">
            <Button type="submit">{save.isPending ? "Saving…" : "Save"}</Button>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}

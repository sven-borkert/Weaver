"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ReviewerPicker } from "~/components/review/ReviewerPicker";
import type { ReviewerOption } from "~/components/review/reviewer-options";
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
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";

type Group = RouterOutputs["reviewerGroup"]["list"][number];

/** Client-side mirror of the server's reviewerGroup.create input (minus projectId). */
const groupFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(80, "Use at most 80 characters"),
  memberIds: z.array(z.string()).max(200, "Select at most 200 members"),
});
type GroupFormValues = z.infer<typeof groupFormSchema>;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

export function ReviewerGroupDialog({
  projectId,
  group,
  memberOptions,
  open,
  onOpenChange,
}: {
  projectId: string;
  group: Group | null;
  memberOptions: ReviewerOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = api.useUtils();
  const create = api.reviewerGroup.create.useMutation();
  const rename = api.reviewerGroup.rename.useMutation();
  const setMembers = api.reviewerGroup.setMembers.useMutation();
  const pending = create.isPending || rename.isPending || setMembers.isPending;
  const editing = group !== null;
  // Name already saved by an earlier submit of this dialog session, so a retry skips the rename.
  const savedName = useRef<{ groupId: string; name: string } | null>(null);
  const close = () => {
    savedName.current = null;
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        aria-busy={pending || undefined}
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit reviewer group" : "New reviewer group"}
          </DialogTitle>
          <DialogDescription>
            A named set of project members that can be assigned as reviewers.
          </DialogDescription>
        </DialogHeader>
        <GroupForm
          key={group?.id ?? "new"}
          group={group}
          memberOptions={memberOptions}
          pending={pending}
          onSubmit={async (values, setError) => {
            const original = group?.members.map((m) => m.userId) ?? [];
            const baseName =
              group && savedName.current?.groupId === group.id
                ? savedName.current.name
                : group?.name;
            let step: "rename" | "members" = "rename";
            try {
              if (!group) {
                await create.mutateAsync({ projectId, ...values });
              } else {
                if (values.name !== baseName) {
                  await rename.mutateAsync({
                    projectId,
                    groupId: group.id,
                    name: values.name,
                  });
                  savedName.current = { groupId: group.id, name: values.name };
                }
                step = "members";
                if (!sameSet(values.memberIds, original)) {
                  await setMembers.mutateAsync({
                    projectId,
                    groupId: group.id,
                    memberIds: values.memberIds,
                  });
                }
              }
            } catch (err) {
              const error = err as Parameters<typeof applyTrpcErrorToForm>[0];
              const nameSaved =
                step === "members" && savedName.current !== null;
              const message = nameSaved
                ? `The name was saved, but the members could not be updated${
                    error.message ? `: ${error.message}` : "."
                  }`
                : error.message;
              if (error.data?.field) {
                applyTrpcErrorToForm({ ...error, message }, (name, detail) =>
                  setError(name as keyof GroupFormValues, detail),
                );
              } else {
                toast.error(
                  message ||
                    (group
                      ? "Could not update the reviewer group"
                      : "Could not create the reviewer group"),
                );
              }
              return;
            } finally {
              void utils.reviewerGroup.list.invalidate({ projectId });
              void utils.reviewerGroup.getDefaults.invalidate({ projectId });
            }
            toast.success(
              group ? "Reviewer group updated" : "Reviewer group created",
            );
            close();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function GroupForm({
  group,
  memberOptions,
  pending,
  onSubmit,
}: {
  group: Group | null;
  memberOptions: ReviewerOption[];
  pending: boolean;
  onSubmit: (
    values: GroupFormValues,
    setError: (name: keyof GroupFormValues, error: { message: string }) => void,
  ) => Promise<void>;
}) {
  const known = new Set(memberOptions.map((option) => option.id));
  const {
    register,
    control,
    setError,
    handleSubmit,
    formState: { errors },
  } = useForm<GroupFormValues>({
    resolver: zodResolver(groupFormSchema),
    defaultValues: {
      name: group?.name ?? "",
      memberIds: (group?.members ?? [])
        .map((member) => member.userId)
        .filter((id) => known.has(id)),
    },
  });

  return (
    <form
      onSubmit={handleSubmit((values) => onSubmit(values, setError))}
      className="flex flex-col gap-3"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reviewer-group-name">Name</Label>
        <Input
          id="reviewer-group-name"
          autoFocus
          autoComplete="off"
          disabled={pending}
          aria-invalid={errors.name ? true : undefined}
          {...register("name")}
        />
        {errors.name ? (
          <p className="text-danger text-[12px]">{errors.name.message}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Members</Label>
        <Controller
          control={control}
          name="memberIds"
          render={({ field }) => (
            <ReviewerPicker
              aria-label="Members"
              options={memberOptions}
              value={field.value.map((id) => ({ type: "user", id }))}
              onChange={(next) => field.onChange(next.map((t) => t.id))}
              disabled={pending}
            />
          )}
        />
        {errors.memberIds ? (
          <p className="text-danger text-[12px]">{errors.memberIds.message}</p>
        ) : null}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

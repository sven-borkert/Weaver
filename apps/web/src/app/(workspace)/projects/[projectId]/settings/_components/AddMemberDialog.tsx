"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { UserPlus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";

export const PROJECT_ROLES = [
  "Owner",
  "Maintainer",
  "Editor",
  "Viewer",
] as const;

/** Client-side mirror of the server's projectMember.add input (minus projectId). */
const addMemberFormSchema = z.object({
  email: z.email("Enter a valid email address"),
  role: z.enum(PROJECT_ROLES),
});

type AddMemberFormValues = z.infer<typeof addMemberFormSchema>;

const defaultValues: AddMemberFormValues = { email: "", role: "Viewer" };

export function AddMemberDialog({
  projectId,
  grantableRoles,
}: {
  projectId: string;
  grantableRoles: readonly (typeof PROJECT_ROLES)[number][];
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);

  const {
    register,
    setError,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<AddMemberFormValues>({
    resolver: zodResolver(addMemberFormSchema),
    defaultValues,
  });

  const addMember = api.projectMember.add.useMutation({
    onSuccess: () => {
      toast.success("Member added");
      void utils.account.landingProject.invalidate();
      void utils.projectMember.list.invalidate({ projectId });
      setOpen(false);
      reset(defaultValues);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as keyof AddMemberFormValues, error),
        );
      } else {
        toast.error(err.message || "Could not add the member");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    addMember.mutate({ projectId, email: values.email, role: values.role });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (addMember.isPending) return;
        setOpen(nextOpen);
        if (!nextOpen) reset(defaultValues);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <UserPlus data-icon="inline-start" />
          Add member
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={addMember.isPending || undefined}
        showCloseButton={!addMember.isPending}
      >
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Add someone to this project using their email address.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-member-email">Email</Label>
            <Input
              id="add-member-email"
              type="email"
              autoFocus
              placeholder="person@example.com"
              aria-invalid={errors.email ? true : undefined}
              {...register("email")}
            />
            {errors.email ? (
              <p className="text-danger text-[12px]">{errors.email.message}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-member-role">Role</Label>
            <Controller
              control={control}
              name="role"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="add-member-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {grantableRoles.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.role ? (
              <p className="text-danger text-[12px]">{errors.role.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={addMember.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={addMember.isPending}>
              {addMember.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

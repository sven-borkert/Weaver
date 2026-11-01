"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { withBasePath } from "~/lib/basePath";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { confirmNavigation } from "~/lib/use-unsaved-changes-guard";
import { api } from "~/trpc/react";

/** Client-side mirror of the server's project.create input. */
const createProjectFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(120, "Name must be at most 120 characters"),
  description: z
    .string()
    .trim()
    .max(2000, "Description must be at most 2000 characters")
    .optional(),
});

type CreateProjectFormValues = z.infer<typeof createProjectFormSchema>;

const defaultValues: CreateProjectFormValues = { name: "", description: "" };

export function CreateProjectDialog({
  onOpenChange,
}: {
  /** Notified on every open/close, e.g. so a parent menu can close alongside a cancel. */
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<CreateProjectFormValues>({
    resolver: zodResolver(createProjectFormSchema),
    defaultValues,
  });

  const createProject = api.project.create.useMutation({
    onSuccess: (project) => {
      toast.success("Project created");
      void utils.project.list.invalidate();
      setOpen(false);
      reset(defaultValues);
      const destination = `/projects/${project.id}/settings`;
      if (confirmNavigation(withBasePath(destination)))
        router.push(destination);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error(err.message || "Could not create the project");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    createProject.mutate({
      name: values.name,
      description: values.description?.trim() ? values.description : undefined,
    });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (createProject.isPending) return;
        setOpen(nextOpen);
        if (!nextOpen) reset(defaultValues);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus data-icon="inline-start" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Projects hold documents, tables and knowledge graphs.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-name">Name</Label>
            <Input
              id="create-project-name"
              autoFocus
              placeholder="My project"
              aria-invalid={errors.name ? true : undefined}
              {...register("name")}
            />
            {errors.name ? (
              <p className="text-danger text-[12px]">{errors.name.message}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-description">
              Description{" "}
              <span className="text-text-muted font-normal">(optional)</span>
            </Label>
            <Textarea
              id="create-project-description"
              rows={3}
              placeholder="What is this project about?"
              aria-invalid={errors.description ? true : undefined}
              {...register("description")}
            />
            {errors.description ? (
              <p className="text-danger text-[12px]">
                {errors.description.message}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={createProject.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={createProject.isPending}>
              {createProject.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

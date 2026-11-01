"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type ProjectGet = RouterOutputs["project"]["get"];

/** Client-side mirror of the server's project.update fields. */
const projectSettingsFormSchema = z.object({
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

type ProjectSettingsFormValues = z.infer<typeof projectSettingsFormSchema>;

export function ProjectSettingsForm({
  project,
  canEdit,
}: {
  project: ProjectGet;
  canEdit: boolean;
}) {
  const utils = api.useUtils();

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<ProjectSettingsFormValues>({
    resolver: zodResolver(projectSettingsFormSchema),
    defaultValues: {
      name: project.name,
      description: project.description ?? "",
    },
  });

  const updateProject = api.project.update.useMutation({
    onSuccess: (_updated, variables) => {
      toast.success("Project updated");
      void utils.project.get.invalidate({ projectId: variables.projectId });
      void utils.account.landingProject.invalidate();
      void utils.project.list.invalidate();
      reset({
        name: variables.name ?? project.name,
        description: variables.description ?? "",
      });
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error(err.message || "Could not save the changes");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    updateProject.mutate({
      projectId: project.id,
      name: values.name,
      description: values.description?.trim() ? values.description : null,
    });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Name and description of the project.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          {!canEdit ? (
            <div className="bg-info-bg text-info border-info-border rounded-[6px] border px-3 py-2 text-[12px]">
              You have read-only access
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-settings-name">Name</Label>
            <Input
              id="project-settings-name"
              disabled={!canEdit || updateProject.isPending}
              aria-invalid={errors.name ? true : undefined}
              {...register("name")}
            />
            {errors.name ? (
              <p className="text-danger text-[12px]">{errors.name.message}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-settings-description">Description</Label>
            <Textarea
              id="project-settings-description"
              rows={3}
              disabled={!canEdit || updateProject.isPending}
              aria-invalid={errors.description ? true : undefined}
              {...register("description")}
            />
            {errors.description ? (
              <p className="text-danger text-[12px]">
                {errors.description.message}
              </p>
            ) : null}
          </div>
          {canEdit ? (
            <div className="flex justify-end">
              <Button type="submit" disabled={updateProject.isPending}>
                {updateProject.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

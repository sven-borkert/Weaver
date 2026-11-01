"use client";

import { zodResolver } from "@hookform/resolvers/zod";
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
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import type { ArtifactRow } from "./ArtifactsTable";

// Client-side mirror of the server's renameArtifactInput filename.
const renameArtifactSchema = z.object({
  filename: z.string().trim().min(1).max(255),
});
type RenameArtifactValues = z.infer<typeof renameArtifactSchema>;

export function RenameArtifactDialog({
  projectId,
  artifact,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  projectId: string;
  artifact: ArtifactRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        aria-busy={pending || undefined}
        showCloseButton={!pending}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>
            Choose a new name for <strong>{artifact?.filename}</strong>. It must
            be unique in this project.
          </DialogDescription>
        </DialogHeader>
        {artifact ? (
          <RenameArtifactForm
            key={`${artifact.id}:${String(open)}`}
            projectId={projectId}
            artifact={artifact}
            onOpenChange={onOpenChange}
            onPendingChange={setPending}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameArtifactForm({
  projectId,
  artifact,
  onOpenChange,
  onPendingChange,
}: {
  projectId: string;
  artifact: ArtifactRow;
  onOpenChange: (open: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const utils = api.useUtils();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<RenameArtifactValues>({
    resolver: zodResolver(renameArtifactSchema),
    defaultValues: { filename: artifact.filename },
  });
  const rename = api.artifact.rename.useMutation({
    onSuccess: () => {
      toast.success("File renamed");
      void utils.artifact.list.invalidate({ projectId });
      onOpenChange(false);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error("Could not rename the file");
      }
    },
    onSettled: () => onPendingChange(false),
  });

  const onSubmit = handleSubmit((values) => {
    onPendingChange(true);
    rename.mutate({
      projectId,
      artifactId: artifact.id,
      filename: values.filename,
    });
  });

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3"
      aria-busy={rename.isPending}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rename-artifact-filename">File name</Label>
        <Input
          id="rename-artifact-filename"
          autoFocus
          disabled={rename.isPending}
          aria-invalid={errors.filename ? true : undefined}
          aria-describedby={
            errors.filename ? "rename-artifact-filename-error" : undefined
          }
          {...register("filename")}
        />
        {errors.filename ? (
          <p
            id="rename-artifact-filename-error"
            role="alert"
            className="text-danger text-[12px]"
          >
            {errors.filename.message}
          </p>
        ) : null}
      </div>
      {rename.error && !rename.error.data?.field ? (
        <p role="alert" className="text-danger m-0 text-[12px]">
          Could not rename the file. Try again.
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={rename.isPending}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="submit"
          disabled={rename.isPending}
          aria-busy={rename.isPending}
        >
          {rename.isPending ? "Renaming…" : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  );
}

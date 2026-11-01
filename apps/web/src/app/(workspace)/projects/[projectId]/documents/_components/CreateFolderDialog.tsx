"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FolderPlus } from "lucide-react";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";

/** Client-side mirror of the server's folder.create input (minus projectId and parentPath). */
const createFolderFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

type CreateFolderFormValues = z.infer<typeof createFolderFormSchema>;

const defaultValues: CreateFolderFormValues = { name: "" };

type CreateFolderDialogProps = {
  projectId: string;
  parentPath: string[];
  onFolderCreated: (path: string[]) => void;
};

export function CreateFolderDialog({
  projectId,
  parentPath,
  onFolderCreated,
}: CreateFolderDialogProps) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<CreateFolderFormValues>({
    resolver: zodResolver(createFolderFormSchema),
    defaultValues,
  });

  const createFolder = api.folder.create.useMutation({
    onSuccess: (folder) => {
      toast.success("Folder created");
      void utils.folder.tree.invalidate({ projectId });
      setOpen(false);
      reset(defaultValues);
      onFolderCreated(folder.path);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error("Could not create the folder");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    createFolder.mutate({ projectId, parentPath, name: values.name });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (createFolder.isPending) return;
        if (nextOpen) createFolder.reset();
        setOpen(nextOpen);
        if (!nextOpen) reset(defaultValues);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderPlus data-icon="inline-start" />
          New folder
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!createFolder.isPending}>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Create a folder in{" "}
            {parentPath.length ? parentPath.join(" / ") : "the project root"}.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
          aria-busy={createFolder.isPending}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-folder-name">Name</Label>
            <Input
              id="create-folder-name"
              autoFocus
              disabled={createFolder.isPending}
              placeholder="Guides"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={
                errors.name ? "create-folder-name-error" : undefined
              }
              {...register("name")}
            />
            {errors.name ? (
              <p
                id="create-folder-name-error"
                role="alert"
                className="text-danger text-[12px]"
              >
                {errors.name.message}
              </p>
            ) : null}
          </div>
          {createFolder.error && !createFolder.error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not create the folder. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={createFolder.isPending}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={createFolder.isPending}
              aria-busy={createFolder.isPending}
            >
              {createFolder.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

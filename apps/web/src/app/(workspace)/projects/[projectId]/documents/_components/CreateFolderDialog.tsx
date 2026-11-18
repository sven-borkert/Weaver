"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FolderPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
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
import { localDocumentsHref } from "~/lib/documents/local-documents-url";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import { KeepOutOfGitField } from "./KeepOutOfGitField";

/** Client-side mirror of the folder creation fields, with the storage choice. */
const createFolderFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  keepOutOfGit: z.boolean(),
});

type CreateFolderFormValues = z.infer<typeof createFolderFormSchema>;

const defaultValues: CreateFolderFormValues = { name: "", keepOutOfGit: false };

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
  const router = useRouter();
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);

  const {
    control,
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<CreateFolderFormValues>({
    resolver: zodResolver(createFolderFormSchema),
    defaultValues,
  });
  const keepOutOfGit = useWatch({ control, name: "keepOutOfGit" });

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

  const createLocal = api.localDocument.create.useMutation({
    onSuccess: (folder) => {
      toast.success("Folder created in Outside Git");
      const { markdown: _markdown, ...summary } = folder;
      utils.localDocument.list.setData({ projectId }, (entries) =>
        entries && !entries.some((entry) => entry.id === folder.id)
          ? [...entries, summary]
          : entries,
      );
      void utils.localDocument.list.invalidate({ projectId });
      setOpen(false);
      reset(defaultValues);
      router.push(localDocumentsHref(projectId, { folder: folder.id }));
    },
    onError: (err) => {
      if (err.data?.field === "title")
        applyTrpcErrorToForm(err, (_name, error) => setError("name", error));
    },
  });
  const pending = createFolder.isPending || createLocal.isPending;
  const error = keepOutOfGit ? createLocal.error : createFolder.error;

  const onSubmit = handleSubmit((values) => {
    if (values.keepOutOfGit) {
      createLocal.mutate({ projectId, kind: "folder", title: values.name });
      return;
    }
    createFolder.mutate({ projectId, parentPath, name: values.name });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        if (nextOpen) {
          createFolder.reset();
          createLocal.reset();
        }
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
      <DialogContent showCloseButton={!pending} aria-busy={pending}>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Create a folder in{" "}
            {keepOutOfGit
              ? "the project’s Outside Git area"
              : parentPath.length
                ? parentPath.join(" / ")
                : "the project root"}
            .
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
          aria-busy={pending}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-folder-name">Name</Label>
            <Input
              id="create-folder-name"
              autoFocus
              disabled={pending}
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
          <KeepOutOfGitField
            field={register("keepOutOfGit")}
            disabled={pending}
          />
          {error && !error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not create the folder. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

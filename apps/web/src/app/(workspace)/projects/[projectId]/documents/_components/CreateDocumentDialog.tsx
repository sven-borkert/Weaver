"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FilePlus } from "lucide-react";
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

/** Client-side mirror of the document creation fields, with the storage choice. */
const createDocumentFormSchema = z.object({
  title: z.string().trim().min(1, "Enter a title").max(200),
  keepOutOfGit: z.boolean(),
});

type CreateDocumentFormValues = z.infer<typeof createDocumentFormSchema>;

const defaultValues: CreateDocumentFormValues = {
  title: "",
  keepOutOfGit: false,
};

type CreateDocumentDialogProps = {
  projectId: string;
  folderPath: string[];
};

export function CreateDocumentDialog({
  projectId,
  folderPath,
}: CreateDocumentDialogProps) {
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
  } = useForm<CreateDocumentFormValues>({
    resolver: zodResolver(createDocumentFormSchema),
    defaultValues,
  });
  const keepOutOfGit = useWatch({ control, name: "keepOutOfGit" });

  const createDocument = api.document.create.useMutation({
    onSuccess: (document) => {
      toast.success("Document created");
      void utils.document.list.invalidate({ projectId });
      void utils.folder.tree.invalidate({ projectId });
      setOpen(false);
      reset(defaultValues);
      router.push(`/projects/${projectId}/documents/${document.id}`);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error("Could not create the document");
      }
    },
  });

  const createLocal = api.localDocument.create.useMutation({
    onSuccess: (document) => {
      toast.success("Document created in Outside Git");
      utils.localDocument.get.setData(
        { projectId, entryId: document.id },
        document,
      );
      void utils.localDocument.list.invalidate({ projectId });
      setOpen(false);
      reset(defaultValues);
      router.push(localDocumentsHref(projectId, { document: document.id }));
    },
    onError: (err) => {
      if (err.data?.field === "title")
        applyTrpcErrorToForm(err, (_name, error) => setError("title", error));
    },
  });
  const pending = createDocument.isPending || createLocal.isPending;
  const error = keepOutOfGit ? createLocal.error : createDocument.error;

  const onSubmit = handleSubmit((values) => {
    if (values.keepOutOfGit) {
      createLocal.mutate({ projectId, kind: "document", title: values.title });
      return;
    }
    createDocument.mutate({
      projectId,
      folderPath,
      title: values.title,
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        if (nextOpen) {
          createDocument.reset();
          createLocal.reset();
        }
        setOpen(nextOpen);
        if (!nextOpen) reset(defaultValues);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <FilePlus data-icon="inline-start" />
          New document
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!pending} aria-busy={pending}>
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>
            Create a document in{" "}
            {keepOutOfGit
              ? "the project’s Outside Git area"
              : folderPath.length
                ? folderPath.join(" / ")
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
            <Label htmlFor="create-document-title">Title</Label>
            <Input
              id="create-document-title"
              autoFocus
              disabled={pending}
              placeholder="Untitled document"
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={
                errors.title ? "create-document-title-error" : undefined
              }
              {...register("title")}
            />
            {errors.title ? (
              <p
                id="create-document-title-error"
                role="alert"
                className="text-danger text-[12px]"
              >
                {errors.title.message}
              </p>
            ) : null}
          </div>
          <KeepOutOfGitField
            field={register("keepOutOfGit")}
            disabled={pending}
          />
          {error && !error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not create the document. Try again.
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

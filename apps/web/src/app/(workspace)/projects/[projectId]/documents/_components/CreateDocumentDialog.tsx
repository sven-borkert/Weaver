"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FilePlus } from "lucide-react";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";

/** Client-side mirror of the server's document.create input (minus projectId, folderPath, and contentJson). */
const createDocumentFormSchema = z.object({
  title: z.string().trim().min(1, "Enter a title").max(200),
});

type CreateDocumentFormValues = z.infer<typeof createDocumentFormSchema>;

const defaultValues: CreateDocumentFormValues = { title: "" };

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
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<CreateDocumentFormValues>({
    resolver: zodResolver(createDocumentFormSchema),
    defaultValues,
  });

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

  const onSubmit = handleSubmit((values) => {
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
        if (createDocument.isPending) return;
        if (nextOpen) createDocument.reset();
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
      <DialogContent showCloseButton={!createDocument.isPending}>
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>
            Create a document in{" "}
            {folderPath.length ? folderPath.join(" / ") : "the project root"}.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3"
          aria-busy={createDocument.isPending}
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-document-title">Title</Label>
            <Input
              id="create-document-title"
              autoFocus
              disabled={createDocument.isPending}
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
          {createDocument.error && !createDocument.error.data?.field ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              Could not create the document. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={createDocument.isPending}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={createDocument.isPending}
              aria-busy={createDocument.isPending}
            >
              {createDocument.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

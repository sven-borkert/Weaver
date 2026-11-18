"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { normalizeFolderName } from "@weaver/core/documents/folderMetadata";
import { documentTitleSchema } from "@weaver/core/documents/title";
import { useId, useState, type RefObject } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { api } from "~/trpc/react";
import type { LocalEntrySummary } from "./LocalDocumentsScreen";

export type LocalEntryAction = (
  | { type: "create"; kind: LocalEntrySummary["kind"]; parentId: string | null }
  | { type: "rename" | "delete"; entry: LocalEntrySummary }
) & { trigger: HTMLButtonElement | null };

const folderTitleSchema = z
  .string()
  .trim()
  .refine(
    (title) => normalizeFolderName(title) !== null,
    "Enter a folder name of 1 to 120 characters on a single line.",
  );

export function LocalEntryDialog({
  projectId,
  action,
  focusFallback,
  onClose,
  onCreated,
}: {
  projectId: string;
  action: LocalEntryAction;
  focusFallback: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: (entry: LocalEntrySummary) => void;
}) {
  const utils = api.useUtils();
  const nameId = useId();
  const [open, setOpen] = useState(true);
  const kind = action.type === "create" ? action.kind : action.entry.kind;
  const editingTitle = action.type !== "delete";
  const heading =
    action.type === "create"
      ? `New ${kind}`
      : `${action.type === "rename" ? "Rename" : "Delete"} ${kind}`;
  const schema = z.object({
    title: kind === "folder" ? folderTitleSchema : documentTitleSchema,
  });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      title: action.type === "rename" ? action.entry.title : "",
    },
  });
  const [failure, setFailure] = useState<string>();
  const create = api.localDocument.create.useMutation();
  const update = api.localDocument.update.useMutation();
  const remove = api.localDocument.delete.useMutation();
  const busy = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;

  const saveTitle = handleSubmit(async ({ title }) => {
    if (busy || action.type === "delete") return;
    setFailure(undefined);
    try {
      const saved =
        action.type === "create"
          ? await create.mutateAsync({
              projectId,
              kind,
              parentId: action.parentId,
              title,
            })
          : await update.mutateAsync({
              projectId,
              entryId: action.entry.id,
              revision: action.entry.revision,
              title,
            });
      const { markdown, ...summary } = saved;
      utils.localDocument.list.setData({ projectId }, (entries) =>
        entries
          ? [...entries.filter((entry) => entry.id !== saved.id), summary]
          : entries,
      );
      utils.localDocument.get.setData(
        { projectId, entryId: saved.id },
        {
          ...summary,
          markdown,
        },
      );
      void utils.localDocument.list.invalidate({ projectId });
      toast.success(
        kind === "folder"
          ? action.type === "create"
            ? "Folder created"
            : "Folder renamed"
          : action.type === "create"
            ? "Document created"
            : "Document renamed",
      );
      setOpen(false);
      if (action.type === "create" && action.trigger?.isConnected)
        onCreated(summary);
    } catch (err) {
      const data = (err as { data?: { field?: string; code?: string } }).data;
      if (data?.field === "title") {
        setError("title", {
          message:
            data.code === "CONFLICT"
              ? "This folder already contains an item with that name."
              : "Enter a valid name.",
        });
      } else if (data?.code === "CONFLICT") {
        setFailure("This item changed. Close this dialog and try again.");
        void utils.localDocument.list.invalidate({ projectId });
      } else {
        setFailure(`Could not ${action.type} the ${kind}. Try again.`);
      }
    }
  });

  const deleteEntry = async () => {
    if (busy || action.type !== "delete") return;
    setFailure(undefined);
    const { id, revision } = action.entry;
    try {
      await remove.mutateAsync({ projectId, entryId: id, revision });
      utils.localDocument.list.setData({ projectId }, (entries) =>
        entries?.filter((entry) => entry.id !== id),
      );
      void utils.localDocument.get.reset({ projectId, entryId: id });
      void utils.localDocument.list.invalidate({ projectId });
      toast.success(kind === "folder" ? "Folder deleted" : "Document deleted");
      setOpen(false);
    } catch (err) {
      const data = (err as { data?: { code?: string } }).data;
      if (data?.code === "PRECONDITION_FAILED") {
        setFailure(
          "Delete the items in this folder before deleting the folder.",
        );
      } else if (data?.code === "CONFLICT" || data?.code === "NOT_FOUND") {
        setFailure("This item changed. Close this dialog and try again.");
        void utils.localDocument.list.invalidate({ projectId });
      } else {
        setFailure(`Could not delete the ${kind}. Try again.`);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogContent
        aria-busy={busy}
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(action.trigger, focusFallback.current);
          onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {action.type === "create"
              ? `Create a ${kind} outside Git.`
              : action.type === "rename"
                ? `Change the name of this ${kind}.`
                : `Permanently delete “${action.entry.title}”?`}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={
            editingTitle
              ? saveTitle
              : (event) => {
                  event.preventDefault();
                  void deleteEntry();
                }
          }
          className="flex flex-col gap-4"
        >
          {editingTitle ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={nameId}>
                {kind === "folder" ? "Folder name" : "Document title"}
              </Label>
              <Input
                id={nameId}
                autoFocus
                disabled={busy}
                aria-invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? `${nameId}-error` : undefined}
                {...register("title")}
              />
              {errors.title ? (
                <p
                  id={`${nameId}-error`}
                  role="alert"
                  className="text-danger text-xs"
                >
                  {errors.title.message}
                </p>
              ) : null}
            </div>
          ) : null}
          {failure ? (
            <p role="alert" className="text-danger text-xs">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={editingTitle ? "default" : "destructive"}
              disabled={
                busy || (error?.data?.code === "CONFLICT" && !error.data.field)
              }
            >
              {busy
                ? "Working…"
                : action.type === "create"
                  ? "Create"
                  : action.type === "rename"
                    ? "Save"
                    : "Delete"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

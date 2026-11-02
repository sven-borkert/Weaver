"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import {
  MAX_WIKI_SUMMARY_CHARS,
  MAX_WIKI_TAGS,
  MAX_WIKI_TAG_CHARS,
  MAX_WIKI_TYPE_CHARS,
  isReservedWikiType,
} from "@weaver/core/wiki/properties";
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
import { focusDialogTarget } from "~/lib/dialog-focus";
import { invalidateDocumentReview } from "~/lib/documents/review-cache-invalidation";
import { api, type RouterOutputs } from "~/trpc/react";

type Document = RouterOutputs["document"]["get"];

const formSchema = z.object({
  type: z
    .string()
    .trim()
    .max(MAX_WIKI_TYPE_CHARS, `Use at most ${MAX_WIKI_TYPE_CHARS} characters`)
    .refine((value) => !isReservedWikiType(value), "This type is reserved"),
  summary: z
    .string()
    .trim()
    .max(
      MAX_WIKI_SUMMARY_CHARS,
      `Use at most ${MAX_WIKI_SUMMARY_CHARS} characters`,
    ),
  tags: z.string().refine((value) => {
    const tags = splitTags(value);
    return (
      tags.length <= MAX_WIKI_TAGS &&
      tags.every((tag) => [...tag].length <= MAX_WIKI_TAG_CHARS)
    );
  }, `Use at most ${MAX_WIKI_TAGS} tags of ${MAX_WIKI_TAG_CHARS} characters`),
});
type FormValues = z.infer<typeof formSchema>;

export function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

/** Only a field the user changed is sent; an emptied field is cleared with null. */
export function propertiesPatch(
  values: FormValues,
  original: FormValues,
): { type?: string | null; summary?: string | null; tags?: string[] | null } {
  const patch: ReturnType<typeof propertiesPatch> = {};
  if (values.type.trim() !== original.type.trim())
    patch.type = values.type.trim() || null;
  if (values.summary.trim() !== original.summary.trim())
    patch.summary = values.summary.trim() || null;
  if (
    splitTags(values.tags).join("\n") !== splitTags(original.tags).join("\n")
  ) {
    const tags = splitTags(values.tags);
    patch.tags = tags.length ? tags : null;
  }
  return patch;
}

export function PropertiesDialog({
  projectId,
  document,
  baseCommitSha,
  open,
  onOpenChange,
  triggerRef,
}: {
  projectId: string;
  document: Document;
  baseCommitSha: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: { current: HTMLButtonElement | null };
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-busy={busy || undefined}
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(triggerRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>Page properties</DialogTitle>
          <DialogDescription>
            Type, summary and tags describe this page in lists and the Index
            view.
          </DialogDescription>
        </DialogHeader>
        <PropertiesForm
          projectId={projectId}
          document={document}
          baseCommitSha={baseCommitSha}
          busy={busy}
          onBusyChange={setBusy}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function PropertiesForm({
  projectId,
  document,
  baseCommitSha,
  busy,
  onBusyChange,
  onDone,
}: {
  projectId: string;
  document: Document;
  baseCommitSha: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const utils = api.useUtils();
  const properties = document.properties;
  const original: FormValues = {
    type: properties?.type ?? "",
    summary: properties?.summary ?? "",
    tags: (properties?.tags ?? []).join(", "),
  };
  const {
    register,
    setError,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: original,
  });
  const save = api.document.setProperties.useMutation({
    onMutate: () => onBusyChange(true),
    onSuccess: async () => {
      try {
        await invalidateDocumentReview(utils, projectId, document.id);
      } catch {
        toast.error("Saved, but the page could not be refreshed. Reload it.");
      }
      void utils.folder.tree.invalidate({ projectId });
      void utils.document.list.invalidate({ projectId });
      toast.success("Properties saved");
      onBusyChange(false);
      onDone();
    },
    onError: (err) => {
      onBusyChange(false);
      if (err.data?.code === "CONFLICT") {
        toast.error("The document changed. Reload and try again.");
        void utils.document.get.invalidate({
          projectId,
          documentId: document.id,
        });
      } else if (err.data?.field?.startsWith("properties")) {
        const sub = err.data.field.split(".")[1];
        setError(sub === "summary" || sub === "tags" ? sub : "type", {
          message: err.message,
        });
      } else {
        toast.error(err.message || "Could not save the properties");
      }
    },
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={handleSubmit((values) => {
        if (busy) return;
        const patch = propertiesPatch(values, original);
        if (Object.keys(patch).length === 0) {
          onDone();
          return;
        }
        save.mutate({
          projectId,
          documentId: document.id,
          expectedHeadCommitSha: baseCommitSha,
          properties: patch,
        });
      })}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="document-property-type">Type</Label>
        <Input
          id="document-property-type"
          placeholder="entity, concept, topic…"
          disabled={busy}
          aria-invalid={errors.type ? true : undefined}
          {...register("type")}
        />
        {errors.type ? (
          <p className="text-danger text-[12px]">{errors.type.message}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="document-property-summary">Summary</Label>
        <Input
          id="document-property-summary"
          disabled={busy}
          aria-invalid={errors.summary ? true : undefined}
          {...register("summary")}
        />
        {errors.summary ? (
          <p className="text-danger text-[12px]">{errors.summary.message}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="document-property-tags">Tags</Label>
        <Input
          id="document-property-tags"
          placeholder="comma separated"
          disabled={busy}
          aria-invalid={errors.tags ? true : undefined}
          {...register("tags")}
        />
        {errors.tags ? (
          <p className="text-danger text-[12px]">{errors.tags.message}</p>
        ) : null}
      </div>
      {properties?.sources?.length ? (
        <div className="flex flex-col gap-1.5">
          <Label>Sources</Label>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            {properties.sources.map((source, index) => (
              <li key={index} className="text-text-2 break-all">
                {source.kind === "url" ? (
                  <span>
                    {source.url}{" "}
                    <ExternalLink
                      aria-label="External link, shown as text"
                      className="inline size-3"
                    />
                  </span>
                ) : source.available ? (
                  `${source.kind}: ${source.title ?? source.id}`
                ) : (
                  `${source.kind}: unavailable`
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

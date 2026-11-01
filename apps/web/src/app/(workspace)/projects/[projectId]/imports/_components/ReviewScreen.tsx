"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DRAFT_COLUMN_TYPES } from "@weaver/core/ingestion/draftTable";
import { projectRoleAtLeast } from "@weaver/core/roles";
import type { DraftDetail, FileDetail } from "@weaver/core/services/ingestion";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import { FolderPicker } from "../../documents/_components/FolderPicker";
import { TableFolderPicker } from "../../tables/_components/TableFolderPicker";
import { DraftPreview } from "./DraftPreview";
import { FileStageBadge } from "./FileStageBadge";
import {
  ingestionPollingInterval,
  isIngestionAccessError,
} from "./imports-state";
import {
  COLUMN_TYPE_LABELS,
  acceptReviewedDraft,
  confidenceLabel,
  linksForDraft,
  rejectDialogState,
  resolveFolderValue,
  reviewDestination,
} from "./review-state";

const schema = z.object({
  proposedTitle: z.string().trim().min(1, "Enter a title").max(200),
  proposedFolderPath: z.string().max(500),
  columns: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Name the column").max(100),
        type: z.enum(DRAFT_COLUMN_TYPES),
      }),
    )
    .max(100),
  links: z
    .array(z.object({ documentId: z.string(), keep: z.boolean() }))
    .max(10),
});
type Values = z.infer<typeof schema>;
function defaultsFor(draft: DraftDetail, folders: string[]): Values {
  return {
    proposedTitle: draft.proposedTitle,
    proposedFolderPath: resolveFolderValue(
      folders,
      draft.proposedFolderPath,
    ).value.join("/"),
    columns: draft.table?.columns ?? [],
    links: draft.links.map(({ documentId, keep }) => ({ documentId, keep })),
  };
}

export function ReviewScreen({
  projectId,
  fileId,
}: {
  projectId: string;
  fileId: string;
}) {
  const project = api.project.get.useQuery({ projectId });
  const file = api.ingestion.getFile.useQuery(
    { fileId },
    {
      refetchInterval: (query) =>
        isIngestionAccessError(query.state.error)
          ? false
          : ingestionPollingInterval(
              query.state.data
                ? [
                    {
                      hasActiveFiles: [
                        "pending",
                        "parsing",
                        "extracting",
                        "linking",
                        "accepting",
                      ].includes(query.state.data.status),
                    },
                  ]
                : undefined,
            ),
    },
  );
  const targetKind = file.data?.draft?.targetKind;
  const documentFolders = api.folder.tree.useQuery(
    { projectId },
    { enabled: targetKind === "document" },
  );
  const tableFolders = api.tableFolder.tree.useQuery(
    { projectId },
    { enabled: targetKind === "table" },
  );
  const requiredFolders =
    targetKind === "document" ? documentFolders : tableFolders;
  const canEdit =
    !!project.data && projectRoleAtLeast(project.data.myRole, "Editor");
  if (
    [project.error, file.error].some(isIngestionAccessError) ||
    (project.data && !canEdit)
  )
    return (
      <p role="alert" className="text-text-2 text-sm">
        Import review unavailable. Editor access to this project is required.
      </p>
    );
  if (file.isLoading || project.isLoading || requiredFolders.isLoading)
    return (
      <p role="status" className="text-text-2 text-sm">
        Loading import…
      </p>
    );
  if (
    project.error ||
    file.error ||
    (targetKind && requiredFolders.error) ||
    !project.data ||
    !file.data
  )
    return (
      <div role="alert" className="text-danger text-sm">
        Could not load the import review.{" "}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void Promise.all([
              project.refetch(),
              file.refetch(),
              targetKind ? requiredFolders.refetch() : Promise.resolve(),
            ])
          }
        >
          Retry loading review
        </Button>
      </div>
    );
  if (file.data.projectId !== projectId)
    return (
      <p role="alert" className="text-danger text-sm">
        This import does not belong to this project.
      </p>
    );
  const folders = targetKind
    ? ((requiredFolders.data as { folders: string[] } | undefined)?.folders ??
      [])
    : [];
  return (
    <ReviewForm
      key={`${file.data.id}:${file.data.status}`}
      projectId={projectId}
      file={file.data}
      folders={folders}
    />
  );
}

function ReviewForm({
  projectId,
  file,
  folders,
}: {
  projectId: string;
  file: FileDetail;
  folders: string[];
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [rejectOpen, setRejectOpen] = useState(false);
  const draft = file.draft;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: draft ? defaultsFor(draft, folders) : undefined,
  });
  const { register, handleSubmit, control, setError, reset, formState } = form;
  const reviewable = file.status === "ready" && !!draft;
  const recovering = file.status === "accepting" && !!draft;
  const folderMissing = draft
    ? resolveFolderValue(folders, draft.proposedFolderPath).missing
    : false;
  async function invalidate() {
    await Promise.all([
      utils.ingestion.getFile.invalidate({ fileId: file.id }),
      utils.ingestion.getBatch.invalidate({ batchId: file.batchId }),
      utils.ingestion.listBatches.invalidate({ projectId }),
    ]);
  }
  const onFieldError = (
    err: {
      data?: { field?: string; code?: string } | null;
      message: string;
    },
    fallback: string,
  ) => {
    // Someone else saved this draft: show their version before anything is accepted.
    if (err.data?.code === "CONFLICT") void invalidate();
    return fieldErrorOrToast(err, fallback);
  };
  const fieldErrorOrToast = (
    err: { data?: { field?: string } | null; message: string },
    fallback: string,
  ) =>
    err.data?.field === "proposedTitle" ||
    err.data?.field === "proposedFolderPath" ||
    (err.data?.field === "columns" && !!draft?.table)
      ? applyTrpcErrorToForm(err as never, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        )
      : toast.error(err.message || fallback);
  const updateDraft = api.ingestion.updateDraft.useMutation({
    onSuccess: (updated) => {
      toast.success("Draft saved");
      if (updated.draft) reset(defaultsFor(updated.draft, folders));
      void invalidate();
    },
    onError: (err) => onFieldError(err, "Could not save the draft"),
  });
  const accept = api.ingestion.accept.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.targetKind === "document"
          ? "Document created from the import"
          : "Table created from the import",
      );
      await invalidate();
      if (result.targetKind === "document") {
        void utils.document.list.invalidate({ projectId });
        void utils.folder.tree.invalidate({ projectId });
      } else {
        void utils.table.list.invalidate({ projectId });
        void utils.tableFolder.tree.invalidate({ projectId });
      }
      router.push(
        reviewDestination(projectId, result.targetKind, result.resourceId),
      );
    },
    onError: (err) => onFieldError(err, "Could not accept the draft"),
  });
  const reject = api.ingestion.reject.useMutation({
    onSuccess: async () => {
      toast.success("Import rejected");
      setRejectOpen(false);
      await invalidate();
      router.push(`/projects/${projectId}/imports`);
    },
    onError: (err) => toast.error(err.message || "Could not reject the draft"),
  });
  const busy = updateDraft.isPending || accept.isPending || reject.isPending;
  const payload = (values: Values) => ({
    fileId: file.id,
    expectedRevision: draft?.revision ?? 0,
    proposedTags: [],
    ...values,
    links: linksForDraft(
      draft?.targetKind ?? "document",
      values.links,
      draft?.links.map(({ documentId, keep }) => ({ documentId, keep })) ?? [],
    ),
    columns: draft?.table ? values.columns : undefined,
  });
  const submitSave = handleSubmit((values) =>
    updateDraft.mutate(payload(values)),
  );
  const submitAccept = handleSubmit(async (values) => {
    try {
      await acceptReviewedDraft({
        status: "ready",
        isDirty: formState.isDirty,
        folderWasNormalized: folderMissing,
        updatePayload: payload(values),
        update: (input) => updateDraft.mutateAsync(input),
        reviewedRevision: draft?.revision ?? 0,
        accept: (expectedRevision) =>
          accept.mutate({ fileId: file.id, expectedRevision }),
      });
    } catch {}
  });
  const links = useWatch({ control, name: "links" }) ?? [];
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[13px]">
          <Link
            href={`/projects/${projectId}/imports`}
            className="text-text-2 underline"
          >
            Back to imports
          </Link>
        </p>
        <h1 className="text-text m-0 text-[20px] font-semibold break-words">
          Review {file.fileName}
        </h1>
        <FileStageBadge
          status={file.status}
          failureMessage={file.failureMessage}
        />
      </div>
      {!draft ? (
        <p role="status" className="text-text-2 text-sm">
          This file has no draft yet. Its status updates automatically while it
          is processed.
        </p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <form
            onSubmit={submitSave}
            className="flex flex-col gap-4"
            aria-busy={busy}
            noValidate
          >
            <fieldset
              disabled={!reviewable || busy}
              className="m-0 flex flex-col gap-4 border-0 p-0"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="review-title">Title</Label>
                <Input
                  id="review-title"
                  aria-invalid={
                    formState.errors.proposedTitle ? true : undefined
                  }
                  {...register("proposedTitle")}
                />
                <FieldError message={formState.errors.proposedTitle?.message} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="review-folder">Folder</Label>
                <Controller
                  control={control}
                  name="proposedFolderPath"
                  render={({ field }) =>
                    draft.targetKind === "document" ? (
                      <FolderPicker
                        folders={folders}
                        value={field.value === "" ? [] : field.value.split("/")}
                        onValueChange={(path) => field.onChange(path.join("/"))}
                        disabled={!reviewable || busy}
                      />
                    ) : (
                      <TableFolderPicker
                        id="review-folder"
                        folders={folders}
                        value={field.value === "" ? [] : field.value.split("/")}
                        onValueChange={(path) => field.onChange(path.join("/"))}
                        disabled={!reviewable || busy}
                      />
                    )
                  }
                />
                {folderMissing ? (
                  <p className="text-review text-[12px]">
                    The proposed folder no longer exists; the project root is
                    selected and will be saved when you accept.
                  </p>
                ) : null}
                <FieldError
                  message={formState.errors.proposedFolderPath?.message}
                />
              </div>
              {draft.table ? (
                <div className="flex flex-col gap-2">
                  <span className="text-text text-sm font-medium">Columns</span>
                  {draft.table.columns.map((column, index) => (
                    <div
                      key={column.name}
                      className="grid grid-cols-[minmax(0,1fr)_10rem] items-start gap-2"
                    >
                      <div className="flex flex-col gap-1">
                        <Input
                          aria-label={`Column ${index + 1} name`}
                          aria-invalid={
                            formState.errors.columns?.[index]?.name
                              ? true
                              : undefined
                          }
                          {...register(`columns.${index}.name`)}
                        />
                        <FieldError
                          message={
                            formState.errors.columns?.[index]?.name?.message
                          }
                        />
                      </div>
                      <Controller
                        control={control}
                        name={`columns.${index}.type`}
                        render={({ field }) => (
                          <Select
                            value={field.value}
                            onValueChange={field.onChange}
                          >
                            <SelectTrigger
                              aria-label={`Column ${index + 1} type`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DRAFT_COLUMN_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                  {COLUMN_TYPE_LABELS[type]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                  ))}
                  <FieldError
                    message={
                      (formState.errors.columns as { message?: string })
                        ?.message ??
                      (formState.errors.columns
                        ? "Check the column names and types"
                        : undefined)
                    }
                  />
                </div>
              ) : null}
              {draft.links.length ? (
                <div className="flex flex-col gap-2">
                  <span className="text-text text-sm font-medium">
                    Related documents
                  </span>
                  <p className="text-text-3 m-0 text-xs">
                    {draft.targetKind === "document"
                      ? "Checked documents are added as a Related section at the end of the document."
                      : "These are navigable reference suggestions only; they are not added to the table."}
                  </p>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {draft.links.map((link, index) => (
                      <li
                        key={link.documentId}
                        className="border-line flex items-start gap-2 rounded-[10px] border p-2"
                      >
                        {draft.targetKind === "document" ? (
                          <input
                            id={`review-link-${index}`}
                            type="checkbox"
                            aria-label={`Keep ${link.title}`}
                            className="mt-1"
                            {...register(`links.${index}.keep`)}
                          />
                        ) : null}
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <Link
                            href={`/projects/${projectId}/documents/${link.documentId}`}
                            className="text-text text-sm font-medium break-words underline"
                          >
                            {link.title}
                          </Link>
                          <span className="text-text-3 text-xs">
                            {confidenceLabel(link.confidence)} match
                            {link.anchor ? ` · section ${link.anchor}` : ""}
                          </span>
                          {link.excerpt ? (
                            <span className="text-text-2 text-xs break-words">
                              {link.excerpt}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {draft.warnings.length ? (
                <div className="bg-review-bg text-review rounded-[10px] p-3 text-xs">
                  <span className="font-medium">Processing notes</span>
                  <ul className="m-0 mt-1 pl-4">
                    {draft.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </fieldset>
            {file.status === "accepted" && draft.acceptedResourceId ? (
              <p className="text-text-2 m-0 text-sm">
                Accepted.{" "}
                <Link
                  href={reviewDestination(
                    projectId,
                    draft.targetKind,
                    draft.acceptedResourceId,
                  )}
                  className="underline"
                >
                  Open the {draft.targetKind}
                </Link>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="outline"
                disabled={!reviewable || busy || !formState.isDirty}
              >
                Save changes
              </Button>
              <Button
                type="button"
                disabled={(!reviewable && !recovering) || busy}
                onClick={() =>
                  recovering
                    ? void acceptReviewedDraft({
                        status: "accepting",
                        isDirty: formState.isDirty,
                        folderWasNormalized: folderMissing,
                        updatePayload: payload(form.getValues()),
                        update: (input) => updateDraft.mutateAsync(input),
                        reviewedRevision: draft?.revision ?? 0,
                        accept: (expectedRevision) =>
                          accept.mutate({
                            fileId: file.id,
                            expectedRevision,
                          }),
                      })
                    : void submitAccept()
                }
              >
                {recovering
                  ? "Retry acceptance"
                  : accept.isPending
                    ? "Accepting…"
                    : "Accept"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={!reviewable || busy}
                onClick={() => setRejectOpen(true)}
              >
                Reject
              </Button>
            </div>
          </form>
          <section
            aria-label="Draft preview"
            className="border-line bg-surface min-w-0 rounded-[10px] border p-4"
          >
            <DraftPreview draft={draft} />
          </section>
        </div>
      )}
      <Dialog
        open={rejectOpen}
        onOpenChange={(open) => {
          if (!reject.isPending) setRejectOpen(open);
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-busy={reject.isPending}
          showCloseButton={!reject.isPending}
        >
          <DialogHeader>
            <DialogTitle>Reject import</DialogTitle>
            <DialogDescription>
              Reject the draft for <strong>{file.fileName}</strong>? Nothing is
              written to the project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <RejectDialogActions
              pending={reject.isPending}
              onReject={() => reject.mutate({ fileId: file.id })}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {draft?.targetKind === "document" ? (
        <p className="text-text-3 m-0 text-[13px]">
          {links.filter((link) => link.keep).length} related documents will be
          linked.
        </p>
      ) : null}
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-danger text-[12px]">
      {message}
    </p>
  ) : null;
}

export function RejectDialogActions({
  pending,
  onReject,
}: {
  pending: boolean;
  onReject: () => void;
}) {
  const state = rejectDialogState(pending);
  return (
    <>
      <DialogClose asChild>
        <Button variant="outline" disabled={state.disabled}>
          Cancel
        </Button>
      </DialogClose>
      <Button
        variant="destructive"
        disabled={state.disabled}
        onClick={onReject}
      >
        {state.label}
      </Button>
    </>
  );
}

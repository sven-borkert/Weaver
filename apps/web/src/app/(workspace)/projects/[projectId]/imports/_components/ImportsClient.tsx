"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { projectRoleAtLeast } from "@weaver/core/roles";
import type {
  BatchSummary,
  DerivedBatchStatus,
} from "@weaver/core/services/ingestion";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { api } from "~/trpc/react";
import { BatchTable } from "./BatchTable";
import { UploadDropzone } from "./UploadDropzone";
import {
  BATCH_STATUS_LABELS,
  ingestionPollingInterval,
  isIngestionAccessError,
} from "./imports-state";

export function ImportsClient({
  projectId,
  maxBytes,
}: {
  projectId: string;
  maxBytes: number;
}) {
  const utils = api.useUtils();
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [status, setStatus] = useState<DerivedBatchStatus | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BatchSummary | null>(null);
  const [uploadAccessDenied, setUploadAccessDenied] = useState(false);
  const [notice, setNotice] = useState("");
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const project = api.project.get.useQuery(
    { projectId },
    { enabled: !!projectId },
  );
  const canEdit =
    !!project.data &&
    projectRoleAtLeast(project.data.myRole, "Editor") &&
    !isIngestionAccessError(project.error) &&
    !uploadAccessDenied;
  const batches = api.ingestion.listBatches.useQuery(
    {
      projectId,
      limit: 20,
      cursor: cursors.at(-1),
      ...(status === "all" ? {} : { status }),
    },
    {
      enabled: canEdit,
      placeholderData: keepPreviousData,
      refetchInterval: (query) =>
        isIngestionAccessError(query.state.error)
          ? false
          : ingestionPollingInterval(query.state.data?.items),
    },
  );
  const detail = api.ingestion.getBatch.useQuery(
    { batchId: expandedId ?? "" },
    {
      enabled:
        canEdit && !!expandedId && !isIngestionAccessError(batches.error),
      refetchInterval: (query) =>
        isIngestionAccessError(query.state.error)
          ? false
          : ingestionPollingInterval(
              query.state.data ? [query.state.data] : undefined,
            ),
    },
  );
  async function refreshImports() {
    await Promise.all([
      utils.ingestion.listBatches.invalidate({ projectId }),
      utils.ingestion.getBatch.invalidate(),
    ]);
  }
  const retry = api.ingestion.retry.useMutation({
    onSuccess: () => {
      setNotice("");
      toast.success("File queued for retry");
    },
    onError: (error) => {
      const message =
        error.message === "retry was stored but job publication failed"
          ? "Retry saved. Processing is pending and will resume automatically."
          : "Could not retry the file. Check its status and try again.";
      setNotice(message);
      toast.error(message);
    },
    onSettled: refreshImports,
  });
  const deleteBatch = api.ingestion.deleteBatch.useMutation({
    onSuccess: (_data, variables) => {
      setDeleteTarget(null);
      if (expandedId === variables.batchId) setExpandedId(null);
      setCursors([undefined]);
      toast.success("Import batch deleted");
      screenRef.current?.focus();
    },
    onError: () => toast.error("Could not delete the import batch. Try again."),
    onSettled: refreshImports,
  });
  const accessDenied =
    uploadAccessDenied ||
    [
      project.error,
      batches.error,
      detail.error,
      retry.error,
      deleteBatch.error,
    ].some(isIngestionAccessError);

  const importsUnavailable = accessDenied || Boolean(project.data && !canEdit);
  useEffect(() => {
    if (!importsUnavailable) return;
    const frame = window.requestAnimationFrame(() => setDeleteTarget(null));
    return () => window.cancelAnimationFrame(frame);
  }, [importsUnavailable]);
  if (importsUnavailable)
    return (
      <p role="alert" className="text-text-2 text-sm">
        Imports unavailable. Editor access to this project is required.
      </p>
    );
  if (project.isLoading)
    return (
      <p role="status" className="text-text-2 text-sm">
        Loading imports…
      </p>
    );
  if (!project.data)
    return (
      <div role="alert" className="text-text-2 text-sm">
        Could not load project.{" "}
        <Button variant="outline" onClick={() => void project.refetch()}>
          Retry
        </Button>
      </div>
    );
  const busy = retry.isPending || deleteBatch.isPending;
  return (
    <div
      ref={screenRef}
      tabIndex={-1}
      className="flex w-full flex-col gap-4 outline-none"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold break-words">
          Imports
        </h1>
        <p className="text-text-2 m-0 text-[13px]">
          Upload files and follow their progress into drafts.
        </p>
        <p className="text-text-3 m-0 text-[13px]">
          Text, Markdown, Word, PDF, and image files become document drafts;
          Excel and CSV files become table drafts. Scanned pages use the Import
          parsing model configured in Administration › Settings › AI. Files that
          are ready for review open a review page where you accept or reject the
          draft.
        </p>
      </div>
      {project.error ? (
        <p role="alert" className="text-danger text-sm">
          Project access could not refresh.{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void project.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : null}
      <UploadDropzone
        projectId={projectId}
        maxBytes={maxBytes}
        onAccessDenied={() => setUploadAccessDenied(true)}
        onUploaded={async (batchId) => {
          setStatus("all");
          setCursors([undefined]);
          setExpandedId(batchId);
          await refreshImports();
        }}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="import-status"
            className="text-text-2 text-xs font-medium"
          >
            Batch status
          </label>
          <Select
            value={status}
            onValueChange={(value: DerivedBatchStatus | "all") => {
              setStatus(value);
              setCursors([undefined]);
              setExpandedId(null);
            }}
          >
            <SelectTrigger id="import-status" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(BATCH_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          disabled={batches.isFetching}
          onClick={() => void refreshImports()}
        >
          Refresh
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-text-2 m-0 text-sm">
          {notice}
        </p>
      ) : null}
      {batches.error ? (
        <div role="alert" className="text-danger text-sm">
          {batches.data
            ? "Import list could not refresh. Showing the last loaded batches."
            : "Could not load imports."}{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void batches.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {batches.isLoading && !batches.data ? (
        <p role="status" className="text-text-2 text-sm">
          Loading imports…
        </p>
      ) : batches.data?.items.length ? (
        <BatchTable
          projectId={projectId}
          batches={batches.data.items}
          expandedId={expandedId}
          detail={detail.data}
          detailLoading={detail.isLoading}
          detailError={!!detail.error}
          busy={busy || batches.isPlaceholderData}
          onExpand={(id) =>
            setExpandedId((current) => (current === id ? null : id))
          }
          onDelete={(batch, trigger) => {
            deleteBatch.reset();
            deleteTriggerRef.current = trigger;
            setDeleteTarget(batch);
          }}
          onRetry={(fileId) => retry.mutate({ fileId })}
          onRefreshDetail={() => void detail.refetch()}
        />
      ) : !batches.error ? (
        <div className="border-line bg-surface rounded-[10px] border p-6">
          <p className="text-text m-0 text-sm font-medium">
            {status === "all" && cursors.length === 1
              ? "No imports yet"
              : "No matching imports"}
          </p>
          <p className="text-text-2 mt-1 mb-0 text-sm">
            {status === "all" && cursors.length === 1
              ? "Upload files to create your first batch."
              : "Change the status filter or return to the previous page."}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-text-3 m-0 text-[13px]">
          Page {cursors.length} · {batches.data?.items.length ?? 0} batches
          shown
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={cursors.length <= 1 || batches.isFetching}
            onClick={() => {
              setCursors((current) => current.slice(0, -1));
              setExpandedId(null);
            }}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={
              !batches.data?.nextCursor ||
              batches.isFetching ||
              batches.isPlaceholderData
            }
            onClick={() => {
              const next = batches.data?.nextCursor;
              if (next) {
                setCursors((current) => [...current, next]);
                setExpandedId(null);
              }
            }}
          >
            Next
          </Button>
        </div>
      </div>
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBatch.isPending) setDeleteTarget(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-busy={deleteBatch.isPending}
          showCloseButton={!deleteBatch.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = deleteTriggerRef.current;
            if (target?.isConnected) target.focus();
            else screenRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete import batch</DialogTitle>
            <DialogDescription>
              Delete <strong>{deleteTarget?.label ?? "Untitled import"}</strong>{" "}
              and its {deleteTarget?.fileCount} files? Its import drafts will
              also be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteBatch.error ? (
            <p role="alert" className="text-danger m-0 text-xs">
              Could not delete this batch. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleteBatch.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteBatch.isPending || !deleteTarget}
              onClick={() => {
                if (deleteTarget)
                  deleteBatch.mutate({ batchId: deleteTarget.id });
              }}
            >
              {deleteBatch.isPending ? "Deleting…" : "Delete batch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";

import { Fragment } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  BatchDetail,
  BatchSummary,
  FileSummary,
} from "@weaver/core/services/ingestion";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useMounted } from "~/lib/use-mounted";
import { FileStageBadge } from "./FileStageBadge";
import { BATCH_STATUS_LABELS } from "./imports-state";
import { formatBytes } from "./upload";
import { reviewDestination } from "./review-state";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const FAILURE_LABELS: Record<
  NonNullable<FileSummary["failureKind"]>,
  string
> = {
  configuration: "Configuration",
  source_missing: "Source missing",
  parser: "Parser",
  provider: "AI provider",
  validation: "Validation",
  internal: "Processing error",
};

export function BatchTable({
  projectId,
  batches,
  expandedId,
  detail,
  detailLoading,
  detailError,
  busy,
  onExpand,
  onDelete,
  onRetry,
  onRefreshDetail,
}: {
  projectId: string;
  batches: BatchSummary[];
  expandedId: string | null;
  detail?: BatchDetail;
  detailLoading: boolean;
  detailError: boolean;
  busy: boolean;
  onExpand: (id: string) => void;
  onDelete: (batch: BatchSummary, trigger: HTMLButtonElement) => void;
  onRetry: (fileId: string) => void;
  onRefreshDetail: () => void;
}) {
  const mounted = useMounted();
  return (
    <div className="border-line bg-surface overflow-hidden rounded-[10px] border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Label</TableHead>
            <TableHead>Origin</TableHead>
            <TableHead>Files</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created by</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batches.map((batch) => {
            const expanded = batch.id === expandedId;
            const files =
              expanded && detail?.id === batch.id ? detail.files : undefined;
            return (
              <Fragment key={batch.id}>
                <TableRow>
                  <TableCell className="w-full max-w-0 font-medium">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={
                        expanded ? `batch-files-${batch.id}` : undefined
                      }
                      disabled={busy}
                      onClick={() => onExpand(batch.id)}
                      className="text-text hover:text-brand-text flex w-full items-center gap-2 text-left"
                    >
                      <span className="shrink-0">
                        {expanded ? (
                          <ChevronDown size={16} />
                        ) : (
                          <ChevronRight size={16} />
                        )}
                      </span>
                      <span className="truncate">
                        {batch.label ?? "Untitled import"}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="text-text-2">
                    {batch.origin === "upload"
                      ? "Upload"
                      : batch.origin === "wiki"
                        ? "Wiki"
                        : "External"}
                  </TableCell>
                  <TableCell className="text-text-2">
                    {batch.fileCount}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${batch.status === "attention" ? "bg-danger-bg text-danger" : "bg-surface-2 text-text-2"}`}
                    >
                      {BATCH_STATUS_LABELS[batch.status]}
                    </span>
                  </TableCell>
                  <TableCell className="text-text-2 max-w-48 truncate">
                    {batch.createdBy.name || batch.createdBy.email}
                  </TableCell>
                  <TableCell className="text-text-2 whitespace-nowrap">
                    {mounted ? (
                      <time dateTime={batch.createdAt.toISOString()}>
                        {dateTimeFormatter.format(batch.createdAt)}
                      </time>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Delete ${batch.label ?? "untitled import"}`}
                      onClick={(event) => onDelete(batch, event.currentTarget)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
                {expanded ? (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-subtle p-4">
                      <div
                        id={`batch-files-${batch.id}`}
                        className="flex flex-col gap-3"
                        aria-label={`Files in ${batch.label ?? "untitled import"}`}
                      >
                        {detailError ? (
                          <div role="alert" className="text-danger text-sm">
                            Files could not refresh.{" "}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={onRefreshDetail}
                            >
                              Retry loading files
                            </Button>
                          </div>
                        ) : null}
                        {detailLoading && !files ? (
                          <p role="status" className="text-text-2 m-0 text-sm">
                            Loading files…
                          </p>
                        ) : null}
                        {files?.length === 0 ? (
                          <p className="text-text-2 m-0 text-sm">
                            No files in this batch.
                          </p>
                        ) : null}
                        {files?.map((file) => (
                          <div
                            key={file.id}
                            className="border-line flex flex-col gap-2 border-b pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                          >
                            <div className="flex min-w-0 flex-col gap-1">
                              <span className="text-text text-sm font-medium break-words">
                                {file.fileName}
                              </span>
                              <span className="text-text-3 text-xs">
                                {formatBytes(file.byteSize)}
                              </span>
                              <FileStageBadge
                                status={file.status}
                                failureMessage={file.failureMessage}
                              />
                              {file.failureKind || file.failureMessage ? (
                                <p className="text-danger m-0 text-xs break-words">
                                  {file.failureKind
                                    ? `${FAILURE_LABELS[file.failureKind]}: `
                                    : ""}
                                  {file.failureMessage ??
                                    "Processing could not finish."}
                                </p>
                              ) : null}
                              {file.status === "blocked_configuration" ? (
                                <p className="text-text-2 m-0 text-xs">
                                  Ask an administrator to check AI settings
                                  before retrying.
                                </p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 gap-2">
                              {file.status === "ready" ||
                              file.status === "accepting" ? (
                                <Button asChild size="sm">
                                  <Link
                                    href={`/projects/${projectId}/imports/${file.id}`}
                                    aria-label={`Review ${file.fileName}`}
                                  >
                                    Review
                                  </Link>
                                </Button>
                              ) : null}
                              {file.status === "accepted" &&
                              file.targetKind &&
                              file.acceptedResourceId ? (
                                <Button asChild variant="outline" size="sm">
                                  <Link
                                    href={reviewDestination(
                                      projectId,
                                      file.targetKind,
                                      file.acceptedResourceId,
                                    )}
                                    aria-label={`Open ${file.fileName}`}
                                  >
                                    Open {file.targetKind}
                                  </Link>
                                </Button>
                              ) : null}
                              {file.status === "failed" ||
                              file.status === "blocked_configuration" ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  aria-label={`Retry ${file.fileName}`}
                                  onClick={() => onRetry(file.id)}
                                >
                                  Retry
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

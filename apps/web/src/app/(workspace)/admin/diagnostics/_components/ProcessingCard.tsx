"use client";

import Link from "next/link";
import { PROCESSING_RETENTION_DAYS } from "@weaver/core/diagnostics/processingRetention";
import { DEFAULT_RETENTION_SETTINGS } from "@weaver/core/diagnostics/retentionSettings";
import { useState } from "react";
import {
  PROCESSING_KINDS,
  PROCESSING_STATUSES,
  type ProcessingKind,
} from "@weaver/core/diagnostics/processingSchema";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { ClientDateTime } from "~/components/ui/client-date";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { api } from "~/trpc/react";

const LABELS: Record<ProcessingKind | "queue", string> = {
  knowledge_generation: "Knowledge generations",
  knowledge_document: "Knowledge documents",
  keyword: "Keyword indexing",
  ingestion: "Import files",
  assistant: "Assistant runs",
  scheduled_task: "Scheduled task runs",
  queue: "Queue deliveries",
};
const QUEUE_STATUSES = [
  "created",
  "retry",
  "active",
  "completed",
  "cancelled",
  "failed",
] as const;

type Correlation = {
  fileId?: string | null;
  projectId: string | null;
  generationId: string | null;
  documentId: string | null;
  runId: string | null;
  jobId: string | null;
};
export function processingEventsHref(
  row: Correlation,
  delivery = false,
): string {
  const params = new URLSearchParams();
  if (delivery && row.jobId) params.set("jobId", row.jobId);
  else if (row.runId) params.set("runId", row.runId);
  else if (row.fileId) params.set("fileId", row.fileId);
  else if (row.documentId || row.generationId) {
    if (row.projectId) params.set("projectId", row.projectId);
    if (row.generationId) params.set("generationId", row.generationId);
    if (row.documentId) params.set("documentId", row.documentId);
  } else if (row.jobId) params.set("jobId", row.jobId);
  else if (row.projectId) params.set("projectId", row.projectId);
  return `/admin/diagnostics?${params.toString()}#events`;
}

export function ProcessingCard() {
  const [kind, setKind] = useState<ProcessingKind | "queue">(
    "knowledge_document",
  );
  const [status, setStatus] = useState("all");
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const cursor = cursors.at(-1);
  const options = {
    refetchInterval: cursor ? (false as const) : 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !cursor,
    refetchOnReconnect: !cursor,
  };
  const work = api.diagnostics.listProcessing.useQuery(
    {
      kind: kind === "queue" ? "keyword" : kind,
      status: kind !== "queue" && status !== "all" ? status : undefined,
      cursor,
      limit: 25,
    },
    { ...options, enabled: kind !== "queue" },
  );
  const queue = api.diagnostics.listProcessingQueue.useQuery(
    {
      state:
        kind === "queue" && status !== "all"
          ? (status as (typeof QUEUE_STATUSES)[number])
          : undefined,
      cursor,
      limit: 25,
    },
    { ...options, enabled: kind === "queue" },
  );
  const summary = api.diagnostics.processingQueueSummary.useQuery(undefined, {
    ...options,
    enabled: kind === "queue",
  });
  const retention = api.diagnostics.getRetentionSettings.useQuery();
  const retentionSettings =
    retention.data?.settings ?? DEFAULT_RETENTION_SETTINGS;
  const query = kind === "queue" ? queue : work;
  const rows =
    kind === "queue"
      ? queue.data?.items.map((row) => ({
          ...row,
          attempts: row.retryCount + (row.startedAt ? 1 : 0),
          failureCode: null,
          lastAttemptAt: row.startedAt,
        }))
      : work.data?.items;
  const counts =
    kind === "queue"
      ? (summary.error ? undefined : summary.data?.queues)?.map((row) => ({
          label: `${row.name} / ${row.state}`,
          count: row.count,
        }))
      : work.data?.counts.map((row) => ({
          label: row.status,
          count: row.count,
        }));
  const statuses =
    kind === "queue" ? QUEUE_STATUSES : PROCESSING_STATUSES[kind];
  const restart = () => setCursors([undefined]);

  return (
    <Card id="processing">
      <CardHeader>
        <CardTitle>Processing</CardTitle>
        <CardDescription>
          Durable processing states, newest first. Available at every diagnostic
          log level. Events show any retained logs for the selected work.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-text-3 m-0 text-[12px]">
          Active work is never pruned. Diagnostic logs follow the configured
          retention; terminal queue deliveries and assistant events are kept for{" "}
          {PROCESSING_RETENTION_DAYS.assistantEvents} days, terminal assistant
          attempts for {PROCESSING_RETENTION_DAYS.assistantAttempts} days, task
          run history for {retentionSettings.taskRunDays} days, and AI usage for{" "}
          {retentionSettings.aiUsageDays} days; finished import batches and idle
          assistant conversations follow the Retention card above. Latest task
          runs, successful baselines, and referenced external-call evidence
          remain available.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="processing-kind">Work type</Label>
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as ProcessingKind | "queue");
                setStatus("all");
                restart();
              }}
            >
              <SelectTrigger id="processing-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...PROCESSING_KINDS, "queue" as const].map((value) => (
                  <SelectItem key={value} value={value}>
                    {LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="processing-status">Status</Label>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                restart();
              }}
            >
              <SelectTrigger id="processing-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!query.error && counts ? (
          <div className="text-text-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            {counts.map((row) => (
              <span key={row.label}>
                {row.label}: {row.count}
              </span>
            ))}
          </div>
        ) : null}
        {kind === "queue" && summary.error ? (
          <p role="alert" className="text-danger text-[13px]">
            Queue totals unavailable.{" "}
            <button type="button" onClick={() => void summary.refetch()}>
              Retry totals
            </button>
          </p>
        ) : null}
        {kind === "queue" &&
        !query.error &&
        !summary.error &&
        summary.data?.truncated ? (
          <p className="text-text-3 text-[12px]">Queue totals are truncated.</p>
        ) : null}
        {query.error ? (
          <div
            role="alert"
            className="text-danger flex items-center gap-3 text-[13px]"
          >
            Processing state unavailable.
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : query.isLoading ? (
          <p role="status">Loading processing state…</p>
        ) : !rows?.length ? (
          <p className="text-text-3 text-[13px]">
            No work matches these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Record</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Failure code</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last attempt</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-[12px]" title={row.id}>
                      {row.id.length > 40
                        ? `${row.generationId?.slice(0, 8)} / ${row.documentId?.slice(0, 8)}`
                        : row.id.slice(0, 8)}
                      {"name" in row ? (
                        <span className="block">{String(row.name)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>{row.status.replaceAll("_", " ")}</TableCell>
                    <TableCell>{row.attempts ?? "—"}</TableCell>
                    <TableCell>{row.failureCode ?? "—"}</TableCell>
                    <TableCell>
                      <ClientDateTime value={row.createdAt} />
                    </TableCell>
                    <TableCell>
                      {row.lastAttemptAt ? (
                        <ClientDateTime value={row.lastAttemptAt} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {row.completedAt ? (
                        <ClientDateTime value={row.completedAt} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        className="text-brand-text underline"
                        href={processingEventsHref(row, kind === "queue")}
                      >
                        Events
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={cursors.length === 1 || query.isFetching}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={
              !query.data?.nextCursor ||
              query.isFetching ||
              Boolean(query.error)
            }
            onClick={() => {
              const next = query.data?.nextCursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          >
            Next
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              restart();
              if (!cursor) void query.refetch();
            }}
          >
            Refresh latest
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

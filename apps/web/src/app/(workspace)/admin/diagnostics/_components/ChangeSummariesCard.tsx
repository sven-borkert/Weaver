"use client";

import Link from "next/link";
import { useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
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
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  CHANGE_SUMMARY_STATUSES,
  changeSummaryEventsHref,
  changeSummaryListInput,
  completionDuration,
  type ChangeSummaryStatusFilter,
} from "./changeSummaryFilters";

type SummaryRow =
  RouterOutputs["diagnostics"]["listChangeSummaries"]["items"][number];

const STATUS_TONE: Record<SummaryRow["status"], string> = {
  pending: "text-review",
  ready: "text-approved",
  failed: "text-danger",
  skipped: "text-text-3",
};

export function ChangeSummariesCard() {
  const [status, setStatus] = useState<ChangeSummaryStatusFilter>("all");
  const [projectId, setProjectId] = useState("all");
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const list = api.diagnostics.listChangeSummaries.useQuery(
    changeSummaryListInput({ status, projectId }, cursors.at(-1)),
    {
      placeholderData: keepPreviousData,
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
  );
  const items = list.data?.items ?? [];
  const counts = list.data?.counts;
  const projects = list.data?.projects ?? [];
  const restart = () => setCursors([undefined]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change summaries</CardTitle>
        <CardDescription>
          AI change comments for document saves, newest first. Metadata only;
          open Events to see what each attempt logged.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {CHANGE_SUMMARY_STATUSES.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={status === value ? "default" : "outline"}
              aria-pressed={status === value}
              onClick={() => {
                setStatus(status === value ? "all" : value);
                restart();
              }}
            >
              {`${value} · ${counts?.[value] ?? 0}`}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="summaries-status">Status</Label>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as ChangeSummaryStatusFilter);
                restart();
              }}
            >
              <SelectTrigger id="summaries-status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {CHANGE_SUMMARY_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="summaries-project">Project</Label>
            <Select
              value={projectId}
              onValueChange={(value) => {
                setProjectId(value);
                restart();
              }}
            >
              <SelectTrigger id="summaries-project">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {list.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : list.error ? (
          <div
            role="alert"
            className="border-danger-border bg-danger-bg flex flex-col items-start gap-3 rounded-xl border p-4"
          >
            <p className="text-danger m-0 text-[13px]">
              Could not load change summaries.
            </p>
            <Button variant="outline" onClick={() => void list.refetch()}>
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-text-3 m-0 text-[13px]">
            No change summaries match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Error class</TableHead>
                  <TableHead>Took</TableHead>
                  <TableHead>
                    <span className="sr-only">Events</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={`${row.projectId}:${row.commitSha}`}>
                    <TableCell title={row.createdAt.toISOString()}>
                      <ClientDateTime value={row.createdAt} />
                    </TableCell>
                    <TableCell>{row.projectName}</TableCell>
                    <TableCell
                      className="font-mono text-[12px]"
                      title={row.commitSha}
                    >
                      {row.commitSha.slice(0, 8)}
                    </TableCell>
                    <TableCell className={STATUS_TONE[row.status]}>
                      {row.status}
                    </TableCell>
                    <TableCell>{row.failureReason ?? "—"}</TableCell>
                    <TableCell>{row.attempts}</TableCell>
                    <TableCell className="font-mono text-[12px]">
                      {row.lastErrorClass ?? "—"}
                    </TableCell>
                    <TableCell>{completionDuration(row)}</TableCell>
                    <TableCell>
                      <Link
                        href={changeSummaryEventsHref(row)}
                        className="text-brand-text underline-offset-2 hover:underline"
                        aria-label={`Events for commit ${row.commitSha.slice(0, 8)}`}
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-3 m-0 text-[13px]">
            {`Page ${cursors.length} · ${items.length} summaries shown`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={cursors.length <= 1 || list.isFetching}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={
                !list.data?.nextCursor ||
                list.isFetching ||
                list.isPlaceholderData
              }
              onClick={() => {
                const next = list.data?.nextCursor;
                if (next) setCursors((current) => [...current, next]);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

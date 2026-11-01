"use client";

import type {
  BackgroundWorkKind,
  BackgroundWorkState,
  WorkAudience,
  WorkView,
} from "@weaver/core/jobs/backgroundWorkSchema";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { BackgroundWorkRow } from "~/components/background-work/BackgroundWorkRow";
import { useBackgroundWork } from "~/components/background-work/BackgroundWorkProvider";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { changeWorkFilters } from "~/lib/background-work/pagination";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import {
  visibleWorkReferences,
  workPollInterval,
} from "~/lib/background-work/presentation";
import { api } from "~/trpc/react";

type Filters = {
  audience: WorkAudience;
  projectId: string;
  kind: BackgroundWorkKind | "";
  view: WorkView;
  state: BackgroundWorkState | "";
};
const initialFilters: Filters = {
  audience: "mine",
  projectId: "",
  kind: "",
  view: "all",
  state: "",
};

const selectClass =
  "border-input bg-surface text-text h-8 rounded-md border px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function BackgroundWorkScreen({
  initial,
}: {
  initial?: Pick<Filters, "audience" | "projectId">;
}) {
  const [state, setState] = useState({
    ...initialFilters,
    ...initial,
    cursors: [null] as (string | null)[],
    page: 0,
  });
  const { cursors, page, ...filters } = state;
  const { pageVisible } = useBackgroundWork();
  const utils = api.useUtils();
  const projectsQuery = api.project.list.useQuery();
  const projects =
    dataUnlessAccessError(projectsQuery.data, projectsQuery.error) ?? [];
  const maintainableProjects = projects.filter(
    (project) => project.myRole === "Owner" || project.myRole === "Maintainer",
  );
  const projectChoices =
    filters.audience === "projects" ? maintainableProjects : projects;
  const input = {
    audience: filters.audience,
    view: filters.view,
    limit: 20,
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.state ? { state: filters.state } : {}),
    ...(cursors[page] ? { cursor: cursors[page] } : {}),
  };
  const query = api.backgroundWork.list.useQuery(input, {
    retry: false,
    refetchInterval: (state) =>
      page === 0
        ? workPollInterval({
            open: true,
            active: (state.state.data?.items ?? []).some((item) =>
              ["queued", "running"].includes(item.state),
            ),
            hidden: !pageVisible,
          })
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: page === 0,
    refetchOnReconnect: page === 0,
  });
  const data = dataUnlessAccessError(query.data, query.error);
  const references = visibleWorkReferences(data?.items ?? []);
  const markSeen = api.backgroundWork.markSeen.useMutation({
    onSuccess: () => {
      toast.success("This page is marked as seen");
      void utils.backgroundWork.list.invalidate();
      void utils.backgroundWork.summary.invalidate();
    },
    onError: () => toast.error("Couldn’t mark this page as seen"),
  });

  const change = (patch: Partial<Filters>) => {
    setState((current) => changeWorkFilters(current, patch));
  };
  const refresh = () => {
    setState((current) => changeWorkFilters(current, {}));
    if (page === 0) void query.refetch();
  };
  const next = () => {
    if (!data?.nextCursor) return;
    setState((current) => ({
      ...current,
      cursors: [...current.cursors.slice(0, current.page + 1), data.nextCursor],
      page: current.page + 1,
    }));
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          Background work
        </h1>
        <p className="text-text-3 m-0 text-[13px]">
          See work running for you and recent results across your projects.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Open an item to manage it on its source screen.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Filter label="Audience">
              <select
                className={selectClass}
                value={filters.audience}
                onChange={(event) =>
                  change({
                    audience: event.target.value as WorkAudience,
                    projectId: "",
                    ...(event.target.value === "mine" &&
                    filters.kind === "knowledge"
                      ? { kind: "" }
                      : {}),
                  })
                }
              >
                <option value="mine">My work</option>
                <option value="projects">Project work</option>
              </select>
            </Filter>
            <Filter label="Project">
              <select
                className={selectClass}
                value={filters.projectId}
                onChange={(event) => change({ projectId: event.target.value })}
              >
                <option value="">
                  {filters.audience === "projects"
                    ? "All managed projects"
                    : "All projects"}
                </option>
                {projectChoices.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Filter>
            <Filter label="Kind">
              <select
                className={selectClass}
                value={filters.kind}
                onChange={(event) =>
                  change({ kind: event.target.value as Filters["kind"] })
                }
              >
                <option value="">All kinds</option>
                <option value="exam">Exam</option>
                <option value="task">Tasks</option>
                <option value="import">Imports</option>
                <option value="assistant">Assistant</option>
                <option value="notebook">OneNote notebooks</option>
                <option value="git_sync">Git sync</option>
                {filters.audience === "projects" ? (
                  <option value="knowledge">Knowledge</option>
                ) : null}
              </select>
            </Filter>
            <Filter label="View">
              <select
                className={selectClass}
                value={filters.view}
                onChange={(event) =>
                  change({ view: event.target.value as WorkView })
                }
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="recent">Recent results</option>
              </select>
            </Filter>
            <Filter label="State">
              <select
                className={selectClass}
                value={filters.state}
                onChange={(event) =>
                  change({ state: event.target.value as Filters["state"] })
                }
              >
                <option value="">All states</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
                <option value="blocked">Blocked</option>
                <option value="cancelled">Cancelled</option>
                <option value="skipped">Skipped</option>
              </select>
            </Filter>
          </div>
          {query.error ? (
            <div className="border-danger/30 bg-danger/5 flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="text-text text-[13px]">
                  Background work is unavailable.
                </p>
                {data ? (
                  <p className="text-text-3 text-[12px]">
                    Displayed results may be out of date.
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {query.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : data?.items.length ? (
            <div className="border-line overflow-x-auto rounded-lg border">
              <Table className="min-w-[54rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Work</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Finished</TableHead>
                    <TableHead>Open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => (
                    <BackgroundWorkRow
                      key={`${item.kind}:${item.id}`}
                      item={item}
                      table
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : data ? (
            <p className="text-text-3 py-8 text-center text-[13px]">
              No background work matches these filters.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    page: current.page - 1,
                  }))
                }
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!data?.nextCursor}
                onClick={next}
              >
                Next
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={refresh}>
                <RefreshCw aria-hidden="true" /> Refresh
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={references.length === 0 || markSeen.isPending}
              onClick={() => markSeen.mutate({ items: references })}
            >
              Mark this page as seen
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Filter({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="text-text-2 flex flex-col gap-1 text-[12px]">
      <span>{label}</span>
      {children}
    </label>
  );
}

"use client";

import { DASHBOARD_LIMITS } from "@weaver/core/dashboard/schema";
import { useRef } from "react";
import { useBackgroundWork } from "~/components/background-work/BackgroundWorkProvider";
import { ActivityList } from "~/components/dashboard/ActivityList";
import { ReportShortcutsCard } from "~/components/dashboard/ReportShortcutsCard";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { ActiveWorkCard } from "./ActiveWorkCard";
import { ProjectPinsSection } from "./ProjectPinsSection";

export function ProjectActivityScreen({ projectId }: { projectId: string }) {
  const fallbackFocusRef = useRef<HTMLDivElement>(null);
  const { pageVisible } = useBackgroundWork();
  const queryOptions = {
    retry: false,
    refetchInterval: pageVisible ? DASHBOARD_LIMITS.refreshMs : false,
    refetchIntervalInBackground: false,
  } as const;
  const query = api.dashboard.projectOverview.useQuery(
    { projectId },
    queryOptions,
  );
  const overview = dataUnlessAccessError(query.data, query.error);
  const work = api.backgroundWork.list.useQuery(
    {
      projectId,
      audience: overview?.workAudience ?? "mine",
      view: "active",
      limit: DASHBOARD_LIMITS.projectActiveWorkPreview,
    },
    {
      enabled: !!overview,
      retry: false,
      refetchInterval: overview && pageVisible ? 5_000 : false,
      refetchIntervalInBackground: false,
    },
  );
  const activeWork = dataUnlessAccessError(work.data, work.error);
  const reportsQuery = api.dashboard.reports.useQuery(
    { projectId },
    queryOptions,
  );
  const reports = dataUnlessAccessError(reportsQuery.data, reportsQuery.error);
  return (
    <div
      role="region"
      aria-label="Project activity"
      ref={fallbackFocusRef}
      tabIndex={-1}
      className="flex w-full flex-col gap-6 outline-none"
    >
      {query.error ? (
        <div
          role="alert"
          className="border-danger/30 bg-danger/5 space-y-2 rounded-lg border p-3 text-sm"
        >
          <p>
            Project activity is unavailable.
            {overview ? " Displayed information may be out of date." : ""}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {!overview && query.isLoading ? (
        <p role="status" className="text-text-3 text-sm">
          Loading project activity…
        </p>
      ) : null}
      {overview ? (
        <>
          <header className="flex flex-wrap items-center gap-2">
            <h1 className="text-text text-xl font-semibold">
              {overview.project.name}
            </h1>
            <Badge variant="outline">{overview.project.myRole}</Badge>
          </header>
          <ActiveWorkCard
            projectId={projectId}
            audience={overview.workAudience}
            items={activeWork?.items}
            loading={work.isLoading}
            error={work.error}
            retry={() => void work.refetch()}
          />
          <ActivityList
            key={`${projectId}:${overview.workAudience}`}
            projectId={projectId}
            audience={overview.workAudience}
          />
          <ProjectPinsSection
            overview={overview}
            fallbackFocusRef={fallbackFocusRef}
          />
          {reportsQuery.error ? (
            <div
              role="alert"
              className="border-danger/30 bg-danger/5 space-y-2 rounded-lg border p-3 text-sm"
            >
              <p>Could not load scheduled reports.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reportsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {!reports && reportsQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : reports ? (
            <ReportShortcutsCard items={reports.items} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

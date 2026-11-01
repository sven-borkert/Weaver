"use client";

import type { ActivityView } from "@weaver/core/dashboard/schema";
import type { WorkAudience } from "@weaver/core/jobs/backgroundWorkSchema";
import { useEffect, useReducer } from "react";
import { useBackgroundWork } from "~/components/background-work/BackgroundWorkProvider";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  activityReducer,
  initialActivityState,
} from "~/lib/dashboard/activityState";
import { activityKey } from "~/lib/dashboard/presentation";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { ActivityRow } from "./ActivityRow";

const views: Array<{ value: ActivityView; label: string }> = [
  { value: "all", label: "All" },
  { value: "others", label: "Changes by others" },
  { value: "results", label: "Results" },
];

export function ActivityList({
  projectId,
  audience = "mine",
}: {
  projectId?: string;
  audience?: WorkAudience;
}) {
  const { pageVisible } = useBackgroundWork();
  const utils = api.useUtils();
  const [state, dispatch] = useReducer(
    activityReducer,
    projectId,
    initialActivityState,
  );
  useEffect(
    () => dispatch({ type: "filter", view: "all", projectId }),
    [projectId, audience],
  );
  const cursor = state.cursors[state.page] ?? undefined;
  const firstPage = state.page === 0;
  const query = api.dashboard.activity.useQuery(
    {
      audience,
      projectId: state.projectId,
      view: state.view,
      limit: 20,
      cursor,
    },
    {
      retry: false,
      staleTime: firstPage ? 30_000 : Infinity,
      refetchInterval: firstPage && pageVisible ? 30_000 : false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: firstPage,
      refetchOnReconnect: firstPage,
      refetchOnMount: firstPage,
    },
  );
  const data = dataUnlessAccessError(query.data, query.error);
  const projectsQuery = api.project.list.useQuery(undefined, {
    enabled: projectId === undefined,
  });
  const projects = dataUnlessAccessError(
    projectsQuery.data,
    projectsQuery.error,
  );
  const presentation = resolveQueryPresentation(query);
  return (
    <section
      aria-labelledby="latest-activity-heading"
      className="bg-surface border-line rounded-[10px] border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="latest-activity-heading"
          className="text-text text-[14px] font-semibold"
        >
          Latest activity
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {projectId === undefined ? (
            <label className="text-text-3 text-[12px]">
              Project{" "}
              <select
                className="border-line bg-surface text-text rounded-md border px-2 py-1"
                value={state.projectId ?? ""}
                onChange={(event) =>
                  dispatch({
                    type: "filter",
                    view: state.view,
                    projectId: event.target.value || undefined,
                  })
                }
              >
                <option value="">All projects</option>
                {projects?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-1" aria-label="Activity view">
            {views.map((view) => (
              <Button
                key={view.value}
                type="button"
                size="sm"
                variant={state.view === view.value ? "secondary" : "ghost"}
                onClick={() =>
                  dispatch({
                    type: "filter",
                    view: view.value,
                    projectId: state.projectId,
                  })
                }
              >
                {view.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {query.error && data ? (
        <p role="alert" className="text-text-3 mt-3 text-[12px]">
          Could not refresh activity. Displayed results may be out of date.{" "}
          <Button
            size="sm"
            variant="ghost"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : null}
      {presentation === "loading" ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-4/5" />
        </div>
      ) : presentation === "error" ? (
        <p role="alert" className="text-text-2 py-4 text-[13px]">
          Could not load activity.{" "}
          <Button
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : data?.items.length ? (
        <div>
          {data.items.map((entry) => (
            <ActivityRow key={activityKey(entry)} entry={entry} />
          ))}
        </div>
      ) : (
        <p className="text-text-3 py-4 text-[13px]">
          No activity matches these filters.
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={state.page === 0}
            onClick={() => dispatch({ type: "previous" })}
          >
            Previous
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!data?.nextCursor}
            onClick={() =>
              data?.nextCursor &&
              dispatch({ type: "next", cursor: data.nextCursor })
            }
          >
            Next
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={query.isFetching}
          onClick={() => {
            void utils.dashboard.activity.invalidate(
              {
                audience,
                projectId: state.projectId,
                view: state.view,
                limit: 20,
                cursor: undefined,
              },
              { exact: true, refetchType: "none" },
            );
            dispatch({ type: "refresh" });
            if (state.page === 0) void query.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { ClientDateTime } from "~/components/ui/client-date";
import { Skeleton } from "~/components/ui/skeleton";
import { focusDialogTarget } from "~/lib/dialog-focus";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api, type RouterOutputs } from "~/trpc/react";
import { ExternalInputsList } from "./ExternalInputsEditor";
import { RunHistoryTable } from "./RunHistoryTable";
import { TaskDialog } from "./TaskDialog";
import { TaskStatusBadge } from "./TasksScreen";

type Run = RouterOutputs["scheduledTask"]["listRuns"]["runs"][number];

function scopeText(scope: { kind: string; projectIds: string[] }): string {
  if (scope.kind === "document") return "One document";
  if (scope.kind === "table") return "One table";
  if (scope.kind === "all")
    return `All accessible projects (${scope.projectIds.length})`;
  return scope.projectIds.length === 1
    ? "This project"
    : `${scope.projectIds.length} projects`;
}

/** Live runs drive polling so a "Run now" click resolves without a manual reload. */
function hasLiveRun(pages: { runs: Run[] }[] | undefined): boolean {
  return (pages ?? []).some((page) =>
    page.runs.some(
      (run) => run.status === "queued" || run.status === "running",
    ),
  );
}

export function TaskDetailScreen({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const utils = api.useUtils();
  const containerRef = useRef<HTMLDivElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const runs = api.scheduledTask.listRuns.useInfiniteQuery(
    { taskId, limit: 25 },
    {
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: (query) =>
        hasLiveRun(query.state.data?.pages) ? 3000 : false,
    },
  );
  const query = api.scheduledTask.get.useQuery(
    { taskId },
    { refetchInterval: hasLiveRun(runs.data?.pages) ? 3000 : false },
  );
  const presentation = resolveQueryPresentation(query);
  const runsPresentation = resolveQueryPresentation(runs);
  const task = dataUnlessAccessError(query.data, query.error);
  const [editing, setEditing] = useState(false);
  if (editing && task && !task.canEditDefinition) setEditing(false);
  const invalidate = () => {
    void utils.scheduledTask.get.invalidate({ taskId });
    void utils.scheduledTask.listRuns.invalidate({ taskId });
    void utils.scheduledTask.listForProject.invalidate({ projectId });
  };
  const runNow = api.scheduledTask.runNow.useMutation({
    onSuccess: () => {
      toast.success("Run queued");
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (presentation === "loading") return <Skeleton className="h-40 w-full" />;
  if (presentation === "error" || !task)
    return (
      <p role="alert" className="text-text-2 text-[13px]">
        This task isn’t available.
      </p>
    );

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-text m-0 text-[20px] font-semibold">
            {task.name}
          </h1>
          <p className="text-text-3 m-0 text-[13px]">
            {task.scheduleText} · runs as {task.ownerName ?? "—"} (
            {task.ownerEmail})
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TaskStatusBadge task={task} />
          {task.canManage ? (
            <>
              {task.canEditDefinition ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(event) => {
                    editTriggerRef.current = event.currentTarget;
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={runNow.isPending || task.status !== "active"}
                title={
                  task.status !== "active"
                    ? "Resume the task before running it now"
                    : undefined
                }
                onClick={() => runNow.mutate({ taskId })}
              >
                Run now
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px]">
        {task.canEditDefinition ? (
          <>
            <dt className="text-text-3">Instruction</dt>
            <dd className="m-0 whitespace-pre-wrap">{task.instruction}</dd>
            <dt className="text-text-3">Scope</dt>
            <dd className="m-0">{scopeText(task.scopeSnapshot)}</dd>
          </>
        ) : (
          <>
            <dt className="text-text-3">Inputs</dt>
            <dd className="m-0">Visible only to the task owner.</dd>
          </>
        )}
        <dt className="text-text-3">Output</dt>
        <dd className="m-0">
          {task.outputDocumentId ? (
            <Link
              href={`/projects/${projectId}/documents/${task.outputDocumentId}`}
              className="hover:underline"
            >
              Open the report document
            </Link>
          ) : (
            <span>
              Written on the first successful run into{" "}
              {task.outputFolderPath.length
                ? task.outputFolderPath.join(" / ")
                : "the project root"}
            </span>
          )}
        </dd>
        <dt className="text-text-3">Next run</dt>
        <dd className="m-0">
          {task.nextRunAt ? <ClientDateTime value={task.nextRunAt} /> : "—"}
        </dd>
      </dl>
      {task.canEditDefinition ? (
        <ExternalInputsList value={task.externalInputs} />
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="text-text m-0 text-[15px] font-semibold">Run history</h2>
        {runsPresentation === "loading" ? (
          <Skeleton className="h-24 w-full" />
        ) : runsPresentation === "error" ? (
          <p role="alert" className="text-text-2 m-0 text-[13px]">
            Could not load runs.{" "}
            <Button
              size="sm"
              variant="outline"
              disabled={runs.isFetching}
              onClick={() => void runs.refetch()}
            >
              Retry
            </Button>
          </p>
        ) : runs.data?.pages.flatMap((page) => page.runs).length ? (
          <RunHistoryTable
            runs={runs.data.pages.flatMap((page) => page.runs)}
          />
        ) : (
          <p className="text-text-3 m-0 text-[13px]">No runs yet.</p>
        )}
        {runs.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            disabled={runs.isFetchingNextPage}
            onClick={() => void runs.fetchNextPage()}
          >
            Load more
          </Button>
        ) : null}
      </section>
      {task.canEditDefinition ? (
        <TaskDialog
          key={task.id}
          projectId={projectId}
          task={task}
          open={editing}
          onOpenChange={setEditing}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(editTriggerRef.current, containerRef.current);
          }}
        />
      ) : null}
    </div>
  );
}

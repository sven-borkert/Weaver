"use client";

import {
  CalendarClock,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { projectRoleAtLeast } from "@weaver/core/roles";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ClientDateTime } from "~/components/ui/client-date";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { focusDialogTarget } from "~/lib/dialog-focus";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  PAUSE_REASON_LABELS,
  RUN_STATUS_LABELS,
  TASK_STATUS_LABELS,
} from "./scheduleForm";
import { TaskDialog } from "./TaskDialog";

type TaskRow = RouterOutputs["scheduledTask"]["listForProject"][number];

export function TaskStatusBadge({
  task,
}: {
  task: Pick<TaskRow, "status" | "pauseReason">;
}) {
  if (task.status === "active")
    return <Badge variant="secondary">{TASK_STATUS_LABELS.active}</Badge>;
  return (
    <Badge variant={task.pauseReason === "failing" ? "destructive" : "outline"}>
      {TASK_STATUS_LABELS.paused}
      {task.pauseReason ? ` · ${PAUSE_REASON_LABELS[task.pauseReason]}` : ""}
    </Badge>
  );
}

export function LastRunCell({
  task,
}: {
  task: Pick<TaskRow, "lastRunAt" | "lastRunStatus">;
}) {
  if (!task.lastRunAt || !task.lastRunStatus)
    return <span className="text-text-3">Never</span>;
  return (
    <span className="flex flex-col">
      <span>{RUN_STATUS_LABELS[task.lastRunStatus]}</span>
      <span className="text-text-3 text-[12px]">
        <ClientDateTime value={task.lastRunAt} />
      </span>
    </span>
  );
}

/** Presentational — renders without tRPC so it can be tested with renderToStaticMarkup. */
export function TasksTable({
  projectId,
  tasks,
  onEdit,
  onAction,
  triggerRef,
}: {
  projectId: string;
  tasks: TaskRow[];
  onEdit: (task: TaskRow) => void;
  onAction: (
    action: "runNow" | "pause" | "resume" | "delete",
    task: TaskRow,
  ) => void;
  /** Records the row's action button so a dialog can hand focus back to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>Runs as</TableHead>
          <TableHead>Last run</TableHead>
          <TableHead>Next run</TableHead>
          <TableHead>Output</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.map((task) => (
          <TableRow key={task.id}>
            <TableCell className="text-text text-[13px] font-medium">
              <Link
                href={`/projects/${projectId}/tasks/${task.id}`}
                className="hover:underline"
              >
                {task.name}
              </Link>
            </TableCell>
            <TableCell>{task.scheduleText}</TableCell>
            <TableCell title="The task uses this account's project access and MCP connections">
              <span className="text-text block text-[13px]">
                {task.ownerName ?? "—"}
              </span>
              <span className="text-text-3 block text-[11px]">
                {task.ownerEmail}
              </span>
            </TableCell>
            <TableCell>
              <LastRunCell task={task} />
            </TableCell>
            <TableCell>
              {task.nextRunAt ? (
                <ClientDateTime value={task.nextRunAt} />
              ) : (
                <span className="text-text-3">—</span>
              )}
            </TableCell>
            <TableCell>
              {task.outputDocumentId ? (
                <Link
                  href={`/projects/${projectId}/documents/${task.outputDocumentId}`}
                  className="hover:underline"
                >
                  Open document
                </Link>
              ) : (
                <span className="text-text-3">Not yet written</span>
              )}
            </TableCell>
            <TableCell>
              <TaskStatusBadge task={task} />
            </TableCell>
            <TableCell>
              {task.canManage ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${task.name}`}
                      onClick={(event) => {
                        if (triggerRef)
                          triggerRef.current = event.currentTarget;
                      }}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={task.status !== "active"}
                      onSelect={() => onAction("runNow", task)}
                    >
                      <Play data-icon="inline-start" />
                      Run now
                    </DropdownMenuItem>
                    {task.status === "active" ? (
                      <DropdownMenuItem
                        onSelect={() => onAction("pause", task)}
                      >
                        <Pause data-icon="inline-start" />
                        Pause
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => onAction("resume", task)}
                      >
                        <Play data-icon="inline-start" />
                        Resume
                      </DropdownMenuItem>
                    )}
                    {task.canEditDefinition ? (
                      <DropdownMenuItem onSelect={() => onEdit(task)}>
                        Edit
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      onSelect={() => onAction("delete", task)}
                      className="text-danger"
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function TasksScreen({ projectId }: { projectId: string }) {
  const utils = api.useUtils();
  const project = api.project.get.useQuery({ projectId });
  const query = api.scheduledTask.listForProject.useQuery({ projectId });
  const presentation = resolveQueryPresentation(query);
  const tasks = dataUnlessAccessError(query.data, query.error);
  const [dialog, setDialog] = useState<{
    open: boolean;
    taskId: string | null;
  }>({ open: false, taskId: null });
  const screenRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const editing = api.scheduledTask.get.useQuery(
    { taskId: dialog.taskId ?? "" },
    { enabled: dialog.open && dialog.taskId !== null },
  );
  const invalidate = () => {
    void utils.scheduledTask.listForProject.invalidate({ projectId });
    void utils.scheduledTask.listMine.invalidate();
  };
  const mutation = (message: string) => ({
    onSuccess: () => {
      toast.success(message);
      invalidate();
    },
    onError: (err: { message: string }) => {
      toast.error(err.message);
      invalidate();
    },
  });
  const runNow = api.scheduledTask.runNow.useMutation(mutation("Run queued"));
  const pause = api.scheduledTask.pause.useMutation(mutation("Task paused"));
  const resume = api.scheduledTask.resume.useMutation(mutation("Task resumed"));
  const remove = api.scheduledTask.delete.useMutation(mutation("Task deleted"));
  const canCreate =
    !!project.data && projectRoleAtLeast(project.data.myRole, "Editor");

  return (
    <div
      ref={screenRef}
      role="region"
      aria-label="Tasks"
      tabIndex={-1}
      className="flex w-full flex-col gap-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-text m-0 text-[20px] font-semibold">Tasks</h1>
          <p className="text-text-3 m-0 text-[13px]">
            Scheduled AI tasks that write their report into this project.
          </p>
        </div>
        {canCreate ? (
          <Button
            size="sm"
            onClick={(event) => {
              triggerRef.current = event.currentTarget;
              setDialog({ open: true, taskId: null });
            }}
          >
            <Plus data-icon="inline-start" />
            New task
          </Button>
        ) : null}
      </div>
      {presentation === "loading" ? (
        <Skeleton className="h-24 w-full" />
      ) : presentation === "error" ? (
        <div role="alert">
          Could not load tasks.{" "}
          <Button
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !tasks?.length ? (
        <div className="border-line bg-surface flex flex-col items-center gap-3 rounded-[10px] border border-dashed px-6 py-12 text-center">
          <CalendarClock className="text-text-3 size-5" strokeWidth={1.75} />
          <div className="text-text text-[14px] font-semibold">
            No scheduled tasks yet
          </div>
          <p className="text-text-3 m-0 max-w-[420px] text-[13px]">
            A task reads what you can read, runs on a schedule, and keeps one
            report document up to date.
          </p>
        </div>
      ) : (
        <TasksTable
          projectId={projectId}
          tasks={tasks}
          triggerRef={triggerRef}
          onEdit={(task) => setDialog({ open: true, taskId: task.id })}
          onAction={(action, task) => {
            if (action === "runNow") runNow.mutate({ taskId: task.id });
            if (action === "pause") pause.mutate({ taskId: task.id });
            if (action === "resume") resume.mutate({ taskId: task.id });
            if (
              action === "delete" &&
              window.confirm(
                `Delete "${task.name}"? Its output document stays in the project.`,
              )
            )
              remove.mutate({ taskId: task.id });
          }}
        />
      )}
      {dialog.taskId === null || editing.data ? (
        <TaskDialog
          key={dialog.taskId ?? "new"}
          projectId={projectId}
          task={dialog.taskId ? (editing.data ?? null) : null}
          open={dialog.open}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(triggerRef.current, screenRef.current);
          }}
          onOpenChange={(open) =>
            setDialog((current) => ({ ...current, open }))
          }
        />
      ) : null}
    </div>
  );
}

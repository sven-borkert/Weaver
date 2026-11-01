"use client";

import Link from "next/link";
import { toast } from "sonner";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { TaskDialog } from "../../../projects/[projectId]/tasks/_components/TaskDialog";
import { ClientDateTime } from "~/components/ui/client-date";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { resolveQueryPresentation } from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import {
  LastRunCell,
  TaskStatusBadge,
} from "../../../projects/[projectId]/tasks/_components/TasksScreen";

export function MyTasksCard() {
  const [editing, setEditing] = useState<{
    id: string;
    projectId: string;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const query = api.scheduledTask.listMine.useQuery();
  const utils = api.useUtils();
  const remove = api.scheduledTask.delete.useMutation({
    onSuccess: async () => {
      await utils.scheduledTask.listMine.invalidate();
      toast.success("Task deleted");
    },
    onError: (error) => toast.error(error.message),
  });
  const presentation = resolveQueryPresentation(query);
  if (presentation === "loading") return <Skeleton className="h-24 w-full" />;
  if (presentation === "error")
    return (
      <p role="alert" className="text-text-2 text-[13px]">
        Could not load your tasks.
      </p>
    );
  if (!query.data?.length)
    return (
      <p className="text-text-3 m-0 text-[13px]">
        You have no scheduled tasks. Create one from a project’s Tasks section.
      </p>
    );
  return (
    <div ref={container}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Next run</TableHead>
            <TableHead>Output</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.data.map((task) => (
            <TableRow key={task.id}>
              <TableCell className="text-text text-[13px] font-medium">
                <Link
                  href={`/projects/${task.outputProjectId}/tasks/${task.id}`}
                  className="hover:underline"
                >
                  {task.name}
                </Link>
              </TableCell>
              <TableCell>{task.outputProjectName}</TableCell>
              <TableCell>{task.scheduleText}</TableCell>
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
                    href={`/projects/${task.outputProjectId}/documents/${task.outputDocumentId}`}
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
                {task.canEditDefinition ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      setEditing({
                        id: task.id,
                        projectId: task.outputProjectId,
                      });
                    }}
                  >
                    Edit {task.name}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete "${task.name}"? Its output document stays in the project.`,
                      )
                    )
                      remove.mutate({ taskId: task.id });
                  }}
                >
                  Delete {task.name}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editing ? (
        <AccountTaskEditor
          key={editing.id}
          taskId={editing.id}
          projectId={editing.projectId}
          onClose={() => setEditing(null)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(trigger.current, container.current);
          }}
        />
      ) : null}
    </div>
  );
}

export function AccountTaskEditor({
  taskId,
  projectId,
  onClose,
  onCloseAutoFocus,
}: {
  taskId: string;
  projectId: string;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const query = api.scheduledTask.get.useQuery({ taskId });
  const presentation = resolveQueryPresentation(query);
  if (presentation === "loading")
    return <p role="status">Loading task editor…</p>;
  if (presentation === "error" || !query.data?.canEditDefinition)
    return (
      <p role="alert">
        This task is no longer editable.{" "}
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </p>
    );
  return (
    <TaskDialog
      projectId={projectId}
      task={query.data}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}

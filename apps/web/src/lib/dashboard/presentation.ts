import type { BackgroundWorkState } from "@weaver/core/jobs/backgroundWorkSchema";
import type { DashboardDestination } from "@weaver/core/dashboard/schema";

const part = encodeURIComponent;

export function activityKey(entry: { source: string; id: string }) {
  return `${entry.source}:${entry.id}`;
}

export function dashboardDestinationHref(
  destination: DashboardDestination,
): string {
  switch (destination.kind) {
    case "exam":
      return `/projects/${part(destination.projectId)}/exams/attempts/${part(destination.attemptId)}`;
    case "document":
      return `/projects/${part(destination.projectId)}/documents/${part(destination.documentId)}`;
    case "table":
      return `/projects/${part(destination.projectId)}/tables/${part(destination.tableId)}`;
    case "task":
      return `/projects/${part(destination.projectId)}/tasks/${part(destination.taskId)}`;
    case "import":
      return `/projects/${part(destination.projectId)}/imports/${part(destination.fileId)}`;
    case "assistant":
      return `/assistant/${part(destination.conversationId)}`;
    case "knowledge":
      return `/projects/${part(destination.projectId)}/graph`;
    case "git_sync":
      return `/projects/${part(destination.projectId)}/settings`;
    case "notebook":
      return `/projects/${part(destination.projectId)}/artifacts?file=${part(destination.filename)}`;
  }
}

export function activityAttribution(
  editorName: string | null,
  isOwnChange: boolean | null,
) {
  if (isOwnChange) return "Updated by you";
  return editorName ? `Updated by ${editorName}` : "Updated";
}

const outcome: Record<BackgroundWorkState, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  skipped: "Skipped",
};
export const workOutcomeLabel = (state: BackgroundWorkState) => outcome[state];

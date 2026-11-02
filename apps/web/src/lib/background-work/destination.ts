import type { WorkDestination } from "@weaver/core/jobs/backgroundWorkSchema";

export function backgroundWorkHref(destination: WorkDestination): string {
  switch (destination.kind) {
    case "wiki":
      return `/projects/${destination.projectId}/wiki`;
    case "exam":
      return `/projects/${destination.projectId}/exams/attempts/${destination.attemptId}`;
    case "task":
      return `/projects/${destination.projectId}/tasks/${destination.taskId}`;
    case "import":
      return `/projects/${destination.projectId}/imports/${destination.fileId}`;
    case "assistant":
      return `/assistant/${destination.conversationId}`;
    case "knowledge":
      return `/projects/${destination.projectId}/settings`;
    case "git_sync":
      return `/projects/${destination.projectId}/settings`;
    case "notebook":
      return `/projects/${destination.projectId}/artifacts?file=${encodeURIComponent(destination.filename)}`;
  }
}

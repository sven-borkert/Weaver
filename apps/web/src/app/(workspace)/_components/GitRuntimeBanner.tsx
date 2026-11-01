import { TriangleAlert } from "lucide-react";
import type { GitRuntimeStatus } from "@weaver/git-store/version";

export function gitRuntimeMessage(git: GitRuntimeStatus): string | null {
  if (git.status === "missing") {
    return "Git is not installed on the server. Documents, tables, and history can't load until an administrator installs Git.";
  }
  if (git.status === "unsupported") {
    return `The server runs Git ${git.version}, but Weaver needs Git ${git.minimum} or newer. Documents, tables, and history can't load until an administrator upgrades Git.`;
  }
  return null;
}

export function GitRuntimeBanner({ git }: { git: GitRuntimeStatus }) {
  const message = gitRuntimeMessage(git);
  if (!message) return null;
  return (
    <div
      role="alert"
      className="border-danger-border bg-danger-bg text-danger flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[13px]"
    >
      <TriangleAlert className="size-4 shrink-0" strokeWidth={1.75} />
      <span>{message}</span>
    </div>
  );
}

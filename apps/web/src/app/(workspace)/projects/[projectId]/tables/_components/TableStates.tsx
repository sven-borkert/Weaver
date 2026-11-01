import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

type WorkspaceStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

function WorkspaceState({ title, description, action }: WorkspaceStateProps) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <h2 className="text-text m-0 text-[15px] font-semibold">{title}</h2>
      {description ? (
        <p className="text-text-3 m-0 max-w-md text-[13px]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function WorkspaceLoading({
  title = "Loading tables",
  description = "Retrieving this project’s table workspace.",
}: Partial<WorkspaceStateProps>) {
  return (
    <div
      role="status"
      aria-label={title}
      className="mx-auto flex h-full min-h-48 w-full max-w-xl flex-col justify-center gap-3 px-6 py-10"
    >
      <span className="sr-only">
        {title}. {description}
      </span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="mt-2 h-20 w-full" />
    </div>
  );
}

export function WorkspaceEmpty({
  title = "No tables yet",
  description = "Tables will appear here when they are added to this project.",
  action,
}: Partial<WorkspaceStateProps>) {
  return (
    <WorkspaceState title={title} description={description} action={action} />
  );
}

export function WorkspaceNotFound({
  title = "Project not found",
  description = "This project may have been deleted, or you do not have access to it.",
  action,
}: Partial<WorkspaceStateProps>) {
  return (
    <div role="alert">
      <WorkspaceState title={title} description={description} action={action} />
    </div>
  );
}

export function WorkspaceError({
  title = "Could not load tables",
  description = "Please try again.",
  action,
}: Partial<WorkspaceStateProps>) {
  return (
    <div role="alert">
      <WorkspaceState title={title} description={description} action={action} />
    </div>
  );
}

export function WorkspaceRefreshError({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="border-danger-border bg-danger-bg flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 sm:px-6"
    >
      <div className="min-w-0">
        <p className="text-danger m-0 text-[12px] font-medium">{title}</p>
        <p className="text-text-3 mt-0.5 mb-0 text-[12px]">{description}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

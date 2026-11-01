import type { ReactNode } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

type WorkspaceStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

function WorkspaceState({
  title,
  description,
  action,
  className,
}: WorkspaceStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-48 flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className,
      )}
    >
      <h2 className="text-text m-0 text-[15px] font-semibold">{title}</h2>
      {description ? (
        <p className="text-text-3 m-0 max-w-md text-[13px]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function WorkspaceLoading({
  title = "Loading documents",
  description = "Retrieving this project’s document workspace.",
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
  title = "No documents yet",
  description = "Create a document to begin building this project’s knowledge base.",
  action,
  className,
}: Partial<WorkspaceStateProps>) {
  return (
    <WorkspaceState
      title={title}
      description={description}
      action={action}
      className={className}
    />
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
  title = "Could not load documents",
  description = "Please try again.",
  action,
}: Partial<WorkspaceStateProps>) {
  return (
    <div role="alert">
      <WorkspaceState title={title} description={description} action={action} />
    </div>
  );
}

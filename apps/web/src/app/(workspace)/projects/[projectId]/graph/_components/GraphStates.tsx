import type { ReactNode } from "react";

import { Skeleton } from "~/components/ui/skeleton";

type GraphStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

function GraphState({ title, description, action }: GraphStateProps) {
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

export function GraphLoading({
  title = "Loading graph workspace",
  description = "Retrieving this project’s knowledge graph.",
}: Partial<GraphStateProps>) {
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

export function GraphNotFound({
  title = "Project not found",
  description = "This project may have been deleted, or you do not have access to it.",
  action,
}: Partial<GraphStateProps>) {
  return (
    <div role="alert">
      <GraphState title={title} description={description} action={action} />
    </div>
  );
}

export function GraphError({
  title = "Could not load knowledge graph",
  description = "Please try again.",
  action,
}: Partial<GraphStateProps>) {
  return (
    <div role="alert">
      <GraphState title={title} description={description} action={action} />
    </div>
  );
}

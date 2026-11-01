"use client";

import { Pin } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

export function relativeTime(date: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - date.getTime()) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function ConversationList({
  activeId,
  onSelect,
  pageSize = 30,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  pageSize?: number;
}) {
  const mounted = useMounted();
  const projects = api.project.list.useQuery();
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const query = api.assistant.listConversations.useInfiniteQuery(
    { limit: pageSize },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  if (!query.isLoading && items.length === 0) {
    return <p className="text-text-2 p-4 text-[13px]">No conversations yet.</p>;
  }
  return (
    <div className="scrollarea min-h-0 flex-1 overflow-y-auto">
      <ul aria-label="Conversations" className="flex flex-col p-2">
        {items.map((c) => {
          const active = c.id === activeId;
          return (
            <li key={c.id}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect(c.id)}
                className={cn(
                  "hover:bg-hover flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left",
                  active && "bg-subtle",
                )}
              >
                <span className="text-text flex items-center gap-2 text-[13px]">
                  {c.activeRun ? (
                    <span
                      aria-label="Run in progress"
                      className="bg-brand size-1.5 shrink-0 animate-pulse rounded-full"
                    />
                  ) : c.lastRunStatus === "failed" ? (
                    <span
                      aria-label="Last run failed"
                      title="Last run failed"
                      className="bg-danger size-1.5 shrink-0 rounded-full"
                    />
                  ) : null}
                  <span className="truncate">{c.title}</span>
                </span>
                <span className="text-text-muted flex items-center gap-2 text-[11px]">
                  {c.pinnedProjectId && names.get(c.pinnedProjectId) ? (
                    <span className="flex items-center gap-1">
                      <Pin className="size-3" aria-hidden="true" />
                      {names.get(c.pinnedProjectId)}
                    </span>
                  ) : null}
                  {mounted && c.lastMessageAt ? (
                    <span>
                      {relativeTime(new Date(c.lastMessageAt), new Date())}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mx-2 mb-2 w-[calc(100%-1rem)]"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load older
        </Button>
      ) : null}
    </div>
  );
}

"use client";

import { History } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { getTableHistoryEntryState } from "~/lib/tables/panel-state";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

const HISTORY_PAGE_SIZE = 50;
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type HistoryEntry = RouterOutputs["table"]["history"]["entries"][number];

function deduplicateHistory(entries: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.sha)) return false;
    seen.add(entry.sha);
    return true;
  });
}

export function TableHistoryPanel({
  projectId,
  tableId,
  currentSha,
  selectedSha,
  onSelectVersion,
}: {
  projectId: string;
  tableId: string;
  currentSha: string;
  selectedSha?: string;
  onSelectVersion: (sha: string) => void;
}) {
  const mounted = useMounted();
  const utils = api.useUtils();
  const historyQuery = api.table.history.useQuery({
    projectId,
    tableId,
    offset: 0,
    limit: HISTORY_PAGE_SIZE,
  });
  const [appendedEntries, setAppendedEntries] = useState<HistoryEntry[]>([]);
  const [appendedHasMore, setAppendedHasMore] = useState<boolean>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const entries = useMemo(
    () =>
      deduplicateHistory([
        ...(historyQuery.data?.entries ?? []),
        ...appendedEntries,
      ]),
    [appendedEntries, historyQuery.data?.entries],
  );
  const hasMore = appendedHasMore ?? historyQuery.data?.hasMore ?? false;

  const loadMore = async () => {
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const next = await utils.table.history.fetch({
        projectId,
        tableId,
        offset: entries.length,
        limit: HISTORY_PAGE_SIZE,
      });
      setAppendedEntries((current) =>
        deduplicateHistory([...current, ...next.entries]),
      );
      setAppendedHasMore(next.hasMore);
    } catch {
      setLoadMoreError("Could not load more history. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section aria-labelledby="table-history-heading" className="p-3">
      <div className="mb-3 flex items-center gap-2">
        <History className="text-text-3 size-4" aria-hidden="true" />
        <h3
          id="table-history-heading"
          className="text-text m-0 text-[13px] font-semibold"
        >
          History
        </h3>
      </div>

      {historyQuery.isLoading && entries.length === 0 ? (
        <div role="status" aria-label="Loading table history">
          <span className="sr-only">Loading table history…</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="mt-2 h-16 w-full" />
          <Skeleton className="mt-2 h-16 w-full" />
        </div>
      ) : historyQuery.error && entries.length === 0 ? (
        <div
          role="alert"
          className="border-danger-border bg-danger-bg rounded-[8px] border p-3"
        >
          <p className="text-danger m-0 text-[12px] font-medium">
            Could not load history
          </p>
          <p className="text-text-3 mt-1 mb-0 text-[12px]">
            Refresh the page to try loading the version timeline again.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void historyQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-text-3 m-0 py-4 text-center text-[12px]">
          No versions found.
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map((entry) => {
            const { current: isCurrent, selected: isSelected } =
              getTableHistoryEntryState(currentSha, selectedSha, entry.sha);
            return (
              <li key={entry.sha}>
                <button
                  type="button"
                  disabled={isCurrent}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-pressed={isSelected}
                  onClick={() => onSelectVersion(entry.sha)}
                  className={cn(
                    "border-line-faint hover:bg-hover focus-visible:ring-brand/50 w-full rounded-[8px] border px-3 py-2.5 text-left outline-none focus-visible:ring-3 disabled:cursor-default disabled:opacity-100",
                    isSelected && "border-brand-border bg-brand-bg",
                    isCurrent && "bg-surface",
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-text min-w-0 text-[12px] leading-4 font-medium break-words">
                      {entry.message}
                    </span>
                    {isCurrent ? (
                      <span className="border-approved-border bg-approved-bg text-approved shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                        Current
                      </span>
                    ) : null}
                  </span>
                  <span className="text-text-3 mt-1 block text-[11px]">
                    {entry.userName ?? entry.authorName}
                  </span>
                  {mounted ? (
                    <time
                      dateTime={entry.date.toISOString()}
                      className="text-text-muted mt-0.5 block text-[11px]"
                    >
                      {dateTimeFormatter.format(entry.date)}
                    </time>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {historyQuery.error && entries.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p role="alert" className="text-danger m-0 text-[12px]">
            History could not refresh. Showing cached versions.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void historyQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {loadMoreError ? (
        <p role="alert" className="text-danger mt-3 mb-0 text-[12px]">
          {loadMoreError}
        </p>
      ) : null}
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          disabled={loadingMore}
          aria-busy={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}

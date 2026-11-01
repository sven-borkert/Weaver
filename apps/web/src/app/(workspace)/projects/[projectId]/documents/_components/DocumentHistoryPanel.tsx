"use client";

import { History, LoaderCircle } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { changeSummaryMessage } from "@weaver/core/documents/changeSummaryMessage";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { changeSummaryRefetchInterval } from "~/lib/documents/change-summary";
import { cn } from "~/lib/utils";
import { useMounted } from "~/lib/use-mounted";
import { api, type RouterOutputs } from "~/trpc/react";

const HISTORY_PAGE_SIZE = 20;
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type HistoryEntry = RouterOutputs["document"]["history"]["entries"][number];

export type DocumentHistoryPagination = {
  entries: HistoryEntry[];
  hasMore?: boolean;
};

type DocumentHistoryPanelProps = {
  projectId: string;
  documentId: string;
  currentSha: string;
  selectedSha?: string;
  focusSelectedRequest?: number;
  pagination: DocumentHistoryPagination;
  onPaginationChange: Dispatch<SetStateAction<DocumentHistoryPagination>>;
  onSelectVersion: (sha: string) => void;
};

export function DocumentHistoryPanel({
  projectId,
  documentId,
  currentSha,
  selectedSha,
  focusSelectedRequest = 0,
  pagination,
  onPaginationChange,
  onSelectVersion,
}: DocumentHistoryPanelProps) {
  const selectedButtonRef = useRef<HTMLButtonElement>(null);
  const fulfilledFocusRequestRef = useRef(0);
  const mounted = useMounted();
  const utils = api.useUtils();
  const historyQuery = api.document.history.useQuery(
    {
      projectId,
      documentId,
      offset: 0,
      limit: HISTORY_PAGE_SIZE,
    },
    {
      refetchInterval: (query) =>
        changeSummaryRefetchInterval(query.state.data, Date.now()),
    },
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const firstPage = historyQuery.data?.entries ?? [];
  const entries = [...firstPage, ...pagination.entries];
  const hasMore = pagination.hasMore ?? historyQuery.data?.hasMore ?? false;

  useEffect(() => {
    if (
      !focusSelectedRequest ||
      !selectedSha ||
      fulfilledFocusRequestRef.current === focusSelectedRequest
    ) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const target = selectedButtonRef.current;
      if (!target) return;
      target.focus();
      if (document.activeElement === target) {
        fulfilledFocusRequestRef.current = focusSelectedRequest;
      }
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [
    focusSelectedRequest,
    historyQuery.data,
    pagination.entries,
    selectedSha,
  ]);

  const loadMore = async () => {
    setLoadingMore(true);
    setLoadMoreError(undefined);

    try {
      const next = await utils.document.history.fetch({
        projectId,
        documentId,
        offset: entries.length,
        limit: HISTORY_PAGE_SIZE,
      });
      onPaginationChange((current) => {
        const seen = new Set(
          [...firstPage, ...current.entries].map((entry) => entry.sha),
        );
        const unique = next.entries.filter((entry) => {
          if (seen.has(entry.sha)) return false;
          seen.add(entry.sha);
          return true;
        });
        return {
          entries: [...current.entries, ...unique],
          hasMore: next.hasMore,
        };
      });
    } catch {
      setLoadMoreError("Could not load more history. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section aria-labelledby="document-history-heading" className="p-3">
      <div className="mb-3 flex items-center gap-2">
        <History className="text-text-3 size-4" aria-hidden="true" />
        <h3
          id="document-history-heading"
          className="text-text m-0 text-[13px] font-semibold"
        >
          History
        </h3>
      </div>

      {historyQuery.isLoading && entries.length === 0 ? (
        <div role="status" aria-label="Loading document history">
          <span className="sr-only">Loading document history…</span>
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
        </div>
      ) : entries.length === 0 ? (
        <p className="text-text-3 m-0 py-4 text-center text-[12px]">
          No versions found.
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map((entry) => {
            const isCurrent = entry.sha === currentSha;
            const isSelected = entry.sha === selectedSha;
            const author = entry.userName ?? entry.authorName;

            return (
              <li key={entry.sha}>
                <button
                  ref={isSelected ? selectedButtonRef : undefined}
                  type="button"
                  disabled={isCurrent}
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => onSelectVersion(entry.sha)}
                  className={cn(
                    "border-line-faint hover:bg-hover focus-visible:ring-brand/50 w-full rounded-[8px] border px-3 py-2.5 text-left outline-none focus-visible:ring-3 disabled:cursor-default disabled:opacity-100",
                    isSelected && "border-brand-border bg-brand-bg",
                    isCurrent && "bg-surface",
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-text min-w-0 text-[12px] leading-4 font-medium break-words">
                      {changeSummaryMessage(entry.message, entry.changeSummary)}
                    </span>
                    {isCurrent ? (
                      <span className="border-approved-border bg-approved-bg text-approved shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                        Current
                      </span>
                    ) : null}
                  </span>
                  {entry.changeSummary?.status === "pending" ? (
                    <span
                      role="status"
                      className="text-text-muted mt-1 flex items-center gap-1 text-[11px]"
                    >
                      <LoaderCircle
                        className="size-3 animate-spin"
                        aria-hidden="true"
                      />
                      Summarizing…
                    </span>
                  ) : entry.changeSummary?.status === "failed" ? (
                    <span className="text-text-muted mt-1 block text-[11px]">
                      Summary unavailable
                    </span>
                  ) : null}
                  <span className="text-text-3 mt-1 block text-[11px]">
                    {author}
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

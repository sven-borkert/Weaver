"use client";

import { ArrowDownLeft } from "lucide-react";
import Link from "next/link";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useMounted } from "~/lib/use-mounted";
import { api } from "~/trpc/react";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function TableBacklinksPanel({
  projectId,
  tableId,
}: {
  projectId: string;
  tableId: string;
}) {
  const mounted = useMounted();
  const backlinksQuery = api.table.backlinks.useQuery({ projectId, tableId });
  const sources = backlinksQuery.data;

  return (
    <section aria-labelledby="table-backlinks-heading" className="p-3">
      <div className="mb-3 flex items-center gap-2">
        <ArrowDownLeft className="text-text-3 size-4" aria-hidden="true" />
        <h3
          id="table-backlinks-heading"
          className="text-text m-0 text-[13px] font-semibold"
        >
          Linked from
        </h3>
      </div>

      {backlinksQuery.isLoading && !sources ? (
        <div role="status" aria-label="Loading table backlinks">
          <span className="sr-only">Loading table backlinks…</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="mt-2 h-20 w-full" />
        </div>
      ) : backlinksQuery.error && !sources ? (
        <div
          role="alert"
          className="border-danger-border bg-danger-bg rounded-[8px] border p-3"
        >
          <p className="text-danger m-0 text-[12px] font-medium">
            Could not load backlinks
          </p>
          <p className="text-text-3 mt-1 mb-0 text-[12px]">
            Refresh the page to try loading source documents again.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void backlinksQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : sources?.length ? (
        <>
          {backlinksQuery.error ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p role="alert" className="text-danger m-0 text-[12px]">
                Backlinks could not refresh. Showing cached documents.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void backlinksQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {sources.map((source) => (
              <li key={source.id}>
                <Link
                  href={`/projects/${projectId}/documents/${source.id}`}
                  className="border-line-faint hover:bg-hover focus-visible:ring-brand/50 block rounded-[8px] border px-3 py-2.5 no-underline outline-none focus-visible:ring-3"
                >
                  <span className="text-text block truncate text-[12px] font-medium">
                    {source.title}
                  </span>
                  <span className="text-text-muted mt-0.5 block truncate text-[11px]">
                    {source.path}
                  </span>
                  {source.excerpt ? (
                    <span className="text-text-3 mt-1 line-clamp-2 block text-[11px] leading-4">
                      {source.excerpt}
                    </span>
                  ) : null}
                  {mounted ? (
                    <time
                      dateTime={source.lastEditedAt.toISOString()}
                      className="text-text-muted mt-1 block text-[11px]"
                    >
                      Last edited{" "}
                      {dateTimeFormatter.format(source.lastEditedAt)}
                    </time>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {backlinksQuery.error ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p role="alert" className="text-danger m-0 text-[12px]">
                Backlinks could not refresh. Showing cached documents.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void backlinksQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          <p className="text-text-3 m-0 py-4 text-center text-[12px]">
            No documents link to this table.
          </p>
        </>
      )}
    </section>
  );
}

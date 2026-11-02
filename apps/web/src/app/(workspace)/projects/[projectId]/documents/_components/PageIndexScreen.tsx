"use client";

import Link from "next/link";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { documentHref, documentsBase } from "~/lib/documents/explorer";
import { resolveQueryPresentation } from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { DocumentsWorkspace } from "./DocumentsWorkspace";
import { WorkspaceEmpty, WorkspaceError } from "./DocumentStates";
import { groupIndexPages } from "./pageIndexGroups";

export function PageIndexScreen({ projectId }: { projectId: string }) {
  const query = api.document.pageIndex.useInfiniteQuery(
    { projectId },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const presentation = resolveQueryPresentation(query);
  const pages = useMemo(
    () => query.data?.pages.flatMap((page) => page.pages) ?? [],
    [query.data],
  );
  const groups = useMemo(() => groupIndexPages(pages), [pages]);
  const overview = query.data?.pages[0]?.overview ?? null;

  let body;
  if (presentation === "loading") body = <Skeleton className="h-40 w-full" />;
  else if (presentation !== "data")
    body = (
      <WorkspaceError
        title="Could not load the index"
        description="Refresh the page to try again."
      />
    );
  else if (pages.length === 0)
    body = (
      <WorkspaceEmpty
        title="No pages yet"
        description="Pages appear here, grouped by their type, once documents exist."
      />
    );
  else
    body = (
      <div className="flex flex-col gap-5">
        {groups.map((group, index) => (
          <section
            key={`${group.key}:${index}`}
            aria-label={group.label}
            className="flex flex-col gap-1.5"
          >
            <h2 className="text-text m-0 text-[14px] font-semibold">
              {group.label}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {group.pages.map((page) => (
                <li key={page.id} className="text-[13px]">
                  <Link
                    href={documentHref(projectId, page.id)}
                    className="text-brand-text font-medium hover:underline"
                  >
                    {page.title}
                  </Link>
                  {page.summary ? (
                    <span className="text-text-2"> — {page.summary}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {query.hasNextPage ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>
    );

  return (
    <DocumentsWorkspace canvasLabel="Page index">
      <div className="flex min-h-full w-full flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-text m-0 text-[20px] font-semibold">Index</h1>
          <p className="text-text-3 m-0 text-[13px]">
            Pages grouped by type.{" "}
            {overview ? (
              <>
                Start with{" "}
                <Link
                  href={documentHref(projectId, overview.id)}
                  className="text-brand-text hover:underline"
                >
                  {overview.title}
                </Link>
                .{" "}
              </>
            ) : null}
            <Link
              href={documentsBase(projectId)}
              className="text-brand-text hover:underline"
            >
              Back to documents
            </Link>
          </p>
        </div>
        {body}
      </div>
    </DocumentsWorkspace>
  );
}

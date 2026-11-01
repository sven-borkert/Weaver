"use client";

import { ArrowDownLeft, ArrowUpRight, Table2 } from "lucide-react";
import Link from "next/link";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  documentReferenceKey,
  indexResolvedDocumentReferences,
  type CollectedDocumentReference,
} from "~/lib/documents/references";
import { api } from "~/trpc/react";

type DocumentLinksPanelProps = {
  projectId: string;
  documentId: string;
  outgoing: CollectedDocumentReference[];
};

type LinkItemProps = {
  projectId: string;
  targetType: "document" | "table";
  item: {
    id: string;
    title: string;
    path: string;
    excerpt: string;
  };
};

function LinkItem({ projectId, targetType, item }: LinkItemProps) {
  const href = `/projects/${projectId}/${targetType === "table" ? "tables" : "documents"}/${item.id}`;

  return (
    <li>
      <Link
        href={href}
        className="border-line-faint hover:bg-hover focus-visible:ring-brand/50 block rounded-[8px] border px-3 py-2.5 no-underline outline-none focus-visible:ring-3"
      >
        <span className="text-text block truncate text-[12px] font-medium">
          {targetType === "table" ? (
            <Table2 aria-hidden="true" className="mr-1 inline size-3" />
          ) : null}
          {item.title}
        </span>
        <span className="text-text-muted mt-0.5 block truncate text-[11px]">
          {item.path}
        </span>
        {item.excerpt ? (
          <span className="text-text-3 mt-1 line-clamp-2 block text-[11px] leading-4">
            {item.excerpt}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function DocumentLinksPanel({
  projectId,
  documentId,
  outgoing,
}: DocumentLinksPanelProps) {
  const ids = outgoing.map((reference) => reference.targetId);
  const resolvedQuery = api.document.resolveRefs.useQuery(
    { projectId, ids },
    { enabled: ids.length > 0 },
  );
  const backlinksQuery = api.document.backlinks.useInfiniteQuery(
    { projectId, documentId, limit: 50 },
    { getNextPageParam: (page) => page.nextCursor ?? undefined },
  );
  const backlinks =
    backlinksQuery.data?.pages.flatMap((page) => page.documents) ?? [];
  const resolvedByKey = indexResolvedDocumentReferences(
    resolvedQuery.data ?? [],
  );
  const outgoingTargets = outgoing.flatMap((reference) => {
    const target = resolvedByKey.get(
      documentReferenceKey(reference.targetType, reference.targetId),
    );
    return target?.exists ? [{ targetType: reference.targetType, target }] : [];
  });

  return (
    <div className="flex flex-col gap-6 p-3">
      <section aria-labelledby="document-links-to-heading">
        <div className="mb-3 flex items-center gap-2">
          <ArrowUpRight className="text-text-3 size-4" aria-hidden="true" />
          <h3
            id="document-links-to-heading"
            className="text-text m-0 text-[13px] font-semibold"
          >
            Links to
          </h3>
        </div>

        {resolvedQuery.isLoading ? (
          <div role="status" aria-label="Loading outgoing links">
            <span className="sr-only">Loading outgoing links…</span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="mt-2 h-14 w-full" />
          </div>
        ) : resolvedQuery.error ? (
          <p role="alert" className="text-danger m-0 py-3 text-[12px]">
            Could not load outgoing links.
          </p>
        ) : outgoingTargets.length === 0 ? (
          <p className="text-text-3 m-0 py-3 text-center text-[12px]">
            This document does not link to any existing documents or tables.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {outgoingTargets.map(({ targetType, target }) => (
              <LinkItem
                key={documentReferenceKey(targetType, target.id)}
                projectId={projectId}
                targetType={targetType}
                item={target}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="document-linked-from-heading">
        <div className="mb-3 flex items-center gap-2">
          <ArrowDownLeft className="text-text-3 size-4" aria-hidden="true" />
          <h3
            id="document-linked-from-heading"
            className="text-text m-0 text-[13px] font-semibold"
          >
            Linked from
          </h3>
        </div>

        {backlinksQuery.isLoading ? (
          <div role="status" aria-label="Loading incoming links">
            <span className="sr-only">Loading incoming links…</span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="mt-2 h-14 w-full" />
          </div>
        ) : backlinksQuery.error ? (
          <p role="alert" className="text-danger m-0 py-3 text-[12px]">
            Could not load incoming links.
          </p>
        ) : backlinks.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {backlinks.map((source) => (
              <LinkItem
                key={source.id}
                projectId={projectId}
                targetType="document"
                item={source}
              />
            ))}
          </ul>
        ) : (
          <p className="text-text-3 m-0 py-3 text-center text-[12px]">
            No documents link to this document.
          </p>
        )}
        {backlinksQuery.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            disabled={backlinksQuery.isFetchingNextPage}
            onClick={() => void backlinksQuery.fetchNextPage()}
          >
            Load more incoming links
          </Button>
        ) : null}
      </section>
    </div>
  );
}

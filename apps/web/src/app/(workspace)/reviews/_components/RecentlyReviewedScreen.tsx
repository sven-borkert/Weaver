"use client";

import Link from "next/link";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { useMounted } from "~/lib/use-mounted";
import { api, type RouterOutputs } from "~/trpc/react";
import { ReviewDate } from "./ReviewsScreen";

type RecentItem = RouterOutputs["review"]["listRecent"]["items"][number];

function RecentRow({ item, mounted }: { item: RecentItem; mounted: boolean }) {
  return (
    <TableRow>
      <TableCell className="max-w-72 truncate font-medium">
        <Link
          href={`/projects/${item.projectId}/documents/${item.id}`}
          className="text-text hover:underline"
        >
          {item.title}
        </Link>
      </TableCell>
      <TableCell className="text-text-2 max-w-48 truncate">
        {item.projectName}
      </TableCell>
      <TableCell className="text-text-2 max-w-48 truncate">
        {item.reviewedBy?.name ?? "—"}
      </TableCell>
      <TableCell className="text-text-2 whitespace-nowrap">
        {mounted ? <ReviewDate value={item.lastReviewedAt} /> : null}
      </TableCell>
      <TableCell className="text-text-2 whitespace-nowrap">
        {mounted && item.dueAt ? <ReviewDate value={item.dueAt} /> : null}
      </TableCell>
    </TableRow>
  );
}

export function RecentlyReviewedScreen() {
  const mounted = useMounted();
  const listQuery = api.review.listRecent.useInfiniteQuery(
    {},
    { getNextPageParam: (page) => page.nextCursor ?? undefined },
  );
  const data = dataUnlessAccessError(listQuery.data, listQuery.error);
  const presentation = resolveQueryPresentation({
    data,
    error: listQuery.error,
    isLoading: listQuery.isLoading,
  });
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          Recently reviewed
        </h1>
        <p className="text-text-3 m-0 text-[13px]">
          The latest review of each document in your projects.
        </p>
      </div>

      {presentation === "loading" ? (
        <div className="flex flex-col gap-2 py-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : presentation === "error" || !data ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-danger m-0 text-[13px]">
            Could not load reviews.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void listQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-text-3 m-0 text-[13px]">
          No document has been reviewed yet.
        </p>
      ) : (
        <>
          <Table aria-label="Recently reviewed documents">
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Reviewed by</TableHead>
                <TableHead>Reviewed</TableHead>
                <TableHead>Next review due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <RecentRow key={item.id} item={item} mounted={mounted} />
              ))}
            </TableBody>
          </Table>
          {listQuery.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={listQuery.isFetchingNextPage}
              onClick={() => void listQuery.fetchNextPage()}
            >
              {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

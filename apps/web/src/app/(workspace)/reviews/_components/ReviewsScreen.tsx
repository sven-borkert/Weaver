"use client";

import Link from "next/link";
import { useState } from "react";

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
import { reviewFolderLabel, reviewStatus } from "~/lib/documents/review-status";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type DueItem = RouterOutputs["review"]["listDue"]["items"][number];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

export function ReviewDate({ value }: { value: Date }) {
  return (
    <time dateTime={value.toISOString()}>{dateFormatter.format(value)}</time>
  );
}

function ReviewRow({
  item,
  mounted,
  now,
}: {
  item: DueItem;
  mounted: boolean;
  now: Date;
}) {
  const neverReviewed = item.lastReviewedAt === null;
  const overdue =
    mounted && !neverReviewed && reviewStatus(item.dueAt, now) === "overdue";
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
      <TableCell className="text-text-2 max-w-64 truncate">
        {reviewFolderLabel(item.path)}
      </TableCell>
      <TableCell
        className={cn(
          "whitespace-nowrap",
          overdue && "text-danger font-medium",
          neverReviewed && "text-review",
          !overdue && !neverReviewed && "text-text-2",
        )}
      >
        {mounted ? (
          neverReviewed ? (
            "Not reviewed yet"
          ) : (
            <>
              <ReviewDate value={item.dueAt} />
              {overdue ? " (overdue)" : null}
            </>
          )
        ) : null}
      </TableCell>
      <TableCell className="text-text-2 whitespace-nowrap">
        {mounted ? (
          item.lastReviewedAt ? (
            <ReviewDate value={item.lastReviewedAt} />
          ) : (
            "Never"
          )
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export function ReviewsScreen() {
  const mounted = useMounted();
  const [now] = useState(() => new Date());
  const listQuery = api.review.listDue.useInfiniteQuery(
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
          Open reviews
        </h1>
        <p className="text-text-3 m-0 text-[13px]">
          Documents that are due for your review.
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
          Nothing is due for review.
        </p>
      ) : (
        <>
          <Table aria-label="Documents due for review">
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Folder</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Last reviewed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <ReviewRow
                  key={item.id}
                  item={item}
                  mounted={mounted}
                  now={now}
                />
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

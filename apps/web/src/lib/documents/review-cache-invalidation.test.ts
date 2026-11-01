import { InfiniteQueryObserver, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { createQueryClient, retireQueryClient } from "~/trpc/query-client";
import type { RouterOutputs } from "~/trpc/react";
import {
  invalidateDocumentReview,
  invalidateFolderReview,
} from "./review-cache-invalidation";

it("refreshes recently reviewed documents when returning after a review write", async () => {
  const client = createQueryClient();
  const queryKey = ["review", "listRecent"];
  let reviewer = "Previous reviewer";
  const options = {
    queryKey,
    initialPageParam: null,
    getNextPageParam: () => undefined,
    queryFn: async (): Promise<RouterOutputs["review"]["listRecent"]> => ({
      items: [
        {
          id: "document-1",
          title: "Runbook",
          path: "runbook.md",
          projectId: "project-1",
          projectName: "Operations",
          reviewedBy: { id: null, name: reviewer },
          lastReviewedAt: new Date("2026-10-08T12:00:00Z"),
          dueAt: new Date("2027-10-08T12:00:00Z"),
        },
      ],
      nextCursor: null,
    }),
  };
  const utils = {
    document: {
      reviewPermissions: { invalidate: vi.fn() },
      history: { invalidate: vi.fn() },
      get: { invalidate: vi.fn(), fetch: vi.fn() },
    },
    review: {
      dueCount: { invalidate: vi.fn() },
      listDue: { invalidate: vi.fn() },
      listRecent: {
        invalidate: () => client.invalidateQueries({ queryKey }),
      },
    },
  } as unknown as Parameters<typeof invalidateDocumentReview>[0];
  const firstVisit = new InfiniteQueryObserver(client, options);
  let unsubscribe = firstVisit.subscribe(() => undefined);
  try {
    await firstVisit.refetch();
    expect(firstVisit.getCurrentResult().isStale).toBe(false);
    unsubscribe();

    reviewer = "Current reviewer";
    await invalidateDocumentReview(utils, "project-1", "document-1");

    const returnVisit = new InfiniteQueryObserver(client, options);
    unsubscribe = returnVisit.subscribe(() => undefined);
    await vi.waitFor(() => {
      expect(
        returnVisit.getCurrentResult().data?.pages[0]?.items[0]?.reviewedBy
          ?.name,
      ).toBe("Current reviewer");
    });
  } finally {
    unsubscribe();
    retireQueryClient(client);
  }
});

it("invalidates recursive review lists, counts, details and defaults without resetting drafts", async () => {
  const invalidate = () => ({
    invalidate: vi.fn().mockResolvedValue(undefined),
  });
  const utils = {
    folder: {
      tree: invalidate(),
      reviewDefaults: invalidate(),
      previewReview: invalidate(),
      previewMarkReviewed: invalidate(),
    },
    document: {
      list: invalidate(),
      get: invalidate(),
      history: invalidate(),
      reviewPermissions: invalidate(),
    },
    review: {
      dueCount: invalidate(),
      listDue: invalidate(),
      listRecent: invalidate(),
    },
  };
  await invalidateFolderReview(
    utils as unknown as Parameters<typeof invalidateFolderReview>[0],
    "p1",
  );
  for (const entry of Object.values(utils.document))
    expect(entry.invalidate).toHaveBeenCalledWith(
      { projectId: "p1" },
      undefined,
      { throwOnError: true },
    );
  for (const name of [
    "tree",
    "reviewDefaults",
    "previewReview",
    "previewMarkReviewed",
  ] as const)
    expect(utils.folder[name].invalidate).toHaveBeenCalledWith(
      { projectId: "p1" },
      undefined,
      { throwOnError: true },
    );
  expect(utils.review.dueCount.invalidate).toHaveBeenCalledWith(
    undefined,
    undefined,
    { throwOnError: true },
  );
  expect(utils.review.listDue.invalidate).toHaveBeenCalledWith(
    undefined,
    undefined,
    { throwOnError: true },
  );
  expect(utils.review.listRecent.invalidate).toHaveBeenCalledWith(
    undefined,
    undefined,
    { throwOnError: true },
  );
});

it("reports failed active detail refetch so the saved dialog can retain its reload hint", async () => {
  const client = createQueryClient();
  const queryKey = ["document", "get", "p1"];
  const failure = new Error("detail refresh failed");
  const observer = new QueryObserver(client, {
    queryKey,
    initialData: "original",
    queryFn: async () => {
      throw failure;
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  const invalidate = () => ({
    invalidate: vi.fn().mockResolvedValue(undefined),
  });
  const utils = {
    folder: {
      tree: invalidate(),
      reviewDefaults: invalidate(),
      previewReview: invalidate(),
      previewMarkReviewed: invalidate(),
    },
    document: {
      list: invalidate(),
      history: invalidate(),
      reviewPermissions: invalidate(),
      get: {
        invalidate: (
          _input: unknown,
          _filters: unknown,
          options?: { throwOnError?: boolean },
        ) => client.invalidateQueries({ queryKey }, options),
      },
    },
    review: {
      dueCount: invalidate(),
      listDue: invalidate(),
      listRecent: invalidate(),
    },
  };
  try {
    await expect(
      invalidateFolderReview(
        utils as unknown as Parameters<typeof invalidateFolderReview>[0],
        "p1",
      ),
    ).rejects.toBe(failure);
  } finally {
    unsubscribe();
    retireQueryClient(client);
  }
});

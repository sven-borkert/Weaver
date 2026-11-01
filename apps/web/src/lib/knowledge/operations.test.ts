import { describe, expect, it, vi } from "vitest";

import {
  knowledgeStatusLifecycle,
  outdatedExtractionMessage,
  runFailedKnowledgeRetry,
} from "./operations";

describe("knowledgeStatusLifecycle", () => {
  it.each(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"])(
    "clears a building snapshot and stops polling after %s",
    (code) => {
      const buildingSnapshot = {
        buildingGeneration: { id: "generation-1" },
      };

      expect(
        knowledgeStatusLifecycle({
          data: buildingSnapshot,
          error: { data: { code } },
        }),
      ).toEqual({
        accessError: true,
        snapshot: undefined,
        refetchInterval: false,
      });
    },
  );

  it("retains a building snapshot and polling after a transient error", () => {
    const buildingSnapshot = {
      buildingGeneration: { id: "generation-1" },
    };

    expect(
      knowledgeStatusLifecycle({
        data: buildingSnapshot,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      }),
    ).toEqual({
      accessError: false,
      snapshot: buildingSnapshot,
      refetchInterval: 3_000,
    });
  });

  it("polls while a readiness layer is building before a generation appears", () => {
    const pendingSnapshot = {
      buildingGeneration: null,
      readiness: {
        keyword: "ready",
        semantic: "building",
        graph: "building",
      },
    };

    expect(knowledgeStatusLifecycle({ data: pendingSnapshot })).toEqual({
      accessError: false,
      snapshot: pendingSnapshot,
      refetchInterval: 3_000,
    });
  });
});

describe("runFailedKnowledgeRetry", () => {
  it("drives cursor pages sequentially and totals accepted retries", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        retried: 200,
        hasMore: true,
        nextCursor: {
          generationId: "generation-1",
          documentId: "document-200",
        },
      })
      .mockResolvedValueOnce({
        retried: 3,
        hasMore: false,
        nextCursor: null,
      });

    await expect(runFailedKnowledgeRetry(fetchPage)).resolves.toEqual({
      retried: 203,
      outcome: "complete",
    });
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, {
      generationId: "generation-1",
      documentId: "document-200",
    });
  });

  it("stops when a page retries no work", async () => {
    const cursor = {
      generationId: "generation-1",
      documentId: "document-1",
    };

    await expect(
      runFailedKnowledgeRetry(async () => ({
        retried: 0,
        hasMore: true,
        nextCursor: cursor,
      })),
    ).resolves.toEqual({ retried: 0, outcome: "stalled" });
  });

  it("stops when more work is reported without a next cursor", async () => {
    await expect(
      runFailedKnowledgeRetry(async () => ({
        retried: 4,
        hasMore: true,
        nextCursor: null,
      })),
    ).resolves.toEqual({ retried: 4, outcome: "stalled" });
  });

  it("stops a repeated cursor after preserving the accumulated count", async () => {
    const cursor = {
      generationId: "generation-1",
      documentId: "document-1",
    };
    const fetchPage = vi.fn().mockResolvedValue({
      retried: 2,
      hasMore: true,
      nextCursor: cursor,
    });

    await expect(runFailedKnowledgeRetry(fetchPage)).resolves.toEqual({
      retried: 4,
      outcome: "stalled",
    });
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, cursor);
  });
});

describe("outdatedExtractionMessage", () => {
  it("stays silent when every document is current", () => {
    expect(outdatedExtractionMessage(0, 7)).toBeNull();
  });

  it("names the count with singular and plural wording", () => {
    expect(outdatedExtractionMessage(1, 7)).toBe(
      "1 of 7 documents was extracted with an older model or prompt. Rebuild to re-extract all documents with the current model.",
    );
    expect(outdatedExtractionMessage(3, 7)).toBe(
      "3 of 7 documents were extracted with an older model or prompt. Rebuild to re-extract all documents with the current model.",
    );
  });
});

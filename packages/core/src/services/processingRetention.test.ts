import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { pruneProcessingHistory } from "./processingRetention";

vi.mock("../diagnostics/writer", () => ({ emitDiagnostic: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("processing history retention", () => {
  it.each([0, -1, 5001, Number.NaN, 1.5])(
    "rejects an unbounded or invalid batch size %s",
    async (batchSize) => {
      const transaction = vi.fn();
      const db = { $transaction: transaction } as unknown as PrismaClient;
      await expect(
        pruneProcessingHistory(db, new Date(), { batchSize }),
      ).rejects.toThrow(RangeError);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("propagates a rolled-back cleanup failure without emitting success", async () => {
    const failure = new Error("database unavailable");
    const db = {
      systemSetting: { findUnique: async () => null },
      $transaction: async () => {
        throw failure;
      },
    } as unknown as PrismaClient;
    await expect(pruneProcessingHistory(db)).rejects.toBe(failure);
    expect(emitDiagnostic).not.toHaveBeenCalled();
  });

  it("skips a concurrent maintenance pass without deleting rows", async () => {
    const execute = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: false }]),
      $executeRaw: execute,
    };
    const db = {
      systemSetting: { findUnique: async () => null },
      $transaction: async (run: (value: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaClient;
    expect(await pruneProcessingHistory(db)).toMatchObject({
      skipped: true,
      aiUsage: 0,
      taskRuns: 0,
      assistantEvents: 0,
      assistantAttempts: 0,
      ingestionBatches: 0,
      assistantConversations: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports committed metadata counts only after the bounded deletion transaction", async () => {
    const tx = {
      // Prune lock, then the ingestion candidates, then their file locks.
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([{ id: "b1" }])
        .mockResolvedValueOnce([]),
      // Statement order: aiUsage, taskRuns, ingestionBatches, assistantConversations, assistantEvents, assistantAttempts.
      $executeRaw: vi
        .fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(5),
    };
    const db = {
      systemSetting: { findUnique: async () => null },
      $transaction: async (run: (value: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaClient;
    // batchSize below the conversation prune's own 1,000 cap forces
    // Math.min(batchSize, 1000) to resolve to batchSize there too, so every
    // statement's bound is identical and the loop below proves the clamp
    // actually tracks the caller's bound instead of just matching the old
    // hard-coded 1,000 constant by coincidence.
    const result = await pruneProcessingHistory(
      db,
      new Date("2026-09-17T00:00:00Z"),
      { batchSize: 500 },
    );
    expect(result).toEqual({
      skipped: false,
      aiUsage: 2,
      taskRuns: 3,
      assistantEvents: 4,
      assistantAttempts: 5,
      ingestionBatches: 6,
      assistantConversations: 7,
    });
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "processing.history.pruned",
        details: {
          aiUsage: 2,
          taskRuns: 3,
          assistantEvents: 4,
          assistantAttempts: 5,
          ingestionBatches: 6,
          assistantConversations: 7,
        },
      }),
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6);
    // The ingestion delete is bounded by its candidate select instead.
    tx.$executeRaw.mock.calls.forEach((call, index) => {
      if (index !== 2) expect(call).toContain(500);
    });
    expect(tx.$queryRaw.mock.calls[1]).toContain(500);
    expect(tx.$executeRaw.mock.calls[2]).toContainEqual(["b1"]);
  });
});

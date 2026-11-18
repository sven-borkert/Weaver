import type { PrismaClient } from "@weaver/db/client";
import { describe, expect, it, vi } from "vitest";
import { WikiRunSession } from "./wikiRunSession";
import type { LeasedWikiRun } from "./wikiRuns";

const lease: LeasedWikiRun = {
  id: "run",
  projectId: "project",
  agentId: "agent",
  kind: "ingest",
  attempt: 1,
  leaseToken: "first",
  runningAt: new Date(),
  startedById: null,
  steps: 0,
  writes: 0,
};

function sessionFixture(status: "ready" | "processing" = "processing") {
  const item = { id: "input", status, text: "Original", agentNote: "Notes" };
  const wikiInputItem = {
    findFirst: vi.fn(async () => ({ ...item })),
    updateMany: vi.fn(async ({ data }: { data: Partial<typeof item> }) => {
      Object.assign(item, data);
      return { count: 1 };
    }),
  };
  const storedLease = {
    status: "running",
    leaseToken: lease.leaseToken,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const wikiRunOperation = { count: vi.fn(async () => 1) };
  const tx = {
    wikiInputItem,
    wikiRunOperation,
    $queryRaw: vi.fn(async () => [{ ...storedLease }]),
  };
  const db = {
    ...tx,
    wikiRun: { findFirst: vi.fn(async () => ({ ...storedLease })) },
    projectWikiSettings: {
      findUnique: vi.fn(async () => ({
        enabled: true,
        agentId: lease.agentId,
      })),
    },
    wikiAgent: { findFirst: vi.fn(async () => ({ id: lease.agentId })) },
    project: { findFirst: vi.fn(async () => ({ id: lease.projectId })) },
    $transaction: vi.fn(
      async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx),
    ),
  };
  return {
    session: new WikiRunSession(db as unknown as PrismaClient, lease),
    db,
    item,
    storedLease,
  };
}

const fenceClosed = {
  code: "CONFLICT",
  details: { reason: "WIKI_FENCE_CLOSED" },
};

describe("wiki run input lease", () => {
  it("keeps the input and its notes when a different attempt takes over before completion", async () => {
    const { session, db, item, storedLease } = sessionFixture();
    await session.assertLive();
    db.wikiRunOperation.count.mockImplementationOnce(async () => {
      storedLease.leaseToken = "replacement";
      return 1;
    });

    await expect(
      session.completeInput(item.id, "integrated", "Done"),
    ).rejects.toMatchObject(fenceClosed);
    expect(item).toMatchObject({
      status: "processing",
      text: "Original",
      agentNote: "Notes",
    });
    expect(db.wikiInputItem.updateMany).not.toHaveBeenCalled();

    const replacement = new WikiRunSession(session.db, {
      ...lease,
      attempt: 2,
      leaseToken: "replacement",
    });
    await expect(
      replacement.completeInput(item.id, "integrated", "Done"),
    ).resolves.toMatchObject({ status: "processed" });
    expect(item).toMatchObject({
      status: "processed",
      text: null,
      agentNote: null,
    });
  });

  it("cannot claim an input or overwrite a note after its lease expires", async () => {
    const { session, db, item, storedLease } = sessionFixture("ready");
    await session.assertLive();
    storedLease.leaseExpiresAt = new Date(0);
    await expect(session.readInput(item.id)).rejects.toMatchObject(fenceClosed);

    item.status = "processing";
    session.currentItemId = item.id;
    await expect(session.writeNote("Changed")).rejects.toMatchObject(
      fenceClosed,
    );
    expect(db.wikiInputItem.updateMany).not.toHaveBeenCalled();
    expect(item.agentNote).toBe("Notes");
  });
});

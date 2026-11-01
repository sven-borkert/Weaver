import { afterEach, describe, expect, it, vi } from "vitest";

const bossDoubles = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  instances: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    createQueue: ReturnType<typeof vi.fn>;
    updateQueue: ReturnType<typeof vi.fn>;
    getDb: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  clients: [] as unknown[],
  createQueueError: null as Error | null,
}));

vi.mock("pg-boss", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    PgBoss: class extends EventEmitter {
      start = vi.fn(async () => undefined);
      stop = vi.fn(async () => undefined);
      createQueue = vi.fn(async () => {
        if (bossDoubles.createQueueError) throw bossDoubles.createQueueError;
      });
      updateQueue = vi.fn(async () => undefined);
      getDb = vi.fn(() => ({
        executeSql: vi.fn(async () => ({ rows: [] })),
      }));

      constructor(options: Record<string, unknown>) {
        super();
        bossDoubles.constructed.push(options);
        bossDoubles.instances.push(this);
      }
    },
  };
});

vi.mock("pg", () => ({
  Client: class {
    connect = vi.fn(async () => undefined);
    query = vi.fn(async () => ({ rows: [] }));
    end = vi.fn(async () => undefined);

    constructor() {
      bossDoubles.clients.push(this);
    }
  },
}));

import { PgBossQueue, queueOptions } from "./pgBossQueue";

afterEach(() => {
  bossDoubles.constructed.length = 0;
  bossDoubles.instances.length = 0;
  bossDoubles.clients.length = 0;
  bossDoubles.createQueueError = null;
  vi.restoreAllMocks();
});

describe("PgBossQueue", () => {
  it("enforces deletion singleton keys through a short queue policy", () => {
    expect(queueOptions("content.delete")).toMatchObject({ policy: "short" });
  });

  it("sets seven-day terminal history retention on new and existing worker queues", async () => {
    expect(queueOptions("assistant.run")).toMatchObject({
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    });
    const queue = new PgBossQueue({
      connectionString: "postgresql://localhost/weaver_test",
      queueNames: ["assistant.run"],
      workerConcurrency: 1,
    });
    await queue.start();
    expect(bossDoubles.instances[0]?.updateQueue).toHaveBeenCalledWith(
      "assistant.run",
      expect.objectContaining({ deleteAfterSeconds: 7 * 24 * 60 * 60 }),
    );
  });

  it("ingestion review: housekeeping retries wait for the next scheduled tick", async () => {
    const queue = new PgBossQueue({
      connectionString: "postgresql://localhost/weaver_test",
      queueNames: ["system.reconcile"],
      workerConcurrency: 1,
    });
    await queue.start();
    expect(bossDoubles.instances[0]?.createQueue).toHaveBeenCalledWith(
      "system.reconcile",
      expect.objectContaining({ retryLimit: 0 }),
    );
  });

  it("leaves project push retries to the durable database schedule", async () => {
    const queue = new PgBossQueue({
      connectionString: "postgresql://localhost/weaver_test",
      queueNames: ["project.git-push"],
      workerConcurrency: 2,
    });
    await queue.start();
    expect(bossDoubles.instances[0]?.createQueue).toHaveBeenCalledWith(
      "project.git-push",
      expect.objectContaining({ retryLimit: 0 }),
    );
    expect(
      bossDoubles.instances[0]?.createQueue.mock.calls[0]?.[1],
    ).not.toHaveProperty("policy", "short");
  });

  it("stops the boss when a later start step fails", async () => {
    const failure = new Error("createQueue failed");
    bossDoubles.createQueueError = failure;
    const queue = new PgBossQueue({
      connectionString: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
      queueNames: ["document.search-sync"],
      workerConcurrency: 2,
    });

    await expect(queue.start()).rejects.toBe(failure);

    expect(bossDoubles.instances[0]?.start).toHaveBeenCalledOnce();
    expect(bossDoubles.instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it("logs pg-boss background errors instead of crashing the process", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    new PgBossQueue({
      connectionString: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
      queueNames: ["document.search-sync"],
      workerConcurrency: 2,
      mode: "publisher",
    });
    const failure = new Error("idle client connection lost");

    expect(() =>
      bossDoubles.instances[0]?.emit("error", failure),
    ).not.toThrow();

    // The writer is inactive here, so no reference is available; the error
    // itself is never handed to the console.
    expect(consoleError).toHaveBeenCalledWith(
      "pg-boss background error (ref none)",
    );
  });

  it("disables supervision and scheduling in publisher mode only", () => {
    new PgBossQueue({
      connectionString: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
      queueNames: ["document.search-sync"],
      workerConcurrency: 2,
      mode: "publisher",
    });
    new PgBossQueue({
      connectionString: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
      queueNames: ["document.search-sync"],
      workerConcurrency: 2,
    });

    expect(bossDoubles.constructed[0]).toMatchObject({
      supervise: false,
      schedule: false,
    });
    expect(bossDoubles.constructed[1]).not.toHaveProperty("supervise");
    expect(bossDoubles.constructed[1]).not.toHaveProperty("schedule");
  });

  it("skips the enrichment queue migration in publisher mode", async () => {
    const queue = new PgBossQueue({
      connectionString: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
      queueNames: ["document.ai-enrich"],
      workerConcurrency: 2,
      mode: "publisher",
    });

    await expect(queue.start()).resolves.toBeUndefined();

    expect(bossDoubles.instances[0]?.createQueue).toHaveBeenCalledOnce();
    expect(bossDoubles.instances[0]?.updateQueue).not.toHaveBeenCalled();
    expect(bossDoubles.clients).toHaveLength(0);
  });

  it("keeps change summaries on a short retry schedule, including existing queues", async () => {
    expect(queueOptions("document.change-summary")).toMatchObject({
      policy: "short",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
    });
    const queue = new PgBossQueue({
      connectionString: "postgresql://localhost/weaver_test",
      queueNames: ["document.change-summary"],
      workerConcurrency: 1,
    });
    await queue.start();
    expect(bossDoubles.instances[0]?.updateQueue).toHaveBeenCalledWith(
      "document.change-summary",
      expect.objectContaining({ retryLimit: 2, retryDelay: 30 }),
    );
    expect(
      bossDoubles.instances[0]?.updateQueue.mock.calls[0]?.[1],
    ).not.toHaveProperty("policy");
  });
});

import type { PrismaClient } from "@weaver/db/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "../jobs/queue";
import { createSessionSecurityContext } from "../security/context";
import { runTaskNow } from "./scheduledTasks";

vi.mock("./projectAccess", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectAccess: vi.fn(async () => ({ effectiveRole: "Owner" })),
}));

const actor = createSessionSecurityContext({
  userId: "owner",
  globalRole: "User",
  sessionId: "session",
});
const task = {
  id: "task",
  ownerId: actor.userId,
  outputProjectId: "project",
  status: "active",
};

function taskFixture() {
  let run: { id: string; status: string; jobId: string | null } | null = null;
  const scheduledTaskRun = {
    count: vi.fn(async () => (run ? 1 : 0)),
    create: vi.fn(
      async () => (run = { id: "run", status: "queued", jobId: null }),
    ),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(async () => (run = null)),
    deleteMany: vi.fn(
      async ({
        where,
      }: {
        where: { status: string; jobId: string | null };
      }) => {
        if (run?.status !== where.status || run?.jobId !== where.jobId)
          return { count: 0 };
        run = null;
        return { count: 1 };
      },
    ),
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: task.id }]),
    scheduledTask: { findUniqueOrThrow: vi.fn(async () => task) },
    scheduledTaskRun,
  };
  const db = {
    scheduledTask: { findUnique: vi.fn(async () => task) },
    scheduledTaskRun,
    $transaction: vi.fn(
      async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx),
    ),
  };
  return {
    db: db as unknown as PrismaClient,
    scheduledTaskRun,
    readRun: () => run,
    startRun: () => {
      if (run) run.status = "running";
    },
  };
}

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

describe("manual task queue publication", () => {
  it("returns the run when a worker claims it before an optional receipt fails", async () => {
    const { db, scheduledTaskRun, readRun, startRun } = taskFixture();
    const queue = new FakeJobQueue();
    vi.spyOn(queue, "send").mockImplementation(async () => {
      startRun();
      return "job";
    });
    setJobQueueForTests(queue);
    scheduledTaskRun.updateMany.mockRejectedValueOnce(
      new Error("receipt unavailable"),
    );

    await expect(runTaskNow(db, actor, task.id)).resolves.toEqual({
      runId: "run",
    });
    expect(readRun()).toMatchObject({ status: "running" });
  });

  it("keeps a queued run when publication has an unknown outcome", async () => {
    const { db, readRun } = taskFixture();
    const queue = new FakeJobQueue();
    vi.spyOn(queue, "send").mockRejectedValueOnce(
      new Error("queue connection lost"),
    );
    setJobQueueForTests(queue);

    await expect(runTaskNow(db, actor, task.id)).resolves.toEqual({
      runId: "run",
    });
    expect(readRun()).toMatchObject({ status: "queued", jobId: null });
  });

  it("releases the queued admission when jobs are disabled", async () => {
    const { db, readRun } = taskFixture();
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");

    await expect(runTaskNow(db, actor, task.id)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(queue.jobs).toHaveLength(0);
    expect(readRun()).toBeNull();
  });
});

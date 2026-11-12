import { beforeEach, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { runTaskTick } from "./tick";

const services = vi.hoisted(() => ({
  claimDueTasks: vi.fn(),
  dispatchTaskRun: vi.fn(),
  listStaleQueuedRuns: vi.fn(),
  expireAbandonedRuns: vi.fn(),
}));
vi.mock("../services/scheduledTasks", () => services);
const db = {} as PrismaClient;
beforeEach(() => {
  vi.resetAllMocks();
  services.claimDueTasks.mockResolvedValue([
    { runId: "one", taskId: "a" },
    { runId: "two", taskId: "b" },
  ]);
  services.dispatchTaskRun.mockResolvedValue({
    status: "accepted",
    jobId: "job",
  });
  services.listStaleQueuedRuns.mockResolvedValue([
    { runId: "stale", taskId: "c" },
  ]);
  services.expireAbandonedRuns.mockResolvedValue(1);
});

it("continues dispatching and expiring leases after an individual publication fails", async () => {
  const dispatched: string[] = [];
  services.dispatchTaskRun.mockImplementation(
    async (_db, run: { runId: string }) => {
      dispatched.push(run.runId);
      if (run.runId === "one") throw new Error("queue unavailable");
      return { status: "accepted", jobId: "job" };
    },
  );
  await expect(runTaskTick(db)).rejects.toThrow();
  expect(dispatched).toEqual(["one", "two", "stale"]);
  expect(services.expireAbandonedRuns).toHaveBeenCalledOnce();
});

it("still expires leases when claiming due tasks fails", async () => {
  services.claimDueTasks.mockRejectedValue(new Error("claim failed"));
  await expect(runTaskTick(db)).rejects.toThrow();
  expect(services.dispatchTaskRun).toHaveBeenCalledWith(db, {
    runId: "stale",
    taskId: "c",
  });
  expect(services.expireAbandonedRuns).toHaveBeenCalledOnce();
});

import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_JOB_NAMES,
  knowledgeJobExpireInSeconds,
  knowledgeJobSendOptions,
  SCHEDULED_JOB_NAMES,
  TASK_RUN_EXPIRE_IN_SECONDS,
} from "./types";

describe("scheduled task jobs", () => {
  it("registers both task jobs and schedules the tick", () => {
    expect(KNOWLEDGE_JOB_NAMES).toContain("task.tick");
    expect(KNOWLEDGE_JOB_NAMES).toContain("task.run");
    expect(SCHEDULED_JOB_NAMES).toContain("task.tick");
  });

  it("gives a run 20 minutes before pg-boss expires it", () => {
    expect(TASK_RUN_EXPIRE_IN_SECONDS).toBe(20 * 60);
    expect(knowledgeJobExpireInSeconds("task.run")).toBe(20 * 60);
  });

  it("dedupes queued runs per task through the singleton key", () => {
    expect(
      knowledgeJobSendOptions("task.run", { runId: "r1", taskId: "t1" }),
    ).toEqual({ singletonKey: "t1" });
    expect(
      knowledgeJobSendOptions("task.run", { runId: "r1" }),
    ).toBeUndefined();
  });
});

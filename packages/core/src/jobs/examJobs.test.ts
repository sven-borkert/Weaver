import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_JOB_NAMES,
  SCHEDULED_JOB_NAMES,
  knowledgeJobExpireInSeconds,
} from "./types";
describe("exam jobs", () => {
  it("schedules the expiry sweeper with a bounded lease", () => {
    expect(KNOWLEDGE_JOB_NAMES).toContain("exam.tick");
    expect(SCHEDULED_JOB_NAMES).toContain("exam.tick");
    expect(knowledgeJobExpireInSeconds("exam.tick")).toBe(900);
  });
});

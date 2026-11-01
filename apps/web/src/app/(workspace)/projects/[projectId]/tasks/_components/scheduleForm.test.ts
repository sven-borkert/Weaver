import { describe, expect, it } from "vitest";
import {
  fromSchedule,
  RUN_STATUS_LABELS,
  taskFormSchema,
  toSchedule,
} from "./scheduleForm";

const validForm = {
  name: "Weekly digest",
  instruction: "Summarize the week",
  outputFolderPath: [],
  outputTitle: "",
  externalInputs: [],
  kind: "monthly" as const,
  time: "07:00",
  weekday: "1",
  day: "28",
  timezone: "Europe/Berlin",
};

const issuePaths = (values: unknown) =>
  taskFormSchema.safeParse(values).error?.issues.map((i) => i.path.join("."));

describe("scheduleForm", () => {
  it("round-trips every preset through form values", () => {
    for (const schedule of [
      { kind: "hourly" as const, minute: 15 },
      { kind: "daily" as const, hour: 7, minute: 0 },
      { kind: "weekly" as const, weekday: 1, hour: 7, minute: 30 },
      { kind: "monthly" as const, day: 28, hour: 23, minute: 59 },
    ]) {
      expect(toSchedule(fromSchedule(schedule))).toEqual(schedule);
    }
  });

  it("parses the time field into hour and minute", () => {
    expect(
      toSchedule({ kind: "daily", time: "09:05", weekday: "1", day: "1" }),
    ).toEqual({ kind: "daily", hour: 9, minute: 5 });
    expect(
      toSchedule({ kind: "hourly", time: "09:05", weekday: "1", day: "1" }),
    ).toEqual({ kind: "hourly", minute: 5 });
  });

  it("labels every run status", () => {
    expect(RUN_STATUS_LABELS.succeeded).toBe("Succeeded");
    expect(RUN_STATUS_LABELS.skipped).toBe("Skipped");
  });
});

describe("taskFormSchema", () => {
  it("accepts a complete definition", () => {
    expect(taskFormSchema.safeParse(validForm).success).toBe(true);
  });

  it("pins an out-of-range monthly day to the day field", () => {
    expect(issuePaths({ ...validForm, day: "31" })).toEqual(["day"]);
    expect(issuePaths({ ...validForm, day: "0" })).toEqual(["day"]);
  });

  it("rejects a blank time before the schedule is built", () => {
    expect(issuePaths({ ...validForm, time: "" })).toEqual(["time"]);
  });

  it("pins an impossible time to the time field", () => {
    expect(issuePaths({ ...validForm, kind: "daily", time: "99:99" })).toEqual([
      "time",
    ]);
  });

  it("pins an out-of-range weekday to the weekday field", () => {
    expect(issuePaths({ ...validForm, kind: "weekly", weekday: "9" })).toEqual([
      "weekday",
    ]);
  });

  it("rejects an unknown timezone", () => {
    expect(issuePaths({ ...validForm, timezone: "Mars/Olympus" })).toEqual([
      "timezone",
    ]);
  });
});

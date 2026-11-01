import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  isValidTimezone,
  scheduleToCron,
  taskScheduleSchema,
} from "./scheduleSchema";

describe("task schedule presets", () => {
  it("maps every preset to a five-field cron expression", () => {
    expect(scheduleToCron({ kind: "hourly", minute: 15 })).toBe("15 * * * *");
    expect(scheduleToCron({ kind: "daily", hour: 7, minute: 0 })).toBe(
      "0 7 * * *",
    );
    expect(
      scheduleToCron({ kind: "weekly", weekday: 1, hour: 7, minute: 30 }),
    ).toBe("30 7 * * 1");
    expect(
      scheduleToCron({ kind: "monthly", day: 28, hour: 23, minute: 59 }),
    ).toBe("59 23 28 * *");
  });

  it("describes a preset in words with its timezone", () => {
    expect(describeSchedule({ kind: "hourly", minute: 5 }, "UTC")).toBe(
      "Hourly at :05, UTC",
    );
    expect(
      describeSchedule({ kind: "daily", hour: 7, minute: 0 }, "Europe/Berlin"),
    ).toBe("Daily at 07:00, Europe/Berlin");
    expect(
      describeSchedule(
        { kind: "weekly", weekday: 1, hour: 7, minute: 0 },
        "Europe/Berlin",
      ),
    ).toBe("Weekly on Monday at 07:00, Europe/Berlin");
    expect(
      describeSchedule({ kind: "monthly", day: 1, hour: 9, minute: 15 }, "UTC"),
    ).toBe("Monthly on day 1 at 09:15, UTC");
  });

  it("rejects out-of-range fields and days past the 28th", () => {
    expect(
      taskScheduleSchema.safeParse({ kind: "hourly", minute: 60 }).success,
    ).toBe(false);
    expect(
      taskScheduleSchema.safeParse({
        kind: "monthly",
        day: 31,
        hour: 0,
        minute: 0,
      }).success,
    ).toBe(false);
    expect(
      taskScheduleSchema.safeParse({
        kind: "weekly",
        weekday: 7,
        hour: 0,
        minute: 0,
      }).success,
    ).toBe(false);
  });

  it("validates IANA timezones", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

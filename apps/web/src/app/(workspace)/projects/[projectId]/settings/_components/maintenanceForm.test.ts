import { expect, it } from "vitest";
import {
  describeLintSkip,
  maintenanceDefaults,
  maintenanceFormSchema,
  maintenancePayload,
} from "./maintenanceForm";

it("starts off with the stored timezone and round-trips a stored schedule", () => {
  const off = maintenanceDefaults({ lintSchedule: null, lintTimezone: "UTC" });
  expect(off.kind).toBe("off");
  expect(maintenancePayload(off).lintSchedule).toBeNull();
  const weekly = maintenanceDefaults({
    lintSchedule: { kind: "weekly", weekday: 2, hour: 4, minute: 15 },
    lintTimezone: "Europe/Berlin",
  });
  expect(weekly).toMatchObject({ kind: "weekly", time: "04:15", weekday: "2" });
  expect(maintenancePayload(weekly)).toEqual({
    lintSchedule: { kind: "weekly", weekday: 2, hour: 4, minute: 15 },
    lintTimezone: "Europe/Berlin",
  });
});

it("validates the preset and timezone the way the server does", () => {
  const ok = {
    kind: "monthly",
    time: "07:00",
    weekday: "1",
    day: "28",
    timezone: "UTC",
  };
  expect(maintenanceFormSchema.safeParse(ok).success).toBe(true);
  expect(maintenanceFormSchema.safeParse({ ...ok, day: "31" }).success).toBe(
    false,
  );
  expect(
    maintenanceFormSchema.safeParse({ ...ok, timezone: "Mars/Base" }).success,
  ).toBe(false);
  expect(
    maintenanceFormSchema.safeParse({ ...ok, kind: "off", day: "99" }).success,
  ).toBe(true);
});

it("words every skip reason", () => {
  for (const reason of ["missed", "run_active", "lint_paused", "budget_paused"])
    expect(describeLintSkip(reason)).not.toBe("it could not start");
  expect(describeLintSkip("other")).toBe("it could not start");
});

import { z } from "zod";

// Browser-safe: client components import this file, so it depends on zod only.

export const TASK_NAME_MAX_LENGTH = 120;
export const TASK_INSTRUCTION_MAX_LENGTH = 4000;
export const MAX_TASKS_PER_OWNER = 20;
export const MAX_TASKS_PER_PROJECT = 50;
export const MAX_CONSECUTIVE_FAILURES = 5;

export const TASK_FAILURE_CODES = [
  "ROUTE_MISSING",
  "SCOPE_EMPTY",
  "OUTPUT_FORBIDDEN",
  "OUTPUT_MISSING",
  "OUTPUT_CONFLICT",
  "PROVIDER_ERROR",
  "TIMEOUT",
  "CONTENT_INVALID",
  "ABANDONED",
  "EXTERNAL_AUTH_FAILED",
  "EXTERNAL_UNAVAILABLE",
  "EXTERNAL_APPROVAL_REQUIRED",
  "EXTERNAL_INPUT_INVALID",
  "EXTERNAL_INPUT_FAILED",
  "EXTERNAL_TIMEOUT",
  "EXTERNAL_CONTEXT_LIMIT",
  "EXTERNAL_FORBIDDEN",
  "EXTERNAL_TOOL_CHANGED",
  "EXTERNAL_UNSUPPORTED_PROTOCOL",
  "EXTERNAL_UNSUPPORTED_SCHEMA",
  "EXTERNAL_RESPONSE_TOO_LARGE",
  "EXTERNAL_INVALID_RESULT",
  "EXTERNAL_TOOL_ERROR",
  "EXTERNAL_OUTCOME_UNKNOWN",
  "EXTERNAL_TOOL_DENIED",
  "EXTERNAL_CALL_INVALIDATED",
] as const;
export type TaskFailureCode = (typeof TASK_FAILURE_CODES)[number];

export const TASK_SKIP_REASONS = [
  "overlap",
  "task_paused",
  "owner_inactive",
  "owner_password_change",
] as const;
export type TaskSkipReason = (typeof TASK_SKIP_REASONS)[number];

const minute = z.number().int().min(0).max(59);
const hour = z.number().int().min(0).max(23);

export const taskScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hourly"), minute }),
  z.object({ kind: z.literal("daily"), hour, minute }),
  z.object({
    kind: z.literal("weekly"),
    weekday: z.number().int().min(0).max(6),
    hour,
    minute,
  }),
  // Day stops at 28 so a monthly task fires every month.
  z.object({
    kind: z.literal("monthly"),
    day: z.number().int().min(1).max(28),
    hour,
    minute,
  }),
]);
export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function scheduleToCron(schedule: TaskSchedule): string {
  switch (schedule.kind) {
    case "hourly":
      return `${schedule.minute} * * * *`;
    case "daily":
      return `${schedule.minute} ${schedule.hour} * * *`;
    case "weekly":
      return `${schedule.minute} ${schedule.hour} * * ${schedule.weekday}`;
    case "monthly":
      return `${schedule.minute} ${schedule.hour} ${schedule.day} * *`;
  }
}

export function describeSchedule(
  schedule: TaskSchedule,
  timezone: string,
): string {
  switch (schedule.kind) {
    case "hourly":
      return `Hourly at :${two(schedule.minute)}, ${timezone}`;
    case "daily":
      return `Daily at ${two(schedule.hour)}:${two(schedule.minute)}, ${timezone}`;
    case "weekly":
      return `Weekly on ${WEEKDAY_NAMES[schedule.weekday]} at ${two(schedule.hour)}:${two(schedule.minute)}, ${timezone}`;
    case "monthly":
      return `Monthly on day ${schedule.day} at ${two(schedule.hour)}:${two(schedule.minute)}, ${timezone}`;
  }
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

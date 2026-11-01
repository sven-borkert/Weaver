export { externalInputSchema as taskExternalInputsSchema } from "@weaver/core/externalMcp/schema";
import { z } from "zod";
import {
  isValidTimezone,
  TASK_INSTRUCTION_MAX_LENGTH,
  TASK_NAME_MAX_LENGTH,
  taskScheduleSchema,
  type TaskSchedule,
} from "@weaver/core/scheduledTasks/scheduleSchema";

export type ScheduleFormValues = {
  kind: TaskSchedule["kind"];
  /** HH:MM, 24-hour. */
  time: string;
  weekday: string;
  day: string;
};

const two = (value: number) => String(value).padStart(2, "0");

export function fromSchedule(schedule: TaskSchedule): ScheduleFormValues {
  const hour = "hour" in schedule ? schedule.hour : 0;
  return {
    kind: schedule.kind,
    time: `${two(hour)}:${two(schedule.minute)}`,
    weekday: String(schedule.kind === "weekly" ? schedule.weekday : 1),
    day: String(schedule.kind === "monthly" ? schedule.day : 1),
  };
}

export function toSchedule(values: ScheduleFormValues): TaskSchedule {
  const [h, m] = values.time.split(":");
  const hour = Number(h);
  const minute = Number(m);
  switch (values.kind) {
    case "hourly":
      return { kind: "hourly", minute };
    case "daily":
      return { kind: "daily", hour, minute };
    case "weekly":
      return { kind: "weekly", weekday: Number(values.weekday), hour, minute };
    case "monthly":
      return { kind: "monthly", day: Number(values.day), hour, minute };
  }
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const DEFAULT_SCHEDULE_VALUES: ScheduleFormValues = {
  kind: "daily",
  time: "07:00",
  weekday: "1",
  day: "1",
};

const TIME_PATTERN = /^\d{2}:\d{2}$/;

const SCHEDULE_ISSUES = {
  hourly: { path: "time", message: "Use a valid time" },
  daily: { path: "time", message: "Use a valid time" },
  weekly: { path: "weekday", message: "Pick a weekday" },
  monthly: { path: "day", message: "Pick a day from 1 to 28" },
} as const;

/** Client-side mirror of the server's scheduledTask.create/update input. */
export const taskFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name is required")
      .max(TASK_NAME_MAX_LENGTH),
    instruction: z
      .string()
      .trim()
      .min(1, "Describe what the task should produce")
      .max(TASK_INSTRUCTION_MAX_LENGTH),
    outputFolderPath: z.array(z.string()),
    outputTitle: z.string().trim().max(200, "Use at most 200 characters"),
    kind: z.enum(["hourly", "daily", "weekly", "monthly"]),
    time: z.string().regex(TIME_PATTERN, "Use HH:MM"),
    weekday: z.string(),
    day: z.string(),
    timezone: z.string().refine(isValidTimezone, "Unknown timezone"),
  })
  .superRefine((values, ctx) => {
    // The time field already reports its own format error; don't blame the day too.
    if (!TIME_PATTERN.test(values.time)) return;
    if (taskScheduleSchema.safeParse(toSchedule(values)).success) return;
    const issue = SCHEDULE_ISSUES[values.kind];
    ctx.addIssue({
      code: "custom",
      path: [issue.path],
      message: issue.message,
    });
  });
export type TaskFormValues = z.infer<typeof taskFormSchema>;

export const RUN_STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
} as const;

export const TASK_STATUS_LABELS = {
  active: "Active",
  paused: "Paused",
} as const;

export const PAUSE_REASON_LABELS = {
  manual: "paused by hand",
  failing: "paused after repeated failures",
} as const;

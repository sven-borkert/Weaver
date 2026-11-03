import { z } from "zod";
import {
  isValidTimezone,
  taskScheduleSchema,
  type TaskSchedule,
} from "@weaver/core/scheduledTasks/scheduleSchema";
import {
  fromSchedule,
  toSchedule,
  DEFAULT_SCHEDULE_VALUES,
} from "../../tasks/_components/scheduleForm";

export const maintenanceFormSchema = z
  .object({
    kind: z.enum(["off", "hourly", "daily", "weekly", "monthly"]),
    time: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
    weekday: z.string(),
    day: z.string(),
    timezone: z.string().refine(isValidTimezone, "Unknown timezone"),
  })
  .superRefine((values, ctx) => {
    if (values.kind === "off" || !/^\d{2}:\d{2}$/.test(values.time)) return;
    if (taskScheduleSchema.safeParse(toMaintenanceSchedule(values)).success)
      return;
    ctx.addIssue({
      code: "custom",
      path: [values.kind === "monthly" ? "day" : "time"],
      message:
        values.kind === "monthly"
          ? "Pick a day from 1 to 28"
          : "Use a valid time",
    });
  });
export type MaintenanceFormValues = z.infer<typeof maintenanceFormSchema>;

function toMaintenanceSchedule(
  values: MaintenanceFormValues,
): TaskSchedule | null {
  return values.kind === "off"
    ? null
    : toSchedule({ ...values, kind: values.kind });
}

export function maintenanceDefaults(settings: {
  lintSchedule: TaskSchedule | null;
  lintTimezone: string;
}): MaintenanceFormValues {
  return settings.lintSchedule
    ? {
        ...fromSchedule(settings.lintSchedule),
        timezone: settings.lintTimezone,
      }
    : {
        kind: "off",
        time: DEFAULT_SCHEDULE_VALUES.time,
        weekday: DEFAULT_SCHEDULE_VALUES.weekday,
        day: DEFAULT_SCHEDULE_VALUES.day,
        timezone: settings.lintTimezone,
      };
}

/** The wiki.update fields: a null schedule turns scheduled maintenance off. */
export function maintenancePayload(values: MaintenanceFormValues) {
  return {
    lintSchedule: toMaintenanceSchedule(values),
    lintTimezone: values.timezone,
  };
}

const SKIP_REASONS: Record<string, string> = {
  missed: "the server was not running at that time",
  run_active: "another wiki run was active",
  lint_paused: "scheduled maintenance is paused after repeated failures",
  budget_paused: "the 24-hour change budget is exceeded",
  agent_unavailable: "the wiki agent was not available",
};

export function describeLintSkip(reason: string): string {
  return SKIP_REASONS[reason] ?? "it could not start";
}

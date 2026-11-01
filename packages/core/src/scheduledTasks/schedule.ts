import { CronExpressionParser } from "cron-parser";

/** Strictly after `after`, in the task's timezone; missed slots are never revisited. */
export function nextOccurrence(
  cron: string,
  timezone: string,
  after: Date,
): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone })
    .next()
    .toDate();
}

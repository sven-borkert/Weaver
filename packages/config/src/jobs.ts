import { z } from "zod";

export const MAX_KNOWLEDGE_WORKER_CONCURRENCY = 8;
const DEFAULT_WORKER_CONCURRENCY = 2;
const DEFAULT_RECONCILE_CRON = "*/15 * * * *";
// Assistant-run recovery must land within about one lease (30 s), not on the
// knowledge-graph cadence: a stranded run blocks its whole conversation.
const DEFAULT_ASSISTANT_RECONCILE_CRON = "* * * * *";
// Scheduled tasks are claimed by a minute tick over the task table (Phase 6A §6).
const DEFAULT_TASK_TICK_CRON = "* * * * *";

export const rawCommonSchema = z.object({
  WEAVER_INGESTION_TMP_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10080)
    .default(60),
  WEAVER_JOBS_ENABLED: z.enum(["true", "false"]).default("true"),
  WEAVER_JOB_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_KNOWLEDGE_WORKER_CONCURRENCY)
    .default(DEFAULT_WORKER_CONCURRENCY),
  WEAVER_KNOWLEDGE_RECONCILE_CRON: z
    .string()
    .min(1)
    .default(DEFAULT_RECONCILE_CRON),
  WEAVER_ASSISTANT_RECONCILE_CRON: z
    .string()
    .min(1)
    .default(DEFAULT_ASSISTANT_RECONCILE_CRON),
  WEAVER_TASK_TICK_CRON: z.string().min(1).default(DEFAULT_TASK_TICK_CRON),
});

import { z } from "zod";
import { CoreError } from "../../errors";
import {
  BACKGROUND_WORK_KINDS,
  BACKGROUND_WORK_STATES,
  BACKGROUND_WORK_LIMITS,
} from "../../jobs/backgroundWorkSchema";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ local: true, offset: true });
const nonnegativeInteger = z.number().int().nonnegative();
const destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), projectId: uuid, taskId: uuid }).strict(),
  z
    .object({ kind: z.literal("import"), projectId: uuid, fileId: uuid })
    .strict(),
  z.object({ kind: z.literal("assistant"), conversationId: uuid }).strict(),
  z.object({ kind: z.literal("knowledge"), projectId: uuid }).strict(),
  z
    .object({
      kind: z.literal("notebook"),
      projectId: uuid,
      filename: z.string().min(1).max(255),
    })
    .strict(),
  z.object({ kind: z.literal("git_sync"), projectId: uuid }).strict(),
  z
    .object({ kind: z.literal("exam"), projectId: uuid, attemptId: uuid })
    .strict(),
  z.object({ kind: z.literal("wiki"), projectId: uuid }).strict(),
]);
const workRowSchema = z
  .object({
    id: uuid,
    kind: z.enum(BACKGROUND_WORK_KINDS),
    title: z
      .string()
      .refine(
        (value) => [...value].length <= BACKGROUND_WORK_LIMITS.titleLength,
      ),
    projectId: uuid.nullable(),
    projectName: z.string().nullable(),
    state: z.enum(BACKGROUND_WORK_STATES),
    sourceStatus: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "pending",
      "parsing",
      "extracting",
      "linking",
      "ready",
      "accepting",
      "accepted",
      "rejected",
      "blocked_configuration",
      "cancelling",
      "completed",
      "cancelled",
      "building",
      "active",
      "superseded",
      "in_progress",
      "submitted",
      "in_review",
      "released",
      "preparing",
      "stopped",
    ]),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    sortAt: timestamp,
    progress: z
      .object({
        ready: nonnegativeInteger,
        total: nonnegativeInteger,
        failed: nonnegativeInteger,
      })
      .strict()
      .nullable(),
    errorCode: z
      .enum([
        "TASK_FAILED",
        "IMPORT_FAILED",
        "ASSISTANT_FAILED",
        "KNOWLEDGE_FAILED",
        "NOTEBOOK_FAILED",
        "GIT_SYNC_FAILED",
        "CONFIGURATION_REQUIRED",
        "WIKI_FAILED",
      ])
      .nullable(),
    errorMessage: z
      .string()
      .refine((value) => [...value].length <= 500)
      .nullable(),
    destination,
    revision: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    isPersonal: z.boolean(),
    unseen: z.boolean(),
  })
  .strict()
  .refine((row) => row.kind === row.destination.kind);
export type WorkRow = z.infer<typeof workRowSchema>;

const listRowsSchema = z.tuple([
  z
    .object({
      items: z.array(workRowSchema).max(BACKGROUND_WORK_LIMITS.maxLimit + 1),
      asOf: z.date(),
      windowStart: z.date(),
    })
    .strict(),
]);
const summaryRowsSchema = z.tuple([
  z
    .object({
      active: nonnegativeInteger.max(BACKGROUND_WORK_LIMITS.summaryCap),
      unseen: nonnegativeInteger.max(BACKGROUND_WORK_LIMITS.summaryCap),
      observedAt: z.date(),
    })
    .strict(),
]);
const seenRowsSchema = z
  .array(z.object({ workId: uuid }).strict())
  .max(BACKGROUND_WORK_LIMITS.maxAcknowledgements);
const pruneCountSchema = nonnegativeInteger.max(
  BACKGROUND_WORK_LIMITS.pruneBatch,
);

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "Invalid background work result",
    );
  return result.data;
}
export function parseListRows(value: unknown) {
  return parseResult(listRowsSchema, value);
}
export function parseSummaryRows(value: unknown) {
  return parseResult(summaryRowsSchema, value);
}
export function parseSeenRows(value: unknown) {
  return parseResult(seenRowsSchema, value);
}
export function parsePruneCount(value: unknown) {
  return parseResult(pruneCountSchema, value);
}

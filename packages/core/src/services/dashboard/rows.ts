import { z } from "zod";
import { CoreError } from "../../errors";
import { DOCUMENT_KIND_NAMES, type DocumentKind } from "../../documents/kinds";
import { ACTIVITY_SOURCES, DASHBOARD_LIMITS } from "../../dashboard/schema";
import { BACKGROUND_WORK_STATES } from "../../jobs/backgroundWorkSchema";
const uuid = z.uuid();
export const timestamp = z.iso
  .datetime({ local: true, offset: true })
  .transform(isoUtc);
export function isoUtc(value: string): string {
  return new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`,
  ).toISOString();
}
const title = z.string().refine((v) => [...v].length <= 200);
const kind = z.enum(["document", "table"]);
const documentDestination = z
  .object({ kind: z.literal("document"), projectId: uuid, documentId: uuid })
  .strict();
const tableDestination = z
  .object({ kind: z.literal("table"), projectId: uuid, tableId: uuid })
  .strict();
const taskDestination = z
  .object({ kind: z.literal("task"), projectId: uuid, taskId: uuid })
  .strict();
const destination = z.discriminatedUnion("kind", [
  documentDestination,
  tableDestination,
  taskDestination,
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
const contentCard = z
  .object({
    id: uuid,
    kind,
    title,
    projectId: uuid,
    projectName: z.string(),
    lastEditedAt: timestamp,
    editorName: z.string().nullable(),
    isOwnChange: z.boolean(),
    documentKind: z
      .enum(DOCUMENT_KIND_NAMES as [DocumentKind, ...DocumentKind[]])
      .nullable(),
    destination: z.discriminatedUnion("kind", [
      documentDestination,
      tableDestination,
    ]),
  })
  .strict()
  .refine(
    (r) =>
      r.kind === r.destination.kind &&
      r.projectId === r.destination.projectId &&
      r.id ===
        (r.destination.kind === "document"
          ? r.destination.documentId
          : r.destination.tableId),
  );
const sourceStatus = z.enum([
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
  "stopped",
]);
const activity = z
  .object({
    id: uuid,
    source: z.enum(ACTIVITY_SOURCES),
    category: z.enum(["content_update", "work_result"]),
    title,
    projectId: uuid.nullable(),
    projectName: z.string().nullable(),
    sortAt: timestamp,
    occurredAt: timestamp.nullable(),
    editorName: z.string().nullable(),
    isOwnChange: z.boolean().nullable(),
    state: z.enum(BACKGROUND_WORK_STATES).nullable(),
    sourceStatus: sourceStatus.nullable(),
    destination,
    currentReport: documentDestination.nullable(),
  })
  .strict()
  .refine(
    (r) =>
      r.source === r.destination.kind &&
      (r.category === "content_update"
        ? (r.source === "document" || r.source === "table") &&
          r.state === null &&
          r.sourceStatus === null
        : r.source !== "document" &&
          r.source !== "table" &&
          r.state !== null &&
          r.state !== "queued" &&
          r.state !== "running"),
  );
const report = z
  .object({
    taskId: uuid,
    title,
    projectId: uuid,
    projectName: z.string(),
    status: z.enum(["active", "paused"]),
    lastRunStatus: z
      .enum(["queued", "running", "succeeded", "failed", "skipped"])
      .nullable(),
    nextRunAt: timestamp.nullable(),
    destination: taskDestination,
    currentReport: documentDestination.nullable(),
  })
  .strict()
  .refine(
    (r) =>
      r.taskId === r.destination.taskId &&
      r.projectId === r.destination.projectId,
  );
const count = z
  .object({
    value: z.number().int().min(0).max(DASHBOARD_LIMITS.projectCountCap),
    capped: z.boolean(),
  })
  .strict()
  .refine((c) => c.capped === (c.value === DASHBOARD_LIMITS.projectCountCap));
const pin = z.discriminatedUnion("available", [
  z
    .object({
      pinId: uuid,
      kind,
      available: z.literal(true),
      content: contentCard,
    })
    .strict()
    .refine((p) => p.kind === p.content.kind),
  z.object({ pinId: uuid, kind, available: z.literal(false) }).strict(),
]);
const project = z
  .object({
    project: z
      .object({
        id: uuid,
        name: z.string(),
        description: z.string().nullable(),
        myRole: z.enum(["Owner", "Maintainer", "Editor", "Viewer"]),
      })
      .strict(),
    counts: z.object({ documents: count, tables: count }).strict(),
    pins: z.array(pin).max(12),
    pinCapacity: z
      .object({ used: z.number().int().min(0).max(12), limit: z.literal(12) })
      .strict()
      .nullable(),
    canManagePins: z.boolean(),
    workAudience: z.enum(["mine", "projects"]),
    observedAt: z.date(),
  })
  .strict()
  .refine((r) =>
    r.canManagePins
      ? r.pinCapacity !== null
      : r.pinCapacity === null && r.pins.every((p) => p.available),
  );
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new CoreError("INTERNAL_SERVER_ERROR", "Invalid dashboard result");
  return result.data;
}
export function parseRecentRows(value: unknown) {
  return parse(
    z.tuple([
      z
        .object({ items: z.array(contentCard).max(20), observedAt: z.date() })
        .strict(),
    ]),
    value,
  );
}
export function parseReportRows(value: unknown) {
  return parse(
    z.tuple([
      z
        .object({ items: z.array(report).max(5), observedAt: z.date() })
        .strict(),
    ]),
    value,
  );
}
export function parseActivityRows(value: unknown) {
  return parse(
    z.tuple([
      z
        .object({
          items: z.array(activity).max(51),
          asOf: z.date(),
          contentWindowStart: z.date(),
          workWindowStart: z.date(),
        })
        .strict(),
    ]),
    value,
  );
}
export function parseProjectRows(value: unknown) {
  return parse(z.tuple([project]), value);
}

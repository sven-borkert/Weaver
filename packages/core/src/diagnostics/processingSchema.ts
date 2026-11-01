import { z } from "zod";

export const PROCESSING_STATUSES = {
  knowledge_generation: ["building", "active", "failed", "superseded"],
  knowledge_document: [
    "pending",
    "processing",
    "ready",
    "failed",
    "blocked_configuration",
    "missing",
  ],
  keyword: [
    "pending",
    "processing",
    "ready",
    "failed",
    "blocked_configuration",
    "missing",
  ],
  ingestion: [
    "pending",
    "parsing",
    "extracting",
    "linking",
    "ready",
    "accepting",
    "accepted",
    "rejected",
    "failed",
    "blocked_configuration",
  ],
  assistant: [
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ],
  scheduled_task: ["queued", "running", "succeeded", "failed", "skipped"],
} as const;
export const PROCESSING_KINDS = [
  "knowledge_generation",
  "knowledge_document",
  "keyword",
  "ingestion",
  "assistant",
  "scheduled_task",
] as const;
export type ProcessingKind = (typeof PROCESSING_KINDS)[number];
export const listProcessingInput = z
  .object({
    kind: z.enum(PROCESSING_KINDS),
    status: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(600).optional(),
  })
  .superRefine((input, context) => {
    if (
      input.status &&
      !(PROCESSING_STATUSES[input.kind] as readonly string[]).includes(
        input.status,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Invalid status for processing kind",
      });
  });
export type ListProcessingInput = z.input<typeof listProcessingInput>;
export const listProcessingQueueInput = z.object({
  state: z
    .enum(["created", "retry", "active", "completed", "cancelled", "failed"])
    .optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(600).optional(),
});

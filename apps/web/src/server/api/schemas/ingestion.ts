import { documentTitleSchema } from "@weaver/core/documents/title";
import { DRAFT_COLUMN_TYPES } from "@weaver/core/ingestion/draftTable";
import { MAX_PROPOSED_LINKS } from "@weaver/core/ingestion/links";
import {
  BATCH_CURSOR_MAX_CHARS,
  BATCH_PAGE_MAX,
} from "@weaver/core/services/ingestion";
import { z } from "zod";

const uuid = z.uuid();

export const listBatchesInput = z.object({
  projectId: uuid,
  limit: z.number().int().min(1).max(BATCH_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(BATCH_CURSOR_MAX_CHARS).optional(),
  status: z
    .enum(["empty", "pending", "processing", "ready", "attention", "resolved"])
    .optional(),
});

export const batchIdInput = z.object({ batchId: uuid });
export const fileIdInput = z.object({ fileId: uuid });

export const updateDraftInput = z.object({
  fileId: uuid,
  proposedTitle: documentTitleSchema,
  proposedFolderPath: z.string().trim().max(500),
  proposedTags: z.array(z.string().trim().min(1).max(60)).max(20),
  columns: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        type: z.enum(DRAFT_COLUMN_TYPES),
      }),
    )
    .max(100)
    .optional(),
  links: z
    .array(z.object({ documentId: uuid, keep: z.boolean() }))
    .max(MAX_PROPOSED_LINKS)
    .optional(),
  expectedRevision: z.number().int().min(0),
});

export const acceptDraftInput = z.object({
  fileId: uuid,
  expectedRevision: z.number().int().min(0),
});

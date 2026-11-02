import { validateDocumentContent } from "@weaver/core/editor/markdown";
import { documentTitleSchema } from "@weaver/core/documents/title";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { wikiPagePropertiesInputSchema } from "@weaver/core/wiki/properties";
import { z } from "zod";
import { isSingleLineChangeSummary } from "~/lib/documents/change-summary";
import { folderPathSchema } from "./folder";

const title = documentTitleSchema;

// The validator's own reason (e.g. merged cells) is what the editor shows on a failed save.
const contentJson = z.unknown().superRefine((content, ctx) => {
  try {
    validateDocumentContent(content);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message:
        error instanceof Error && error.message
          ? error.message
          : "invalid document content",
    });
  }
});

const changeSummary = z
  .string()
  .refine(isSingleLineChangeSummary, {
    message: "changeSummary must be a single line",
  })
  .trim()
  .min(1)
  .max(120);

// A 2 MB document cannot contain 25,000 minimal serialized UUID crossrefs.
export const RESOLVE_REFS_MAX_IDS = 25_000;

export const documentIdInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
});

export const rebuildIndexInput = z.object({
  projectId: z.uuid(),
});

export const createDocumentInput = z.object({
  projectId: z.uuid(),
  folderPath: folderPathSchema,
  title,
  contentJson,
  properties: wikiPagePropertiesInputSchema.optional(),
});

export const updateDocumentInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
  baseCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  title: title.optional(),
  content: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("markdown"), contentJson }),
    z.object({
      kind: z.literal("python"),
      text: z.string().max(MAX_MARKDOWN_CHARS),
    }),
  ]),
  changeSummary: changeSummary.optional(),
  properties: wikiPagePropertiesInputSchema.optional(),
});

export const setPropertiesInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
  expectedHeadCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  properties: wikiPagePropertiesInputSchema,
});

export const importFileInput = z.object({
  projectId: z.uuid(),
  folderPath: folderPathSchema,
  fileName: z.string().trim().min(1).max(255),
  text: z.string().max(MAX_MARKDOWN_CHARS),
});

export const moveDocumentInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
  folderPath: folderPathSchema,
});

export const historyInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
  offset: z.number().int().min(0).max(1000).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

export const diffInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
  fromSha: z.string().regex(/^[0-9a-f]{40}$/),
  toSha: z.string().regex(/^[0-9a-f]{40}$/),
});

export const restoreInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  expectedHeadCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
});

export const resolveRefsInput = z.object({
  projectId: z.uuid(),
  ids: z.array(z.uuid()).max(RESOLVE_REFS_MAX_IDS),
});

export const listDocumentsInput = z.object({
  projectId: z.uuid(),
  folderPath: folderPathSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(0).max(200).default(50),
  search: z
    .string()
    .trim()
    .max(200)
    .describe("Case-insensitive document title substring")
    .optional(),
  type: z.string().trim().min(1).max(40).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  includeSummary: z.boolean().default(false),
  sort: z
    .enum(["title", "lastEditedAt", "createdAt", "updatedAt"])
    .default("lastEditedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export const pageIndexInput = z.object({
  projectId: z.uuid(),
  cursor: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(50).default(50),
});

export const documentBacklinksInput = documentIdInput.extend({
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

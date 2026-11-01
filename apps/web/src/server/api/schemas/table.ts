import { documentTitleSchema } from "@weaver/core/documents/title";
import { z } from "zod";
import { COLUMN_TYPES, hasOptions } from "@weaver/core/tables/types";
import {
  CANONICAL_UUID_RE,
  MAX_MULTISELECT_VALUES,
  MAX_TEXT_CHARS,
} from "@weaver/core/tables/validation";
import { folderPathSchema } from "./folder";

const canonicalUuid = z.uuid().regex(CANONICAL_UUID_RE, {
  message: "UUID must use canonical lowercase form",
});

const title = documentTitleSchema;

const sha = z.string().regex(/^[0-9a-f]{40}$/);

export const tableColumnSchema = z
  .object({
    id: canonicalUuid,
    name: z.string().trim().min(1).max(100),
    type: z.enum(COLUMN_TYPES),
    options: z
      .array(
        z.object({
          id: canonicalUuid,
          label: z.string().trim().min(1).max(100),
        }),
      )
      .max(200)
      .optional(),
  })
  .superRefine((column, ctx) => {
    if (hasOptions(column.type) && (column.options ?? []).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "select/multiselect columns require options",
        path: ["options"],
      });
    }
    if (!hasOptions(column.type) && column.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "options are only valid on select/multiselect columns",
        path: ["options"],
      });
    }
    const ids = (column.options ?? []).map((option) => option.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "option ids must be unique",
        path: ["options"],
      });
    }
  });

export const tableRowSchema = z.object({
  id: canonicalUuid,
  cells: z.record(
    canonicalUuid,
    z.union([
      z.string().max(MAX_TEXT_CHARS),
      z.number().finite(),
      z.boolean(),
      z.array(canonicalUuid).min(1).max(MAX_MULTISELECT_VALUES),
    ]),
  ),
});

export const tableColumnsSchema = z
  .array(tableColumnSchema)
  .max(100)
  .refine(
    (columns) =>
      new Set(columns.map((column) => column.id)).size === columns.length,
    { message: "column ids must be unique" },
  );

export const tableRowsSchema = z
  .array(tableRowSchema)
  .max(10_000)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, {
    message: "row ids must be unique",
  });

export const tableIdInput = z.object({
  projectId: z.uuid(),
  tableId: canonicalUuid,
});

export const createTableInput = z.object({
  projectId: z.uuid(),
  folderPath: folderPathSchema,
  title,
  columns: tableColumnsSchema.optional(),
  rows: tableRowsSchema.optional(),
});

export const saveTableInput = z.object({
  projectId: z.uuid(),
  tableId: canonicalUuid,
  baseCommitSha: sha,
  title: title.optional(),
  columns: tableColumnsSchema,
  rows: tableRowsSchema,
});

export const moveTableInput = z.object({
  projectId: z.uuid(),
  tableId: canonicalUuid,
  folderPath: folderPathSchema,
});

export const tableHistoryInput = z.object({
  projectId: z.uuid(),
  tableId: canonicalUuid,
  offset: z.number().int().min(0).max(1000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

export const tableDiffInput = z.object({
  projectId: z.uuid(),
  tableId: canonicalUuid,
  fromSha: sha,
  toSha: sha,
});

export const restoreTableInput = z.object({
  projectId: z.uuid(),
  tableId: canonicalUuid,
  sha,
  expectedHeadCommitSha: sha,
});

export const listTablesInput = z.object({
  projectId: z.uuid(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(-1).max(200).default(25),
  search: z.string().trim().max(200).optional(),
  folderPath: folderPathSchema.optional(),
  sort: z.enum(["title", "lastEditedAt"]).default("lastEditedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export const rebuildTableIndexInput = z.object({
  projectId: z.uuid(),
});

export const deleteTableInput = tableIdInput.extend({
  expectedHeadCommitSha: sha,
});

export const importCsvTableInput = z.object({
  projectId: z.uuid(),
  folderPath: folderPathSchema,
  fileName: z.string().trim().min(1).max(255),
  // A sanity bound only — the service enforces the real 5 MB limit so an
  // oversize file gets that PRECONDITION_FAILED message, not a raw zod error.
  content: z.string().max(10_000_000),
});

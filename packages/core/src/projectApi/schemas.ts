import { z } from "zod";
import { COLUMN_TYPES } from "../tables/types";
import { documentTitleSchema } from "../documents/title";
import {
  MACHINE_ACTIONS,
  MACHINE_TARGET_KINDS,
  MACHINE_UUID_RE,
  PROJECT_API_DEFAULT_RATE_LIMIT,
  PROJECT_API_MAX_RATE_LIMIT,
  PROJECT_API_MAX_EXPIRY_DAYS,
  PROJECT_API_MAX_GRANTS,
  PROJECT_API_MAX_PAGE_SIZE,
  PROJECT_API_DEFAULT_PAGE_SIZE,
} from "./constants";

export const machineUuid = z
  .string()
  .regex(MACHINE_UUID_RE, "A canonical UUID is required");
export const machineAction = z.enum(MACHINE_ACTIONS);
export const machineKeyName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}\u2028\u2029]+$/u, "Use a name on one line");
export const machineExpiryDays = z
  .number()
  .int()
  .min(1)
  .max(PROJECT_API_MAX_EXPIRY_DAYS)
  .nullable();
export const machineRateLimit = z
  .number()
  .int()
  .min(1)
  .max(PROJECT_API_MAX_RATE_LIMIT)
  .default(PROJECT_API_DEFAULT_RATE_LIMIT);
export const machineFolderRef = z.union([
  z.strictObject({ id: machineUuid }),
  z.strictObject({ root: z.literal(true) }),
]);

const cell = z.union([
  z.string().max(200_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()).max(200),
]);
export const machineColumn = z.strictObject({
  id: machineUuid,
  name: z.string().trim().min(1).max(100),
  type: z.enum(COLUMN_TYPES),
  options: z
    .array(
      z.strictObject({
        id: machineUuid,
        label: z.string().trim().min(1).max(100),
      }),
    )
    .min(1)
    .max(200)
    .optional(),
});
export const machineInputColumn = machineColumn.extend({
  id: machineUuid.optional(),
});
export const machineRow = z.strictObject({
  id: machineUuid,
  cells: z.record(machineUuid, cell),
});
export const machineInputRow = machineRow.extend({
  id: machineUuid.optional(),
});
const markdown = z
  .string()
  .max(200_000)
  .refine((s) => !s.includes("\0"), "Invalid Markdown");
export const documentCreateBody = z.strictObject({
  title: documentTitleSchema,
  folder: machineFolderRef,
  markdown,
});
export const documentReplaceBody = z.strictObject({
  markdown,
  title: documentTitleSchema.optional(),
});
export const tableCreateBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  folder: machineFolderRef,
  columns: z.array(machineInputColumn).max(100),
  rows: z.array(machineInputRow).max(10_000).default([]),
});
export const tableReplaceBody = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  columns: z.array(machineColumn).max(100),
  rows: z.array(machineRow).max(10_000),
});
export const rowsAppendBody = z.strictObject({
  rows: z.array(machineInputRow).min(1).max(1_000),
});
export const rowsUpdateBody = z.strictObject({
  rows: z
    .array(
      z.strictObject({
        rowId: machineUuid,
        set: z.record(machineUuid, cell).default({}),
        clear: z.array(machineUuid).max(100).default([]),
      }),
    )
    .min(1)
    .max(1_000),
});
export const machineCommandSchema = z.discriminatedUnion("kind", [
  documentCreateBody.extend({ kind: z.literal("document.create") }),
  documentReplaceBody.extend({
    kind: z.literal("document.replace"),
    id: machineUuid,
  }),
  z.strictObject({ kind: z.literal("document.delete"), id: machineUuid }),
  tableCreateBody.extend({ kind: z.literal("table.create") }),
  tableReplaceBody.extend({
    kind: z.literal("table.replace"),
    id: machineUuid,
  }),
  rowsAppendBody.extend({ kind: z.literal("rows.append"), id: machineUuid }),
  rowsUpdateBody.extend({ kind: z.literal("rows.update"), id: machineUuid }),
  z.strictObject({
    kind: z.literal("rows.delete"),
    id: machineUuid,
    rowId: machineUuid,
  }),
  z.strictObject({ kind: z.literal("table.delete"), id: machineUuid }),
]);
export type MachineCommand = z.infer<typeof machineCommandSchema>;

/** Management-only grant input: a resource UUID, folder UUID, scope root, or legacy folder path. */
export const machineGrantInput = z
  .strictObject({
    kind: z.enum(MACHINE_TARGET_KINDS),
    targetId: machineUuid.optional(),
    root: z.literal(true).optional(),
    path: z.array(z.string().min(1).max(255)).min(1).max(64).optional(),
    actions: z.array(machineAction).min(1).max(MACHINE_ACTIONS.length),
  })
  .superRefine((grant, ctx) => {
    const forms = [grant.targetId, grant.root, grant.path].filter(
      (value) => value !== undefined,
    ).length;
    const folder =
      grant.kind === "documentFolder" || grant.kind === "tableFolder";
    if (forms !== 1 || (!folder && (grant.root || grant.path)))
      ctx.addIssue({
        code: "custom",
        message: "Choose exactly one applicable target",
        path: ["targetId"],
      });
    if (grant.kind === "document" && grant.actions.includes("create"))
      ctx.addIssue({
        code: "custom",
        message: "Documents support Read, Update and Delete",
        path: ["actions"],
      });
  });
export const createProjectApiKeyInput = z.strictObject({
  projectId: machineUuid,
  name: machineKeyName,
  grants: z
    .array(machineGrantInput)
    .min(1, "Add at least one grant")
    .max(PROJECT_API_MAX_GRANTS),
  expiresInDays: machineExpiryDays.optional(),
  rateLimitPerMinute: machineRateLimit,
});
export const updateProjectApiKeyInput = createProjectApiKeyInput.extend({
  keyId: machineUuid,
});
export const projectApiKeyIdInput = z.strictObject({
  projectId: machineUuid,
  keyId: machineUuid,
});
export const projectApiProjectInput = z.strictObject({
  projectId: machineUuid,
});
export const projectApiTargetInput = z.strictObject({
  projectId: machineUuid,
  kind: z.enum(MACHINE_TARGET_KINDS),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PROJECT_API_MAX_PAGE_SIZE)
    .default(PROJECT_API_DEFAULT_PAGE_SIZE),
  cursor: z.string().max(4096).optional(),
  search: z.string().max(100).optional(),
});
export type ProjectApiTargetInput = z.input<typeof projectApiTargetInput>;
export type GrantInput = z.infer<typeof machineGrantInput>;
export type CreateProjectApiKeyInput = z.input<typeof createProjectApiKeyInput>;
export type UpdateProjectApiKeyInput = z.input<typeof updateProjectApiKeyInput>;

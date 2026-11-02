import { createHash, randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { z } from "zod";
import type { PrismaClient } from "@weaver/db/client";
import type {
  GitLogEntry,
  ProjectRepoReader,
  ProjectRepoWriter,
} from "@weaver/git-store";
import {
  assertAuthorName,
  authorForUser,
  FrontmatterError,
  MAX_AUTHOR_NAME_CHARS,
  parseDocumentFile,
  type DocumentAuthor,
} from "../documents/frontmatter";
import {
  DOCUMENT_KINDS,
  documentKindOfPath,
  documentKindFromPath,
  type DocumentKind,
} from "../documents/kinds";
import { assetsDirForDocPath, hasAssetsSegment } from "../documents/images";
import { withoutTitleHeading } from "../documents/importMarkdown";
import { MAX_MARKDOWN_CHARS } from "../documents/limits";
import { wikiPagePropertiesInputSchema } from "../wiki/properties";
import { assertSafeSegments } from "../documents/paths";
import { collectImageReferences } from "../documents/imageReferences";
import { applyDocumentPatch } from "../documents/patch";
import { classifyDeletedPath } from "../documents/recovery";
import { slugify } from "../documents/slug";
import { documentTitleSchema } from "../documents/title";
import { parseDocumentBody, serializeDocumentBody } from "../editor/markdown";
import { CoreError } from "../errors";
import { validateRows } from "../tables/cellValues";
import { applyTableChange } from "../tables/change";
import { parseRows, parseSchemaFile } from "../tables/jsonl";
import {
  assertOutsideTablesRoot,
  folderPathOfTableDir,
  TABLES_ROOT,
} from "../tables/paths";
import {
  COLUMN_TYPES,
  hasOptions,
  type SchemaFile,
  type TableColumn,
  type TableRow,
} from "../tables/types";
import {
  CANONICAL_UUID_RE,
  MAX_MULTISELECT_VALUES,
  MAX_TEXT_CHARS,
} from "../tables/validation";
import {
  documentSlugFromPath,
  deleteDocumentInRepo,
  moveDocumentInRepo,
  repairDocumentProjectionInRepo,
  restoreDocumentInRepo,
  writeDocumentInRepo,
  type DocumentAssetFile,
  type DocumentMetadataOverride,
  type EnrichedActor,
} from "./documents";
import { hasNoUser, type ContentWriteActor } from "./contentAuthor";
import { MAX_SERVED_BLOB_BYTES } from "./documentImages";
import { defaultReviewForFolderInRepo } from "./folderReview";
import { resolveImageReferences } from "./documentImageImports";
import {
  createFolderInRepo,
  deleteFolderInRepo,
  moveFolderToInRepo,
  renameFolderInRepo,
  scopeForResourceType,
  type FolderAudit,
  type FolderScope,
} from "./folders";
import {
  deleteTableInRepo,
  getTableInRepo,
  moveTableInRepo,
  restoreTableInRepo,
  writeTableInRepo,
} from "./tables";

export { MAX_MARKDOWN_CHARS };
export const RECOVERY_LOG_LIMIT = 10;

export const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const canonicalUuid = z.string().regex(CANONICAL_UUID_RE);
export const folderPath = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/))
  .max(10);
export const title = documentTitleSchema;
export const cellValue = z.union([
  z.string().max(MAX_TEXT_CHARS),
  z.number().finite(),
  z.boolean(),
  // multiselect cells: a set of canonical option ids.
  z.array(canonicalUuid).min(1).max(MAX_MULTISELECT_VALUES),
]);
export const cells = z.record(canonicalUuid, cellValue);
// Generated ids must already satisfy the Git writers' canonical-UUID rule,
// otherwise a proposal would be creatable but never acceptable.
export const columnSchema = z
  .object({
    id: canonicalUuid.optional(),
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
export const rowSchema = z.object({ id: canonicalUuid.optional(), cells });

export const schemaChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), column: columnSchema }),
  z.object({
    op: z.literal("rename"),
    columnId: z.string(),
    name: z.string().trim().min(1).max(100),
  }),
  z.object({ op: z.literal("remove"), columnId: z.string() }),
]);
export type SchemaChange = z.infer<typeof schemaChangeSchema>;

export const rowChangesSchema = z.object({
  inserts: z.array(rowSchema).max(1_000),
  updates: z.array(z.object({ rowId: z.string(), cells })).max(1_000),
  deletes: z.array(z.string()).max(1_000),
});
export type RowChanges = z.infer<typeof rowChangesSchema>;

const patchNeedle = z.string().min(1).max(10_000);
const patchText = z
  .string()
  .max(MAX_MARKDOWN_CHARS)
  .describe(
    'Markdown; ![alt](weaver-image:…) references are copied in; <img src="…" alt="…" width="N"> on its own line, blank lines around it, sets an image width.',
  );
const sectionId = z.string().min(1).max(200);

export const patchActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("replace_text"),
    find: patchNeedle,
    replace: patchText,
    sectionId: sectionId.optional(),
    expectedMatches: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    action: z.literal("insert_before"),
    anchor: patchNeedle,
    text: patchText,
    sectionId: sectionId.optional(),
  }),
  z.object({
    action: z.literal("insert_after"),
    anchor: patchNeedle,
    text: patchText,
    sectionId: sectionId.optional(),
  }),
  z.object({
    action: z.literal("prepend"),
    text: patchText,
    sectionId: sectionId.optional(),
  }),
  z.object({
    action: z.literal("append"),
    text: patchText,
    sectionId: sectionId.optional(),
  }),
  z.object({
    action: z.literal("replace_section_body"),
    sectionId,
    text: patchText,
  }),
  z.object({ action: z.literal("remove_section"), sectionId }),
]);
export type PatchActionInput = z.infer<typeof patchActionSchema>;

const selectOptionSchema = z.object({
  id: canonicalUuid.optional(),
  label: z.string().trim().min(1).max(100),
});
// Unlike `option_add`, a retype's options are used as-is (no id generation),
// so its ids must already be canonical — see applyColumnChanges's "retype" case.
const retypeOptionSchema = z.object({
  id: canonicalUuid,
  label: z.string().trim().min(1).max(100),
});
const columnName = z.string().trim().min(1).max(100);

export const tableColumnChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), column: columnSchema }),
  z.object({ op: z.literal("rename"), columnId: z.string(), name: columnName }),
  z.object({ op: z.literal("remove"), columnId: z.string() }),
  z.object({
    op: z.literal("retype"),
    columnId: z.string(),
    type: z.enum(COLUMN_TYPES),
    options: z.array(retypeOptionSchema).max(200).optional(),
  }),
  z.object({
    op: z.literal("reorder"),
    columnIds: z.array(z.string()).min(1).max(100),
  }),
  z.object({
    op: z.literal("option_add"),
    columnId: z.string(),
    option: selectOptionSchema,
  }),
  z.object({
    op: z.literal("option_rename"),
    columnId: z.string(),
    optionId: z.string(),
    label: z.string().trim().min(1).max(100),
  }),
  z.object({
    op: z.literal("option_remove"),
    columnId: z.string(),
    optionId: z.string(),
  }),
]);

export const tableRowChangesSchema = z.object({
  inserts: z.array(rowSchema).max(1_000),
  updates: z
    .array(
      z.object({
        rowId: z.string(),
        set: cells.optional(),
        clear: z.array(canonicalUuid).max(100).optional(),
      }),
    )
    .max(1_000),
  deletes: z.array(z.string()).max(1_000),
});

const documentAuthorInput = z
  .union([
    z.strictObject({ userId: z.uuid() }),
    z.strictObject({ name: z.string().min(1).max(MAX_AUTHOR_NAME_CHARS) }),
  ])
  .describe(
    "{ userId } of a project member, or { name } of an author outside Weaver",
  );
const metadataTimestamp = z.iso
  .datetime({ offset: true })
  .describe("ISO-8601 timestamp, not in the future");

/** Explicit document metadata, e.g. an imported document's original dates and author. */
export const documentMetadataInputSchema = z
  .strictObject({
    created: metadataTimestamp.optional(),
    createdBy: documentAuthorInput.optional(),
    updated: metadataTimestamp.optional(),
    updatedBy: documentAuthorInput.optional(),
  })
  .describe(
    "Optional document metadata, e.g. an imported document's original dates and author. Set only what the user asked for; omitted fields default to now and to you.",
  );
export type DocumentMetadataInput = z.infer<typeof documentMetadataInputSchema>;

const documentMarkdown = z
  .string()
  .max(MAX_MARKDOWN_CHARS)
  .describe(
    'Markdown body without the title: Weaver writes the title as the H1 heading. Images: keep the ![alt](weaver-image:…) references the file read tools return (OneNote, Word), or write ![alt](weaver-image:<file id>) for an image file in Files; Weaver copies each image into the document. Write <img src="…" alt="…" width="N"> on its own line, with a blank line before and after, to set an image\'s width in pixels. For a Python document, send the full source text instead; the title heading rule does not apply.',
  );

export const contentOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document.create"),
    projectId: z.uuid(),
    folderPath,
    title,
    markdown: documentMarkdown,
    metadata: documentMetadataInputSchema.optional(),
    properties: wikiPagePropertiesInputSchema.optional(),
  }),
  z.object({
    kind: z.literal("document.edit"),
    projectId: z.uuid(),
    documentId: z.uuid(),
    baseCommitSha: sha,
    title: title.optional(),
    markdown: documentMarkdown,
    metadata: documentMetadataInputSchema.optional(),
    properties: wikiPagePropertiesInputSchema.optional(),
  }),
  z.object({
    kind: z.literal("document.patch"),
    projectId: z.uuid(),
    documentId: z.uuid(),
    baseCommitSha: sha,
    title: title.optional(),
    actions: z.array(patchActionSchema).max(50),
    metadata: documentMetadataInputSchema.optional(),
    properties: wikiPagePropertiesInputSchema.optional(),
  }),
  z.object({
    kind: z.literal("table.create"),
    projectId: z.uuid(),
    folderPath,
    title,
    columns: z.array(columnSchema).min(1).max(100),
    rows: z.array(rowSchema).max(1_000),
  }),
  z.object({
    kind: z.literal("table.schema"),
    projectId: z.uuid(),
    tableId: z.uuid(),
    baseCommitSha: sha,
    changes: z.array(schemaChangeSchema).min(1).max(100),
  }),
  z.object({
    kind: z.literal("table.rows"),
    projectId: z.uuid(),
    tableId: z.uuid(),
    baseCommitSha: sha,
    ...rowChangesSchema.shape,
  }),
  z.object({
    kind: z.literal("table.change"),
    projectId: z.uuid(),
    tableId: z.uuid(),
    baseCommitSha: sha,
    title: title.optional(),
    columns: z.array(tableColumnChangeSchema).max(100),
    rows: tableRowChangesSchema,
  }),
  z.object({
    kind: z.literal("content.restore"),
    projectId: z.uuid(),
    resourceType: z.enum(["document", "table"]),
    resourceId: z.uuid(),
    mode: z.enum(["version", "deleted"]),
    sourceSha: sha,
    expectedHeadCommitSha: sha.optional(),
    deletedAtSha: sha.optional(),
  }),
  // Flat, not a discriminated union over `action`: six branches would each
  // re-emit projectId and two regexes, costing 5,738 B of tool schema against
  // 1,967 B (design §7.3). assertLifecycleShape carries the strictness.
  z.object({
    kind: z.literal("content.lifecycle"),
    projectId: z.uuid(),
    action: z.enum([
      "folder_create",
      "folder_rename",
      "folder_move",
      "folder_delete",
      "item_move",
      "item_delete",
    ]),
    resourceType: z.enum(["document", "table"]),
    baseProjectCommitSha: sha.optional(),
    // A root is unaddressable rather than defended by a later check.
    path: folderPath.min(1).optional(),
    parentPath: folderPath.optional(),
    newParentPath: folderPath.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    resourceId: z.uuid().optional(),
    expectedHeadCommitSha: sha.optional(),
    folderPath: folderPath.optional(),
  }),
]);
export type ContentOperation = z.infer<typeof contentOperationSchema>;
export type ContentRestoreOperation = Extract<
  ContentOperation,
  { kind: "content.restore" }
>;
export type ContentLifecycleOperation = Extract<
  ContentOperation,
  { kind: "content.lifecycle" }
>;
export type LifecycleAction = ContentLifecycleOperation["action"];

/** A discriminated-union option cannot carry .refine, so the
 * "title or at least one action" rule lives here and runs on both paths. */
export function assertPatchHasWork(operation: ContentOperation): void {
  if (
    operation.kind === "document.patch" &&
    operation.title === undefined &&
    operation.metadata === undefined &&
    operation.properties === undefined &&
    operation.actions.length === 0
  )
    throw new CoreError(
      "BAD_REQUEST",
      "a patch needs a title change, a metadata or properties change or at least one action",
    );
}

/** Each restore mode carries a different revision guard (concept §7.3). */
export function assertRestoreGuard(operation: ContentOperation): void {
  if (operation.kind !== "content.restore") return;
  if (operation.mode === "version" && !operation.expectedHeadCommitSha)
    throw new CoreError(
      "BAD_REQUEST",
      "a version restore requires expectedHeadCommitSha",
    );
  if (operation.mode === "deleted" && !operation.deletedAtSha)
    throw new CoreError(
      "BAD_REQUEST",
      "a deleted recovery requires deletedAtSha",
    );
}

const LIFECYCLE_FIELDS = [
  "baseProjectCommitSha",
  "path",
  "parentPath",
  "newParentPath",
  "name",
  "resourceId",
  "expectedHeadCommitSha",
  "folderPath",
] as const;
type LifecycleField = (typeof LIFECYCLE_FIELDS)[number];

/** Exactly the fields each action carries. A discriminated union would say
 * this in types; at six actions that costs 3.8 KB of tool schema (design
 * §7.3), so the rule runs here on both the proposal and the MCP path. */
const LIFECYCLE_REQUIRED: Record<LifecycleAction, readonly LifecycleField[]> = {
  folder_create: ["baseProjectCommitSha", "parentPath", "name"],
  folder_rename: ["baseProjectCommitSha", "path", "name"],
  folder_move: ["baseProjectCommitSha", "path", "newParentPath"],
  folder_delete: ["baseProjectCommitSha", "path"],
  item_move: ["resourceId", "expectedHeadCommitSha", "folderPath"],
  item_delete: ["resourceId", "expectedHeadCommitSha"],
};

export function assertLifecycleShape(operation: ContentOperation): void {
  if (operation.kind !== "content.lifecycle") return;
  const required = LIFECYCLE_REQUIRED[operation.action];
  for (const field of LIFECYCLE_FIELDS) {
    const present = operation[field] !== undefined;
    if (required.includes(field)) {
      if (!present)
        throw new CoreError(
          "BAD_REQUEST",
          `action ${operation.action} requires ${field}`,
          { field },
        );
    } else if (present) {
      throw new CoreError(
        "BAD_REQUEST",
        `action ${operation.action} does not accept ${field}`,
        { field },
      );
    }
  }
}

const FOLDER_ACTIONS = new Set<LifecycleAction>([
  "folder_create",
  "folder_rename",
  "folder_move",
  "folder_delete",
]);

export function isFolderLifecycleAction(action: LifecycleAction): boolean {
  return FOLDER_ACTIONS.has(action);
}

/** A table.change with nothing in it would commit an empty diff. */
export function assertChangeHasWork(operation: ContentOperation): void {
  if (
    operation.kind === "table.change" &&
    operation.title === undefined &&
    operation.columns.length === 0 &&
    operation.rows.inserts.length === 0 &&
    operation.rows.updates.length === 0 &&
    operation.rows.deletes.length === 0
  )
    throw new CoreError(
      "BAD_REQUEST",
      "a table change needs a title change, a column change or a row change",
    );
}

/** document.edit caps `markdown` in the schema; a patch can only be capped
 * once its actions are applied, and an uncapped result would outgrow its own
 * history diff. */
export function assertPatchedMarkdownFits(markdown: string): void {
  if (markdown.length > MAX_MARKDOWN_CHARS)
    throw new CoreError(
      "BAD_REQUEST",
      `the patched document would be ${markdown.length} characters; the limit is ${MAX_MARKDOWN_CHARS}`,
      { field: "actions", reason: "PAYLOAD_TOO_LARGE" },
    );
}

export function fillColumn(column: z.infer<typeof columnSchema>): TableColumn {
  return {
    id: column.id ?? randomUUID(),
    name: column.name,
    type: column.type,
    ...(column.options ? { options: column.options } : {}),
  };
}

export function fillRow(row: z.infer<typeof rowSchema>): TableRow {
  return { id: row.id ?? randomUUID(), cells: row.cells };
}

export function fillSelectOption(option: { id?: string; label: string }): {
  id: string;
  label: string;
} {
  return { id: option.id ?? randomUUID(), label: option.label };
}

export function assertValidRows(
  columns: TableColumn[],
  rows: TableRow[],
): void {
  const result = validateRows(columns, rows);
  if (!result.ok) {
    throw new CoreError(
      "BAD_REQUEST",
      `invalid cell values: ${result.errors
        .slice(0, 5)
        .map((e) => `${e.rowId}/${e.columnId}: ${e.reason}`)
        .join("; ")}`,
    );
  }
}

export function applyTableSchemaChanges(
  columns: TableColumn[],
  rows: TableRow[],
  changes: SchemaChange[],
): { columns: TableColumn[]; rows: TableRow[] } {
  let next = columns.map((c) => ({ ...c }));
  const removed = new Set<string>();
  for (const change of changes) {
    if (change.op === "add") {
      const column = fillColumn(change.column);
      if (next.some((c) => c.id === column.id))
        throw new CoreError("BAD_REQUEST", `duplicate column id ${column.id}`);
      if (next.some((c) => c.name.toLowerCase() === column.name.toLowerCase()))
        throw new CoreError(
          "BAD_REQUEST",
          `duplicate column name ${column.name}`,
        );
      next.push(column);
    } else {
      const target = next.find((c) => c.id === change.columnId);
      if (!target)
        throw new CoreError("BAD_REQUEST", `unknown column ${change.columnId}`);
      if (change.op === "rename") {
        if (
          next.some(
            (c) =>
              c.id !== target.id &&
              c.name.toLowerCase() === change.name.toLowerCase(),
          )
        )
          throw new CoreError(
            "BAD_REQUEST",
            `duplicate column name ${change.name}`,
          );
        target.name = change.name;
      } else {
        next = next.filter((c) => c.id !== target.id);
        removed.add(target.id);
      }
    }
  }
  if (next.length === 0)
    throw new CoreError("BAD_REQUEST", "a table needs at least one column");
  const nextRows = rows.map((row) => ({
    id: row.id,
    cells: Object.fromEntries(
      Object.entries(row.cells).filter(([columnId]) => !removed.has(columnId)),
    ),
  }));
  assertValidRows(next, nextRows);
  return { columns: next, rows: nextRows };
}

export function applyTableRowChanges(
  columns: TableColumn[],
  rows: TableRow[],
  changes: RowChanges,
): { columns: TableColumn[]; rows: TableRow[] } {
  const byId = new Map(
    rows.map((row) => [row.id, { id: row.id, cells: { ...row.cells } }]),
  );
  for (const update of changes.updates) {
    const row = byId.get(update.rowId);
    if (!row) throw new CoreError("BAD_REQUEST", `unknown row ${update.rowId}`);
    Object.assign(row.cells, update.cells);
  }
  for (const rowId of changes.deletes) {
    if (!byId.delete(rowId))
      throw new CoreError("BAD_REQUEST", `unknown row ${rowId}`);
  }
  for (const insert of changes.inserts) {
    const row = fillRow(insert);
    if (byId.has(row.id))
      throw new CoreError("BAD_REQUEST", `duplicate row id ${row.id}`);
    byId.set(row.id, row);
  }
  const next = [...byId.values()];
  assertValidRows(columns, next);
  return { columns, rows: next };
}

export type TableAtHead = Awaited<ReturnType<typeof getTableInRepo>>;

/** Who a recovered commit must belong to; a wiki identity also needs the ledger's trust. */
export type RecoveryIdentity =
  | { requestHash: string; toolName: string }
  | { wikiAgentId: string; wikiRequestHash: string };

export function matchesRecoveryIdentity(
  entry: GitLogEntry,
  identity: RecoveryIdentity,
): boolean {
  return "wikiAgentId" in identity
    ? entry.trustedAuthor === true &&
        entry.wikiAgentId === identity.wikiAgentId &&
        entry.wikiRequestHash === identity.wikiRequestHash
    : entry.mcpRequestHash === identity.requestHash &&
        entry.mcpToolName === identity.toolName;
}

// Verified trailers identify writes whose database acknowledgement was lost.
export async function findCommitByOperationId(
  repo: ProjectRepoWriter,
  path: string,
  operationId: string,
  identity?: RecoveryIdentity,
): Promise<string | null> {
  const entries = await repo.logForPath(path, {
    skip: 0,
    limit: RECOVERY_LOG_LIMIT,
  });
  return (
    entries.find(
      (entry) =>
        entry.operationId === operationId &&
        (!identity || matchesRecoveryIdentity(entry, identity)),
    )?.sha ?? null
  );
}

// The create identity survives a crash before the operation acknowledgement is stored.
export function createdResourceId(operationId: string): string {
  const hex = createHash("sha256")
    .update(`weaver-content-create:${operationId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Where a lifecycle action left its result. A folder create's own commit
 * touches only `<folder>/.gitkeep`, so a folder result is computed from the
 * operation. An item action's commit can also touch the resource's assets
 * directory in the same commit (a document move carries its assets along),
 * and git orders diff entries by path — an assets path can sort before the
 * resource's own — so an item's result path is read from the commit's full
 * change list and classified, never from its first entry. A move whose
 * destination slug was taken rewrites the body, so git's rename detection can
 * miss it and report `D <source>` plus `A <destination>`; a move therefore
 * reports the entry that is not the deletion. */
async function lifecycleResultPath(
  repo: ProjectRepoReader,
  operation: ContentLifecycleOperation,
  entrySha: string,
): Promise<string> {
  const prefix =
    scopeForResourceType(operation.resourceType) === "tables"
      ? [TABLES_ROOT]
      : [];
  switch (operation.action) {
    case "folder_create":
      return [
        ...prefix,
        ...operation.parentPath!,
        slugify(operation.name!),
      ].join("/");
    case "folder_rename":
      return [
        ...prefix,
        ...operation.path!.slice(0, -1),
        slugify(operation.name!),
      ].join("/");
    case "folder_move":
      return [
        ...prefix,
        ...operation.newParentPath!,
        operation.path!.at(-1)!,
      ].join("/");
    case "folder_delete":
      return [...prefix, ...operation.path!].join("/");
    case "item_move":
    case "item_delete": {
      const [entry] = await repo.logChangesBefore(entrySha, { limit: 1 });
      if (entry?.sha !== entrySha)
        throw new CoreError(
          "CONFLICT",
          "prior lifecycle commit cannot be verified",
        );
      // A delete leaves only `D` entries; a move's result is its destination,
      // which is every status but `D` (`R`/`C` report the new path).
      let deleted: string | null = null;
      for (const change of entry.changes) {
        const classified = classifyDeletedPath(change.path);
        if (classified?.kind !== operation.resourceType) continue;
        if (operation.action === "item_delete" || change.status !== "D")
          return classified.resourcePath;
        deleted ??= classified.resourcePath;
      }
      if (deleted !== null) return deleted;
      throw new CoreError(
        "CONFLICT",
        "prior lifecycle commit did not touch a resource of the expected type",
      );
    }
  }
}

/** A lifecycle action's outcome cannot be re-derived from current state — a
 * delete leaves nothing to find and a folder create would collide with itself
 * — so a lost acknowledgement is recovered from the commit trailer
 * (concept §7.3). */
async function recoverLifecycleOperation(
  repo: ProjectRepoWriter,
  operation: ContentLifecycleOperation,
  operationId: string,
  identity?: RecoveryIdentity,
): Promise<AppliedOperation | null> {
  const entries = await repo.logForPath(".", {
    skip: 0,
    limit: RECOVERY_LOG_LIMIT + 1,
    operationId,
  });
  const matching = entries.filter((entry) => entry.operationId === operationId);
  if (entries.length > RECOVERY_LOG_LIMIT || matching.length > 1)
    throw new CoreError("CONFLICT", "prior lifecycle history is ambiguous");
  const entry = matching[0];
  if (!entry) return null;
  if (identity && !matchesRecoveryIdentity(entry, identity))
    throw new CoreError(
      "CONFLICT",
      "idempotency key was already used for a different request, or its prior commit cannot be verified",
      { reason: "IDEMPOTENCY_KEY_REUSED" },
    );
  return {
    commitSha: entry.sha,
    resourceId: isFolderLifecycleAction(operation.action)
      ? null
      : operation.resourceId!,
    path: await lifecycleResultPath(repo, operation, entry.sha),
  };
}

/** Recovers a write whose outcome cannot be re-derived from current state
 * after the acknowledgement that would have replayed it was lost: a create or
 * a deleted recovery, whose identity is fixed before the commit, and a
 * lifecycle action, which may have removed its own target (concept §7.3). */
export async function recoverPriorOperation(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: ContentOperation,
  operationId: string,
  identity?: RecoveryIdentity,
): Promise<AppliedOperation | null> {
  if (operation.kind === "content.lifecycle") {
    assertLifecycleShape(operation);
    return recoverLifecycleOperation(repo, operation, operationId, identity);
  }
  if (operation.kind === "content.restore")
    return operation.mode === "deleted"
      ? recoverDeletedRestore(db, repo, operation, operationId, identity)
      : null;
  if (operation.kind !== "document.create" && operation.kind !== "table.create")
    return null;
  const resourceId = createdResourceId(operationId);
  const document = await db.document.findUnique({
    where: { id: resourceId },
    select: { projectId: true, path: true },
  });
  const table = await db.dataTable.findUnique({
    where: { id: resourceId },
    select: { projectId: true, path: true },
  });
  const existing = document ?? table;
  if (
    existing &&
    (existing.projectId !== operation.projectId ||
      Boolean(document) !== (operation.kind === "document.create"))
  )
    throw new CoreError(
      "CONFLICT",
      "idempotency key was already used for a different request",
    );
  const entries = await repo.logForPath(".", {
    skip: 0,
    limit: RECOVERY_LOG_LIMIT + 1,
    operationId,
  });
  const matching = entries.filter((entry) => entry.operationId === operationId);
  if (entries.length > RECOVERY_LOG_LIMIT || matching.length > 1)
    throw new CoreError("CONFLICT", "prior create history is ambiguous");
  const entry = matching[0];
  if (!entry) {
    if (existing)
      throw new CoreError("CONFLICT", "prior create commit cannot be verified");
    return null;
  }
  if (identity && !matchesRecoveryIdentity(entry, identity))
    throw new CoreError(
      "CONFLICT",
      "idempotency key was already used for a different request, or its prior commit cannot be verified",
      { reason: "IDEMPOTENCY_KEY_REUSED" },
    );
  const [change] = await repo.logChangesBefore(entry.sha, { limit: 1 });
  const candidates: string[] = [];
  for (const item of change?.changes ?? []) {
    if (item.status === "D") continue;
    const isDocument = operation.kind === "document.create";
    if (
      isDocument
        ? documentKindFromPath(item.path) === null ||
          hasAssetsSegment(item.path) ||
          item.path.startsWith(`${TABLES_ROOT}/`)
        : !item.path.endsWith(".table/schema.json")
    )
      continue;
    if (((await repo.blobSizeAt(entry.sha, item.path)) ?? Infinity) > 2_000_000)
      continue;
    try {
      const content = await repo.showFileAt(entry.sha, item.path);
      const id = isDocument
        ? parseDocumentFile(content, documentKindOfPath(item.path)).meta.id
        : (JSON.parse(content) as { id: string }).id;
      if (id === resourceId)
        candidates.push(
          isDocument ? item.path : item.path.slice(0, -"/schema.json".length),
        );
    } catch {
      continue;
    }
  }
  if (candidates.length !== 1)
    throw new CoreError("CONFLICT", "prior create identity cannot be verified");
  const path = candidates[0]!;
  const id = resourceId;
  if (operation.kind === "document.create") {
    await repairDocumentProjectionInRepo(
      db,
      repo,
      operation.projectId,
      id,
      path,
    );
  } else {
    try {
      await getTableInRepo(db, repo, operation.projectId, id);
    } catch (error) {
      if (!(error instanceof CoreError && error.code === "NOT_FOUND"))
        throw error;
    }
  }
  return { commitSha: entry.sha, resourceId: id, path };
}

/**
 * Where a restore's identity lives at HEAD, read from committed content: a
 * prior recovery whose projection write failed leaves no database row, so Git
 * is the second witness. Repairs a document's missing projection on the way.
 */
async function liveRestoreTarget(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: ContentRestoreOperation,
): Promise<{ path: string } | null> {
  if (operation.resourceType === "document") {
    const repaired = await repairDocumentProjectionInRepo(
      db,
      repo,
      operation.projectId,
      operation.resourceId,
    );
    return repaired ? { path: repaired.path } : null;
  }
  try {
    return await getTableInRepo(
      db,
      repo,
      operation.projectId,
      operation.resourceId,
    );
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** A deleted recovery writes a new file carrying an id the operation already
 * names, so a lost acknowledgement has to be recovered from the commit trailer
 * exactly like a create — replaying the write would commit that id twice. */
async function recoverDeletedRestore(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: ContentRestoreOperation,
  operationId: string,
  identity?: RecoveryIdentity,
): Promise<AppliedOperation | null> {
  const entries = await repo.logForPath(".", {
    skip: 0,
    limit: RECOVERY_LOG_LIMIT + 1,
    operationId,
  });
  const matching = entries.filter((entry) => entry.operationId === operationId);
  if (entries.length > RECOVERY_LOG_LIMIT || matching.length > 1)
    throw new CoreError("CONFLICT", "prior restore history is ambiguous");
  const entry = matching[0];
  if (!entry) return null;
  if (identity && !matchesRecoveryIdentity(entry, identity))
    throw new CoreError(
      "CONFLICT",
      "idempotency key was already used for a different request, or its prior commit cannot be verified",
      { reason: "IDEMPOTENCY_KEY_REUSED" },
    );
  const live = await liveRestoreTarget(db, repo, operation);
  if (!live)
    throw new CoreError("CONFLICT", "prior restore commit cannot be verified");
  return {
    commitSha: entry.sha,
    resourceId: operation.resourceId,
    path: live.path,
  };
}

export type OperationBase =
  | { ok: true; path: string | null; table: TableAtHead | null }
  | { ok: false; reason: "gone" }
  | { ok: false; reason: "stale"; path: string };

/** Inside the project lock: does the operation's expected revision still match? */
export async function checkOperationBase(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: ContentOperation,
): Promise<OperationBase> {
  if (operation.kind === "content.restore") {
    assertRestoreGuard(operation);
    // Deleted mode has no live resource: applyOperationInRepo re-verifies
    // absence and identity under the write lock instead.
    if (operation.mode === "deleted")
      return { ok: true, path: null, table: null };
    // Version mode guards on expectedHeadCommitSha rather than baseCommitSha,
    // so it cannot reuse the branches below; reporting "stale" with the path
    // lets the shared recovery find our own commit by trailer after a lost
    // acknowledgement (concept §7.3).
    if (operation.resourceType === "document") {
      const current = await db.document.findFirst({
        where: { id: operation.resourceId, projectId: operation.projectId },
        select: { path: true },
      });
      if (!current) return { ok: false, reason: "gone" };
      if (
        (await repo.lastCommitForPath(current.path)) !==
        operation.expectedHeadCommitSha
      )
        return { ok: false, reason: "stale", path: current.path };
      return { ok: true, path: current.path, table: null };
    }
    let restoreTarget: TableAtHead;
    try {
      restoreTarget = await getTableInRepo(
        db,
        repo,
        operation.projectId,
        operation.resourceId,
      );
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND")
        return { ok: false, reason: "gone" };
      throw error;
    }
    if (restoreTarget.baseCommitSha !== operation.expectedHeadCommitSha)
      return { ok: false, reason: "stale", path: restoreTarget.path };
    return { ok: true, path: restoreTarget.path, table: restoreTarget };
  }
  if (operation.kind === "content.lifecycle") {
    assertLifecycleShape(operation);
    if (isFolderLifecycleAction(operation.action)) {
      // A path names a subtree, not a stable UUID, so the guard is the whole
      // project's revision (concept §7.2). "." lets the shared recovery search
      // the repository root for our own commit after a lost acknowledgement.
      if ((await repo.resolveHead()) !== operation.baseProjectCommitSha)
        return { ok: false, reason: "stale", path: "." };
      return { ok: true, path: null, table: null };
    }
    if (operation.resourceType === "document") {
      const current = await db.document.findFirst({
        where: { id: operation.resourceId, projectId: operation.projectId },
        select: { path: true },
      });
      if (!current) return { ok: false, reason: "gone" };
      if (
        (await repo.lastCommitForPath(current.path)) !==
        operation.expectedHeadCommitSha
      )
        return { ok: false, reason: "stale", path: current.path };
      return { ok: true, path: current.path, table: null };
    }
    let target: TableAtHead;
    try {
      target = await getTableInRepo(
        db,
        repo,
        operation.projectId,
        operation.resourceId!,
      );
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND")
        return { ok: false, reason: "gone" };
      throw error;
    }
    if (target.baseCommitSha !== operation.expectedHeadCommitSha)
      return { ok: false, reason: "stale", path: target.path };
    return { ok: true, path: target.path, table: target };
  }
  if (
    operation.kind === "document.edit" ||
    operation.kind === "document.patch"
  ) {
    const current = await db.document.findFirst({
      where: { id: operation.documentId, projectId: operation.projectId },
      select: { path: true },
    });
    if (!current) return { ok: false, reason: "gone" };
    if (
      (await repo.lastCommitForPath(current.path)) !== operation.baseCommitSha
    )
      return { ok: false, reason: "stale", path: current.path };
    return { ok: true, path: current.path, table: null };
  }
  if (
    operation.kind === "table.schema" ||
    operation.kind === "table.rows" ||
    operation.kind === "table.change"
  ) {
    let table: TableAtHead;
    try {
      table = await getTableInRepo(
        db,
        repo,
        operation.projectId,
        operation.tableId,
      );
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND")
        return { ok: false, reason: "gone" };
      throw error;
    }
    if (table.baseCommitSha !== operation.baseCommitSha)
      return { ok: false, reason: "stale", path: table.path };
    return { ok: true, path: table.path, table };
  }
  return { ok: true, path: null, table: null };
}

function existingResourceId(operation: ContentOperation): string | null {
  switch (operation.kind) {
    case "document.edit":
    case "document.patch":
      return operation.documentId;
    case "table.schema":
    case "table.rows":
    case "table.change":
      return operation.tableId;
    case "content.restore":
      return operation.resourceId;
    case "content.lifecycle":
      // A folder action commits no resource, so this is null for one; an
      // item action always carries an id.
      return operation.resourceId ?? null;
    default:
      return null;
  }
}

/** The shared write sequence under the project lock: recover a lost
 * acknowledgement, check the base revision, then apply. A prior commit under
 * this operation id that fails the identity check is a CONFLICT, never a
 * recovery and never a fresh write. */
export async function recoverCheckApply(input: {
  db: PrismaClient;
  repo: ProjectRepoWriter;
  operation: ContentOperation;
  operationId: string;
  identity: RecoveryIdentity;
  checkpoint?: () => void;
  apply: (
    base: Extract<OperationBase, { ok: true }>,
  ) => Promise<AppliedOperation>;
}): Promise<{ applied: AppliedOperation; committed: boolean }> {
  const { db, repo, operation, operationId, identity } = input;
  const recoveredCreate = await recoverPriorOperation(
    db,
    repo,
    operation,
    operationId,
    identity,
  );
  const base = await checkOperationBase(db, repo, operation);
  input.checkpoint?.();
  if (recoveredCreate) return { applied: recoveredCreate, committed: false };
  if (base.ok) {
    input.checkpoint?.();
    return { applied: await input.apply(base), committed: true };
  }
  if (base.reason === "gone")
    throw new CoreError("NOT_FOUND", "target no longer exists");
  // Our own commit from a crash between commit and row insert wins;
  // anything else is a real conflict the client must re-read for.
  const recovered = await findCommitByOperationId(
    repo,
    base.path,
    operationId,
    identity,
  );
  if (!recovered) {
    const unverified = await findCommitByOperationId(
      repo,
      base.path,
      operationId,
    );
    if (unverified)
      throw new CoreError(
        "CONFLICT",
        "idempotency key was already used for a different request, or its prior commit cannot be verified",
        { reason: "IDEMPOTENCY_KEY_REUSED" },
      );
    throw new CoreError(
      "CONFLICT",
      "base revision changed; re-read and retry with the current commitSha",
      { reason: "STALE_BASE" },
    );
  }
  return {
    applied: {
      commitSha: recovered,
      resourceId: existingResourceId(operation),
      path: base.path,
    },
    committed: false,
  };
}

export type AppliedOperation = {
  commitSha: string;
  /** null for a folder action, which commits no resource (design §7.6). */
  resourceId: string | null;
  path: string;
};

export type ApplyOperationOptions = {
  /** The table read by checkOperationBase; required for table.schema / table.rows. */
  table: TableAtHead | null;
  /** Document change summary (edit) and, with `message`, the commit message. */
  summary: string;
  /** Recorded as the Weaver-Operation-Id trailer; the recovery key. */
  operationId: string;
  /** Both are persisted as Git trailers for fail-closed MCP recovery. */
  mcpRequestHash?: string;
  mcpToolName?: string;
  /** Recorded as the Weaver-Run-Id trailer for proposal accepts. */
  runId?: string;
  /** Weaver-Wiki-Request-Hash, required on every wiki agent commit. */
  wikiRequestHash?: string;
  /** Runs under the project lock immediately before the commit. */
  beforeCommit?: () => Promise<void>;
  /** Overrides the default document commit message (direct writes). */
  message?: (path: string, oldPath: string | null) => string;
  /** Sees the canonical body before and after a patch; a throw refuses it. */
  assertPatched?: (before: string, after: string) => void;
};

/** Paths of the given type that this commit deleted, from its own D records. */
async function deletedResourcePaths(
  repo: ProjectRepoReader,
  operation: ContentRestoreOperation,
): Promise<string[]> {
  const [entry] = await repo.logChangesBefore(operation.deletedAtSha!, {
    limit: 1,
  });
  if (!entry || entry.sha !== operation.deletedAtSha)
    throw new CoreError("NOT_FOUND", "unknown deletion commit");
  const paths: string[] = [];
  for (const change of entry.changes) {
    if (change.status !== "D") continue;
    const classified = classifyDeletedPath(change.path);
    if (classified?.kind === operation.resourceType)
      paths.push(classified.resourcePath);
  }
  if (paths.length === 0)
    throw new CoreError(
      "BAD_REQUEST",
      "that commit did not delete a resource of that type",
    );
  return paths;
}

/** The deleted path whose committed content carries the requested identity. */
export async function locateDeletedDocument(
  repo: ProjectRepoReader,
  operation: ContentRestoreOperation,
): Promise<{ path: string; file: ReturnType<typeof parseDocumentFile> }> {
  for (const path of await deletedResourcePaths(repo, operation)) {
    try {
      const file = parseDocumentFile(
        await repo.showFileAt(operation.sourceSha, path),
        documentKindOfPath(path),
      );
      if (file.meta.id === operation.resourceId) return { path, file };
    } catch {
      continue;
    }
  }
  throw new CoreError(
    "NOT_FOUND",
    "that revision does not contain the requested document",
  );
}

/** The deleted table directory whose committed schema carries the identity. */
export async function locateDeletedTable(
  repo: ProjectRepoReader,
  operation: ContentRestoreOperation,
): Promise<{ dir: string; schema: SchemaFile; rows: TableRow[] }> {
  for (const dir of await deletedResourcePaths(repo, operation)) {
    try {
      const schema = parseSchemaFile(
        await repo.showFileAt(operation.sourceSha, `${dir}/schema.json`),
      );
      if (schema.id !== operation.resourceId) continue;
      const rows = parseRows(
        await repo.showFileAt(operation.sourceSha, `${dir}/data.jsonl`),
      );
      return { dir, schema, rows };
    } catch {
      continue;
    }
  }
  throw new CoreError(
    "NOT_FOUND",
    "that revision does not contain the requested table",
  );
}

/** A recovery lands the item back where it was, so an ancestor folder that was
 * deleted with it is recreated in the same commit. Concept §7.3 names empty
 * folder recreation as sufficient; without it both writers' create paths
 * refuse the recovery outright. */
async function ensureRecoveryFolder(
  repo: ProjectRepoWriter,
  folderPath: string[],
  scope: FolderScope,
): Promise<void> {
  if (folderPath.length === 0) return;
  try {
    assertSafeSegments(folderPath);
    if (scope === "documents") assertOutsideTablesRoot(folderPath);
  } catch {
    throw new CoreError("BAD_REQUEST", "invalid folder path");
  }
  const rel =
    scope === "tables"
      ? [TABLES_ROOT, ...folderPath].join("/")
      : folderPath.join("/");
  if (await repo.fileExistsInWorktree(rel)) return;
  await repo.ensureFolder(rel);
}

/** Recovers an absent table at its original identity from sourceSha. */
async function recoverDeletedTableInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: ContentRestoreOperation,
  author: EnrichedActor,
  options: ApplyOperationOptions,
): Promise<AppliedOperation> {
  const { dir, schema, rows } = await locateDeletedTable(repo, operation);
  await ensureRecoveryFolder(repo, folderPathOfTableDir(dir), "tables");
  const result = await writeTableInRepo(
    db,
    repo,
    operation.projectId,
    {
      kind: "create",
      id: schema.id,
      folderPath: folderPathOfTableDir(dir),
      title: schema.title,
      columns: schema.columns,
      rows,
      createdAt: schema.created,
      ...(schema.appearance ? { appearance: schema.appearance } : {}),
    },
    author,
    {
      operation: "restore",
      sourceCommitSha: operation.sourceSha,
      operationId: options.operationId,
      mcpRequestHash: options.mcpRequestHash,
      mcpToolName: options.mcpToolName,
      runId: options.runId,
    },
  );
  return {
    commitSha: result.headCommitSha,
    resourceId: result.id,
    path: result.path,
  };
}

/** A recovered document's images, read from the revision it is restored from;
 * the writer commits them with the document so one operation is one commit. */
async function deletedDocumentAssets(
  repo: ProjectRepoReader,
  operation: ContentRestoreOperation,
  oldDocPath: string,
): Promise<DocumentAssetFile[]> {
  const from = assetsDirForDocPath(oldDocPath);
  const assets: DocumentAssetFile[] = [];
  for (const file of await repo.listTrackedFiles(operation.sourceSha)) {
    if (!file.startsWith(`${from}/`)) continue;
    const name = file.slice(from.length + 1);
    if (
      name
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
    )
      continue;
    const blob = await repo.readCommittedBlobAt(
      operation.sourceSha,
      file,
      MAX_SERVED_BLOB_BYTES,
    );
    // The writer rewrites this document's links onto the new slug, so skipping
    // an unreadable asset would commit a link to a file nothing ever writes.
    if (!blob)
      throw new CoreError(
        "BAD_REQUEST",
        `cannot recover the image ${file}: it is unreadable at that revision or larger than the ${MAX_SERVED_BLOB_BYTES}-byte limit`,
      );
    assets.push({ name, bytes: blob.bytes });
  }
  return assets;
}

/** Writes an absent resource back at its original identity (concept §7.3). */
async function recoverDeletedInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: ContentRestoreOperation,
  author: EnrichedActor,
  options: ApplyOperationOptions,
): Promise<AppliedOperation> {
  // Unfiltered by project: an id that is live anywhere would be duplicated.
  const live = await db.document.findFirst({
    where: { id: operation.resourceId },
    select: { id: true },
  });
  const liveTable = await db.dataTable.findFirst({
    where: { id: operation.resourceId },
    select: { id: true },
  });
  if (live || liveTable || (await liveRestoreTarget(db, repo, operation)))
    throw new CoreError(
      "BAD_REQUEST",
      "that identity is already live; use mode=version to roll it back",
    );
  if (operation.resourceType === "table")
    return recoverDeletedTableInRepo(db, repo, operation, author, options);
  const { path, file } = await locateDeletedDocument(repo, operation);
  await ensureRecoveryFolder(repo, path.split("/").slice(0, -1), "documents");
  const kind = documentKindOfPath(path);
  const result = await writeDocumentInRepo(
    db,
    repo,
    operation.projectId,
    {
      kind: "create",
      id: file.meta.id,
      folderPath: path.split("/").slice(0, -1),
      title: file.meta.title,
      content:
        kind === "markdown"
          ? { kind: "markdown", contentJson: parseDocumentBody(file.body) }
          : { kind: "python", text: file.body },
      createdAt: file.meta.created,
      ...(file.meta.appearance ? { appearance: file.meta.appearance } : {}),
      ...(file.meta.properties ? { properties: file.meta.properties } : {}),
      // A review block-less file restarts its review clock at recovery time.
      ...(file.meta.review || !file.meta.properties?.reviewExempt
        ? {
            review:
              file.meta.review ??
              (await defaultReviewForFolderInRepo(db, repo, {
                projectId: operation.projectId,
                path: path.split("/").slice(0, -1),
                now: new Date().toISOString(),
              })),
          }
        : {}),
      // The writer allocates the slug, so it also rewrites the document's own
      // asset links onto it and commits the blobs in the same commit.
      ...(DOCUMENT_KINDS[kind].supportsImages && {
        assets: await deletedDocumentAssets(repo, operation, path),
        assetsFromSlug: documentSlugFromPath(path),
      }),
    },
    author,
    {
      operation: "restore",
      sourceCommitSha: operation.sourceSha,
      operationId: options.operationId,
      mcpRequestHash: options.mcpRequestHash,
      mcpToolName: options.mcpToolName,
      runId: options.runId,
    },
  );
  return {
    commitSha: result.headCommitSha,
    resourceId: result.id,
    path: result.path,
  };
}

async function resolveAuthor(
  db: PrismaClient,
  projectId: string,
  input: NonNullable<DocumentMetadataInput["createdBy"]>,
  field: string,
): Promise<DocumentAuthor> {
  if ("name" in input) {
    const name = input.name.trim();
    try {
      assertAuthorName(name);
    } catch (error) {
      if (error instanceof FrontmatterError)
        throw new CoreError("BAD_REQUEST", `${field} name must be one line`, {
          field,
        });
      throw error;
    }
    return { id: null, name };
  }
  const member = await db.member.findFirst({
    where: {
      userId: input.userId,
      organization: { project: { id: projectId } },
    },
    select: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!member)
    throw new CoreError(
      "BAD_REQUEST",
      `${field} userId is not a member of this project; use { name } for an author outside Weaver`,
      { field },
    );
  return authorForUser(member.user);
}

function resolveTimestamp(value: string, field: string, now: Date): string {
  const date = new Date(value);
  if (date.getTime() > now.getTime())
    throw new CoreError("BAD_REQUEST", `${field} must not be in the future`, {
      field,
    });
  return date.toISOString();
}

/** A userId must belong to a current project member; a name is taken as written. */
export async function resolveDocumentMetadata(
  db: PrismaClient,
  projectId: string,
  input: DocumentMetadataInput | undefined,
  now = new Date(),
): Promise<DocumentMetadataOverride | undefined> {
  if (!input) return undefined;
  return {
    ...(input.created !== undefined && {
      created: resolveTimestamp(input.created, "metadata.created", now),
    }),
    ...(input.createdBy !== undefined && {
      createdBy: await resolveAuthor(
        db,
        projectId,
        input.createdBy,
        "metadata.createdBy",
      ),
    }),
    ...(input.updated !== undefined && {
      updated: resolveTimestamp(input.updated, "metadata.updated", now),
    }),
    ...(input.updatedBy !== undefined && {
      updatedBy: await resolveAuthor(
        db,
        projectId,
        input.updatedBy,
        "metadata.updatedBy",
      ),
    }),
  };
}

/** A machine author never copies from Files: references are read with a user's access. */
function machineImageContent(contentJson: JSONContent) {
  if (collectImageReferences(contentJson).length > 0)
    throw new CoreError(
      "FORBIDDEN",
      "weaver-image references are not available to this author",
    );
  return {
    content: { kind: "markdown" as const, contentJson },
    assets: [],
  };
}

/** Assets go under the title's slug; the writer moves them if it allocates another. */
async function createImages(
  db: PrismaClient,
  author: ContentWriteActor,
  operation: { projectId: string; title: string; markdown: string },
) {
  const assetsFromSlug = slugify(operation.title);
  const contentJson = parseDocumentBody(
    withoutTitleHeading(operation.markdown, operation.title),
  );
  if (hasNoUser(author)) return machineImageContent(contentJson);
  const images = await resolveImageReferences(db, author, {
    projectId: operation.projectId,
    contentJson,
    assetsSlug: assetsFromSlug,
    takenNames: new Set(),
  });
  return {
    content: { kind: "markdown" as const, contentJson: images.contentJson },
    assets: images.assets,
    assetsFromSlug,
  };
}

/** Copies referenced images in beside the ones the document already has. */
async function updateImages(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  author: ContentWriteActor,
  operation: { projectId: string; documentId: string },
  contentJson: JSONContent,
) {
  if (hasNoUser(author)) return machineImageContent(contentJson);
  const row = await db.document.findFirst({
    where: { id: operation.documentId, projectId: operation.projectId },
    select: { path: true, slug: true },
  });
  if (!row) return { content: { kind: "markdown" as const, contentJson } };
  const assetsDir = `${assetsDirForDocPath(row.path)}/`;
  const images = await resolveImageReferences(db, author, {
    projectId: operation.projectId,
    contentJson,
    assetsSlug: row.slug,
    takenNames: new Set(
      (await repo.listTrackedFiles())
        .filter((file) => file.startsWith(assetsDir))
        .map((file) => file.slice(assetsDir.length)),
    ),
  });
  return {
    content: { kind: "markdown" as const, contentJson: images.contentJson },
    assets: images.assets,
  };
}

async function documentKindOf(
  db: PrismaClient,
  projectId: string,
  documentId: string,
): Promise<DocumentKind> {
  const row = await db.document.findFirst({
    where: { id: documentId, projectId },
    select: { kind: true },
  });
  if (!row) throw new CoreError("NOT_FOUND");
  return row.kind;
}

/** A full-body edit without the title heading of the title it keeps or sets. */
async function editedBody(
  db: PrismaClient,
  operation: {
    projectId: string;
    documentId: string;
    title?: string;
    markdown: string;
  },
): Promise<string> {
  const title =
    operation.title ??
    (
      await db.document.findFirst({
        where: { id: operation.documentId, projectId: operation.projectId },
        select: { title: true },
      })
    )?.title;
  return title === undefined
    ? operation.markdown
    : withoutTitleHeading(operation.markdown, title);
}

function operationAudit(options: ApplyOperationOptions) {
  return {
    operationId: options.operationId,
    mcpRequestHash: options.mcpRequestHash,
    mcpToolName: options.mcpToolName,
    runId: options.runId,
    wikiRequestHash: options.wikiRequestHash,
    beforeCommit: options.beforeCommit,
  };
}

/** The branches a machine author may reach; `applyOperationInRepo` itself stays user-only. */
export async function applyDocumentCreate(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: Extract<ContentOperation, { kind: "document.create" }>,
  author: ContentWriteActor,
  options: ApplyOperationOptions,
): Promise<AppliedOperation> {
  const result = await writeDocumentInRepo(
    db,
    repo,
    operation.projectId,
    {
      kind: "create",
      id: createdResourceId(options.operationId),
      folderPath: operation.folderPath,
      title: operation.title,
      ...(await createImages(db, author, operation)),
      createdAt: new Date().toISOString(),
      metadata: await resolveDocumentMetadata(
        db,
        operation.projectId,
        operation.metadata,
      ),
      ...(operation.properties && { propertiesInput: operation.properties }),
    },
    author,
    {
      operation: "create",
      message: options.message,
      ...operationAudit(options),
    },
  );
  return {
    commitSha: result.headCommitSha,
    resourceId: result.id,
    path: result.path,
  };
}

export async function applyDocumentPatchOperation(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: Extract<ContentOperation, { kind: "document.patch" }>,
  author: ContentWriteActor,
  options: ApplyOperationOptions,
): Promise<AppliedOperation> {
  assertPatchHasWork(operation);
  const row = await db.document.findFirst({
    where: { id: operation.documentId, projectId: operation.projectId },
    select: { path: true },
  });
  if (!row) throw new CoreError("NOT_FOUND");
  const kind = documentKindOfPath(row.path);
  const file = parseDocumentFile(
    await repo.readFileFromWorktree(row.path),
    kind,
  );
  // Selectors were resolved against getDocumentAtSnapshot's canonical
  // text, so patch the canonical form, not the raw stored body.
  const canonical =
    kind === "python"
      ? file.body
      : serializeDocumentBody(parseDocumentBody(file.body));
  const patched = applyDocumentPatch(canonical, operation.actions, kind);
  assertPatchedMarkdownFits(patched);
  options.assertPatched?.(canonical, patched);
  const result = await writeDocumentInRepo(
    db,
    repo,
    operation.projectId,
    {
      kind: "update",
      documentId: operation.documentId,
      baseCommitSha: operation.baseCommitSha,
      title: operation.title,
      ...(kind === "python"
        ? { content: { kind: "python" as const, text: patched } }
        : await updateImages(
            db,
            repo,
            author,
            operation,
            parseDocumentBody(patched),
          )),
      changeSummary: options.summary.slice(0, 200),
      metadata: await resolveDocumentMetadata(
        db,
        operation.projectId,
        operation.metadata,
      ),
      ...(operation.properties && { propertiesInput: operation.properties }),
    },
    author,
    {
      operation: "update",
      message: options.message,
      ...operationAudit(options),
    },
  );
  return {
    commitSha: result.headCommitSha,
    resourceId: result.id,
    path: result.path,
  };
}

export async function applyFolderCreate(
  repo: ProjectRepoWriter,
  operation: ContentLifecycleOperation,
  author: Parameters<typeof createFolderInRepo>[2],
  audit: FolderAudit,
): Promise<AppliedOperation> {
  assertLifecycleShape(operation);
  const result = await createFolderInRepo(
    repo,
    { parentPath: operation.parentPath!, name: operation.name! },
    author,
    scopeForResourceType(operation.resourceType),
    audit,
  );
  return {
    commitSha: result.headCommitSha,
    resourceId: null,
    path: result.path,
  };
}

/** The one place a document or table operation becomes a commit; shared by
 * proposal acceptance and MCP direct writes so both produce identical history. */
export async function applyOperationInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  operation: ContentOperation,
  author: EnrichedActor,
  options: ApplyOperationOptions,
): Promise<AppliedOperation> {
  const audit = operationAudit(options);
  switch (operation.kind) {
    case "document.create":
      return applyDocumentCreate(db, repo, operation, author, options);
    case "document.edit": {
      const kind = await documentKindOf(
        db,
        operation.projectId,
        operation.documentId,
      );
      const result = await writeDocumentInRepo(
        db,
        repo,
        operation.projectId,
        {
          kind: "update",
          documentId: operation.documentId,
          baseCommitSha: operation.baseCommitSha,
          title: operation.title,
          ...(kind === "python"
            ? { content: { kind: "python" as const, text: operation.markdown } }
            : await updateImages(
                db,
                repo,
                author,
                operation,
                parseDocumentBody(await editedBody(db, operation)),
              )),
          changeSummary: options.summary.slice(0, 200),
          metadata: await resolveDocumentMetadata(
            db,
            operation.projectId,
            operation.metadata,
          ),
          ...(operation.properties && {
            propertiesInput: operation.properties,
          }),
        },
        author,
        { operation: "update", message: options.message, ...audit },
      );
      return {
        commitSha: result.headCommitSha,
        resourceId: result.id,
        path: result.path,
      };
    }
    case "document.patch":
      return applyDocumentPatchOperation(db, repo, operation, author, options);
    case "table.create": {
      const result = await writeTableInRepo(
        db,
        repo,
        operation.projectId,
        {
          kind: "create",
          id: createdResourceId(options.operationId),
          folderPath: operation.folderPath,
          title: operation.title,
          columns: operation.columns.map(fillColumn),
          rows: operation.rows.map(fillRow),
          createdAt: new Date().toISOString(),
        },
        author,
        { operation: "create", ...audit },
      );
      return {
        commitSha: result.headCommitSha,
        resourceId: result.id,
        path: result.path,
      };
    }
    case "table.change": {
      assertChangeHasWork(operation);
      if (!options.table)
        throw new CoreError(
          "INTERNAL_SERVER_ERROR",
          "table snapshot was not read",
        );
      const current = options.table;
      const next = applyTableChange(
        { title: current.title, columns: current.columns, rows: current.rows },
        {
          title: operation.title,
          columns: operation.columns,
          rows: operation.rows,
        },
      );
      const result = await writeTableInRepo(
        db,
        repo,
        operation.projectId,
        {
          kind: "update",
          tableId: operation.tableId,
          baseCommitSha: operation.baseCommitSha,
          title: next.title,
          columns: next.columns,
          rows: next.rows,
        },
        author,
        { operation: "update", ...audit },
      );
      return {
        commitSha: result.headCommitSha,
        resourceId: result.id,
        path: result.path,
      };
    }
    case "content.restore": {
      assertRestoreGuard(operation);
      if (operation.mode === "version") {
        const result =
          operation.resourceType === "document"
            ? await restoreDocumentInRepo(
                db,
                repo,
                {
                  projectId: operation.projectId,
                  documentId: operation.resourceId,
                  sha: operation.sourceSha,
                  expectedHeadCommitSha: operation.expectedHeadCommitSha!,
                },
                author,
                audit,
              )
            : await restoreTableInRepo(
                db,
                repo,
                {
                  projectId: operation.projectId,
                  tableId: operation.resourceId,
                  sha: operation.sourceSha,
                  expectedHeadCommitSha: operation.expectedHeadCommitSha!,
                },
                author,
                audit,
              );
        return {
          commitSha: result.headCommitSha,
          resourceId: result.id,
          path: result.path,
        };
      }
      return recoverDeletedInRepo(db, repo, operation, author, options);
    }
    case "table.schema":
    case "table.rows": {
      if (!options.table)
        throw new CoreError(
          "INTERNAL_SERVER_ERROR",
          "table snapshot was not read",
        );
      const current = options.table;
      const next =
        operation.kind === "table.schema"
          ? applyTableSchemaChanges(
              current.columns,
              current.rows,
              operation.changes,
            )
          : applyTableRowChanges(current.columns, current.rows, operation);
      const result = await writeTableInRepo(
        db,
        repo,
        operation.projectId,
        {
          kind: "update",
          tableId: operation.tableId,
          baseCommitSha: operation.baseCommitSha,
          columns: next.columns,
          rows: next.rows,
        },
        author,
        { operation: "update", ...audit },
      );
      return {
        commitSha: result.headCommitSha,
        resourceId: result.id,
        path: result.path,
      };
    }
    case "content.lifecycle": {
      // Every `!` below is justified by assertLifecycleShape, which has just
      // proved the action carries exactly these fields.
      assertLifecycleShape(operation);
      const scope = scopeForResourceType(operation.resourceType);
      switch (operation.action) {
        case "folder_create":
          return applyFolderCreate(repo, operation, author, audit);
        case "folder_rename": {
          const result = await renameFolderInRepo(
            db,
            repo,
            operation.projectId,
            { path: operation.path!, name: operation.name! },
            author,
            scope,
            audit,
          );
          return {
            commitSha: result.headCommitSha,
            resourceId: null,
            path: result.path,
          };
        }
        case "folder_move": {
          const from = operation.path!;
          const result = await moveFolderToInRepo(
            db,
            repo,
            operation.projectId,
            from,
            [...operation.newParentPath!, from.at(-1)!],
            author,
            scope,
            audit,
          );
          return {
            commitSha: result.headCommitSha,
            resourceId: null,
            path: result.path,
          };
        }
        case "folder_delete": {
          const result = await deleteFolderInRepo(
            repo,
            { path: operation.path! },
            author,
            scope,
            audit,
          );
          return {
            commitSha: result.headCommitSha,
            resourceId: null,
            path: result.path,
          };
        }
        case "item_move": {
          const result =
            operation.resourceType === "document"
              ? await moveDocumentInRepo(
                  db,
                  repo,
                  {
                    projectId: operation.projectId,
                    documentId: operation.resourceId!,
                    folderPath: operation.folderPath!,
                  },
                  author,
                  audit,
                )
              : await moveTableInRepo(
                  db,
                  repo,
                  {
                    projectId: operation.projectId,
                    tableId: operation.resourceId!,
                    folderPath: operation.folderPath!,
                  },
                  author,
                  audit,
                );
          return {
            commitSha: result.headCommitSha,
            resourceId: result.id,
            path: result.path,
          };
        }
        case "item_delete": {
          const result =
            operation.resourceType === "document"
              ? await deleteDocumentInRepo(
                  db,
                  repo,
                  {
                    projectId: operation.projectId,
                    documentId: operation.resourceId!,
                  },
                  author,
                  audit,
                )
              : await deleteTableInRepo(
                  db,
                  repo,
                  {
                    projectId: operation.projectId,
                    tableId: operation.resourceId!,
                    expectedHeadCommitSha: operation.expectedHeadCommitSha!,
                  },
                  author,
                  audit,
                );
          return {
            commitSha: result.headCommitSha,
            resourceId: result.id,
            path: result.path,
          };
        }
      }
    }
  }
}

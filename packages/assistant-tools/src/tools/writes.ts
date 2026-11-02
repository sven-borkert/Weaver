import { hasCapability } from "@weaver/core/security/context";
import {
  contentOperationSchema,
  rowChangesSchema,
  schemaChangeSchema,
  type ContentOperation,
} from "@weaver/core/services/contentOperations";
import {
  applyMcpOperation,
  IDEMPOTENCY_KEY_RE,
} from "@weaver/core/services/mcpOperations";
import { z } from "zod";
import {
  defineTool,
  requireScope,
  ToolError,
  type ToolContext,
} from "../contract";

const idempotencyKey = z
  .string()
  .regex(IDEMPOTENCY_KEY_RE)
  .describe(
    "Client-generated key (8–128 of A-Z a-z 0-9 _ . : -). Retrying with the same key returns the original result instead of committing again; reusing it for a different request is a CONFLICT.",
  );
const summary = z
  .string()
  .refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value),
    "summary must not contain control characters",
  )
  .trim()
  .min(1)
  .max(500)
  .describe("One sentence recorded as the change summary in history.");
const sha = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/)
  .describe(
    "commitSha returned by read_document/get_table for the same resource; the write is refused if it moved.",
  );

async function write(
  ctx: ToolContext,
  toolName: string,
  key: string,
  operation: ContentOperation,
  text: string,
) {
  if (!hasCapability(ctx.actor, "content:write"))
    throw new ToolError("FORBIDDEN", "not permitted");
  requireScope(ctx, operation.projectId);
  const result = await applyMcpOperation(
    ctx.db,
    { ...ctx.actor, name: ctx.profile.name, email: ctx.profile.email },
    {
      idempotencyKey: key,
      toolName,
      operation,
      summary: text,
      signal: ctx.signal,
    },
  );
  return { output: result };
}

// Look schemas up by kind, not position: the union grows as slices land, and
// a renumbered index silently picks up the next operation's shape instead.
type OperationSchemaOption = (typeof contentOperationSchema)["options"][number];

function optionFor<K extends ContentOperation["kind"]>(
  kind: K,
): Extract<OperationSchemaOption, { shape: { kind: { value: K } } }> {
  const found = contentOperationSchema.options.find(
    (option) => option.shape.kind.value === kind,
  );
  if (!found) throw new Error(`no operation schema for kind "${kind}"`);
  return found as Extract<
    OperationSchemaOption,
    { shape: { kind: { value: K } } }
  >;
}

const docCreate = optionFor("document.create").omit({ kind: true });
const docEdit = optionFor("document.edit").omit({ kind: true });
const docPatch = optionFor("document.patch").omit({ kind: true });
const tableCreate = optionFor("table.create").omit({ kind: true });
const tableChange = optionFor("table.change").omit({ kind: true });
const contentRestore = optionFor("content.restore").omit({ kind: true });
const contentLifecycle = optionFor("content.lifecycle").omit({ kind: true });

export const createDocumentTool = defineTool({
  name: "create_document",
  kind: "write",
  capability: "content:write",
  description:
    "Create a Markdown document directly (no review). folderPath must be an existing folder from list_content_folders, or [] for the project root; folders are never created implicitly. Requires content:write, an explicit projectId, and an idempotencyKey. Cross-reference pages as [Title](weaver://document/<id>) or weaver://table/<id> with ids from tools.",
  inputSchema: docCreate.extend({ idempotencyKey, summary }),
  execute: ({ idempotencyKey: key, summary: text, ...operation }, ctx) =>
    write(
      ctx,
      "create_document",
      key,
      { kind: "document.create", ...operation },
      text,
    ),
});

export const updateDocumentTool = defineTool({
  name: "update_document",
  kind: "write",
  capability: "content:write",
  description:
    "Replace a document's body (Markdown, or the full source text of a Python file), and optionally its title, directly. Provide the full new body and the commitSha you read. Cross-reference pages as [Title](weaver://document/<id>) or weaver://table/<id> with ids from tools.",
  inputSchema: docEdit.extend({ baseCommitSha: sha, idempotencyKey, summary }),
  execute: ({ idempotencyKey: key, summary: text, ...operation }, ctx) =>
    write(
      ctx,
      "update_document",
      key,
      { kind: "document.edit", ...operation },
      text,
    ),
});

export const createTableTool = defineTool({
  name: "create_table",
  kind: "write",
  capability: "content:write",
  description:
    "Create a table with typed columns and initial rows directly. folderPath must be an existing table folder from list_content_folders, or [] for the root; folders are never created implicitly.",
  inputSchema: tableCreate.extend({ idempotencyKey, summary }),
  execute: ({ idempotencyKey: key, summary: text, ...operation }, ctx) =>
    write(
      ctx,
      "create_table",
      key,
      { kind: "table.create", ...operation },
      text,
    ),
});

export const updateTableSchemaTool = defineTool({
  name: "update_table_schema",
  kind: "write",
  capability: "content:write",
  description: "Add, rename, or remove table columns directly.",
  inputSchema: z.object({
    projectId: z.uuid(),
    tableId: z.uuid(),
    baseCommitSha: sha,
    changes: z.array(schemaChangeSchema).min(1).max(100),
    idempotencyKey,
    summary,
  }),
  execute: ({ idempotencyKey: key, summary: text, ...operation }, ctx) =>
    write(
      ctx,
      "update_table_schema",
      key,
      { kind: "table.schema", ...operation },
      text,
    ),
});

export const updateTableRowsTool = defineTool({
  name: "update_table_rows",
  kind: "write",
  capability: "content:write",
  description:
    "Insert, update (by row id, cells merged), or delete table rows directly.",
  inputSchema: z
    .object({
      projectId: z.uuid(),
      tableId: z.uuid(),
      baseCommitSha: sha,
      idempotencyKey,
      summary,
    })
    .extend(rowChangesSchema.shape),
  execute: ({ idempotencyKey: key, summary: text, ...operation }, ctx) =>
    write(
      ctx,
      "update_table_rows",
      key,
      { kind: "table.rows", ...operation },
      text,
    ),
});

export const patchDocumentTool = defineTool({
  name: "patch_document",
  kind: "write",
  capability: "content:write",
  description:
    "Apply a small, exact document change directly: replace literal text, insert around an anchor, or replace/remove a section from navigate_document. Works on Python files too (plain text; section ids come from navigate_document's def/class outline). Cross-reference pages as [Title](weaver://document/<id>) or weaver://table/<id> with ids from tools.",
  inputSchema: docPatch.extend({ baseCommitSha: sha, idempotencyKey, summary }),
  execute: ({ summary: text, idempotencyKey: key, ...operation }, ctx) =>
    write(
      ctx,
      "patch_document",
      key,
      { kind: "document.patch", ...operation },
      text,
    ),
});

export const changeTableTool = defineTool({
  name: "change_table",
  kind: "write",
  capability: "content:write",
  description:
    "Apply one coherent table change directly: title, columns, select options and rows together, committed as a single revision.",
  inputSchema: tableChange.extend({
    baseCommitSha: sha,
    idempotencyKey,
    summary,
  }),
  execute: ({ summary: text, idempotencyKey: key, ...operation }, ctx) =>
    write(
      ctx,
      "change_table",
      key,
      { kind: "table.change", ...operation },
      text,
    ),
});

export const restoreContentTool = defineTool({
  name: "restore_content",
  kind: "write",
  capability: "content:write",
  description:
    "Restore a document or table to an earlier version, or recover one that was deleted, directly. A version restore (mode=version) needs expectedHeadCommitSha; a deleted recovery (mode=deleted) needs deletedAtSha. Get sourceSha and both guard shas from content_history.",
  inputSchema: contentRestore.extend({ idempotencyKey, summary }),
  execute: ({ summary: text, idempotencyKey: key, ...operation }, ctx) =>
    write(
      ctx,
      "restore_content",
      key,
      { kind: "content.restore", ...operation },
      text,
    ),
});

export const applyContentLifecycleTool = defineTool({
  name: "apply_content_lifecycle",
  kind: "write",
  capability: "content:write",
  description:
    "Apply one organization change directly: create, rename, move or delete an empty folder, or move or delete a document or table. Folder actions need baseProjectCommitSha from list_content_folders; item actions need resourceId and the commitSha you read for that item. Create a folder only when the user asked for it, before writing into it. Folder deletion is never recursive — empty the folder first.",
  inputSchema: contentLifecycle.extend({ idempotencyKey, summary }),
  execute: ({ summary: text, idempotencyKey: key, ...operation }, ctx) =>
    write(
      ctx,
      "apply_content_lifecycle",
      key,
      { kind: "content.lifecycle", ...operation },
      text,
    ),
});

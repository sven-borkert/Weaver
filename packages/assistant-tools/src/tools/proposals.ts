import { hasCapability } from "@weaver/core/security/context";
import {
  createProposal,
  proposalOperationSchema,
  type ProposalOperation,
} from "@weaver/core/services/assistantProposals";
import type { ExamProposalOperationInput } from "@weaver/core/services/examProposals";
import { z } from "zod";
import {
  defineTool,
  requireScope,
  ToolError,
  type ToolContext,
} from "../contract";

export const summary = z
  .string()
  .refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value),
    "summary must not contain control characters",
  )
  .trim()
  .min(1)
  .max(500)
  .describe("One sentence the user will see before accepting.");
const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .describe(
    "commitSha returned by read_document/get_table for the same resource",
  );

export async function propose(
  ctx: ToolContext,
  operation:
    z.infer<typeof proposalOperationSchema> | ExamProposalOperationInput,
  text: string,
) {
  if (!ctx.run)
    throw new ToolError(
      "FORBIDDEN",
      "proposals require an assistant conversation run",
    );
  if (!hasCapability(ctx.actor, "content:propose"))
    throw new ToolError("FORBIDDEN", "not permitted");
  requireScope(ctx, operation.projectId);
  const proposal = await createProposal(ctx.db, ctx.actor, {
    conversationId: ctx.run.conversationId,
    runId: ctx.run.runId,
    attemptId: ctx.run.attemptId,
    summary: text,
    operation,
  });
  return {
    output: {
      proposalId: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      resourceId: proposal.resourceId,
      resolution: proposal.resolution,
      summary: proposal.summary,
      expiresAt: proposal.expiresAt.toISOString(),
    },
  };
}

// Look schemas up by kind, not position: the union grows as slices land, and
// a renumbered index silently picks up the next operation's shape instead.
type OperationSchemaOption =
  (typeof proposalOperationSchema)["options"][number];

function optionFor<K extends ProposalOperation["kind"]>(
  kind: K,
): Extract<OperationSchemaOption, { shape: { kind: { value: K } } }> {
  const found = proposalOperationSchema.options.find(
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

export const proposeDocumentCreateTool = defineTool({
  name: "propose_document_create",
  kind: "propose",
  capability: "content:propose",
  description:
    "Propose a new Markdown document. folderPath is an existing folder from list_content_folders, or [] for the project root. Weaver applies it if the user enabled auto-approve; otherwise it awaits review. Check the returned status.",
  inputSchema: docCreate.extend({ summary }),
  execute: ({ summary: text, ...operation }, ctx) =>
    propose(ctx, { kind: "document.create", ...operation }, text),
});

export const proposeDocumentEditTool = defineTool({
  name: "propose_document_edit",
  kind: "propose",
  capability: "content:propose",
  description:
    "Propose replacing a document's Markdown body (and optionally its title). Provide the full new body and the commitSha you read.",
  inputSchema: docEdit.extend({ baseCommitSha: sha, summary }),
  execute: ({ summary: text, ...operation }, ctx) =>
    propose(ctx, { kind: "document.edit", ...operation }, text),
});

export const proposeTableCreateTool = defineTool({
  name: "propose_table_create",
  kind: "propose",
  capability: "content:propose",
  description:
    "Propose a new table with typed columns and initial rows. folderPath is an existing table folder from list_content_folders, or [] for the root.",
  inputSchema: tableCreate.extend({ summary }),
  execute: ({ summary: text, ...operation }, ctx) =>
    propose(ctx, { kind: "table.create", ...operation }, text),
});

export const proposeDocumentPatchTool = defineTool({
  name: "propose_document_patch",
  kind: "propose",
  capability: "content:propose",
  description:
    "Propose a small, exact document change: replace literal text, insert around an anchor, or replace/remove a section from navigate_document. Prefer this over propose_document_edit; only unchanged text is preserved automatically.",
  inputSchema: docPatch.extend({ baseCommitSha: sha, summary }),
  execute: ({ summary: text, ...operation }, ctx) =>
    propose(ctx, { kind: "document.patch", ...operation }, text),
});

export const proposeTableChangeTool = defineTool({
  name: "propose_table_change",
  kind: "propose",
  capability: "content:propose",
  description:
    "Propose one coherent table change: title, columns, select options and rows together, committed as a single revision. Row updates use set to assign cells and clear to remove them.",
  inputSchema: tableChange.extend({ baseCommitSha: sha, summary }),
  execute: ({ summary: text, ...operation }, ctx) =>
    propose(ctx, { kind: "table.change", ...operation }, text),
});

export const proposeContentRestoreTool = defineTool({
  name: "propose_content_restore",
  kind: "propose",
  capability: "content:propose",
  description:
    "Propose restoring a document or table to an earlier version, or recovering one that was deleted. A version restore (mode=version) needs expectedHeadCommitSha; a deleted recovery (mode=deleted) needs deletedAtSha. Get sourceSha and both guard shas from content_history.",
  inputSchema: contentRestore.extend({ summary }),
  execute: ({ summary: text, ...operation }, ctx) =>
    propose(ctx, { kind: "content.restore", ...operation }, text),
});

export const proposeContentLifecycleTool = defineTool({
  name: "propose_content_lifecycle",
  kind: "propose",
  capability: "content:propose",
  description:
    "Propose one organization change: create, rename, move or delete an empty folder, or move or delete a document or table. Folder actions need baseProjectCommitSha from list_content_folders; item actions need resourceId and the commitSha you read for that item. Propose a new folder only when the user asked for it. Folder deletion is never recursive — empty the folder first. Always awaits review.",
  inputSchema: contentLifecycle.extend({ summary }),
  execute: ({ summary: text, ...operation }, ctx) =>
    propose(ctx, { kind: "content.lifecycle", ...operation }, text),
});

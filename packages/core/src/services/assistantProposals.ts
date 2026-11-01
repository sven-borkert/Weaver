import { assertLiveAssistantPrincipal } from "../assistant/principal";
import { diffLines } from "diff";
import { openProjectRepo } from "@weaver/git-store";
import type {
  AssistantProposal,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import { scopeSnapshotSchema } from "../assistant/scopeSchema";
import { boundedJson } from "../assistant/events";
import { withoutTitleHeading } from "../documents/importMarkdown";
import { applyDocumentPatch } from "../documents/patch";
import { parseDocumentBody, serializeDocumentBody } from "../editor/markdown";
import { CoreError, isCoreError } from "../errors";
import type { SecurityContext } from "../security/context";
import { applyTableChange } from "../tables/change";
import { diffTables } from "../tables/diff";
import {
  assertAssistantUse,
  requireOwnedConversation,
} from "./assistantConversations";
import {
  applyOperationInRepo,
  applyTableRowChanges,
  applyTableSchemaChanges,
  assertChangeHasWork,
  assertLifecycleShape,
  assertPatchedMarkdownFits,
  assertPatchHasWork,
  assertRestoreGuard,
  assertValidRows,
  checkOperationBase,
  contentOperationSchema,
  fillColumn,
  fillRow,
  fillSelectOption,
  findCommitByOperationId,
  isFolderLifecycleAction,
  locateDeletedDocument,
  locateDeletedTable,
  patchActionSchema,
  resolveDocumentMetadata,
  recoverPriorOperation,
  rowChangesSchema,
  schemaChangeSchema,
  tableColumnChangeSchema,
  tableRowChangesSchema,
  type AppliedOperation,
  type ContentOperation,
  type LifecycleAction,
  type RowChanges,
  type SchemaChange,
} from "./contentOperations";
import { slugify } from "../documents/slug";
import { TABLES_ROOT } from "../tables/paths";
import {
  documentContentText,
  getDocument,
  getDocumentAtSnapshot,
  type EnrichedActor,
} from "./documents";
import {
  applyExamProposalInTx,
  examProposalOperationSchema,
  isExamProposalKind,
  prepareExamProposal,
  type ExamProposalKind,
  type ExamProposalOperation,
  type ExamProposalOperationInput,
} from "./examProposals";
import { listContentFolders, scopeForResourceType } from "./folders";
import { assertProjectRole, resolveProjectAccess } from "./projectAccess";
import { assertTrainer } from "./projectTraining";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";
import { checkImageReferences } from "./documentImageImports";
import { getTable, getTableAtSnapshot } from "./tables";

// Compatibility surface for callers that predate contentOperations.ts.
export {
  applyTableRowChanges,
  applyTableSchemaChanges,
  patchActionSchema,
  rowChangesSchema,
  schemaChangeSchema,
  tableColumnChangeSchema,
  tableRowChangesSchema,
  type RowChanges,
  type SchemaChange,
};
export const proposalOperationSchema = contentOperationSchema;
export type ProposalOperation = ContentOperation;

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Only ordinary content edits may auto-apply. Lifecycle operations
 * (restore, and the deletes and moves a later slice adds) always await
 * review, and an unrecognised kind defaults to review rather than
 * silently joining an existing auto-approve grant (concept §9).
 */
const AUTO_APPROVABLE_KINDS = new Set<
  ContentOperation["kind"] | ExamProposalKind
>([
  "exam.create",
  "exam.update",
  "document.create",
  "document.edit",
  "document.patch",
  "table.create",
  "table.schema",
  "table.rows",
  "table.change",
]);

export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PREVIEW_LINES = 2_000;
/**
 * A preview must be able to show a whole change the user is asked to approve,
 * so it is sized against what an operation can actually apply
 * (`MAX_MARKDOWN_CHARS` on each side of a diff, plus per-line JSON overhead) —
 * not against the much smaller SSE event frame budget. `MAX_PREVIEW_LINES` is
 * the intended limiter; char truncation is a backstop, not an ordinary path.
 */
const MAX_PREVIEW_CHARS = 500_000;
const MAX_SAMPLE_ROWS = 20;

/**
 * What the proposal is, as the UI reads it: the operation kind, except a
 * restore, which carries its resource type so a table restore never renders
 * or links as a document. The stored operation keeps the plain kind.
 */
export type ProposalKind =
  | Exclude<ProposalOperation["kind"], "content.restore" | "content.lifecycle">
  | ExamProposalKind
  | "content.restore.document"
  | "content.restore.table"
  | `content.lifecycle.folder_${"create" | "rename" | "move" | "delete"}`
  | `content.lifecycle.item_${"move" | "delete"}.${"document" | "table"}`;

export function proposalKind(operation: ProposalOperation): ProposalKind {
  if (operation.kind === "content.restore")
    return `content.restore.${operation.resourceType}` as const;
  if (operation.kind === "content.lifecycle")
    return isFolderLifecycleAction(operation.action)
      ? (`content.lifecycle.${operation.action}` as ProposalKind)
      : (`content.lifecycle.${operation.action}.${operation.resourceType}` as ProposalKind);
  return operation.kind;
}

export type ProposalView = {
  id: string;
  conversationId: string;
  runId: string;
  projectId: string;
  kind: ProposalKind;
  resourceId: string | null;
  baseCommitSha: string | null;
  summary: string;
  preview: unknown;
  status: AssistantProposal["status"];
  /** Git-backed proposals commit; exam proposals record the exam revision they wrote. */
  resolution: { commitSha?: string; revision?: number; reason?: string } | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
};

type Resolution = NonNullable<ProposalView["resolution"]>;

function toView(
  row: Omit<AssistantProposal, "operation" | "preview"> & {
    preview?: Prisma.JsonValue;
  },
): ProposalView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    runId: row.runId,
    projectId: row.projectId,
    kind: row.kind as ProposalKind,
    resourceId: row.resourceId,
    baseCommitSha: row.baseCommitSha,
    summary: row.summary,
    preview: row.preview ?? null,
    status: row.status,
    resolution: (row.resolution as ProposalView["resolution"]) ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
  };
}

function linePreview(from: string, to: string) {
  const lines = diffLines(from, to).flatMap((part) => {
    const type = part.added ? "add" : part.removed ? "del" : "same";
    return part.value
      .split("\n")
      .filter((line, index, all) => index < all.length - 1 || line.length > 0)
      .map((text) => ({ type, text }));
  });
  return {
    kind: "document" as const,
    lines: lines.slice(0, MAX_PREVIEW_LINES),
    truncated: lines.length > MAX_PREVIEW_LINES,
  };
}

/**
 * Fill generated ids so the persisted operation is exactly what acceptance
 * applies — the preview a user approves must not drift from the write.
 */
function normalizeOperation(operation: ProposalOperation): ProposalOperation {
  switch (operation.kind) {
    case "table.create":
      return {
        ...operation,
        columns: operation.columns.map(fillColumn),
        rows: operation.rows.map(fillRow),
      };
    case "table.schema":
      return {
        ...operation,
        changes: operation.changes.map((change) =>
          change.op === "add"
            ? { op: "add" as const, column: fillColumn(change.column) }
            : change,
        ),
      };
    case "table.rows":
      return { ...operation, inserts: operation.inserts.map(fillRow) };
    case "table.change":
      // applyTableChange mints ids for id-less added columns, added options
      // and inserted rows; without this the preview would show one set of ids
      // and acceptance would commit another.
      return {
        ...operation,
        columns: operation.columns.map((change) => {
          if (change.op === "add")
            return { op: "add" as const, column: fillColumn(change.column) };
          if (change.op === "option_add")
            return { ...change, option: fillSelectOption(change.option) };
          return change;
        }),
        rows: {
          ...operation.rows,
          inserts: operation.rows.inserts.map(fillRow),
        },
      };
    // content.restore needs no case: it generates no ids.
    default:
      return operation;
  }
}

const isExamOperation = (
  operation: ProposalOperation | ExamProposalOperation,
): operation is ExamProposalOperation => isExamProposalKind(operation.kind);

type Prepared = {
  resourceId: string | null;
  baseCommitSha: string | null;
  preview: unknown;
};

type ProposalFolderField =
  "folderPath" | "parentPath" | "newParentPath" | "path";

/** Folder fields the writers require to exist at acceptance; sibling
 * collisions and folder emptiness stay with the writer. */
const LIFECYCLE_FOLDER_FIELDS: Record<
  LifecycleAction,
  readonly ProposalFolderField[]
> = {
  folder_create: ["parentPath"],
  folder_rename: ["path"],
  folder_move: ["path", "newParentPath"],
  folder_delete: ["path"],
  item_move: ["folderPath"],
  item_delete: [],
};

/** The writers refuse an absent folder at acceptance; refusing here lets the model correct itself. */
export function assertProposalFolderListed(
  listed: ReadonlySet<string>,
  field: ProposalFolderField,
  folderPath: string[],
): void {
  if (folderPath.length === 0 || listed.has(folderPath.join("/"))) return;
  const waysOut = [
    "use a path from list_content_folders",
    field === "folderPath"
      ? "omit folderPath for the project root"
      : field === "path"
        ? null
        : `use [] for the root`,
    field === "path"
      ? null
      : "create the folder first with propose_content_lifecycle and wait until it is accepted",
  ].filter((way) => way !== null);
  throw new CoreError(
    "BAD_REQUEST",
    `${field} names a folder that does not exist; ${waysOut.join(", or ")}`,
    { field },
  );
}

async function listedProposalFolders(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
  resourceType: "document" | "table",
): Promise<ReadonlySet<string>> {
  const { folders } = await listContentFolders(
    db,
    { projectId, resourceType },
    actor,
  );
  return new Set(folders.map((folder) => folder.path.join("/")));
}

async function assertProposalFolderExists(
  db: PrismaClient,
  actor: SecurityContext,
  operation: { projectId: string; folderPath: string[] },
  resourceType: "document" | "table",
): Promise<void> {
  if (operation.folderPath.length === 0) return;
  assertProposalFolderListed(
    await listedProposalFolders(db, actor, operation.projectId, resourceType),
    "folderPath",
    operation.folderPath,
  );
}

/** Explicit metadata is validated at proposal time and shown on the approval
 *  card, so a reviewer sees a backdated or re-attributed document. */
async function metadataPreviewLines(
  db: PrismaClient,
  operation: Extract<
    ProposalOperation,
    { kind: "document.create" | "document.edit" | "document.patch" }
  >,
): Promise<Array<{ type: "add"; text: string }>> {
  const metadata = await resolveDocumentMetadata(
    db,
    operation.projectId,
    operation.metadata,
  );
  if (!metadata) return [];
  return [
    metadata.created && `Created: ${metadata.created}`,
    metadata.createdBy && `Created by: ${metadata.createdBy.name}`,
    metadata.updated && `Updated: ${metadata.updated}`,
    metadata.updatedBy && `Updated by: ${metadata.updatedBy.name}`,
  ]
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ type: "add" as const, text }));
}

/** Checks the references with the proposer's access; the bytes are copied at acceptance. */
async function imagePreviewLines(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
  markdown: string,
): Promise<Array<{ type: "add"; text: string }>> {
  const { images } = await checkImageReferences(db, actor, {
    projectId,
    contentJson: parseDocumentBody(markdown),
  });
  if (!images) return [];
  return [{ type: "add", text: `Images: ${images} copied into the document` }];
}

/** Resolves the target's current revision and builds the bounded preview;
 * throws BAD_REQUEST when the model's base is already stale. */
async function prepare(
  db: PrismaClient,
  actor: SecurityContext,
  operation: ProposalOperation,
): Promise<Prepared> {
  switch (operation.kind) {
    case "document.create": {
      await assertProposalFolderExists(db, actor, operation, "document");
      const markdown = withoutTitleHeading(operation.markdown, operation.title);
      const body = linePreview("", markdown);
      return {
        resourceId: null,
        baseCommitSha: null,
        preview: boundedJson(
          {
            ...body,
            lines: [
              ...(await metadataPreviewLines(db, operation)),
              ...(await imagePreviewLines(
                db,
                actor,
                operation.projectId,
                markdown,
              )),
              ...body.lines,
            ].slice(0, MAX_PREVIEW_LINES),
          },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
    case "document.edit": {
      const current = await getDocument(
        db,
        { projectId: operation.projectId, documentId: operation.documentId },
        actor,
      );
      if (current.baseCommitSha !== operation.baseCommitSha)
        throw new CoreError(
          "BAD_REQUEST",
          "stale base revision; re-read the document",
          { field: "baseCommitSha" },
        );
      const markdown =
        current.kind === "python"
          ? operation.markdown
          : withoutTitleHeading(
              operation.markdown,
              operation.title ?? current.title,
            );
      const body = linePreview(documentContentText(current.content), markdown);
      return {
        resourceId: current.id,
        baseCommitSha: current.baseCommitSha,
        preview: boundedJson(
          {
            ...body,
            lines: [
              ...(await metadataPreviewLines(db, operation)),
              ...(await imagePreviewLines(
                db,
                actor,
                operation.projectId,
                markdown,
              )),
              ...body.lines,
            ].slice(0, MAX_PREVIEW_LINES),
          },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
    case "document.patch": {
      assertPatchHasWork(operation);
      const current = await getDocument(
        db,
        { projectId: operation.projectId, documentId: operation.documentId },
        actor,
      );
      if (current.baseCommitSha !== operation.baseCommitSha)
        throw new CoreError(
          "BAD_REQUEST",
          "stale base revision; re-read the document",
          { field: "baseCommitSha", reason: "STALE_BASE" },
        );
      const before = documentContentText(current.content);
      // Resolving here surfaces an ambiguous selector at proposal time
      // rather than at acceptance, and the preview shows the real result.
      const patched = applyDocumentPatch(
        before,
        operation.actions,
        current.kind,
      );
      assertPatchedMarkdownFits(patched);
      // Design §5.5: show the representation the commit will actually store.
      const after =
        current.kind === "python"
          ? patched
          : serializeDocumentBody(parseDocumentBody(patched));
      const body = linePreview(before, after);
      // A title-only patch has no body diff, so the rename would otherwise be
      // invisible on the approval card.
      const titleLines =
        operation.title !== undefined && operation.title !== current.title
          ? [
              { type: "del" as const, text: `Title: ${current.title}` },
              { type: "add" as const, text: `Title: ${operation.title}` },
            ]
          : [];
      return {
        resourceId: current.id,
        baseCommitSha: current.baseCommitSha,
        preview: boundedJson(
          {
            ...body,
            lines: [
              ...titleLines,
              ...(await metadataPreviewLines(db, operation)),
              ...(await imagePreviewLines(
                db,
                actor,
                operation.projectId,
                patched,
              )),
              ...body.lines,
            ].slice(0, MAX_PREVIEW_LINES),
          },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
    case "table.create": {
      await assertProposalFolderExists(db, actor, operation, "table");
      const columns = operation.columns.map(fillColumn);
      const rows = operation.rows.map(fillRow);
      assertValidRows(columns, rows);
      return {
        resourceId: null,
        baseCommitSha: null,
        preview: boundedJson(
          {
            kind: "table",
            columns,
            rowCount: rows.length,
            sampleRows: rows.slice(0, MAX_SAMPLE_ROWS),
          },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
    case "table.change": {
      assertChangeHasWork(operation);
      const current = await getTable(
        db,
        { projectId: operation.projectId, tableId: operation.tableId },
        actor,
      );
      if (current.baseCommitSha !== operation.baseCommitSha)
        throw new CoreError(
          "BAD_REQUEST",
          "stale base revision; re-read the table",
          { field: "baseCommitSha", reason: "STALE_BASE" },
        );
      const next = applyTableChange(
        { title: current.title, columns: current.columns, rows: current.rows },
        {
          title: operation.title,
          columns: operation.columns,
          rows: operation.rows,
        },
      );
      const diff = diffTables(
        { title: current.title, columns: current.columns, rows: current.rows },
        next,
      );
      return {
        resourceId: current.id,
        baseCommitSha: current.baseCommitSha,
        preview: boundedJson(
          { kind: "table", diff, columns: next.columns },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
    case "table.schema":
    case "table.rows": {
      const current = await getTable(
        db,
        { projectId: operation.projectId, tableId: operation.tableId },
        actor,
      );
      if (current.baseCommitSha !== operation.baseCommitSha)
        throw new CoreError(
          "BAD_REQUEST",
          "stale base revision; re-read the table",
          { field: "baseCommitSha" },
        );
      const next =
        operation.kind === "table.schema"
          ? applyTableSchemaChanges(
              current.columns,
              current.rows,
              operation.changes,
            )
          : applyTableRowChanges(current.columns, current.rows, operation);
      const diff = diffTables(
        { title: current.title, columns: current.columns, rows: current.rows },
        { title: current.title, ...next },
      );
      return {
        resourceId: current.id,
        baseCommitSha: current.baseCommitSha,
        preview: boundedJson(
          { kind: "table", diff, columns: current.columns },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
    case "content.restore": {
      assertRestoreGuard(operation);
      if (operation.mode === "version") {
        if (operation.resourceType === "document") {
          const current = await getDocument(
            db,
            {
              projectId: operation.projectId,
              documentId: operation.resourceId,
            },
            actor,
          );
          const source = await getDocumentAtSnapshot(
            db,
            {
              projectId: operation.projectId,
              documentId: operation.resourceId,
              atCommitSha: operation.sourceSha,
            },
            actor,
          );
          return {
            resourceId: current.id,
            baseCommitSha: current.baseCommitSha,
            preview: boundedJson(
              linePreview(
                documentContentText(current.content),
                source.markdown,
              ),
              MAX_PREVIEW_CHARS,
            ),
          };
        }
        const current = await getTable(
          db,
          { projectId: operation.projectId, tableId: operation.resourceId },
          actor,
        );
        const source = await getTableAtSnapshot(
          db,
          {
            projectId: operation.projectId,
            tableId: operation.resourceId,
            atCommitSha: operation.sourceSha,
          },
          actor,
        );
        const diff = diffTables(
          {
            title: current.title,
            columns: current.columns,
            rows: current.rows,
          },
          { title: source.title, columns: source.columns, rows: source.rows },
        );
        return {
          resourceId: current.id,
          baseCommitSha: current.baseCommitSha,
          preview: boundedJson(
            { kind: "table", diff, columns: source.columns },
            MAX_PREVIEW_CHARS,
          ),
        };
      }
      // A recovery has no live target, so the preview reads committed content.
      await assertProjectRole(db, operation.projectId, actor, "Viewer");
      const repo = await openProjectRepo(operation.projectId);
      if (!repo) throw new CoreError("NOT_FOUND");
      if (operation.resourceType === "document") {
        const { file } = await locateDeletedDocument(repo, operation);
        return {
          resourceId: operation.resourceId,
          baseCommitSha: null,
          preview: boundedJson(linePreview("", file.body), MAX_PREVIEW_CHARS),
        };
      }
      const { schema, rows } = await locateDeletedTable(repo, operation);
      return {
        resourceId: operation.resourceId,
        baseCommitSha: null,
        preview: boundedJson(
          {
            kind: "table",
            columns: schema.columns,
            rowCount: rows.length,
            sampleRows: rows.slice(0, MAX_SAMPLE_ROWS),
          },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
    case "content.lifecycle": {
      assertLifecycleShape(operation);
      await assertProjectRole(db, operation.projectId, actor, "Viewer");
      const folderFields = LIFECYCLE_FOLDER_FIELDS[operation.action].filter(
        (field) => operation[field]!.length > 0,
      );
      if (folderFields.length > 0) {
        const listed = await listedProposalFolders(
          db,
          actor,
          operation.projectId,
          operation.resourceType,
        );
        for (const field of folderFields)
          assertProposalFolderListed(listed, field, operation[field]!);
      }
      const prefix =
        scopeForResourceType(operation.resourceType) === "tables"
          ? [TABLES_ROOT]
          : [];
      const rel = (segments: string[]) => [...prefix, ...segments].join("/");
      if (isFolderLifecycleAction(operation.action)) {
        const from =
          operation.action === "folder_create" ? null : rel(operation.path!);
        const to =
          operation.action === "folder_create"
            ? rel([...operation.parentPath!, slugify(operation.name!)])
            : operation.action === "folder_rename"
              ? rel([...operation.path!.slice(0, -1), slugify(operation.name!)])
              : operation.action === "folder_move"
                ? rel([...operation.newParentPath!, operation.path!.at(-1)!])
                : null;
        // Counts come from the projection: what a reviewer needs is how much
        // rides along, not which rows (concept §7.2).
        const where = from
          ? { projectId: operation.projectId, path: { startsWith: `${from}/` } }
          : null;
        const affected = where
          ? {
              documents: await db.document.count({ where }),
              tables: await db.dataTable.count({ where }),
            }
          : { documents: 0, tables: 0 };
        return {
          resourceId: null,
          baseCommitSha: operation.baseProjectCommitSha!,
          preview: boundedJson(
            {
              kind: "lifecycle",
              action: operation.action,
              resourceType: operation.resourceType,
              from,
              to,
              title: null,
              affected,
            },
            MAX_PREVIEW_CHARS,
          ),
        };
      }
      const current =
        operation.resourceType === "document"
          ? await getDocument(
              db,
              {
                projectId: operation.projectId,
                documentId: operation.resourceId!,
              },
              actor,
            )
          : await getTable(
              db,
              {
                projectId: operation.projectId,
                tableId: operation.resourceId!,
              },
              actor,
            );
      return {
        resourceId: current.id,
        baseCommitSha: current.baseCommitSha,
        preview: boundedJson(
          {
            kind: "lifecycle",
            action: operation.action,
            resourceType: operation.resourceType,
            from: current.path,
            // The destination folder, not a final file path: the writer may
            // reallocate the slug if the name is taken there.
            to:
              operation.action === "item_move"
                ? rel(operation.folderPath!)
                : null,
            title: current.title,
            affected:
              operation.resourceType === "document"
                ? { documents: 1, tables: 0 }
                : { documents: 0, tables: 1 },
          },
          MAX_PREVIEW_CHARS,
        ),
      };
    }
  }
}

export async function createProposal(
  db: PrismaClient,
  actor: SecurityContext,
  input: {
    conversationId: string;
    runId: string;
    attemptId?: string;
    summary: string;
    operation: ProposalOperation | ExamProposalOperationInput;
  },
): Promise<ProposalView> {
  assertAssistantUse(actor);
  if (/[\x00-\x1f\x7f]/.test(input.summary))
    throw new CoreError(
      "BAD_REQUEST",
      "summary must not contain control characters",
    );
  const operation = isExamProposalKind(input.operation.kind)
    ? examProposalOperationSchema.parse(input.operation)
    : normalizeOperation(proposalOperationSchema.parse(input.operation));
  const conversation = await requireOwnedConversation(
    db,
    actor,
    input.conversationId,
  );
  const run = await db.assistantRun.findFirst({
    where: { id: input.runId, conversationId: input.conversationId },
    select: { id: true, attemptCount: true },
  });
  if (!run) throw new CoreError("NOT_FOUND");
  let prepared: Prepared;
  let kind: ProposalKind;
  if (isExamOperation(operation)) {
    prepared = {
      ...(await prepareExamProposal(db, actor, operation)),
      baseCommitSha: null,
    };
    kind = operation.kind;
  } else {
    await assertProjectRole(db, operation.projectId, actor, "Editor", {
      capability: "content:propose",
    });
    prepared = await prepare(db, actor, operation);
    kind = proposalKind(operation);
  }
  const row = await db.$transaction(async (tx) => {
    const attemptNumber = input.attemptId
      ? await requireRunningProposalAttempt(tx, input.runId, input.attemptId)
      : null;
    await tx.$queryRaw`SELECT "id" FROM "AssistantRun" WHERE "id" = ${input.runId}::uuid FOR UPDATE`;
    const current = await tx.assistantRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { status: true, attemptCount: true },
    });
    if (
      !["queued", "running"].includes(current.status) ||
      current.attemptCount !== run.attemptCount ||
      (attemptNumber !== null &&
        (current.status !== "running" ||
          current.attemptCount !== attemptNumber))
    )
      throw new CoreError(
        "CONFLICT",
        "Run attempt no longer accepts proposals",
      );
    if (
      await tx.assistantProposal.count({
        where: { runId: input.runId, status: "accepting" },
      })
    )
      throw new CoreError(
        "CONFLICT",
        "A previous change needs acceptance recovery; do not repeat it or propose further changes in this run.",
      );
    return tx.assistantProposal.create({
      data: {
        conversationId: input.conversationId,
        runId: input.runId,
        userId: actor.userId,
        projectId: operation.projectId,
        kind,
        resourceId: prepared.resourceId,
        baseCommitSha: prepared.baseCommitSha,
        summary:
          input.summary.trim().replace(/\s+/g, " ").slice(0, 500) ||
          operation.kind,
        operation,
        preview: prepared.preview as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
      },
    });
  });
  if (
    conversation.autoApproveChanges &&
    input.attemptId &&
    AUTO_APPROVABLE_KINDS.has(operation.kind)
  ) {
    const profile = await db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { name: true, email: true },
    });
    try {
      return await acceptProposalInternal(
        db,
        { ...actor, ...profile },
        row.id,
        {
          attemptCount: run.attemptCount,
          attemptId: input.attemptId,
        },
      );
    } catch (error) {
      // Preserve uncertain writes as recoverable results, not retryable tool errors.
      const current = await requireOwnedProposal(db, actor, row.id);
      if (current.status === "accepting" || current.status === "accepted")
        return toView(current);
      throw error;
    }
  }
  return toView(row);
}

async function requireRunningProposalAttempt(
  tx: Prisma.TransactionClient,
  runId: string,
  attemptId: string,
): Promise<number> {
  await tx.$queryRaw`SELECT "id" FROM "AssistantRunAttempt" WHERE "id" = ${attemptId}::uuid FOR UPDATE`;
  const attempt = await tx.assistantRunAttempt.findFirst({
    where: {
      id: attemptId,
      runId,
      status: "running",
      leaseExpiresAt: { gt: new Date() },
    },
    select: { number: true },
  });
  if (!attempt)
    throw new CoreError("CONFLICT", "Run attempt no longer accepts proposals");
  return attempt.number;
}

async function requireOwnedProposal(
  db: Db,
  actor: SecurityContext,
  proposalId: string,
): Promise<AssistantProposal> {
  assertAssistantUse(actor);
  const row = await db.assistantProposal.findFirst({
    where: { id: proposalId, userId: actor.userId },
  });
  if (!row) throw new CoreError("NOT_FOUND");
  await resolveProjectAccess(db, row.projectId, actor);
  return row;
}

export async function listProposals(
  db: PrismaClient,
  actor: SecurityContext,
  input: { conversationId: string; includePreview?: boolean },
): Promise<ProposalView[]> {
  await requireOwnedConversation(db, actor, input.conversationId);
  const rows = await db.assistantProposal.findMany({
    where: { conversationId: input.conversationId },
    orderBy: { createdAt: "asc" },
    omit: {
      operation: true,
      ...(input.includePreview === false ? { preview: true } : {}),
    },
  });
  const visible: ProposalView[] = [];
  const access = new Map<string, boolean>();
  for (const row of rows) {
    if (!access.has(row.projectId)) {
      try {
        await resolveProjectAccess(db, row.projectId, actor);
        access.set(row.projectId, true);
      } catch (error) {
        if (!isCoreError(error) || error.code !== "NOT_FOUND") throw error;
        access.set(row.projectId, false);
      }
    }
    if (access.get(row.projectId)) visible.push(toView(row));
  }
  return visible;
}

export async function getProposal(
  db: PrismaClient,
  actor: SecurityContext,
  proposalId: string,
): Promise<ProposalView> {
  return toView(await requireOwnedProposal(db, actor, proposalId));
}

async function resolve(
  db: Db,
  proposalId: string,
  status: AssistantProposal["status"],
  resolution: Resolution,
  /** Set only by an accepted create, which has no resourceId until it runs. */
  resourceId?: string,
): Promise<ProposalView> {
  return toView(
    await db.assistantProposal.update({
      where: { id: proposalId },
      data: {
        status,
        resolution,
        resolvedAt: new Date(),
        ...(resourceId === undefined ? {} : { resourceId }),
      },
    }),
  );
}

type AutomaticAcceptance = { attemptCount: number; attemptId: string };

/** Auto-approve admits only the live attempt, in its pinned or sole project, while the setting is on. */
async function admitAutomaticAcceptance(
  tx: Prisma.TransactionClient,
  actor: SecurityContext,
  proposal: Pick<AssistantProposal, "runId" | "conversationId">,
  projectId: string,
  automatic: AutomaticAcceptance,
): Promise<boolean> {
  // Match terminal transition lock order before admitting a write.
  await requireRunningProposalAttempt(tx, proposal.runId, automatic.attemptId);
  await tx.$queryRaw`SELECT "id" FROM "AssistantRun" WHERE "id" = ${proposal.runId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AssistantConversation" WHERE "id" = ${proposal.conversationId}::uuid FOR UPDATE`;
  const conversation = await requireOwnedConversation(
    tx,
    actor,
    proposal.conversationId,
  );
  const run = await tx.assistantRun.findUniqueOrThrow({
    where: { id: proposal.runId },
    select: { status: true, attemptCount: true, scopeSnapshot: true },
  });
  const projectIds = scopeSnapshotSchema.parse(run.scopeSnapshot).projectIds;
  const automaticProjectId =
    conversation.pinnedProjectId ??
    (projectIds.length === 1 ? projectIds[0] : null);
  if (
    projectId !== automaticProjectId ||
    !projectIds.includes(projectId) ||
    !conversation.autoApproveChanges ||
    run.status !== "running" ||
    run.attemptCount !== automatic.attemptCount
  )
    return false;
  await assertLiveAssistantPrincipal(tx, actor);
  return true;
}

/** Exams are database rows: claim, write and resolve commit together, so no acceptance is left to recover. */
async function acceptExamProposal(
  db: PrismaClient,
  actor: SecurityContext,
  row: AssistantProposal,
  automatic?: AutomaticAcceptance,
): Promise<ProposalView> {
  const operation = examProposalOperationSchema.parse(row.operation);
  await assertTrainer(db, operation.projectId, actor);
  return db.$transaction(async (tx) => {
    if (
      automatic &&
      !(await admitAutomaticAcceptance(
        tx,
        actor,
        row,
        operation.projectId,
        automatic,
      ))
    )
      return toView(
        await tx.assistantProposal.findUniqueOrThrow({ where: { id: row.id } }),
      );
    await tx.$queryRaw`SELECT "id" FROM "AssistantProposal" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
    const fresh = await tx.assistantProposal.findFirst({
      where: { id: row.id, userId: actor.userId },
    });
    if (!fresh) throw new CoreError("NOT_FOUND");
    if (automatic && fresh.status !== "pending") return toView(fresh);
    if (fresh.status !== "pending")
      throw new CoreError("CONFLICT", `proposal is ${fresh.status}`);
    if (fresh.expiresAt < new Date())
      return resolve(tx, fresh.id, "expired", { reason: "expired" });
    const applied = await applyExamProposalInTx(tx, actor, operation);
    return applied.ok
      ? resolve(
          tx,
          fresh.id,
          "accepted",
          { revision: applied.revision },
          applied.examId,
        )
      : resolve(tx, fresh.id, "conflicted", { reason: applied.reason });
  });
}

/** Spec §15: recheck permission, take the project lock, verify the base revision, commit once with audit trailers. */
export async function acceptProposal(
  db: PrismaClient,
  actor: EnrichedActor,
  proposalId: string,
): Promise<ProposalView> {
  return acceptProposalInternal(db, actor, proposalId);
}

async function acceptProposalInternal(
  db: PrismaClient,
  actor: EnrichedActor,
  proposalId: string,
  automatic?: AutomaticAcceptance,
): Promise<ProposalView> {
  const row = await requireOwnedProposal(db, actor, proposalId);
  if (row.status !== "pending" && row.status !== "accepting")
    throw new CoreError("CONFLICT", `proposal is ${row.status}`);
  if (isExamProposalKind(row.kind))
    return acceptExamProposal(db, actor, row, automatic);
  const operation = proposalOperationSchema.parse(row.operation);
  await assertProjectRole(db, operation.projectId, actor, "Editor");
  const operationId = `proposal:${row.id}`;
  const author: EnrichedActor = {
    ...actor,
    name: `Assistant on behalf of ${actor.name ?? actor.email}`,
  };

  let contentCommitted = false;
  const accepted = await withProjectRepo(operation.projectId, async (repo) => {
    // Re-read inside the project lock: concurrent accepts of the same proposal
    // serialize here, so only the first one can reach a writer.
    const fresh = await db.assistantProposal.findFirst({
      where: { id: row.id, userId: actor.userId },
    });
    if (!fresh) throw new CoreError("NOT_FOUND");
    if (automatic && fresh.status !== "pending") return toView(fresh);
    if (fresh.status !== "pending" && fresh.status !== "accepting")
      throw new CoreError("CONFLICT", `proposal is ${fresh.status}`);
    if (fresh.status === "pending") {
      const claim = (client: Db) =>
        client.assistantProposal.updateMany({
          where: {
            id: fresh.id,
            status: "pending",
            expiresAt: { gte: new Date() },
          },
          data: { status: "accepting" },
        });
      const claimed = automatic
        ? await db.$transaction(async (tx) => {
            if (
              !(await admitAutomaticAcceptance(
                tx,
                actor,
                fresh,
                operation.projectId,
                automatic,
              ))
            )
              return null;
            await assertProjectRole(tx, operation.projectId, actor, "Editor");
            return claim(tx);
          })
        : await claim(db);
      if (!claimed) return getProposal(db, actor, fresh.id);
      if (claimed.count !== 1) {
        await expireProposals(db);
        const current = await getProposal(db, actor, fresh.id);
        if (current.status === "expired") return current;
        throw new CoreError("CONFLICT", `proposal is ${current.status}`);
      }
    }
    const recoveredCreate = await recoverPriorOperation(
      db,
      repo,
      operation,
      operationId,
    );
    if (recoveredCreate)
      return resolve(
        db,
        fresh.id,
        "accepted",
        { commitSha: recoveredCreate.commitSha },
        recoveredCreate.resourceId ?? undefined,
      );

    const base = await checkOperationBase(db, repo, operation);
    if (!base.ok) {
      if (base.reason === "gone")
        return resolve(db, fresh.id, "conflicted", {
          reason: "target no longer exists",
        });
      /** A moved base never overwrites: recover our own commit or conflict. */
      const recovered = await findCommitByOperationId(
        repo,
        base.path,
        operationId,
      );
      return recovered
        ? resolve(db, fresh.id, "accepted", { commitSha: recovered })
        : resolve(db, fresh.id, "conflicted", {
            reason: "base revision changed",
          });
    }

    let applied: AppliedOperation;
    try {
      applied = await applyOperationInRepo(db, repo, operation, author, {
        table: base.table,
        summary: fresh.summary,
        operationId,
        runId: row.runId,
      });
    } catch (error) {
      const committed = await repo.logForPath(".", {
        skip: 0,
        limit: 1,
        operationId,
      });
      if (!committed.some((entry) => entry.operationId === operationId)) {
        await db.assistantProposal.updateMany({
          where: { id: fresh.id, status: "accepting" },
          data: { status: "pending" },
        });
      }
      throw error;
    }
    contentCommitted = true;
    const createdResourceId =
      operation.kind === "document.create" || operation.kind === "table.create"
        ? (applied.resourceId ?? undefined)
        : undefined;
    return resolve(
      db,
      fresh.id,
      "accepted",
      { commitSha: applied.commitSha },
      createdResourceId,
    );
  });
  // The dispatch takes the repository's shared read lock, so it must run
  // after withProjectRepo released the write lock (M4).
  if (contentCommitted)
    void notifyProjectContentChanged(db, operation.projectId);
  return accepted;
}

export async function rejectProposal(
  db: PrismaClient,
  actor: SecurityContext,
  proposalId: string,
): Promise<ProposalView> {
  const row = await requireOwnedProposal(db, actor, proposalId);
  if (row.status === "accepting") {
    return withProjectRepo(row.projectId, async (repo) => {
      const fresh = await requireOwnedProposal(db, actor, proposalId);
      if (fresh.status !== "accepting")
        throw new CoreError("CONFLICT", `proposal is ${fresh.status}`);
      const committed = await repo.logForPath(".", {
        skip: 0,
        limit: 1,
        operationId: `proposal:${row.id}`,
      });
      if (committed.length)
        throw new CoreError(
          "CONFLICT",
          "Proposal already committed; retry acceptance to recover its status",
        );
      await db.assistantProposal.updateMany({
        where: { id: row.id, status: "accepting" },
        data: { status: "pending" },
      });
      return rejectProposal(db, actor, proposalId);
    });
  }
  if (row.status !== "pending")
    throw new CoreError("CONFLICT", `proposal is ${row.status}`);
  const claimed = await db.assistantProposal.updateMany({
    where: { id: row.id, userId: actor.userId, status: "pending" },
    data: {
      status: "rejected",
      resolution: { reason: "rejected by user" },
      resolvedAt: new Date(),
    },
  });
  if (claimed.count !== 1)
    throw new CoreError("CONFLICT", "proposal is no longer pending");
  return getProposal(db, actor, row.id);
}

/** Only undecided proposals expire; a durable acceptance claim survives worker failure. */
export async function expireProposals(
  db: PrismaClient,
  now = new Date(),
): Promise<number> {
  const result = await db.assistantProposal.updateMany({
    where: { status: "pending", expiresAt: { lt: now } },
    data: {
      status: "expired",
      resolution: { reason: "expired" },
      resolvedAt: now,
    },
  });
  return result.count;
}

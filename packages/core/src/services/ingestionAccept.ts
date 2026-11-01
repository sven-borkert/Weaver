import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { MAX_MARKDOWN_CHARS } from "../documents/limits";
import { FOLDER_NOT_FOUND } from "../documents/paths";
import { CoreError } from "../errors";
import { parseDraftCell, type DraftCellValue } from "../ingestion/columnTypes";
import type { DraftTableColumn } from "../ingestion/draftTable";
import {
  proposedLinksSchema,
  withRelatedLinks,
  type ProposedLink,
} from "../ingestion/links";
import type { SecurityContext } from "../security/context";
import {
  applyOperationInRepo,
  contentOperationSchema,
  recoverPriorOperation,
  type AppliedOperation,
  type ContentOperation,
} from "./contentOperations";
import type { EnrichedActor } from "./documents";
import {
  loadIngestionFile,
  parseStoredTable,
  assertDraftRevision,
  toFileDetail,
  type FileDetail,
} from "./ingestion";
import { notDeleted } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";

export type AcceptableDraft = {
  targetKind: "document" | "table";
  proposedTitle: string;
  proposedFolderPath: string;
  markdown: string | null;
  columns: DraftTableColumn[] | null;
  rows: string[][] | null;
  links: ProposedLink[];
};

export type AcceptResult = {
  file: FileDetail;
  targetKind: "document" | "table";
  resourceId: string;
  commitSha: string;
};

const RELEASE_HISTORY_LIMIT = 10;

const notReady = () =>
  new CoreError("PRECONDITION_FAILED", "only a ready draft can be accepted");

function fieldError(field: string, message: string): CoreError {
  return new CoreError("BAD_REQUEST", message, { field });
}

// Convert the reviewed draft through the shared content-operation contract.
export function buildAcceptOperation(
  projectId: string,
  draft: AcceptableDraft,
): ContentOperation {
  const folderPath =
    draft.proposedFolderPath === "" ? [] : draft.proposedFolderPath.split("/");
  let candidate: unknown;
  if (draft.targetKind === "document") {
    const original = draft.markdown ?? "";
    const markdown = withRelatedLinks(original, draft.links);
    if (
      original.length <= MAX_MARKDOWN_CHARS &&
      markdown.length > MAX_MARKDOWN_CHARS
    )
      throw fieldError(
        "markdown",
        `The Related section would exceed the ${MAX_MARKDOWN_CHARS.toLocaleString("en-US")}-character document limit. Deselect related documents and try accepting again.`,
      );
    candidate = {
      kind: "document.create",
      projectId,
      folderPath,
      title: draft.proposedTitle,
      markdown,
    };
  } else {
    if (!draft.columns || !draft.rows)
      throw fieldError("columns", "the table draft is incomplete");
    const columns = draft.columns.map((column) => ({
      id: randomUUID(),
      name: column.name,
      type: column.type,
    }));
    const rows = draft.rows.map((row, rowIndex) => {
      const cells: Record<string, DraftCellValue> = {};
      columns.forEach((column, index) => {
        const parsed = parseDraftCell(row[index] ?? "", column.type);
        if (!parsed.ok)
          throw fieldError(
            "columns",
            `column ${column.name} cannot be ${column.type}: row ${rowIndex + 1}`,
          );
        if (parsed.value !== null) cells[column.id] = parsed.value;
      });
      return { cells };
    });
    candidate = {
      kind: "table.create",
      projectId,
      folderPath,
      title: draft.proposedTitle,
      columns,
      rows,
    };
  }
  const parsed = contentOperationSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path[0];
    throw fieldError(
      path === "folderPath"
        ? "proposedFolderPath"
        : path === "title"
          ? "proposedTitle"
          : typeof path === "string"
            ? path
            : "draft",
      issue?.message ?? "the draft cannot be accepted",
    );
  }
  return parsed.data;
}

type LoadedFile = Awaited<ReturnType<typeof loadIngestionFile>>;

function acceptableDraft(file: LoadedFile): AcceptableDraft {
  const draft = file.draft;
  if (!draft) throw notReady();
  const table =
    draft.targetKind === "table"
      ? parseStoredTable(draft.tableSchema, draft.tableRows)
      : null;
  return {
    targetKind: draft.targetKind,
    proposedTitle: draft.proposedTitle,
    proposedFolderPath: draft.proposedFolderPath,
    markdown: draft.markdown,
    columns: table?.columns ?? null,
    rows: table?.rows ?? null,
    links: proposedLinksSchema.safeParse(draft.proposedLinks).data ?? [],
  };
}

// The durable file claim protects the reviewed snapshot across a process crash.
export async function acceptDraft(
  db: PrismaClient,
  actor: EnrichedActor,
  input: { fileId: string; expectedRevision?: number },
): Promise<AcceptResult> {
  const initial = await loadIngestionFile(db, actor, input.fileId);
  if (!["ready", "accepting", "accepted"].includes(initial.status))
    throw notReady();
  const operationId = `ingestion:${initial.id}`;
  const started = Date.now();

  let contentCommitted = false;
  const result = await withProjectRepo(initial.projectId, async (repo) => {
    const file = await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "IngestionFile"
        WHERE id = ${initial.id}::uuid FOR UPDATE
      `;
      const current = await loadIngestionFile(tx, actor, initial.id);
      if (current.status === "ready") {
        // Only the first claim is bound to a revision; recovery of an
        // accepting/accepted file must stay idempotent.
        if (current.draft)
          assertDraftRevision(current.draft.revision, input.expectedRevision);
        const claimed = await tx.ingestionFile.updateMany({
          where: {
            id: current.id,
            status: "ready",
            project: { ...notDeleted },
          },
          data: { status: "accepting" },
        });
        if (claimed.count !== 1)
          throw new CoreError("CONFLICT", "the draft is no longer ready");
      } else if (!["accepting", "accepted"].includes(current.status)) {
        throw notReady();
      }
      return loadIngestionFile(tx, actor, initial.id);
    });
    const stored = file.draft;
    if (file.status === "accepted") {
      if (!stored?.acceptedResourceId || !stored.acceptedCommitSha)
        throw new CoreError(
          "CONFLICT",
          "accepted draft acknowledgement is missing",
        );
      return {
        file: toFileDetail(file),
        targetKind: stored.targetKind,
        resourceId: stored.acceptedResourceId,
        commitSha: stored.acceptedCommitSha,
      };
    }

    try {
      const draft = acceptableDraft(file);
      const operation = buildAcceptOperation(file.projectId, draft);
      const recovered = await recoverPriorOperation(
        db,
        repo,
        operation,
        operationId,
      );
      let applied: AppliedOperation;
      if (recovered) {
        applied = recovered;
      } else {
        applied = await applyOperationInRepo(db, repo, operation, actor, {
          table: null,
          summary: "",
          operationId,
        });
        contentCommitted = true;
      }
      // buildAcceptOperation only ever builds document.create or table.create;
      // only a folder action commits no resource, and this is never one.
      if (applied.resourceId === null)
        throw new CoreError(
          "INTERNAL_SERVER_ERROR",
          "accepting an import did not produce a resource id",
        );
      const accepted = await db.$transaction(async (tx) => {
        const finalized = await tx.ingestionFile.updateMany({
          where: {
            id: file.id,
            status: "accepting",
            project: { ...notDeleted },
          },
          data: { status: "accepted", failureKind: null, failureMessage: null },
        });
        if (finalized.count !== 1)
          throw new CoreError("CONFLICT", "acceptance claim is no longer held");
        await tx.ingestionDraft.update({
          where: { fileId: file.id },
          data: {
            acceptedResourceId: applied.resourceId,
            acceptedCommitSha: applied.commitSha,
          },
        });
        return toFileDetail(await loadIngestionFile(tx, actor, file.id));
      });
      emitDiagnostic({
        event: "ingestion.draft.accepted",
        message: `import accepted as ${draft.targetKind}`,
        durationMs: Date.now() - started,
        outcome: "ok",
        projectId: file.projectId,
        details: {
          fileId: file.id,
          targetKind: draft.targetKind,
          resourceId: applied.resourceId,
          keptLinks:
            draft.targetKind === "document"
              ? draft.links.filter((link) => link.keep).length
              : 0,
        },
      });
      return {
        file: accepted,
        targetKind: draft.targetKind,
        resourceId: applied.resourceId,
        commitSha: applied.commitSha,
      };
    } catch (error) {
      // Even validation and recovery failures must preserve a committed claim.
      const candidates = await repo.logForPath(".", {
        skip: 0,
        limit: RELEASE_HISTORY_LIMIT + 1,
        operationId,
      });
      // Git filters message text; only complete history proves trailer absence.
      if (
        candidates.length <= RELEASE_HISTORY_LIMIT &&
        !candidates.some((entry) => entry.operationId === operationId)
      ) {
        await db.ingestionFile.updateMany({
          where: { id: file.id, status: "accepting" },
          data: { status: "ready" },
        });
      }
      if (
        error instanceof CoreError &&
        error.details?.reason === FOLDER_NOT_FOUND
      )
        throw fieldError(
          "proposedFolderPath",
          "the chosen folder no longer exists",
        );
      throw error;
    }
  });
  // The dispatch takes the repository's shared read lock, so it must run
  // after withProjectRepo released the write lock (M4).
  if (contentCommitted) void notifyProjectContentChanged(db, initial.projectId);
  return result;
}

export async function rejectDraft(
  db: PrismaClient,
  actor: SecurityContext,
  input: { fileId: string },
): Promise<FileDetail> {
  const initial = await loadIngestionFile(db, actor, input.fileId, false);
  const rejected = await db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "IngestionFile"
      WHERE id = ${initial.id}::uuid FOR UPDATE
    `;
    const file = await loadIngestionFile(tx, actor, initial.id, false);
    if (file.status === "accepting")
      throw new CoreError(
        "CONFLICT",
        "acceptance is in progress; retry accepting to finish it",
      );
    const changed = await tx.ingestionFile.updateMany({
      where: { id: file.id, status: "ready", project: { ...notDeleted } },
      data: { status: "rejected" },
    });
    if (changed.count !== 1)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "only a ready draft can be rejected",
      );
    return toFileDetail(await loadIngestionFile(tx, actor, file.id));
  });
  emitDiagnostic({
    event: "ingestion.draft.rejected",
    message: "import rejected",
    outcome: "ok",
    projectId: initial.projectId,
    details: { fileId: initial.id },
  });
  return rejected;
}

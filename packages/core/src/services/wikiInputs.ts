import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { contentTypeMatches, normalizeMimeType } from "../ingestion/mimeTypes";
import { readBlob } from "../ingestion/blobStore";
import type { UserSecurityContext } from "../security/context";
import { scanForSecrets } from "../security/secretScan";
import { stripIgnorable } from "../wiki/guideText";
import {
  WIKI_ACTIVE_RUN_STATUSES,
  WIKI_ATTENTION_ITEM_STATUSES,
  WIKI_INGEST_MAX_ITEMS,
  WIKI_NOTE_MAX_CHARS,
  WIKI_QUEUE_ITEM_STATUSES,
  WIKI_QUEUE_MAX_ITEMS,
  WIKI_UNPROTECTING_ITEM_STATUSES,
  type WikiInputStatusName,
} from "../wiki/states";
import { requestKnowledgeJob } from "../jobs/queue";
import type { KnowledgeJobPayloads } from "../jobs/types";
import {
  createWikiIngestionFile,
  resetWikiIngestionFile,
  retireWikiIngestionFile,
  withProjectIngestionLifecycleLock,
} from "./ingestion";
import { assertProjectRole, notDeleted } from "./projectAccess";
import { getLiveWikiAgent } from "./wikiAgents";

type Actor = UserSecurityContext;
type Tx = Prisma.TransactionClient;

const SPREADSHEET_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);
/** The v1 envelope; everything else stays in Files or Imports. */
export const WIKI_INPUT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
  ...SPREADSHEET_TYPES,
]);
const TYPE_REFUSAL =
  "The wiki accepts PDF, Word (docx), Excel (xlsx), CSV, Markdown and text. Keep other files in Files, or bring them in through Imports.";
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const REMOVED_TITLE = "Removed input";

function badRequest(field: string, message: string): CoreError {
  return new CoreError("BAD_REQUEST", message, { field });
}

function sessionOnly(actor: Actor): void {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN");
}

async function assertEditor(
  db: PrismaClient | Tx,
  actor: Actor,
  projectId: string,
): Promise<void> {
  sessionOnly(actor);
  await assertProjectRole(db, projectId, actor, "Editor", {
    capability: "content:write",
  });
}

/** Serializes queue admission and Process on the settings row. */
async function lockEnabledSettings(
  tx: Tx,
  projectId: string,
): Promise<{ agentId: string }> {
  const [row] = await tx.$queryRaw<
    Array<{ enabled: boolean; agentId: string | null }>
  >(Prisma.sql`
    SELECT "enabled", "agentId" FROM "ProjectWikiSettings"
    WHERE "projectId" = ${projectId}::uuid FOR UPDATE
  `);
  if (!row?.enabled || !row.agentId)
    throw new CoreError(
      "CONFLICT",
      "The wiki is not enabled for this project",
      {
        reason: "WIKI_DISABLED",
      },
    );
  return { agentId: row.agentId };
}

const OPEN_STATUSES = [
  ...WIKI_QUEUE_ITEM_STATUSES,
  ...WIKI_ATTENTION_ITEM_STATUSES,
];

async function assertQueueRoom(
  tx: Tx,
  projectId: string,
  adding: number,
): Promise<void> {
  const open = await tx.wikiInputItem.count({
    where: { projectId, status: { in: [...OPEN_STATUSES] } },
  });
  if (open + adding > WIKI_QUEUE_MAX_ITEMS)
    throw new CoreError(
      "CONFLICT",
      `The input queue is limited to ${WIKI_QUEUE_MAX_ITEMS} items. Process or remove some first.`,
      { reason: "QUEUE_FULL" },
    );
}

export function wikiTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Carries no authored text, so it is safe on a held item and on a source page. */
export function neutralInputTitle(kind: "text" | "file", at: Date): string {
  return `${kind === "text" ? "Note" : "File"} ${at.toISOString().slice(0, 10)}`;
}

/** Scans the whole candidate, so a secret past the cut-off cannot leave its start behind. */
export function safeInputTitle(
  kind: "text" | "file",
  candidate: string,
  max: number,
  at: Date,
): string {
  if (scanForSecrets(candidate, kind).length > 0)
    return neutralInputTitle(kind, at);
  return candidate.slice(0, max);
}

function cleanTitle(value: string): string {
  return stripIgnorable(value)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A title that survives stripping, else the first text line, else a fixed fallback. */
function noteTitle(title: string | undefined, text: string, now: Date): string {
  const given = cleanTitle(title ?? "");
  if (given) return safeInputTitle("text", given, 200, now);
  for (const line of text.split("\n")) {
    const candidate = cleanTitle(line.replace(/^#+\s*/, ""));
    if (candidate) return safeInputTitle("text", candidate, 120, now);
  }
  return "Untitled note";
}

export async function addTextInput(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; title?: string; text: string },
): Promise<{ id: string; title: string }> {
  await assertEditor(db, actor, input.projectId);
  if (input.text.length > WIKI_NOTE_MAX_CHARS)
    throw badRequest(
      "text",
      `A note is limited to ${WIKI_NOTE_MAX_CHARS.toLocaleString("en-US")} characters`,
    );
  if (stripIgnorable(input.text).trim().length === 0)
    throw badRequest("text", "The note is empty");
  if (/weaver-image:|<\s*img\b/i.test(input.text))
    throw badRequest(
      "text",
      "Notes cannot contain images. Add the text without them.",
    );
  const title = noteTitle(input.title, input.text, new Date());
  const created = await db.$transaction(async (tx) => {
    await lockEnabledSettings(tx, input.projectId);
    await assertQueueRoom(tx, input.projectId, 1);
    return tx.wikiInputItem.create({
      data: {
        projectId: input.projectId,
        kind: "text",
        title,
        text: input.text,
        textDigest: wikiTextDigest(input.text),
        byteSize: Buffer.byteLength(input.text),
        createdById: actor.userId,
      },
      select: { id: true, title: true },
    });
  });
  emitAdded(input.projectId, created.id, "text");
  return created;
}

function emitAdded(projectId: string, itemId: string, kind: string): void {
  emitDiagnostic({
    event: "wiki.input.added",
    message: "wiki input added",
    outcome: "ok",
    projectId,
    details: { itemId, kind },
  });
}

export async function addFileInputs(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; artifactIds: string[] },
  options: { dataDir: string; maxFileBytes: number },
): Promise<Array<{ id: string; title: string }>> {
  await assertEditor(db, actor, input.projectId);
  const ids = [...new Set(input.artifactIds)];
  if (ids.length === 0 || ids.length > WIKI_QUEUE_MAX_ITEMS)
    throw badRequest("artifactIds", "Choose at least one file");
  const artifacts = await db.artifact.findMany({
    where: { id: { in: ids }, projectId: input.projectId },
  });
  if (artifacts.length !== ids.length)
    throw new CoreError("NOT_FOUND", "A selected file no longer exists");
  for (const artifact of artifacts) {
    if (artifact.uploadedById !== actor.userId)
      throw new CoreError(
        "FORBIDDEN",
        "Only files you uploaded can be added to the wiki input",
      );
    if (!WIKI_INPUT_MIME_TYPES.has(normalizeMimeType(artifact.contentType)))
      throw new CoreError("BAD_REQUEST", TYPE_REFUSAL, {
        field: "artifactIds",
        reason: "UNSUPPORTED_TYPE",
      });
    const bytes = await readBlob(
      options.dataDir,
      input.projectId,
      artifact.contentDigest,
      options.maxFileBytes,
    ).catch((error: unknown) => {
      if (error instanceof RangeError)
        throw badRequest("artifactIds", "The file exceeds the upload limit");
      throw error;
    });
    if (!contentTypeMatches(artifact.contentType, bytes))
      throw new CoreError("BAD_REQUEST", TYPE_REFUSAL, {
        field: "artifactIds",
        reason: "UNSUPPORTED_TYPE",
      });
  }
  const created = await db.$transaction(async (tx) => {
    await lockEnabledSettings(tx, input.projectId);
    await assertQueueRoom(tx, input.projectId, artifacts.length);
    const existing = await tx.wikiInputItem.count({
      where: {
        artifactId: { in: ids },
        status: { notIn: [...WIKI_UNPROTECTING_ITEM_STATUSES] },
      },
    });
    if (existing > 0)
      throw new CoreError(
        "CONFLICT",
        "That file is already in the wiki input",
        {
          reason: "ALREADY_QUEUED",
        },
      );
    const items: Array<{ id: string; title: string }> = [];
    for (const artifact of artifacts) {
      items.push(
        await tx.wikiInputItem.create({
          data: {
            projectId: input.projectId,
            kind: "file",
            title:
              safeInputTitle(
                "file",
                cleanTitle(artifact.filename),
                255,
                new Date(),
              ) || "Untitled file",
            artifactId: artifact.id,
            artifactDigest: artifact.contentDigest,
            byteSize: artifact.byteSize,
            createdById: actor.userId,
          },
          select: { id: true, title: true },
        }),
      );
    }
    return items;
  });
  for (const item of created) emitAdded(input.projectId, item.id, "file");
  return created;
}

export type WikiInputView = {
  id: string;
  kind: "text" | "file";
  title: string;
  byteSize: number;
  status: WikiInputStatusName;
  createdAt: Date;
  createdBy: string | null;
  mine: boolean;
  outcomeNote: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  heldHits: Array<{ kind: string; location: string }> | null;
  heldDigest: string | null;
  processedAt: Date | null;
  sourceDocumentId: string | null;
  sourceTableId: string | null;
  revision: number;
};

export type WikiRunView = {
  id: string;
  kind: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  stopReason: string | null;
  startedAt: Date;
  endedAt: Date | null;
  items: number;
};

const ITEM_SELECT = {
  id: true,
  kind: true,
  title: true,
  byteSize: true,
  status: true,
  createdAt: true,
  createdById: true,
  outcomeNote: true,
  errorCode: true,
  errorMessage: true,
  heldHits: true,
  heldDigest: true,
  processedAt: true,
  sourceDocumentId: true,
  sourceTableId: true,
  revision: true,
  createdBy: { select: { name: true, email: true } },
} satisfies Prisma.WikiInputItemSelect;

type ItemRow = Prisma.WikiInputItemGetPayload<{ select: typeof ITEM_SELECT }>;

function toView(row: ItemRow, actor: Actor): WikiInputView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    byteSize: row.byteSize,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy?.name ?? row.createdBy?.email ?? null,
    mine: row.createdById === actor.userId,
    outcomeNote: row.outcomeNote,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    heldHits: Array.isArray(row.heldHits)
      ? (row.heldHits as Array<{ kind: string; location: string }>)
      : null,
    heldDigest: row.heldDigest,
    processedAt: row.processedAt,
    sourceDocumentId: row.sourceDocumentId,
    sourceTableId: row.sourceTableId,
    revision: row.revision,
  };
}

export async function listInputs(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string },
  now: Date = new Date(),
): Promise<{
  queue: WikiInputView[];
  queuedCount: number;
  attention: WikiInputView[];
  recent: WikiInputView[];
  activeRun: WikiRunView | null;
  lastRun: WikiRunView | null;
  queueLimit: number;
  batchLimit: number;
}> {
  sessionOnly(actor);
  await assertProjectRole(db, input.projectId, actor, "Viewer", {
    capability: "content:read",
  });
  const [queue, attention, recent, runs] = await Promise.all([
    db.wikiInputItem.findMany({
      where: {
        projectId: input.projectId,
        status: { in: [...WIKI_QUEUE_ITEM_STATUSES] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: WIKI_QUEUE_MAX_ITEMS,
      select: ITEM_SELECT,
    }),
    db.wikiInputItem.findMany({
      where: {
        projectId: input.projectId,
        status: { in: [...WIKI_ATTENTION_ITEM_STATUSES] },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: WIKI_QUEUE_MAX_ITEMS,
      select: ITEM_SELECT,
    }),
    db.wikiInputItem.findMany({
      where: {
        projectId: input.projectId,
        status: "processed",
        processedAt: { gte: new Date(now.getTime() - RECENT_WINDOW_MS) },
      },
      orderBy: [{ processedAt: "desc" }, { id: "desc" }],
      take: 50,
      select: ITEM_SELECT,
    }),
    db.wikiRun.findMany({
      where: { projectId: input.projectId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 2,
      include: { _count: { select: { items: true } } },
    }),
  ]);
  const toRun = (run: (typeof runs)[number]): WikiRunView => ({
    id: run.id,
    kind: run.kind,
    status: run.status,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    stopReason: run.stopReason,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    items: run._count.items,
  });
  const active = runs.find((run) => run.endedAt === null);
  const last = runs.find((run) => run.endedAt !== null);
  return {
    queue: queue.map((row) => toView(row, actor)),
    queuedCount: queue.filter((row) => row.status === "queued").length,
    attention: attention.map((row) => toView(row, actor)),
    recent: recent.map((row) => toView(row, actor)),
    activeRun: active ? toRun(active) : null,
    lastRun: last ? toRun(last) : null,
    queueLimit: WIKI_QUEUE_MAX_ITEMS,
    batchLimit: WIKI_INGEST_MAX_ITEMS,
  };
}

type WikiParseJob = KnowledgeJobPayloads["ingestion.parse"];

/**
 * Selected file items parse through Imports' stages. An item with a live source skips this and
 * never gets a second file; a failed parse is reset; a retired file is replaced.
 */
async function bridgeFileItems(
  tx: Tx,
  input: { projectId: string; runId: string; createdById: string },
): Promise<WikiParseJob[]> {
  const items = await tx.wikiInputItem.findMany({
    where: { runId: input.runId, kind: "file", status: "preparing" },
    include: { artifact: true, ingestionFile: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const jobs: WikiParseJob[] = [];
  let batchId: string | null = null;
  for (const item of items) {
    const documentLive =
      item.sourceDocumentId !== null &&
      (await tx.document.count({
        where: { id: item.sourceDocumentId, projectId: input.projectId },
      })) > 0;
    const tableLive =
      item.sourceTableId !== null &&
      (await tx.dataTable.count({
        where: { id: item.sourceTableId, projectId: input.projectId },
      })) > 0;
    if (documentLive || tableLive) continue;
    const { ingestionFile } = item;
    const artifact =
      item.artifact?.contentDigest === item.artifactDigest
        ? item.artifact
        : null;
    if (!artifact) {
      await tx.wikiInputItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          errorCode: "ARTIFACT_CHANGED",
          errorMessage:
            "The original file is gone or changed. Remove this input and add the file again.",
          revision: { increment: 1 },
        },
      });
      continue;
    }
    if (ingestionFile && ingestionFile.status !== "rejected") {
      const reset = await resetWikiIngestionFile(tx, ingestionFile.id);
      if (reset)
        jobs.push({
          fileId: ingestionFile.id,
          projectId: input.projectId,
          contentDigest: ingestionFile.contentDigest,
          baseAttemptCount: reset.attemptCount,
        });
      continue;
    }
    if (batchId === null) {
      const batch = await tx.ingestionBatch.create({
        data: {
          projectId: input.projectId,
          createdById: input.createdById,
          origin: "wiki",
        },
        select: { id: true },
      });
      batchId = batch.id;
    }
    const created = await createWikiIngestionFile(tx, {
      batchId,
      projectId: input.projectId,
      fileName: artifact.filename,
      mimeType: artifact.contentType,
      byteSize: artifact.byteSize,
      contentDigest: artifact.contentDigest,
    });
    await tx.wikiInputItem.update({
      where: { id: item.id },
      data: { ingestionFileId: created.id },
    });
    jobs.push({
      fileId: created.id,
      projectId: input.projectId,
      contentDigest: artifact.contentDigest,
      baseAttemptCount: created.attemptCount,
    });
  }
  return jobs;
}

function runActive(): CoreError {
  return new CoreError("CONFLICT", "A wiki run is already active", {
    reason: "RUN_ACTIVE",
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Oldest first, one active run per project; the partial unique index is the arbiter. */
export async function processInputs(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; itemIds: string[] | "all" },
): Promise<{ runId: string; selected: number; remaining: number }> {
  await assertEditor(db, actor, input.projectId);
  let result: { runId: string; selected: number; remaining: number };
  let parseJobs: WikiParseJob[] = [];
  try {
    // The lifecycle lock orders new file rows against blob and artifact changes.
    result = await withProjectIngestionLifecycleLock(
      db,
      input.projectId,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${input.projectId}::uuid FOR SHARE`;
        await assertEditor(tx, actor, input.projectId);
        await lockEnabledSettings(tx, input.projectId);
        const agent = await getLiveWikiAgent(tx, input.projectId);
        if (!agent)
          throw new CoreError("CONFLICT", "The wiki agent has been revoked", {
            reason: "WIKI_DISABLED",
          });
        // The settings lock orders concurrent calls, so the loser reports the run, not an empty queue.
        const active = await tx.wikiRun.count({
          where: {
            projectId: input.projectId,
            status: { in: [...WIKI_ACTIVE_RUN_STATUSES] },
          },
        });
        if (active > 0) throw runActive();
        const where: Prisma.WikiInputItemWhereInput = {
          projectId: input.projectId,
          status: "queued",
          ...(input.itemIds === "all" ? {} : { id: { in: input.itemIds } }),
        };
        const selected = await tx.wikiInputItem.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: WIKI_INGEST_MAX_ITEMS,
          select: { id: true },
        });
        if (selected.length === 0)
          throw new CoreError("PRECONDITION_FAILED", "Nothing is queued", {
            reason: "NOTHING_QUEUED",
          });
        const run = await tx.wikiRun.create({
          data: {
            projectId: input.projectId,
            agentId: agent.id,
            kind: "ingest",
            trigger: "manual",
            startedById: actor.userId,
            status: "preparing",
          },
          select: { id: true },
        });
        const claimed = await tx.wikiInputItem.updateMany({
          where: {
            id: { in: selected.map((item) => item.id) },
            status: "queued",
          },
          data: {
            status: "preparing",
            runId: run.id,
            processStartedById: actor.userId,
            attempts: { increment: 1 },
            outcomeNote: null,
            errorCode: null,
            errorMessage: null,
            revision: { increment: 1 },
          },
        });
        parseJobs = await bridgeFileItems(tx, {
          projectId: input.projectId,
          runId: run.id,
          createdById: actor.userId,
        });
        const remaining = await tx.wikiInputItem.count({
          where: { projectId: input.projectId, status: "queued" },
        });
        return { runId: run.id, selected: claimed.count, remaining };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw runActive();
    throw error;
  }
  // A lost publication is republished by ingestion reconciliation, inside the 75-minute limit.
  for (const job of parseJobs)
    await requestKnowledgeJob("ingestion.parse", job).catch(() => null);
  emitDiagnostic({
    event: "wiki.run.started",
    message: "wiki ingest run started",
    outcome: "ok",
    projectId: input.projectId,
    details: {
      runId: result.runId,
      kind: "ingest",
      items: result.selected,
      remaining: result.remaining,
    },
  });
  return result;
}

async function loadItem(
  tx: PrismaClient | Tx,
  projectId: string,
  itemId: string,
) {
  const item = await tx.wikiInputItem.findFirst({
    where: { id: itemId, projectId, project: { ...notDeleted } },
  });
  if (!item) throw new CoreError("NOT_FOUND", "Wiki input not found");
  return item;
}

/** Owner-only legal erasure path: lifts SOURCE_PROTECTED without touching the source page. */
export async function unlinkInputArtifact(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; itemId: string },
): Promise<void> {
  sessionOnly(actor);
  await assertProjectRole(db, input.projectId, actor, "Owner", {
    capability: "content:write",
  });
  await loadItem(db, input.projectId, input.itemId);
  const { count } = await db.wikiInputItem.updateMany({
    where: {
      id: input.itemId,
      projectId: input.projectId,
      kind: "file",
      status: { notIn: ["preparing", "processing"] },
    },
    data: {
      artifactId: null,
      artifactDigest: null,
      revision: { increment: 1 },
    },
  });
  if (count === 0)
    throw new CoreError(
      "CONFLICT",
      "This input is being processed. Try again when the run has finished.",
      { reason: "ITEM_BUSY" },
    );
}

export async function retryInput(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; itemId: string },
): Promise<void> {
  await assertEditor(db, actor, input.projectId);
  await loadItem(db, input.projectId, input.itemId);
  const { count } = await db.wikiInputItem.updateMany({
    where: {
      id: input.itemId,
      projectId: input.projectId,
      status: { in: ["skipped", "failed", "reverted"] },
    },
    data: {
      status: "queued",
      runId: null,
      outcomeNote: null,
      errorCode: null,
      errorMessage: null,
      revision: { increment: 1 },
    },
  });
  if (count === 0)
    throw new CoreError(
      "CONFLICT",
      "Only a skipped, failed or reverted input can be retried",
      { reason: "NOT_RETRYABLE" },
    );
}

/** Bound to the exact content the Editor saw; the scanner skips only that digest. */
export async function confirmInput(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; itemId: string; expectedDigest: string },
): Promise<void> {
  await assertEditor(db, actor, input.projectId);
  await loadItem(db, input.projectId, input.itemId);
  const { count } = await db.wikiInputItem.updateMany({
    where: {
      id: input.itemId,
      projectId: input.projectId,
      status: "held",
      heldDigest: input.expectedDigest,
    },
    data: {
      status: "queued",
      runId: null,
      confirmedById: actor.userId,
      confirmedDigest: input.expectedDigest,
      heldHits: Prisma.DbNull,
      outcomeNote: null,
      errorCode: null,
      errorMessage: null,
      revision: { increment: 1 },
    },
  });
  if (count === 0)
    throw new CoreError(
      "CONFLICT",
      "This input changed since it was held. Reload and check it again.",
      { reason: "HOLD_CHANGED" },
    );
}

export async function removeInput(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; itemId: string },
): Promise<void> {
  await assertEditor(db, actor, input.projectId);
  const existing = await loadItem(db, input.projectId, input.itemId);
  const count = await db.$transaction(async (tx) => {
    const { count: removed } = await tx.wikiInputItem.updateMany({
      where: {
        id: input.itemId,
        projectId: input.projectId,
        status: {
          in: [
            "queued",
            "preparing",
            "ready",
            "skipped",
            "held",
            "failed",
            "reverted",
          ],
        },
      },
      // sourceDocumentId and sourceTableId stay: a committed source page keeps its guard.
      data: {
        status: "removed",
        title: REMOVED_TITLE,
        runId: null,
        text: null,
        textDigest: null,
        artifactId: null,
        artifactDigest: null,
        byteSize: 0,
        heldHits: Prisma.DbNull,
        heldDigest: null,
        confirmedById: null,
        confirmedDigest: null,
        createdById: null,
        processStartedById: null,
        outcomeNote: null,
        errorCode: null,
        errorMessage: null,
        revision: { increment: 1 },
      },
    });
    // A parked or running parse ends with the item; its draft leaves with it.
    if (removed === 1 && existing.ingestionFileId)
      await retireWikiIngestionFile(tx, existing.ingestionFileId);
    return removed;
  });
  if (count === 0)
    throw new CoreError(
      "CONFLICT",
      "This input cannot be removed in its current state",
      { reason: "NOT_REMOVABLE" },
    );
}

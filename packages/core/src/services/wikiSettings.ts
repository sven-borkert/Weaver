import type {
  Prisma,
  PrismaClient,
  ProjectWikiSettings,
  WikiGuideSuggestion,
} from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { loadFolderIdentityIndex } from "../projectApi/folderIdentity";
import type { SecurityContext, UserSecurityContext } from "../security/context";
import {
  GUIDE_MAX_BYTES,
  guideAdvisoryFlags,
  guideByteLength,
  guideDiff,
  normalizeGuideText,
  type GuideDiffLine,
  type GuideLineFlag,
  type GuideRemoval,
} from "../wiki/guideText";
import { getDocumentAtSnapshot } from "./documents";
import type { FolderScope } from "./folders";
import { resolveLlmRoute } from "./llmRoutes";
import { assertProjectRole } from "./projectAccess";
import { runWikiBootstrap, type WikiBootstrapRecord } from "./wikiBootstrap";
import { createWikiAgent, revokeWikiAgent } from "./wikiAgents";
import type { WikiWriteGuards } from "./wikiOperations";

type Actor = UserSecurityContext;

export const WIKI_BUDGET_MIN = 1_000;
export const WIKI_BUDGET_MAX = 10_000_000;
export const WIKI_SPEND_ALERT_MAX_CENTS = 1_000_000;

export type WikiSettingsView = {
  projectId: string;
  /** 0 until the first enable creates the row. */
  revision: number;
  enabled: boolean;
  routeReady: boolean;
  agent: { id: string; createdAt: Date; live: boolean } | null;
  enabledAt: Date | null;
  guide: {
    documentId: string | null;
    title: string | null;
    approved: boolean;
    approvedAt: Date | null;
    approvedById: string | null;
  };
  overviewDocumentId: string | null;
  sourcesFolderId: string | null;
  openSuggestions: number;
  destructiveBudget24h: number;
  destructivePausedAt: Date | null;
  spendAlertCentsPerDay: number | null;
  lintSchedule: unknown;
};

export type WikiGuideReview = {
  revision: number;
  documentId: string;
  title: string;
  /** Exactly what a run would inject; empty when tooLarge. */
  text: string;
  digest: string;
  bytes: number;
  tooLarge: boolean;
  removed: GuideRemoval[];
  matchesApproved: boolean;
  approvedAt: Date | null;
  diff: GuideDiffLine[];
  flags: GuideLineFlag[];
};

function sessionOnly(actor: Actor): void {
  // The union reaches here at runtime from non-session callers, so check the kind too.
  if (
    (actor as { kind?: string }).kind !== "user" ||
    actor.authenticationMethod !== "session"
  )
    throw new CoreError("FORBIDDEN");
}

async function requireRole(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  projectId: string,
  role: "Owner" | "Maintainer",
  write: boolean,
): Promise<void> {
  sessionOnly(actor);
  await assertProjectRole(db, projectId, actor, role, {
    capability: write ? "content:write" : "content:read",
  });
}

function stale(): CoreError {
  return new CoreError(
    "CONFLICT",
    "Wiki settings changed. Reload before saving.",
    { reason: "STALE_REVISION" },
  );
}

/** Compare-and-set on the integer revision; every successful write bumps it. */
async function guarded(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  expectedRevision: number,
  data: Prisma.ProjectWikiSettingsUncheckedUpdateManyInput,
): Promise<void> {
  const { count } = await db.projectWikiSettings.updateMany({
    where: { projectId, revision: expectedRevision },
    data: { ...data, revision: { increment: 1 } },
  });
  if (count === 0) throw stale();
}

async function requireRow(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  expectedRevision: number,
): Promise<ProjectWikiSettings> {
  const row = await db.projectWikiSettings.findUnique({ where: { projectId } });
  if (!row) throw new CoreError("NOT_FOUND", "The wiki has not been enabled");
  if (row.revision !== expectedRevision) throw stale();
  return row;
}

async function view(
  db: PrismaClient,
  projectId: string,
  row: ProjectWikiSettings | null,
): Promise<WikiSettingsView> {
  const [agent, openSuggestions, guideRow, route] = await Promise.all([
    row?.agentId
      ? db.wikiAgent.findUnique({ where: { id: row.agentId } })
      : null,
    db.wikiGuideSuggestion.count({ where: { projectId, resolvedAt: null } }),
    row?.guideDocumentId
      ? db.document.findFirst({
          where: { id: row.guideDocumentId, projectId },
          select: { title: true },
        })
      : null,
    resolveLlmRoute(db, "wiki"),
  ]);
  return {
    projectId,
    revision: row?.revision ?? 0,
    enabled: row?.enabled ?? false,
    routeReady: route !== null,
    agent: agent
      ? {
          id: agent.id,
          createdAt: agent.createdAt,
          live: agent.revokedAt === null,
        }
      : null,
    enabledAt: row?.enabledAt ?? null,
    guide: {
      documentId: row?.guideDocumentId ?? null,
      title: guideRow?.title ?? null,
      approved: row?.approvedGuideDigest != null,
      approvedAt: row?.approvedGuideAt ?? null,
      approvedById: row?.approvedGuideById ?? null,
    },
    overviewDocumentId: row?.overviewDocumentId ?? null,
    sourcesFolderId: row?.sourcesFolderId ?? null,
    openSuggestions,
    destructiveBudget24h: row?.destructiveBudget24h ?? 100_000,
    destructivePausedAt: row?.destructivePausedAt ?? null,
    spendAlertCentsPerDay: row?.spendAlertCentsPerDay ?? null,
    lintSchedule: row?.lintSchedule ?? null,
  };
}

function changed(
  projectId: string,
  change: string,
  revision: number | null,
): void {
  emitDiagnostic({
    event: "wiki.settings.changed",
    message: "Wiki settings changed",
    projectId,
    details: { change, revision },
  });
}

async function currentView(
  db: PrismaClient,
  projectId: string,
): Promise<WikiSettingsView> {
  return view(
    db,
    projectId,
    await db.projectWikiSettings.findUnique({ where: { projectId } }),
  );
}

/** Maintainers and Owners see the card; the guide and approval are theirs. */
export async function getWikiSettings(
  db: PrismaClient,
  actor: Actor,
  projectId: string,
): Promise<WikiSettingsView> {
  await requireRole(db, actor, projectId, "Maintainer", false);
  return currentView(db, projectId);
}

export async function enableWiki(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; expectedRevision: number },
): Promise<WikiSettingsView> {
  const { projectId } = input;
  await requireRole(db, actor, projectId, "Owner", true);
  const { row, agentId, wasEnabled } = await db.$transaction(async (tx) => {
    await requireRole(tx, actor, projectId, "Owner", true);
    const existing = await tx.projectWikiSettings.findUnique({
      where: { projectId },
    });
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw stale();
    const agent = await createWikiAgent(tx, projectId);
    const enabled = existing?.enabled === true && existing.agentId === agent.id;
    if (enabled) return { row: existing, agentId: agent.id, wasEnabled: true };
    const data = {
      enabled: true,
      agentId: agent.id,
      enabledById: actor.userId,
      enabledAt: new Date(),
    };
    if (!existing) {
      try {
        const created = await tx.projectWikiSettings.create({
          data: { projectId, ...data },
        });
        return { row: created, agentId: agent.id, wasEnabled: false };
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw stale();
        throw error;
      }
    }
    await guarded(tx, projectId, existing.revision, data);
    return {
      row: await tx.projectWikiSettings.findUniqueOrThrow({
        where: { projectId },
      }),
      agentId: agent.id,
      wasEnabled: false,
    };
  });

  const record = async (patch: WikiBootstrapRecord): Promise<void> => {
    const guide = patch.guide;
    await db.projectWikiSettings.updateMany({
      where: { projectId, agentId, enabled: true },
      data: {
        ...(patch.sourcesFolderId
          ? { sourcesFolderId: patch.sourcesFolderId }
          : {}),
        ...(patch.overviewDocumentId
          ? { overviewDocumentId: patch.overviewDocumentId }
          : {}),
      },
    });
    if (guide)
      await db.projectWikiSettings.updateMany({
        where: { projectId, agentId, enabled: true, guideDocumentId: null },
        data: {
          guideDocumentId: guide.documentId,
          approvedGuideBody: guide.text,
          approvedGuideDigest: guide.digest,
          approvedGuideCommitSha: guide.commitSha,
          approvedGuideAt: new Date(),
          approvedGuideById: null,
        },
      });
  };
  try {
    await runWikiBootstrap(db, {
      projectId,
      agentId,
      existing: {
        sourcesFolderId: row.sourcesFolderId,
        guideDocumentId: row.guideDocumentId,
        overviewDocumentId: row.overviewDocumentId,
      },
      record,
    });
  } catch (error) {
    // Steps are idempotent, so a failed first enable rolls back to off and can simply be retried.
    if (!wasEnabled)
      await db.projectWikiSettings.updateMany({
        where: { projectId, agentId, enabled: true },
        data: { enabled: false, revision: { increment: 1 } },
      });
    throw error;
  }
  const result = await currentView(db, projectId);
  if (!wasEnabled) changed(projectId, "enabled", result.revision);
  return result;
}

export async function disableWiki(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; expectedRevision: number },
): Promise<WikiSettingsView> {
  await requireRole(db, actor, input.projectId, "Owner", true);
  await db.$transaction(async (tx) => {
    await requireRow(tx, input.projectId, input.expectedRevision);
    // TODO(wiki slice 5): cancel queued and preparing runs and abort a running one.
    await guarded(tx, input.projectId, input.expectedRevision, {
      enabled: false,
    });
  });
  const result = await currentView(db, input.projectId);
  changed(input.projectId, "disabled", result.revision);
  return result;
}

export async function revokeAgent(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; expectedRevision: number },
): Promise<WikiSettingsView> {
  await requireRole(db, actor, input.projectId, "Owner", true);
  await db.$transaction(async (tx) => {
    await requireRow(tx, input.projectId, input.expectedRevision);
    await revokeWikiAgent(tx, { projectId: input.projectId });
    await guarded(tx, input.projectId, input.expectedRevision, {
      enabled: false,
    });
  });
  const result = await currentView(db, input.projectId);
  changed(input.projectId, "revoked", result.revision);
  return result;
}

export async function updateWikiSettings(
  db: PrismaClient,
  actor: Actor,
  input: {
    projectId: string;
    expectedRevision: number;
    destructiveBudget24h?: number;
    spendAlertCentsPerDay?: number | null;
  },
): Promise<WikiSettingsView> {
  await requireRole(db, actor, input.projectId, "Owner", true);
  const budget = input.destructiveBudget24h;
  const alert = input.spendAlertCentsPerDay;
  if (
    budget !== undefined &&
    (!Number.isInteger(budget) ||
      budget < WIKI_BUDGET_MIN ||
      budget > WIKI_BUDGET_MAX)
  )
    throw new CoreError("BAD_REQUEST", "Invalid destructive budget", {
      field: "destructiveBudget24h",
    });
  if (
    alert != null &&
    (!Number.isInteger(alert) ||
      alert < 1 ||
      alert > WIKI_SPEND_ALERT_MAX_CENTS)
  )
    throw new CoreError("BAD_REQUEST", "Invalid spend alert", {
      field: "spendAlertCentsPerDay",
    });
  await db.$transaction(async (tx) => {
    await requireRow(tx, input.projectId, input.expectedRevision);
    await guarded(tx, input.projectId, input.expectedRevision, {
      ...(budget !== undefined
        ? { destructiveBudget24h: budget, destructivePausedAt: null }
        : {}),
      ...(alert !== undefined ? { spendAlertCentsPerDay: alert } : {}),
    });
  });
  const result = await currentView(db, input.projectId);
  changed(input.projectId, "settings", result.revision);
  return result;
}

export async function setGuideDocument(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; expectedRevision: number; documentId: string },
): Promise<WikiSettingsView> {
  await requireRole(db, actor, input.projectId, "Owner", true);
  const document = await db.document.findFirst({
    where: { id: input.documentId, projectId: input.projectId },
    select: { kind: true, wikiSourceItemId: true },
  });
  if (!document) throw new CoreError("NOT_FOUND", "Document not found");
  if (document.kind !== "markdown" || document.wikiSourceItemId !== null)
    throw new CoreError("BAD_REQUEST", "This document cannot be the guide", {
      field: "documentId",
    });
  const taskOutputs =
    (await db.scheduledTask.count({
      where: {
        outputProjectId: input.projectId,
        outputDocumentId: input.documentId,
      },
    })) +
    (await db.scheduledTaskRun.count({
      where: { outputDocumentId: input.documentId },
    }));
  if (taskOutputs > 0)
    throw new CoreError("BAD_REQUEST", "This document cannot be the guide", {
      field: "documentId",
    });
  await db.$transaction(async (tx) => {
    const row = await requireRow(tx, input.projectId, input.expectedRevision);
    if (row.guideDocumentId === input.documentId) return;
    await guarded(tx, input.projectId, input.expectedRevision, {
      guideDocumentId: input.documentId,
      approvedGuideBody: null,
      approvedGuideDigest: null,
      approvedGuideCommitSha: null,
      approvedGuideAt: null,
      approvedGuideById: null,
    });
  });
  const result = await currentView(db, input.projectId);
  changed(input.projectId, "guide-document", result.revision);
  return result;
}

async function readGuide(
  db: PrismaClient,
  actor: Actor,
  row: ProjectWikiSettings,
) {
  if (!row.guideDocumentId)
    throw new CoreError("PRECONDITION_FAILED", "No guide document is set");
  const read = await getDocumentAtSnapshot(
    db,
    { projectId: row.projectId, documentId: row.guideDocumentId },
    actor,
  );
  const normalized = normalizeGuideText(read.markdown);
  return { read, normalized, bytes: guideByteLength(normalized.text) };
}

/** Shows exactly what a run would inject, with what was removed, the change since approval and advisory flags. */
export async function reviewGuide(
  db: PrismaClient,
  actor: Actor,
  projectId: string,
): Promise<WikiGuideReview> {
  await requireRole(db, actor, projectId, "Maintainer", false);
  const row = await db.projectWikiSettings.findUnique({ where: { projectId } });
  if (!row) throw new CoreError("NOT_FOUND", "The wiki has not been enabled");
  const { read, normalized, bytes } = await readGuide(db, actor, row);
  const tooLarge = bytes > GUIDE_MAX_BYTES;
  return {
    revision: row.revision,
    documentId: read.id,
    title: read.title,
    text: tooLarge ? "" : normalized.text,
    digest: normalized.digest,
    bytes,
    tooLarge,
    removed: normalized.removed,
    matchesApproved: row.approvedGuideDigest === normalized.digest,
    approvedAt: row.approvedGuideAt,
    diff: tooLarge ? [] : guideDiff(row.approvedGuideBody, normalized.text),
    flags: tooLarge ? [] : guideAdvisoryFlags(normalized.text),
  };
}

export async function approveGuide(
  db: PrismaClient,
  actor: Actor,
  input: {
    projectId: string;
    expectedRevision: number;
    expectedDigest: string;
  },
): Promise<WikiSettingsView> {
  await requireRole(db, actor, input.projectId, "Maintainer", true);
  const row = await requireRow(db, input.projectId, input.expectedRevision);
  const { read, normalized, bytes } = await readGuide(db, actor, row);
  if (bytes > GUIDE_MAX_BYTES)
    throw new CoreError(
      "BAD_REQUEST",
      `The guide is over ${GUIDE_MAX_BYTES.toLocaleString("en-US")} bytes; shorten it before approving`,
      { reason: "GUIDE_TOO_LARGE" },
    );
  if (normalized.digest !== input.expectedDigest)
    throw new CoreError(
      "CONFLICT",
      "The guide changed since it was reviewed. Review it again.",
      { reason: "GUIDE_CHANGED" },
    );
  await db.$transaction(async (tx) => {
    await requireRow(tx, input.projectId, input.expectedRevision);
    await guarded(tx, input.projectId, input.expectedRevision, {
      approvedGuideBody: normalized.text,
      approvedGuideDigest: normalized.digest,
      approvedGuideCommitSha: read.baseCommitSha,
      approvedGuideAt: new Date(),
      approvedGuideById: actor.userId,
    });
  });
  const result = await currentView(db, input.projectId);
  emitDiagnostic({
    event: "wiki.guide.approved",
    message: "Wiki guide approved",
    projectId: input.projectId,
    details: { digest: normalized.digest, bytes, revision: result.revision },
  });
  return result;
}

export async function listGuideSuggestions(
  db: PrismaClient,
  actor: Actor,
  projectId: string,
): Promise<Pick<WikiGuideSuggestion, "id" | "text" | "createdAt">[]> {
  await requireRole(db, actor, projectId, "Maintainer", false);
  return db.wikiGuideSuggestion.findMany({
    where: { projectId, resolvedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, text: true, createdAt: true },
  });
}

export async function resolveGuideSuggestion(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; suggestionId: string },
): Promise<void> {
  await requireRole(db, actor, input.projectId, "Maintainer", true);
  const { count } = await db.wikiGuideSuggestion.updateMany({
    where: {
      id: input.suggestionId,
      projectId: input.projectId,
      resolvedAt: null,
    },
    data: { resolvedAt: new Date(), resolvedById: actor.userId },
  });
  if (count === 0) throw new CoreError("NOT_FOUND");
}

/** What the agent write path may not touch, read at the moment of the write. */
export async function wikiWriteGuardsFor(
  db: PrismaClient,
  projectId: string,
): Promise<WikiWriteGuards> {
  const row = await db.projectWikiSettings.findUnique({
    where: { projectId },
    select: {
      guideDocumentId: true,
      sourcesFolderId: true,
      sourceTablesFolderId: true,
    },
  });
  const repo = await openProjectRepo(projectId);
  if (!repo) throw new CoreError("NOT_FOUND", "Project repository is missing");
  const head = await repo.resolveHead();
  const sourceFolderPaths: string[] = [];
  let sourceFoldersUnresolved = false;
  const resolve = async (id: string | null | undefined, scope: FolderScope) => {
    if (!id) return;
    const index = await loadFolderIdentityIndex(repo, projectId, scope, head);
    const entry = index.byId.get(id);
    if (!entry) sourceFoldersUnresolved = true;
    else if (scope === "documents")
      sourceFolderPaths.push(entry.path.join("/"));
  };
  await resolve(row?.sourcesFolderId, "documents");
  await resolve(row?.sourceTablesFolderId, "tables");
  return {
    guideDocumentId: row?.guideDocumentId ?? null,
    sourceFolderPaths,
    sourceFoldersUnresolved,
  };
}

export type ApprovedWikiGuide = {
  digest: string;
  body: string;
  approvedAt: Date | null;
} | null;

/** The approved text a run or tool may use; null when the wiki is off or nothing is approved. */
export async function readApprovedWikiGuide(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
): Promise<ApprovedWikiGuide> {
  await assertProjectRole(db, projectId, actor, "Viewer");
  const row = await db.projectWikiSettings.findUnique({
    where: { projectId },
    select: {
      enabled: true,
      approvedGuideBody: true,
      approvedGuideDigest: true,
      approvedGuideAt: true,
    },
  });
  if (!row?.enabled || row.approvedGuideBody === null) return null;
  return {
    digest: row.approvedGuideDigest!,
    body: row.approvedGuideBody,
    approvedAt: row.approvedGuideAt,
  };
}

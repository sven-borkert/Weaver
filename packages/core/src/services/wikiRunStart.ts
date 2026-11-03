import type { PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { normalizeGuideText } from "../wiki/guideText";
import { WIKI_PAGE_TYPES } from "../wiki/properties";
import {
  createdResourceId,
  matchesRecoveryIdentity,
  recoverPriorOperation,
  type ContentOperation,
  type RecoveryIdentity,
} from "./contentOperations";
import { repairDocumentProjectionInRepo } from "./documents";
import { withExistingProjectRepo } from "./projectRepo";
import type { LeasedWikiRun } from "./wikiRuns";

const RECOVERY_LOOKUP_LIMIT = 11;

/** Re-verifies the approved digest; a mismatch or no approval means the run cannot start. */
export async function readRunGuide(
  db: PrismaClient,
  projectId: string,
): Promise<string | null> {
  const row = await db.projectWikiSettings.findUnique({
    where: { projectId },
    select: { approvedGuideBody: true, approvedGuideDigest: true },
  });
  if (!row?.approvedGuideBody || !row.approvedGuideDigest) return null;
  return normalizeGuideText(row.approvedGuideBody).digest ===
    row.approvedGuideDigest
    ? row.approvedGuideBody
    : null;
}

/** Counts over the fixed vocabulary; no authored value leaves this function. */
export async function wikiIndexHead(
  db: PrismaClient,
  projectId: string,
): Promise<{ types: Record<string, number>; depths: Record<string, number> }> {
  const rows = await db.document.findMany({
    where: { projectId, wikiSourceItemId: null },
    select: { wikiType: true, path: true },
  });
  const vocabulary = new Set<string>(WIKI_PAGE_TYPES);
  const types: Record<string, number> = {};
  const depths: Record<string, number> = {};
  for (const row of rows) {
    const type =
      row.wikiType && vocabulary.has(row.wikiType) ? row.wikiType : "other";
    types[type] = (types[type] ?? 0) + 1;
    const depth = String(row.path.split("/").length - 1);
    depths[depth] = (depths[depth] ?? 0) + 1;
  }
  return { types, depths };
}

export type RestartBriefingItem = {
  id: string;
  status: string;
  pages: Array<{
    toolName: string;
    documentId: string | null;
    path: string | null;
    commitSha: string | null;
  }>;
};

/** Ledger fields only: ids, paths, tool names and commits, never authored text. */
export async function buildRestartBriefing(
  db: PrismaClient,
  runId: string,
  kind: "ingest" | "lint" = "ingest",
): Promise<RestartBriefingItem[]> {
  if (kind === "lint") {
    const operations = await db.wikiRunOperation.findMany({
      where: { runId, status: "committed" },
      orderBy: { n: "asc" },
      select: {
        toolName: true,
        documentId: true,
        path: true,
        commitSha: true,
      },
    });
    return [{ id: runId, status: "lint", pages: operations }];
  }
  const items = await db.wikiInputItem.findMany({
    where: { runId, status: { in: ["ready", "processing"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, status: true },
  });
  const operations = await db.wikiRunOperation.findMany({
    where: {
      runId,
      status: "committed",
      inputItemId: { in: items.map((item) => item.id) },
    },
    orderBy: { n: "asc" },
    select: {
      inputItemId: true,
      toolName: true,
      documentId: true,
      path: true,
      commitSha: true,
    },
  });
  return items.map((item) => ({
    id: item.id,
    status: item.status,
    pages: operations
      .filter((operation) => operation.inputItemId === item.id)
      .map(({ inputItemId: _inputItemId, ...page }) => page),
  }));
}

/**
 * A reserved row means a write may or may not have landed. Only a ledger-trusted commit with this
 * agent's trailer and the reserved request hash counts; anything else under the id is not ours.
 */
export async function reconcileReservedOperations(
  db: PrismaClient,
  lease: Pick<LeasedWikiRun, "id" | "projectId" | "agentId">,
): Promise<{ committed: number; failed: number }> {
  const reserved = await db.wikiRunOperation.findMany({
    where: { runId: lease.id, status: "reserved" },
    orderBy: { n: "asc" },
  });
  const counts = { committed: 0, failed: 0 };
  if (reserved.length === 0) return counts;
  await withExistingProjectRepo(lease.projectId, async (repo) => {
    for (const operation of reserved) {
      const identity: RecoveryIdentity = {
        wikiAgentId: lease.agentId,
        wikiRequestHash: operation.requestHash,
      };
      let found: { commitSha: string; documentId: string | null } | null = null;
      let conflict = false;
      try {
        if (operation.toolName === "wiki_create_page") {
          const recovered = await recoverPriorOperation(
            db,
            repo,
            {
              kind: "document.create",
              projectId: lease.projectId,
            } as ContentOperation,
            operation.operationId,
            identity,
          );
          if (recovered)
            found = {
              commitSha: recovered.commitSha,
              documentId: createdResourceId(operation.operationId),
            };
        } else {
          const entries = await repo.logForPath(".", {
            skip: 0,
            limit: RECOVERY_LOOKUP_LIMIT,
            operationId: operation.operationId,
          });
          const matching = entries.filter(
            (entry) => entry.operationId === operation.operationId,
          );
          if (matching.length > 0) {
            const entry = matching.length === 1 ? matching[0]! : null;
            if (!entry || !matchesRecoveryIdentity(entry, identity))
              conflict = true;
            else
              found = {
                commitSha: entry.sha,
                documentId: operation.documentId,
              };
          }
        }
      } catch (error) {
        if (!(error instanceof CoreError) || error.code !== "CONFLICT")
          throw error;
        conflict = true;
      }
      if (conflict)
        emitDiagnostic({
          event: "wiki.run.failed",
          severity: "warn",
          message: "a commit under a wiki operation id could not be verified",
          outcome: "error",
          projectId: lease.projectId,
          details: { runId: lease.id, n: operation.n },
        });
      if (!found) {
        await db.wikiRunOperation.update({
          where: { runId_n: { runId: lease.id, n: operation.n } },
          data: { status: "failed" },
        });
        counts.failed += 1;
        continue;
      }
      const page =
        found.documentId === null
          ? null
          : await repairDocumentProjectionInRepo(
              db,
              repo,
              lease.projectId,
              found.documentId,
            );
      await db.wikiRunOperation.update({
        where: { runId_n: { runId: lease.id, n: operation.n } },
        data: {
          status: "committed",
          commitSha: found.commitSha,
          committedAt: new Date(),
          documentId: found.documentId,
          ...(page ? { path: page.path.slice(0, 1_024) } : {}),
        },
      });
      counts.committed += 1;
    }
  });
  return counts;
}

export type LintStartContext = {
  today: string;
  previousLintAt: string | null;
  reportDocumentId: string | null;
};

/** System-side facts only: a date, the last good lint's start and the report page id. */
export async function lintStartContext(
  db: PrismaClient,
  runId: string,
  projectId: string,
  now: Date = new Date(),
): Promise<LintStartContext> {
  const previous = await db.wikiRun.findFirst({
    where: {
      projectId,
      kind: "lint",
      status: "succeeded",
      id: { not: runId },
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { startedAt: true },
  });
  return {
    today: now.toISOString().slice(0, 10),
    previousLintAt: previous?.startedAt.toISOString() ?? null,
    reportDocumentId: (await liveLintReport(db, projectId, runId)).id,
  };
}

/**
 * The recorded report page when it still resolves (a dangling id counts as none), else the page this
 * run committed itself, which covers a crash between the commit and recording the id.
 */
export async function liveLintReport(
  db: PrismaClient,
  projectId: string,
  runId: string,
): Promise<{ id: string | null; recorded: string | null }> {
  const settings = await db.projectWikiSettings.findUnique({
    where: { projectId },
    select: { reportDocumentId: true },
  });
  const recorded = settings?.reportDocumentId ?? null;
  if (recorded) {
    const live = await db.document.findFirst({
      where: { id: recorded, projectId },
      select: { id: true },
    });
    if (live) return { id: live.id, recorded };
  }
  const own = await db.wikiRunOperation.findMany({
    where: {
      runId,
      toolName: "wiki_create_page",
      status: "committed",
      documentId: { not: null },
    },
    orderBy: { n: "asc" },
    select: { documentId: true },
  });
  for (const op of own) {
    const live = await db.document.findFirst({
      where: { id: op.documentId!, projectId },
      select: { id: true },
    });
    if (live) return { id: live.id, recorded };
  }
  return { id: null, recorded };
}

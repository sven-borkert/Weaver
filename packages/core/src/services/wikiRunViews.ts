import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import { projectRoleAtLeast } from "../roles";
import { CoreError } from "../errors";
import type { UserSecurityContext } from "../security/context";
import { assertProjectRole } from "./projectAccess";
import type { WikiRevertReport } from "./wikiRevert";

const RUNS_PAGE = 25;
const MAX_DETAIL_OPERATIONS = 150;
const TERMINAL = new Set(["succeeded", "stopped", "failed", "cancelled"]);

export type WikiRunRow = {
  id: string;
  kind: string;
  trigger: string;
  status: string;
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedBy: string | null;
  startedAt: Date;
  endedAt: Date | null;
  items: number;
  pagesCreated: number;
  pagesPatched: number;
  usageTokens: number;
  costMicros: bigint;
  currency: string | null;
  /** Maintainer+ only; null for everyone else. */
  indexingCostMicros: bigint | null;
};

type OperationRow = {
  runId: string;
  toolName: string;
  status: string;
  documentId: string | null;
  commitSha: string | null;
};

function pageCounts(operations: readonly OperationRow[], runId: string) {
  const committed = operations.filter(
    (operation) =>
      operation.runId === runId &&
      operation.status === "committed" &&
      operation.documentId,
  );
  const created = new Set(
    committed
      .filter((operation) => operation.toolName === "wiki_create_page")
      .map((operation) => operation.documentId),
  );
  const patched = new Set(
    committed
      .filter((operation) => operation.toolName === "wiki_patch_page")
      .map((operation) => operation.documentId),
  );
  for (const id of created) patched.delete(id);
  return { pagesCreated: created.size, pagesPatched: patched.size };
}

async function canSeeCost(
  db: PrismaClient,
  actor: UserSecurityContext,
  projectId: string,
): Promise<boolean> {
  const access = await assertProjectRole(db, projectId, actor, "Viewer");
  return projectRoleAtLeast(access.effectiveRole, "Maintainer");
}

/** The cost of indexing a run's commits, joined at read time through the enrichment's own column. */
async function indexingCosts(
  db: PrismaClient,
  projectId: string,
  operations: readonly OperationRow[],
): Promise<Map<string, bigint>> {
  const byCommit = new Map<string, string>();
  for (const operation of operations)
    if (operation.commitSha) byCommit.set(operation.commitSha, operation.runId);
  const costs = new Map<string, bigint>();
  if (byCommit.size === 0) return costs;
  const rows = await db.aiUsage.findMany({
    where: { projectId, sourceCommitSha: { in: [...byCommit.keys()] } },
    select: { sourceCommitSha: true, costMicros: true },
  });
  for (const row of rows) {
    const runId = byCommit.get(row.sourceCommitSha!);
    if (runId)
      costs.set(runId, (costs.get(runId) ?? 0n) + (row.costMicros ?? 0n));
  }
  return costs;
}

function currencyOf(snapshot: unknown): string | null {
  const value = (snapshot as { currency?: unknown } | null)?.currency;
  return typeof value === "string" ? value : null;
}

export async function listRuns(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string; cursor?: string },
): Promise<{ runs: WikiRunRow[]; nextCursor: string | null }> {
  const maintainer = await canSeeCost(db, actor, input.projectId);
  const rows = await db.wikiRun.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: RUNS_PAGE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      kind: true,
      trigger: true,
      status: true,
      stopReason: true,
      errorCode: true,
      errorMessage: true,
      startedAt: true,
      endedAt: true,
      usageTokens: true,
      usageCostMicros: true,
      routeSnapshot: true,
      startedBy: { select: { name: true, email: true } },
      _count: { select: { items: true } },
    },
  });
  const page = rows.slice(0, RUNS_PAGE);
  const operations = await db.wikiRunOperation.findMany({
    where: { runId: { in: page.map((row) => row.id) } },
    select: {
      runId: true,
      toolName: true,
      status: true,
      documentId: true,
      commitSha: true,
    },
  });
  const costs = maintainer
    ? await indexingCosts(db, input.projectId, operations)
    : null;
  return {
    runs: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      trigger: row.trigger,
      status: row.status,
      stopReason: row.stopReason,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      startedBy: row.startedBy
        ? (row.startedBy.name ?? row.startedBy.email)
        : null,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      items: row._count.items,
      ...pageCounts(operations, row.id),
      usageTokens: row.usageTokens,
      costMicros: row.usageCostMicros,
      currency: currencyOf(row.routeSnapshot),
      indexingCostMicros: costs ? (costs.get(row.id) ?? 0n) : null,
    })),
    nextCursor: rows.length > RUNS_PAGE ? page.at(-1)!.id : null,
  };
}

export type WikiRunDetail = WikiRunRow & {
  /** Plain text by the agent; a revert's summary is Weaver's own. */
  summary: string | null;
  summaryByAgent: boolean;
  inputs: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    outcomeNote: string | null;
  }>;
  commits: Array<{
    n: number;
    toolName: string;
    documentId: string | null;
    path: string | null;
    baseCommitSha: string | null;
    commitSha: string;
    committedAt: Date | null;
    /** Only a ledger-trusted commit under this run's id earns the agent's badge. */
    verified: boolean;
    indexingPending: boolean;
  }>;
  report: WikiRevertReport | null;
  revertible: boolean;
  revertedByRunId: string | null;
};

export async function getRun(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string; runId: string },
): Promise<WikiRunDetail> {
  const listed = await db.wikiRun.findFirst({
    where: { id: input.runId, projectId: input.projectId },
    select: { startedAt: true },
  });
  const maintainer = await canSeeCost(db, actor, input.projectId);
  if (!listed) throw new CoreError("NOT_FOUND", "Wiki run not found");
  const run = await db.wikiRun.findUniqueOrThrow({
    where: { id: input.runId },
    include: {
      startedBy: { select: { name: true, email: true } },
      items: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          kind: true,
          status: true,
          outcomeNote: true,
        },
      },
      revertedBy: {
        where: { status: { in: ["succeeded", "running", "queued"] } },
        select: { id: true },
        take: 1,
      },
    },
  });
  const operations = await db.wikiRunOperation.findMany({
    where: { runId: run.id },
    orderBy: { n: "asc" },
    take: MAX_DETAIL_OPERATIONS,
  });
  const committed = operations.filter(
    (operation) => operation.status === "committed" && operation.commitSha,
  );
  const repo = await openProjectRepo(input.projectId);
  const documentIds = committed.flatMap((operation) =>
    operation.documentId ? [operation.documentId] : [],
  );
  const indexing = await db.documentIndexState.findMany({
    where: { documentId: { in: documentIds } },
    select: { documentId: true, status: true },
  });
  const pending = new Set(
    indexing
      .filter((state) => state.status !== "ready")
      .map((state) => state.documentId),
  );
  const commits: WikiRunDetail["commits"] = [];
  for (const operation of committed) {
    let verified = false;
    try {
      const [entry] = repo
        ? await repo.logChangesBefore(operation.commitSha!, { limit: 1 })
        : [];
      verified =
        entry?.sha === operation.commitSha &&
        entry.trustedAuthor === true &&
        entry.operationId === operation.operationId &&
        (run.kind === "revert"
          ? !entry.wikiAgentId
          : entry.wikiAgentId === run.agentId);
    } catch {
      verified = false;
    }
    commits.push({
      n: operation.n,
      toolName: operation.toolName,
      documentId: operation.documentId,
      path: operation.path,
      baseCommitSha: operation.baseCommitSha,
      commitSha: operation.commitSha!,
      committedAt: operation.committedAt,
      verified,
      indexingPending:
        operation.documentId !== null && pending.has(operation.documentId),
    });
  }
  const costs = maintainer
    ? await indexingCosts(db, input.projectId, operations)
    : null;
  return {
    id: run.id,
    kind: run.kind,
    trigger: run.trigger,
    status: run.status,
    stopReason: run.stopReason,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    startedBy: run.startedBy
      ? (run.startedBy.name ?? run.startedBy.email)
      : null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    items: run.items.length,
    ...pageCounts(operations, run.id),
    usageTokens: run.usageTokens,
    costMicros: run.usageCostMicros,
    currency: currencyOf(run.routeSnapshot),
    indexingCostMicros: costs ? (costs.get(run.id) ?? 0n) : null,
    summary: run.summary,
    summaryByAgent: run.kind !== "revert",
    inputs: run.items,
    commits,
    report: (run.report as WikiRevertReport | null) ?? null,
    revertible:
      run.kind !== "revert" &&
      TERMINAL.has(run.status) &&
      committed.length > 0 &&
      run.revertedBy.length === 0,
    revertedByRunId: run.revertedBy[0]?.id ?? null,
  };
}

/** 30-day totals for the Runs tab; indexing cost is Maintainer+ only. */
export async function wikiUsageSummary(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string },
  now: Date = new Date(),
): Promise<{
  tokens: number;
  costMicros: bigint;
  currency: string | null;
  indexingCostMicros: bigint | null;
}> {
  const maintainer = await canSeeCost(db, actor, input.projectId);
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const [usage, latest] = await Promise.all([
    db.aiUsage.aggregate({
      where: {
        projectId: input.projectId,
        operation: "wiki.run",
        createdAt: { gte: since },
      },
      _sum: { totalTokens: true, costMicros: true },
    }),
    db.aiUsage.findFirst({
      where: {
        projectId: input.projectId,
        operation: "wiki.run",
        currency: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { currency: true },
    }),
  ]);
  let indexingCostMicros: bigint | null = null;
  if (maintainer) {
    const operations = await db.wikiRunOperation.findMany({
      where: {
        status: "committed",
        committedAt: { gte: since },
        run: { projectId: input.projectId },
      },
      select: {
        runId: true,
        toolName: true,
        status: true,
        documentId: true,
        commitSha: true,
      },
    });
    const costs = await indexingCosts(db, input.projectId, operations);
    indexingCostMicros = [...costs.values()].reduce((a, b) => a + b, 0n);
  }
  return {
    tokens: usage._sum.totalTokens ?? 0,
    costMicros: usage._sum.costMicros ?? 0n,
    currency: latest?.currency ?? null,
    indexingCostMicros,
  };
}

import type { Prisma, PrismaClient } from "@weaver/db/client";
import type { GitLogEntry, ProjectRepoReader } from "@weaver/git-store";

type Db = PrismaClient | Prisma.TransactionClient;

type OwnershipEntry = Pick<
  GitLogEntry,
  "sha" | "trustedAuthor" | "wikiAgentId" | "operationId" | "runId"
>;

export type OwnedPageRow = {
  runId: string;
  lastAgentCommitSha: string;
};

export type OwnershipDecision =
  | { action: "keep" }
  | { action: "delete" }
  | { action: "advance"; lastAgentCommitSha: string }
  | {
      action: "insert";
      runId: string;
      createdCommitSha: string;
      lastAgentCommitSha: string;
    };

const OWNERSHIP_WALK_LIMIT = 200;

/** Only a ledger-trusted run commit of a live agent counts; sources and bootstrap never own. */
export function isOwningCommit(
  entry: OwnershipEntry,
  liveAgentIds: ReadonlySet<string>,
): boolean {
  return (
    entry.trustedAuthor === true &&
    typeof entry.wikiAgentId === "string" &&
    liveAgentIds.has(entry.wikiAgentId) &&
    entry.operationId?.startsWith("wiki-run:") === true &&
    typeof entry.runId === "string"
  );
}

/** Pure decision over one page's history, newest first. `complete` means history reaches its first commit. */
export function decideOwnership(input: {
  existing: OwnedPageRow | null;
  history: readonly OwnershipEntry[];
  complete: boolean;
  liveAgentIds: ReadonlySet<string>;
}): OwnershipDecision {
  const { existing, history, liveAgentIds } = input;
  const head = history[0];
  const noRow: OwnershipDecision = existing
    ? { action: "delete" }
    : { action: "keep" };
  if (!head || !isOwningCommit(head, liveAgentIds)) return noRow;
  if (existing) {
    if (existing.lastAgentCommitSha === head.sha) return { action: "keep" };
    // A missed non-agent commit must not be papered over by the agent's next one.
    if (history[1]?.sha === existing.lastAgentCommitSha)
      return { action: "advance", lastAgentCommitSha: head.sha };
  }
  if (
    !input.complete ||
    !history.every((entry) => isOwningCommit(entry, liveAgentIds))
  )
    return noRow;
  const first = history.at(-1)!;
  return {
    action: "insert",
    runId: first.runId!,
    createdCommitSha: first.sha,
    lastAgentCommitSha: head.sha,
  };
}

async function liveAgents(
  db: Db,
  projectId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db.wikiAgent.findMany({
    where: { projectId, revokedAt: null },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/** Reads Git only when the page has a row or its head can be an agent commit. */
export async function deriveOwnership(
  db: Db,
  repo: Pick<ProjectRepoReader, "logForPath">,
  input: {
    projectId: string;
    documentId: string;
    path: string;
    sha: string;
    headIsAgent: boolean;
  },
): Promise<OwnershipDecision> {
  const existing = await db.wikiOwnedPage.findUnique({
    where: { documentId: input.documentId },
    select: { runId: true, lastAgentCommitSha: true },
  });
  if (!existing && !input.headIsAgent) return { action: "keep" };
  const liveAgentIds = await liveAgents(db, input.projectId);
  if (liveAgentIds.size === 0)
    return existing ? { action: "delete" } : { action: "keep" };
  const limit = OWNERSHIP_WALK_LIMIT + 1;
  const history = await repo.logForPath(input.path, {
    skip: 0,
    limit,
    commitish: input.sha,
  });
  const decision = decideOwnership({
    existing,
    history,
    complete: history.length < limit,
    liveAgentIds,
  });
  if (decision.action !== "insert") return decision;
  const run = await db.wikiRun.findFirst({
    where: { id: decision.runId, projectId: input.projectId },
    select: { id: true },
  });
  return run ? decision : existing ? { action: "delete" } : { action: "keep" };
}

/** Called inside the projection's transaction, so the row and the projection move together. */
export async function applyOwnershipDecision(
  tx: Db,
  input: { projectId: string; documentId: string },
  decision: OwnershipDecision,
): Promise<void> {
  switch (decision.action) {
    case "keep":
      return;
    case "delete":
      await tx.wikiOwnedPage.deleteMany({
        where: { documentId: input.documentId },
      });
      return;
    case "advance":
      await tx.wikiOwnedPage.update({
        where: { documentId: input.documentId },
        data: { lastAgentCommitSha: decision.lastAgentCommitSha },
      });
      return;
    case "insert":
      await tx.wikiOwnedPage.upsert({
        where: { documentId: input.documentId },
        create: {
          documentId: input.documentId,
          projectId: input.projectId,
          runId: decision.runId,
          createdCommitSha: decision.createdCommitSha,
          lastAgentCommitSha: decision.lastAgentCommitSha,
        },
        update: {
          runId: decision.runId,
          createdCommitSha: decision.createdCommitSha,
          lastAgentCommitSha: decision.lastAgentCommitSha,
        },
      });
  }
}

/** The row is a cache: under the project lock, Git has the last word. */
export async function isOwnedAtWrite(
  db: PrismaClient,
  repo: Pick<ProjectRepoReader, "lastCommitForPath">,
  input: { documentId: string; path: string; agentId: string },
): Promise<boolean> {
  const row = await db.wikiOwnedPage.findUnique({
    where: { documentId: input.documentId },
    select: { lastAgentCommitSha: true, run: { select: { agentId: true } } },
  });
  if (row?.run.agentId !== input.agentId) return false;
  return (await repo.lastCommitForPath(input.path)) === row.lastAgentCommitSha;
}

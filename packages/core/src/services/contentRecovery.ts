import type { PrismaClient } from "@weaver/db/client";
import { parseDocumentFile } from "@weaver/core/documents/frontmatter";
import { documentKindOfPath } from "@weaver/core/documents/kinds";
import { classifyDeletedPath } from "@weaver/core/documents/recovery";
import { openProjectRepo, type ProjectRepoReader } from "@weaver/git-store";
import {
  cursorQueryIdentity,
  decodeContentCursor,
  encodeContentCursor,
} from "./contentCursors";
import { assertProjectRole, type ProjectActor } from "./projectAccess";

/** Commits inspected per page before the traversal yields with hasMore. */
export const MAX_RECOVERY_SCAN_COMMITS = 200;

export type DeletedContentItem = {
  resourceType: "document" | "table";
  id: string;
  title: string;
  /** Path the resource had when it was deleted. */
  path: string;
  /** The commit that removed it. */
  deletedAtSha: string;
  deletedAt: string;
  /** Its parent: the last revision that still contained the resource. */
  sourceSha: string;
};

async function identityAt(
  repo: ProjectRepoReader,
  sourceSha: string,
  classified: { kind: "document" | "table"; resourcePath: string },
): Promise<{ id: string; title: string } | null> {
  try {
    if (classified.kind === "document") {
      const raw = await repo.showFileAt(sourceSha, classified.resourcePath);
      const parsed = parseDocumentFile(
        raw,
        documentKindOfPath(classified.resourcePath),
      );
      return { id: parsed.meta.id, title: parsed.meta.title };
    }
    const raw = await repo.showFileAt(
      sourceSha,
      `${classified.resourcePath}/schema.json`,
    );
    const schema: unknown = JSON.parse(raw);
    if (
      !schema ||
      typeof schema !== "object" ||
      typeof (schema as { id?: unknown }).id !== "string" ||
      typeof (schema as { title?: unknown }).title !== "string"
    )
      return null;
    return {
      id: (schema as { id: string }).id,
      title: (schema as { title: string }).title,
    };
  } catch {
    // Malformed or unreachable content is not recoverable; skip it.
    return null;
  }
}

/**
 * A recovered resource keeps its id but the writers never reuse a historical
 * path, so absence must be judged by identity too — an id that is live
 * anywhere is one `content.restore` in deleted mode would refuse.
 */
async function identityIsLive(db: PrismaClient, id: string): Promise<boolean> {
  const document = await db.document.findFirst({
    where: { id },
    select: { id: true },
  });
  if (document) return true;
  return (
    (await db.dataTable.findFirst({ where: { id }, select: { id: true } })) !==
    null
  );
}

async function stillAbsent(
  repo: ProjectRepoReader,
  head: string,
  classified: { kind: "document" | "table"; resourcePath: string },
): Promise<boolean> {
  const probe =
    classified.kind === "document"
      ? classified.resourcePath
      : `${classified.resourcePath}/schema.json`;
  return (await repo.blobShaAt(head, probe)) === null;
}

/**
 * Recoverable resources, newest deletion first, read from committed content so
 * an item with no database projection is still found (concept §7.3).
 */
export async function listDeletedContent(
  db: PrismaClient,
  input: {
    projectId: string;
    cursor?: string;
    limit: number;
    /** Internal test seam to exercise page-boundary behavior cheaply; not a public paging knob. */
    scanLimit?: number;
  },
  actor: ProjectActor,
): Promise<{
  items: DeletedContentItem[];
  hasMore: boolean;
  nextCursor: string | null;
  snapshotCommitSha: string;
}> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 50);
  const repo = await openProjectRepo(input.projectId);
  if (!repo)
    return {
      items: [],
      hasMore: false,
      nextCursor: null,
      snapshotCommitSha: "0".repeat(40),
    };
  const head = await repo.resolveHead();
  const query = cursorQueryIdentity({});
  const binding = {
    kind: "deleted" as const,
    projectId: input.projectId,
    resourceId: input.projectId,
    query,
  };
  const decoded =
    input.cursor === undefined
      ? undefined
      : decodeContentCursor(input.cursor, {
          ...binding,
          snapshotCommitSha: undefined,
        });
  const snapshotCommitSha = decoded?.snapshotCommitSha ?? head;
  const after = decoded?.after;
  const resumePosition = decoded?.position ?? 0;
  const skipAfter = after !== undefined && resumePosition === 0;
  const scanLimit = Math.min(
    Math.max(Math.trunc(input.scanLimit ?? MAX_RECOVERY_SCAN_COMMITS), 1),
    MAX_RECOVERY_SCAN_COMMITS,
  );

  // Legacy zero-position cursors consumed the whole commit; positive offsets resume within it.
  const fetchLimit = scanLimit + (skipAfter ? 2 : 1);
  const entries = await repo.logChangesBefore(after ?? snapshotCommitSha, {
    limit: fetchLimit,
  });
  const walk = skipAfter
    ? entries.filter((entry) => entry.sha !== after)
    : entries;
  const scanned = walk.slice(0, scanLimit);

  const items: DeletedContentItem[] = [];
  const seen = new Set<string>();
  let lastScanned: string | undefined;
  let nextPosition = 0;
  let exhaustedPage = false;
  for (const entry of scanned) {
    lastScanned = entry.sha;
    const consumed = entry.sha === after ? resumePosition : 0;
    let sourceSha: string | null | undefined;
    for (const [changeIndex, change] of entry.changes.entries()) {
      if (change.status !== "D") continue;
      const classified = classifyDeletedPath(change.path);
      if (!classified) continue;
      if (!(await stillAbsent(repo, head, classified))) continue;
      if (sourceSha === undefined) {
        const [parent] = await repo.logChangesBefore(`${entry.sha}~1`, {
          limit: 1,
        });
        sourceSha = parent?.sha ?? null;
      }
      if (!sourceSha) continue;
      const identity = await identityAt(repo, sourceSha, classified);
      if (!identity) continue;
      if (seen.has(identity.id)) continue;
      seen.add(identity.id);
      // Rebuild deduplication from the consumed prefix without emitting those items again.
      if (changeIndex < consumed) continue;
      if (await identityIsLive(db, identity.id)) continue;
      items.push({
        resourceType: classified.kind,
        id: identity.id,
        title: identity.title,
        path: classified.resourcePath,
        deletedAtSha: entry.sha,
        deletedAt: entry.date.toISOString(),
        sourceSha,
      });
      if (items.length >= limit) {
        nextPosition =
          changeIndex + 1 < entry.changes.length ? changeIndex + 1 : 0;
        exhaustedPage = true;
        break;
      }
    }
    if (exhaustedPage) break;
  }

  const moreCommits = walk.length > scanLimit;
  const hasMore = exhaustedPage || moreCommits;
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && lastScanned
        ? encodeContentCursor({
            v: 1,
            ...binding,
            snapshotCommitSha,
            position: nextPosition,
            after: lastScanned,
          })
        : null,
    snapshotCommitSha,
  };
}

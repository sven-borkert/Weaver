import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo, type GitChangeEntry } from "@weaver/git-store";
import type { ChangeSummaryView } from "../documents/changeSummaryMessage";
import { documentFileStem, documentKindFromPath } from "../documents/kinds";
import { TABLE_DIR_SUFFIX, TABLES_ROOT } from "../tables/paths";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import { loadChangeSummaries } from "./documentChangeSummaryReads";

export type ChangedResource = {
  id: string | null;
  title: string;
  path: string;
  status: string;
};

export type ProjectChange = {
  sha: string;
  date: Date;
  authorName: string;
  message: string;
  changeSummary: ChangeSummaryView | null;
  documents: ChangedResource[];
  tables: ChangedResource[];
};

export type ProjectChangesResult = {
  headSha: string | null;
  commits: ProjectChange[];
  truncated: boolean;
  fallback: "none" | "since_date";
};

function titleFromPath(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  const withoutExt = documentFileStem(base);
  return withoutExt.endsWith(TABLE_DIR_SUFFIX)
    ? withoutExt.slice(0, -TABLE_DIR_SUFFIX.length)
    : withoutExt;
}

/** Table directory key for a path with no projected DataTable row (deleted or not yet projected). */
function tableDirKey(path: string): string {
  const segments = path.split("/");
  const index = segments.findIndex((s) => s.endsWith(TABLE_DIR_SUFFIX));
  return index === -1 ? path : segments.slice(0, index + 1).join("/");
}

/** Commits after `fromSha` (or within `sinceDate` when there is none), mapped to documents and tables. Phase 6A §7; reused by the 6C activity feed. */
export async function projectChangesSince(
  db: PrismaClient,
  actor: ProjectActor,
  input: {
    projectId: string;
    fromSha: string | null;
    sinceDate: Date;
    limit: number;
  },
): Promise<ProjectChangesResult> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const repo = await openProjectRepo(input.projectId);
  // Repositories are created lazily on first write: no repo, no content yet.
  if (!repo)
    return { headSha: null, commits: [], truncated: false, fallback: "none" };
  let headSha: string | null = null;
  try {
    headSha = await repo.resolveHead();
  } catch {
    return { headSha: null, commits: [], truncated: false, fallback: "none" };
  }
  let entries: GitChangeEntry[];
  let fallback: ProjectChangesResult["fallback"] = "none";
  try {
    entries = input.fromSha
      ? await repo.logSince(input.fromSha, { limit: input.limit + 1 })
      : await repo.logSince(null, {
          limit: input.limit + 1,
          sinceDate: input.sinceDate,
        });
  } catch {
    // The recorded head is gone (repository recreated): use the date window.
    fallback = "since_date";
    entries = await repo.logSince(null, {
      limit: input.limit + 1,
      sinceDate: input.sinceDate,
    });
  }
  const truncated = entries.length > input.limit;
  const window = entries.slice(0, input.limit);
  const summaries = await loadChangeSummaries(
    db,
    input.projectId,
    window.map((entry) => entry.sha),
  );
  const paths = new Set(
    window.flatMap((entry) => entry.changes.map((c) => c.path)),
  );
  const documents = await db.document.findMany({
    where: { projectId: input.projectId, path: { in: [...paths] } },
    select: { id: true, title: true, path: true },
  });
  const documentByPath = new Map(documents.map((d) => [d.path, d]));
  const tables = await db.dataTable.findMany({
    where: { projectId: input.projectId },
    select: { id: true, title: true, path: true },
  });
  const tablePrefix = `${TABLES_ROOT}/`;
  return {
    headSha,
    truncated,
    fallback,
    commits: window.map((entry) => {
      const docs: ChangedResource[] = [];
      const tbls = new Map<string, ChangedResource>();
      for (const change of entry.changes) {
        if (change.path.startsWith(tablePrefix)) {
          const table = tables.find((t) =>
            change.path.startsWith(`${t.path}/`),
          );
          const key = table?.path ?? tableDirKey(change.path);
          if (!tbls.has(key))
            tbls.set(key, {
              id: table?.id ?? null,
              title: table?.title ?? titleFromPath(key),
              path: key,
              status: change.status,
            });
        } else if (documentKindFromPath(change.path) !== null) {
          const doc = documentByPath.get(change.path);
          docs.push({
            id: doc?.id ?? null,
            title: doc?.title ?? titleFromPath(change.path),
            path: change.path,
            status: change.status,
          });
        }
      }
      return {
        sha: entry.sha,
        date: entry.date,
        authorName: entry.authorName,
        message: entry.message,
        changeSummary: summaries.get(entry.sha) ?? null,
        documents: docs,
        tables: [...tbls.values()],
      };
    }),
  };
}

import type { PrismaClient } from "@weaver/db/client";
import {
  openProjectRepo,
  type GitChangeEntry,
  type ProjectRepoReader,
} from "@weaver/git-store";
import { mapWithConcurrency } from "../ai/concurrency";
import type { ChangeSummaryView } from "../documents/changeSummaryMessage";
import { FrontmatterError, parseDocumentFile } from "../documents/frontmatter";
import { ASSETS_SUFFIX, isAssetsSegment } from "../documents/images";
import { documentFileStem, documentKindFromPath } from "../documents/kinds";
import { parseSchemaFile, TableFileError } from "../tables/jsonl";
import { isTableDirName, TABLE_DIR_SUFFIX, TABLES_ROOT } from "../tables/paths";
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
  hasOutOfScopeChanges?: boolean;
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

type HistoricalResource = { kind: "document" | "table"; id: string };
type GitFileChange = GitChangeEntry["changes"][number];
const MAX_SCOPED_PATHS_PER_COMMIT = 25;
const MAX_SCOPED_PATHS_PER_WINDOW = 500;

function focusedResourcePath(
  path: string,
  kind: HistoricalResource["kind"],
): string | null {
  if (path.startsWith(`${TABLES_ROOT}/`)) {
    if (kind !== "table") return null;
    const dir = tableDirKey(path);
    return dir !== path && isTableDirName(dir.split("/").at(-1) ?? "")
      ? dir
      : null;
  }
  if (kind !== "document") return null;
  const parts = path.split("/");
  const assets = parts.findIndex(isAssetsSegment);
  if (assets !== -1 && assets < parts.length - 1)
    return [
      ...parts.slice(0, assets),
      `${parts[assets]!.slice(0, -ASSETS_SUFFIX.length)}.md`,
    ].join("/");
  return documentKindFromPath(path) ? path : null;
}

function historicalPathLookup(
  entry: GitChangeEntry,
  kind: HistoricalResource["kind"],
) {
  const candidates = new Map<
    string,
    { file: string; status: GitFileChange["status"] }
  >();
  let hasOutOfScopeChanges = false;
  for (const change of entry.changes) {
    const path = focusedResourcePath(change.path, kind);
    if (!path) {
      hasOutOfScopeChanges = true;
      continue;
    }
    if (change.oldPath && focusedResourcePath(change.oldPath, kind) !== path)
      hasOutOfScopeChanges = true;
    const file = kind === "document" ? path : `${path}/schema.json`;
    if (change.path === file)
      candidates.set(path, { file, status: change.status });
    else if (!candidates.has(path)) candidates.set(path, { file, status: "M" });
  }
  return {
    candidates,
    hasOutOfScopeChanges: hasOutOfScopeChanges || candidates.size > 1,
  };
}

function resourceFromHistoricalBlob(
  path: string,
  content: string,
  kind: HistoricalResource["kind"],
) {
  try {
    return kind === "table"
      ? parseSchemaFile(content)
      : parseDocumentFile(content, documentKindFromPath(path)!).meta;
  } catch (error) {
    if (error instanceof FrontmatterError || error instanceof TableFileError)
      return null;
    throw error;
  }
}

async function scopedHistory(
  repo: ProjectRepoReader,
  window: GitChangeEntry[],
  summaries: Map<string, ChangeSummaryView>,
  focus: HistoricalResource,
): Promise<Pick<ProjectChangesResult, "commits" | "truncated">> {
  let remaining = MAX_SCOPED_PATHS_PER_WINDOW;
  let truncated = false;
  const lookups = window.flatMap((entry) => {
    const lookup = historicalPathLookup(entry, focus.kind);
    if (!lookup.candidates.size) return [];
    if (
      lookup.candidates.size > Math.min(remaining, MAX_SCOPED_PATHS_PER_COMMIT)
    ) {
      truncated = true;
      return [];
    }
    remaining -= lookup.candidates.size;
    return [{ entry, ...lookup }];
  });
  const commits = await mapWithConcurrency(
    lookups,
    4,
    async ({
      entry,
      candidates,
      hasOutOfScopeChanges,
    }): Promise<ProjectChange[]> => {
      const liveFiles: string[] = [];
      const deletedFiles: string[] = [];
      for (const candidate of candidates.values())
        (candidate.status === "D" ? deletedFiles : liveFiles).push(
          candidate.file,
        );
      const [live, deleted] = await Promise.all([
        liveFiles.length
          ? repo.readBlobsAt(entry.sha, liveFiles)
          : new Map<string, string>(),
        deletedFiles.length
          ? repo.readBlobsAt(`${entry.sha}^1`, deletedFiles)
          : new Map<string, string>(),
      ]);
      const matched: ChangedResource[] = [];
      for (const [path, { file, status }] of candidates) {
        const content = (status === "D" ? deleted : live).get(file);
        if (content === undefined) continue;
        const resource = resourceFromHistoricalBlob(path, content, focus.kind);
        if (resource?.id === focus.id)
          matched.push({
            id: resource.id,
            title: resource.title,
            path,
            status,
          });
      }
      if (matched.length !== 1) return [];
      return [
        {
          sha: entry.sha,
          date: entry.date,
          authorName: entry.authorName,
          message: entry.message,
          changeSummary: summaries.get(entry.sha) ?? null,
          hasOutOfScopeChanges,
          documents: focus.kind === "document" ? matched : [],
          tables: focus.kind === "table" ? matched : [],
        },
      ];
    },
  );
  return { commits: commits.flat(), truncated };
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
    historicalResource?: HistoricalResource;
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
  const dateWindow = async () => {
    const boundary = await repo.firstParentTrustedBefore(
      headSha,
      input.sinceDate,
    );
    const shas = await repo.listCommitShas(headSha, {
      exclude: boundary,
      maxCount: input.limit + 1,
    });
    return repo.logChangesForShas(shas);
  };
  if (input.fromSha && (await repo.isAncestor(input.fromSha, headSha))) {
    const shas = await repo.listCommitShas(headSha, {
      exclude: input.fromSha,
      maxCount: input.limit + 1,
    });
    entries = await repo.logChangesForShas(shas);
  } else {
    if (input.fromSha) fallback = "since_date";
    entries = await dateWindow();
  }
  const truncated = entries.length > input.limit;
  const window = entries.slice(0, input.limit);
  const summaries = await loadChangeSummaries(
    db,
    input.projectId,
    window.map((entry) => entry.sha),
  );
  if (input.historicalResource) {
    const result = await scopedHistory(
      repo,
      window,
      summaries,
      input.historicalResource,
    );
    return {
      ...result,
      headSha,
      truncated: truncated || result.truncated,
      fallback,
    };
  }
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

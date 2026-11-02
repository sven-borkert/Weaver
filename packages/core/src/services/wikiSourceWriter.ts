import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { parseDocumentBody } from "../editor/markdown";
import {
  folderMetadataPath,
  parseFolderMetadata,
} from "../documents/folderMetadata";
import { documentTitleSchema } from "../documents/title";
import { slugify } from "../documents/slug";
import { CoreError } from "../errors";
import { loadFolderIdentityIndex } from "../projectApi/folderIdentity";
import { createWikiAgentSecurityContext } from "../security/context";
import { TABLES_ROOT } from "../tables/paths";
import { stripIgnorable } from "../wiki/guideText";
import { wikiAgentContentAuthor } from "./contentAuthor";
import {
  createdResourceId,
  fillColumn,
  fillRow,
  recoverPriorOperation,
  type ContentOperation,
  type RecoveryIdentity,
} from "./contentOperations";
import { writeDocumentInRepo } from "./documents";
import { createFolderInRepo, type FolderScope } from "./folders";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";
import { writeTableInRepo } from "./tables";
import { WIKI_FOLDER, WIKI_SOURCES_FOLDER } from "./wikiBootstrap";
import { assertPreparingFence } from "./wikiRuns";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Separate from applyWikiOperation's pattern, so the agent cannot mint these.
const SOURCE_OPERATION_ID_RE = new RegExp(
  `^(?:wiki-input:${UUID}|ingestion:${UUID})$`,
);
const WIKI_SOURCE_TABLES_FOLDER = "wiki-sources";
const IMAGE_MARKUP_RE = /weaver-image:|<\s*img\b/i;
const SOURCE_PREFIX = "Source: ";
const FALLBACK_TITLE = `${SOURCE_PREFIX}untitled`;
const TITLE_MAX_CHARS = 200;

export type SourceRun = { id: string; projectId: string; agentId: string };

export type SourceItem = { id: string; title: string };

export type SourceResult = {
  kind: "document" | "table";
  resourceId: string;
  commitSha: string;
  recovered: boolean;
};

/** Never empty: default-ignorable, bidi and control characters go, then a fixed fallback. */
export function sourceTitle(name: string): string {
  const cleaned = stripIgnorable(name)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return FALLBACK_TITLE;
  const title = `${SOURCE_PREFIX}${[...cleaned]
    .slice(0, TITLE_MAX_CHARS - SOURCE_PREFIX.length)
    .join("")}`.trim();
  return documentTitleSchema.safeParse(title).success ? title : FALLBACK_TITLE;
}

export function textSourceOperationId(itemId: string): string {
  return `wiki-input:${itemId}`;
}

export function fileSourceOperationId(fileId: string): string {
  return `ingestion:${fileId}`;
}

/** Resume compares this, so it must not depend on the run or the current folder. */
function requestHash(itemId: string, contentDigest: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, itemId, contentDigest }))
    .digest("hex");
}

function assertNoImageMarkup(markdown: string): void {
  if (IMAGE_MARKUP_RE.test(markdown))
    throw new CoreError(
      "BAD_REQUEST",
      "This input contains images, which the wiki does not accept yet",
      { reason: "SOURCE_HAS_IMAGES" },
    );
}

async function freeFolderName(
  repo: ProjectRepoWriter,
  parentRel: string,
  base: string,
): Promise<string> {
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const rel = [parentRel, slugify(name)].filter(Boolean).join("/");
    if (!(await repo.fileExistsInWorktree(rel))) return name;
  }
  throw new CoreError("CONFLICT", "No free folder name was found");
}

type WriterContext = {
  db: PrismaClient;
  repo: ProjectRepoWriter;
  run: SourceRun;
  item: SourceItem;
  hash: string;
  fence: () => Promise<void>;
  author: ReturnType<typeof wikiAgentContentAuthor>;
};

async function newFolder(
  context: WriterContext,
  scope: FolderScope,
  parentPath: string[],
  baseName: string,
): Promise<{ segments: string[]; id: string }> {
  const { repo, run, item, hash, fence, author } = context;
  const parentRel = (
    scope === "tables" ? [TABLES_ROOT, ...parentPath] : parentPath
  ).join("/");
  const name = await freeFolderName(repo, parentRel, baseName);
  // Random: an interrupted recreation leaves at most an empty folder behind.
  const created = await createFolderInRepo(
    repo,
    { parentPath, name },
    author,
    scope,
    {
      operationId: `wiki-input:${item.id}:folder:${randomUUID()}`,
      runId: run.id,
      wikiRequestHash: hash,
      wikiInputId: item.id,
      beforeCommit: fence,
    },
  );
  const meta = parseFolderMetadata(
    await repo.readFileFromWorktree(folderMetadataPath(created.path)),
  );
  if (!meta?.id)
    throw new CoreError("INTERNAL_SERVER_ERROR", "Source folder has no id");
  return { segments: created.segments, id: meta.id };
}

/** By id; a deleted, renamed-away or ambiguous folder is replaced by a fresh one, never written into. */
async function resolveSourceFolder(
  context: WriterContext,
  scope: FolderScope,
): Promise<string[]> {
  const { db, repo, run } = context;
  const settings = await db.projectWikiSettings.findUniqueOrThrow({
    where: { projectId: run.projectId },
    select: { sourcesFolderId: true, sourceTablesFolderId: true },
  });
  const recorded =
    scope === "documents"
      ? settings.sourcesFolderId
      : settings.sourceTablesFolderId;
  if (recorded) {
    const index = await loadFolderIdentityIndex(
      repo,
      run.projectId,
      scope,
      await repo.resolveHead(),
    );
    const entry = index.byId.get(recorded);
    if (entry) return entry.path;
  }
  let created: { segments: string[]; id: string };
  if (scope === "documents") {
    const root = (await repo.fileExistsInWorktree(WIKI_FOLDER))
      ? [WIKI_FOLDER]
      : (await newFolder(context, "documents", [], WIKI_FOLDER)).segments;
    created = await newFolder(context, "documents", root, WIKI_SOURCES_FOLDER);
  } else {
    created = await newFolder(context, "tables", [], WIKI_SOURCE_TABLES_FOLDER);
  }
  // No revision bump: an anchor the writer maintains must not stale an Owner's open form.
  await db.projectWikiSettings.updateMany({
    where: { projectId: run.projectId },
    data:
      scope === "documents"
        ? { sourcesFolderId: created.id }
        : { sourceTablesFolderId: created.id },
  });
  return created.segments;
}

export type SourceBody =
  | { kind: "document"; markdown: string }
  | {
      kind: "table";
      columns: Extract<ContentOperation, { kind: "table.create" }>["columns"];
      rows: Extract<ContentOperation, { kind: "table.create" }>["rows"];
    };

async function writeSource(
  db: PrismaClient,
  input: {
    run: SourceRun;
    item: SourceItem;
    operationId: string;
    contentDigest: string;
    fileDigest?: string;
    body: SourceBody;
    /** Runs immediately before the commit, after the fence. */
    beforeCommit?: () => Promise<void>;
  },
): Promise<SourceResult> {
  const { run, item, operationId, body } = input;
  if (!SOURCE_OPERATION_ID_RE.test(operationId))
    throw new CoreError("BAD_REQUEST", "Invalid wiki source operation id");
  if (body.kind === "document") assertNoImageMarkup(body.markdown);
  const fence = () =>
    assertPreparingFence(db, {
      projectId: run.projectId,
      runId: run.id,
      agentId: run.agentId,
      itemId: item.id,
      ...(input.fileDigest === undefined
        ? {}
        : { fileDigest: input.fileDigest }),
    });
  await fence();
  const resourceId = createdResourceId(operationId);
  const title = sourceTitle(item.title);
  const hash = requestHash(item.id, input.contentDigest);
  const identity: RecoveryIdentity = {
    wikiAgentId: run.agentId,
    wikiRequestHash: hash,
  };
  const author = wikiAgentContentAuthor(
    createWikiAgentSecurityContext({
      agentId: run.agentId,
      projectId: run.projectId,
    }),
  );
  let committed = false;
  const result = await withProjectRepo(run.projectId, async (repo) => {
    await fence();
    const lookup: ContentOperation =
      body.kind === "document"
        ? {
            kind: "document.create",
            projectId: run.projectId,
            folderPath: [],
            title,
            markdown: body.markdown,
          }
        : {
            kind: "table.create",
            projectId: run.projectId,
            folderPath: [],
            title,
            columns: body.columns,
            rows: body.rows,
          };
    // Requires a ledger-trusted commit with the agent trailer and this hash, else CONFLICT.
    const prior = await recoverPriorOperation(
      db,
      repo,
      lookup,
      operationId,
      identity,
    );
    if (prior) return { commitSha: prior.commitSha, recovered: true };
    const context: WriterContext = {
      db,
      repo,
      run,
      item,
      hash,
      fence,
      author,
    };
    const folderPath = await resolveSourceFolder(
      context,
      body.kind === "document" ? "documents" : "tables",
    );
    const audit = {
      operation: "create" as const,
      operationId,
      runId: run.id,
      wikiRequestHash: hash,
      wikiInputId: item.id,
      beforeCommit: async () => {
        await fence();
        await input.beforeCommit?.();
      },
    };
    const now = new Date().toISOString();
    if (body.kind === "document") {
      const written = await writeDocumentInRepo(
        db,
        repo,
        run.projectId,
        {
          kind: "create",
          id: resourceId,
          folderPath,
          title,
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody(body.markdown),
          },
          createdAt: now,
          properties: { type: "source", reviewExempt: true },
          wikiSourceItemId: item.id,
        },
        author,
        { ...audit, message: (path: string) => `wiki: ${path}` },
      );
      committed = true;
      return { commitSha: written.headCommitSha, recovered: false };
    }
    const written = await writeTableInRepo(
      db,
      repo,
      run.projectId,
      {
        kind: "create",
        id: resourceId,
        folderPath,
        title,
        columns: body.columns.map(fillColumn),
        rows: body.rows.map(fillRow),
        createdAt: now,
      },
      author,
      audit,
    );
    committed = true;
    return { commitSha: written.headCommitSha, recovered: false };
  });
  if (committed) void notifyProjectContentChanged(db, run.projectId);
  return { kind: body.kind, resourceId, ...result };
}

/** Links the item before the commit, so a crash leaves a row-less commit a rebuild can still classify. */
function linkBeforeCommit(
  db: PrismaClient,
  itemId: string,
  kind: "document" | "table",
  resourceId: string,
): () => Promise<void> {
  return async () => {
    await db.wikiInputItem.updateMany({
      where: { id: itemId },
      data:
        kind === "document"
          ? { sourceDocumentId: resourceId }
          : { sourceTableId: resourceId },
    });
  };
}

export async function writeTextSource(
  db: PrismaClient,
  run: SourceRun,
  item: SourceItem & { text: string; textDigest: string },
): Promise<SourceResult> {
  const operationId = textSourceOperationId(item.id);
  return writeSource(db, {
    run,
    item,
    operationId,
    contentDigest: item.textDigest,
    body: { kind: "document", markdown: item.text },
    beforeCommit: linkBeforeCommit(
      db,
      item.id,
      "document",
      createdResourceId(operationId),
    ),
  });
}

export async function writeFileSource(
  db: PrismaClient,
  run: SourceRun,
  item: SourceItem,
  file: { id: string; contentDigest: string; draftDigest: string },
  body: SourceBody,
): Promise<SourceResult> {
  const operationId = fileSourceOperationId(file.id);
  return writeSource(db, {
    run,
    item,
    operationId,
    contentDigest: file.draftDigest,
    fileDigest: file.contentDigest,
    body,
    beforeCommit: linkBeforeCommit(
      db,
      item.id,
      body.kind,
      createdResourceId(operationId),
    ),
  });
}

export async function isLiveSource(
  db: PrismaClient,
  item: {
    projectId: string;
    sourceDocumentId: string | null;
    sourceTableId: string | null;
  },
): Promise<boolean> {
  if (item.sourceDocumentId) {
    const row = await db.document.findFirst({
      where: { id: item.sourceDocumentId, projectId: item.projectId },
      select: { id: true },
    });
    if (row) return true;
  }
  if (item.sourceTableId) {
    const row = await db.dataTable.findFirst({
      where: { id: item.sourceTableId, projectId: item.projectId },
      select: { id: true },
    });
    if (row) return true;
  }
  return false;
}

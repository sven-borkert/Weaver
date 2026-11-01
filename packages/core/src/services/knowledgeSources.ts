import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  parseDocumentFile,
  FrontmatterError,
} from "@weaver/core/documents/frontmatter";
import {
  documentFileExtension,
  documentKindFromPath,
  documentKindOfPath,
  type DocumentKind,
} from "@weaver/core/documents/kinds";
import { assertSafeSegments, docPath } from "@weaver/core/documents/paths";
import { parseSchemaFile, TableFileError } from "@weaver/core/tables/jsonl";
import {
  TABLES_ROOT,
  isTableDirName,
  slugFromTableDir,
  tableDirPath,
} from "@weaver/core/tables/paths";
import type { KnowledgeJobPayloads } from "../jobs/types";
import type { KnowledgeSystemContext } from "../jobs/systemContext";
import type { ProjectRepoReader } from "@weaver/git-store";
import { withExistingProjectRepoReader } from "./projectRepo";

type Db = PrismaClient | Prisma.TransactionClient;

export type DocumentSourcePayload =
  KnowledgeJobPayloads["document.search-sync"];
export type TableSourcePayload = KnowledgeJobPayloads["table.search-sync"];

export type DocumentIndexSource = {
  title: string;
  kind: DocumentKind;
  body: string;
};

export type TableSearchSource = {
  title: string;
  schemaText: string;
};

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_DOCUMENT_FILE_BYTES = 2_000_000;
const MAX_TABLE_SCHEMA_BYTES = 250_000;

/** @internal Snapshot helper for fixtures; indexing uses the locked callback APIs. */
export async function loadDocumentIndexSource(
  context: KnowledgeSystemContext,
  db: Db,
  payload: DocumentSourcePayload,
): Promise<DocumentIndexSource | null> {
  return withDocumentIndexSource(
    context,
    db,
    payload,
    async (source) => source,
  );
}

export async function withDocumentIndexSource<T>(
  context: KnowledgeSystemContext,
  db: Db,
  payload: DocumentSourcePayload,
  useSource: (
    source: DocumentIndexSource,
    repo: ProjectRepoReader,
  ) => Promise<T>,
): Promise<T | null> {
  void context;
  if (
    !COMMIT_SHA_RE.test(payload.sourceCommitSha) ||
    !isCanonicalDocumentPath(payload.pathAtSha) ||
    !(await projectIsLive(db, payload.projectId))
  ) {
    return null;
  }

  return withExistingProjectRepoReader(payload.projectId, async (repo) => {
    const source = await loadDocumentIndexSourceFromRepo(repo, payload);
    return source ? useSource(source, repo) : null;
  });
}

/** @internal Snapshot helper for fixtures; indexing uses the locked callback APIs. */
export async function loadTableSearchSource(
  context: KnowledgeSystemContext,
  db: Db,
  payload: TableSourcePayload,
): Promise<TableSearchSource | null> {
  return withTableSearchSource(context, db, payload, async (source) => source);
}

export async function withTableSearchSource<T>(
  context: KnowledgeSystemContext,
  db: Db,
  payload: TableSourcePayload,
  useSource: (source: TableSearchSource) => Promise<T>,
): Promise<T | null> {
  void context;
  if (
    !COMMIT_SHA_RE.test(payload.sourceCommitSha) ||
    !isCanonicalTablePath(payload.pathAtSha) ||
    !(await projectIsLive(db, payload.projectId))
  ) {
    return null;
  }

  return withExistingProjectRepoReader(payload.projectId, async (repo) => {
    const source = await loadTableSearchSourceFromRepo(repo, payload);
    return source ? useSource(source) : null;
  });
}

async function loadDocumentIndexSourceFromRepo(
  repo: ProjectRepoReader,
  payload: DocumentSourcePayload,
): Promise<DocumentIndexSource | null> {
  if (!(await isExactReachableCommit(repo, payload.sourceCommitSha))) {
    return null;
  }
  const size = await repo.blobSizeAt(
    payload.sourceCommitSha,
    payload.pathAtSha,
  );
  if (size === null || size > MAX_DOCUMENT_FILE_BYTES) return null;

  try {
    const kind = documentKindOfPath(payload.pathAtSha);
    const { meta, body } = parseDocumentFile(
      await repo.showFileAt(payload.sourceCommitSha, payload.pathAtSha),
      kind,
    );
    if (meta.id !== payload.documentId) return null;
    return { title: meta.title, kind, body };
  } catch (error) {
    if (error instanceof FrontmatterError) return null;
    throw error;
  }
}

async function loadTableSearchSourceFromRepo(
  repo: ProjectRepoReader,
  payload: TableSourcePayload,
): Promise<TableSearchSource | null> {
  if (!(await isExactReachableCommit(repo, payload.sourceCommitSha))) {
    return null;
  }
  const schemaPath = `${payload.pathAtSha}/schema.json`;
  const size = await repo.blobSizeAt(payload.sourceCommitSha, schemaPath);
  if (size === null || size > MAX_TABLE_SCHEMA_BYTES) return null;

  try {
    const schema = parseSchemaFile(
      await repo.showFileAt(payload.sourceCommitSha, schemaPath),
    );
    if (schema.id !== payload.tableId) return null;
    return {
      title: schema.title,
      schemaText: schema.columns
        .map((column) => `${column.name} (${column.type})`)
        .join("\n"),
    };
  } catch (error) {
    if (error instanceof TableFileError) return null;
    throw error;
  }
}

async function projectIsLive(db: Db, projectId: string): Promise<boolean> {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  return project !== null;
}

async function isExactReachableCommit(
  repo: ProjectRepoReader,
  sourceCommitSha: string,
): Promise<boolean> {
  return repo.isAncestor(sourceCommitSha, "HEAD");
}

function isCanonicalDocumentPath(file: string): boolean {
  const kind = documentKindFromPath(file);
  if (kind === null) return false;
  const segments = file.split("/");
  const filename = segments.pop() ?? "";
  const slug = filename.slice(0, -documentFileExtension(kind).length);
  try {
    return (
      docPath(segments, slug, kind) === file && segments[0] !== TABLES_ROOT
    );
  } catch {
    return false;
  }
}

function isCanonicalTablePath(dir: string): boolean {
  const segments = dir.split("/");
  if (segments.shift() !== TABLES_ROOT) return false;
  const leaf = segments.pop();
  if (!leaf || !isTableDirName(leaf)) return false;
  try {
    assertSafeSegments(segments);
    return tableDirPath(segments, slugFromTableDir(leaf)) === dir;
  } catch {
    return false;
  }
}

import type { PrismaClient, Prisma } from "@weaver/db/client";
import type { ProjectRepoReader } from "@weaver/git-store";
import { CoreError } from "../errors";
import { documentKindFromPath } from "../documents/kinds";
import { parseDocumentFile, type DocumentMeta } from "../documents/frontmatter";
import {
  isDocumentFilePath,
  documentSlugFromPath,
} from "../services/documents";
import { getTableInRepo, MAX_SCHEMA_FILE_BYTES } from "../services/tables";
import { parseSchemaFile } from "../tables/jsonl";
import { isTableDirName } from "../tables/paths";
import { assertSafeSegments } from "../documents/paths";
import type { TableColumn, TableRow } from "../tables/types";

export type MachineDocumentSnapshot = {
  kind: "document";
  id: string;
  path: string;
  title: string;
  revision: string;
  markdown: string;
  meta: DocumentMeta;
};
export type MachineTableSnapshot = {
  kind: "table";
  id: string;
  path: string;
  title: string;
  revision: string;
  columns: TableColumn[];
  rows: TableRow[];
};
const identityCache = new Map<string, ReadonlyMap<string, string>>();

export async function resourceIdentityIndex(
  repo: ProjectRepoReader,
  projectId: string,
  kind: "document" | "table",
  head: string,
) {
  const cacheKey = `${projectId}:${kind}:${head}`;
  const cached = identityCache.get(cacheKey);
  if (cached) {
    identityCache.delete(cacheKey);
    identityCache.set(cacheKey, cached);
    return cached;
  }
  const tracked = await repo.listTrackedFiles(head);
  const trackedSet = new Set(tracked);
  const files = tracked.filter((file) => {
    if (kind === "document")
      return (
        isDocumentFilePath(file) && documentKindFromPath(file) === "markdown"
      );
    const parts = file.split("/");
    return (
      parts[0] === "tables" &&
      parts.at(-1) === "schema.json" &&
      isTableDirName(parts.at(-2) ?? "") &&
      trackedSet.has(`${parts.slice(0, -1).join("/")}/data.jsonl`)
    );
  });
  if (files.length > 10_000)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Too many resources to resolve project API identities",
    );
  const byId = new Map<string, string>();
  const duplicateIds = new Set<string>();
  for (let offset = 0; offset < files.length; offset += 32) {
    const blobs = await repo.readBlobsAt(
      head,
      files.slice(offset, offset + 32),
      kind === "document" ? 2_000_000 : MAX_SCHEMA_FILE_BYTES,
    );
    for (const [file, content] of blobs) {
      try {
        if (kind === "document") documentSlugFromPath(file);
        const path =
          kind === "document" ? file : file.split("/").slice(0, -1).join("/");
        assertSafeSegments(path.split("/").slice(kind === "table" ? 1 : 0, -1));
        const id =
          kind === "document"
            ? parseDocumentFile(content, "markdown").meta.id
            : parseSchemaFile(content).id;
        if (byId.has(id)) duplicateIds.add(id);
        else byId.set(id, path);
      } catch {
        continue;
      }
    }
  }
  for (const id of duplicateIds) byId.delete(id);
  identityCache.set(cacheKey, byId);
  if (identityCache.size > 16)
    identityCache.delete(identityCache.keys().next().value!);
  return byId;
}

export async function readMachineDocumentSnapshot(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoReader,
  projectId: string,
  documentId: string,
): Promise<MachineDocumentSnapshot> {
  const owner = await db.document.findUnique({
    where: { id: documentId },
    select: { projectId: true },
  });
  if (owner && owner.projectId !== projectId) throw new CoreError("NOT_FOUND");
  const head = await repo.resolveHead();
  const path = (
    await resourceIdentityIndex(repo, projectId, "document", head)
  ).get(documentId);
  if (!path) throw new CoreError("NOT_FOUND");
  const file = await repo.readCommittedFileAt(head, path);
  if (!file) throw new CoreError("NOT_FOUND");
  const { meta, body } = parseDocumentFile(file.content, "markdown");
  if (meta.id !== documentId) throw new CoreError("NOT_FOUND");
  return {
    kind: "document",
    id: documentId,
    path,
    title: meta.title,
    revision: file.baseCommitSha,
    markdown: body,
    meta,
  };
}

/** Committed title and columns only; avoids loading rows for labels and examples. */
export async function readMachineTableSchema(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoReader,
  projectId: string,
  tableId: string,
): Promise<{
  id: string;
  path: string;
  title: string;
  columns: TableColumn[];
}> {
  const owner = await db.dataTable.findUnique({
    where: { id: tableId },
    select: { projectId: true },
  });
  if (owner && owner.projectId !== projectId) throw new CoreError("NOT_FOUND");
  const head = await repo.resolveHead();
  const path = (
    await resourceIdentityIndex(repo, projectId, "table", head)
  ).get(tableId);
  if (!path) throw new CoreError("NOT_FOUND");
  const file = `${path}/schema.json`;
  const text = (
    await repo.readBlobsAt(head, [file], MAX_SCHEMA_FILE_BYTES)
  ).get(file);
  if (text === undefined) throw new CoreError("NOT_FOUND");
  const schema = parseSchemaFile(text);
  if (schema.id !== tableId) throw new CoreError("NOT_FOUND");
  return { id: tableId, path, title: schema.title, columns: schema.columns };
}

export async function readMachineTableSnapshot(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoReader,
  projectId: string,
  tableId: string,
): Promise<MachineTableSnapshot> {
  const owner = await db.dataTable.findUnique({
    where: { id: tableId },
    select: { projectId: true },
  });
  if (owner && owner.projectId !== projectId) throw new CoreError("NOT_FOUND");
  const head = await repo.resolveHead();
  if (
    !(await resourceIdentityIndex(repo, projectId, "table", head)).has(tableId)
  )
    throw new CoreError("NOT_FOUND");
  const table = await getTableInRepo(db, repo, projectId, tableId, head);
  return {
    kind: "table",
    id: table.id,
    path: table.path,
    title: table.title,
    revision: table.baseCommitSha,
    columns: table.columns,
    rows: table.rows,
  };
}

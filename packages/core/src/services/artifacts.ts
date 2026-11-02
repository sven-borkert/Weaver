import { constants } from "node:fs";
import { WIKI_UNPROTECTING_ITEM_STATUSES } from "../wiki/states";
import { open } from "node:fs/promises";
import { parseServerEnv } from "@weaver/config/server";
import { createHash } from "node:crypto";
import { pipeline, Readable, Transform } from "node:stream";
import { Prisma, type PrismaClient } from "@weaver/db/client";

import {
  artifactContentMatches,
  contentTypeForFilename,
} from "../artifacts/contentTypes";
import {
  artifactFilenameKey,
  validateArtifactFilename,
} from "../artifacts/filenames";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { isBlobReferenced, retainedBytes } from "../ingestion/blobReferences";
import {
  deleteBlob,
  openBlobStream,
  promoteUpload,
} from "../ingestion/blobStore";
import { blobPath, DIGEST_RE, UUID_RE } from "../ingestion/paths";
import { MAX_INGESTION_UPLOAD_FILES } from "../ingestion/limits";
import {
  isNotebookFilename,
  NOTEBOOK_PARSER_VERSION,
  type NotebookStatus,
} from "../artifacts/notebookSchema";
import {
  queueNotebookPreparation,
  requestNotebookPreparation,
  sweepArtifactNotebook,
} from "./artifactNotebookJobs";
import { withProjectIngestionLifecycleLock } from "./ingestion";
import { assertProjectRole, type ProjectActor } from "./projectAccess";

type Db = PrismaClient | Prisma.TransactionClient;

const SUMMARY = {
  id: true,
  projectId: true,
  filename: true,
  contentType: true,
  byteSize: true,
  contentDigest: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ArtifactSelect;

export type ArtifactSummary = Prisma.ArtifactGetPayload<{
  select: typeof SUMMARY;
}>;

export type ArtifactUploadFile = {
  uploadId: string;
  filename: string;
  contentDigest: string;
  byteSize: number;
  replace: boolean;
};

const notFound = () => new CoreError("NOT_FOUND", "not found");

/** A live wiki input pins its original; failed and removed items lift this. */
async function assertNotWikiSources(
  db: Db,
  projectId: string,
  artifactIds: readonly string[],
): Promise<void> {
  if (artifactIds.length === 0) return;
  const protectedCount = await db.wikiInputItem.count({
    where: {
      projectId,
      artifactId: { in: [...artifactIds] },
      status: { notIn: [...WIKI_UNPROTECTING_ITEM_STATUSES] },
    },
  });
  if (protectedCount > 0)
    throw new CoreError(
      "CONFLICT",
      "This file is a wiki input. Remove it from the wiki input before replacing or deleting it.",
      { reason: "SOURCE_PROTECTED" },
    );
}

async function projectIdFor(
  db: Db,
  actor: ProjectActor,
  projectId: string,
  role: "Viewer" | "Editor",
): Promise<string> {
  if (!UUID_RE.test(projectId)) throw notFound();
  return (await assertProjectRole(db, projectId, actor, role)).project.id;
}

export type ArtifactNotebookListState = {
  status: NotebookStatus;
  error: string | null;
  finishedAt: Date | null;
  sectionCount: number | null;
  pageCount: number | null;
  emptySectionCount: number | null;
  unreadableSectionCount: number | null;
};

function notebookListState(
  artifact: { filename: string; contentDigest: string },
  row:
    | ({ contentDigest: string; parserVersion: number } & Omit<
        ArtifactNotebookListState,
        "status"
      > & { status: Exclude<NotebookStatus, "unprepared"> })
    | null,
): ArtifactNotebookListState | null {
  if (!isNotebookFilename(artifact.filename)) return null;
  if (
    row?.contentDigest !== artifact.contentDigest ||
    row.parserVersion !== NOTEBOOK_PARSER_VERSION
  )
    return {
      status: "unprepared",
      error: null,
      finishedAt: null,
      sectionCount: null,
      pageCount: null,
      emptySectionCount: null,
      unreadableSectionCount: null,
    };
  const { contentDigest: _digest, parserVersion: _version, ...state } = row;
  return state;
}

export async function listArtifacts(
  db: PrismaClient,
  actor: ProjectActor,
  input: {
    projectId: string;
    page: number;
    pageSize: number;
    search?: string;
    sort: "filename" | "byteSize" | "updatedAt";
    dir: "asc" | "desc";
  },
) {
  const projectId = await projectIdFor(db, actor, input.projectId, "Viewer");
  const where: Prisma.ArtifactWhereInput = {
    projectId,
    ...(input.search
      ? { filenameKey: { contains: artifactFilenameKey(input.search) } }
      : {}),
  };
  const total = await db.artifact.count({ where });
  const items = await db.artifact.findMany({
    where,
    orderBy: [
      input.sort === "filename"
        ? { filenameKey: input.dir }
        : { [input.sort]: input.dir },
      { id: "asc" },
    ],
    skip: (input.page - 1) * input.pageSize,
    take: input.pageSize,
    select: {
      ...SUMMARY,
      notebook: {
        select: {
          contentDigest: true,
          parserVersion: true,
          status: true,
          error: true,
          finishedAt: true,
          sectionCount: true,
          pageCount: true,
          emptySectionCount: true,
          unreadableSectionCount: true,
        },
      },
    },
  });
  return {
    items: items.map(({ notebook, ...artifact }) => ({
      ...artifact,
      notebook: notebookListState(artifact, notebook),
    })),
    total,
    page: input.page,
    pageSize: input.pageSize,
    pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
  };
}

export async function getArtifact(
  db: Db,
  actor: ProjectActor,
  input:
    | { projectId: string; artifactId: string }
    | { projectId: string; filename: string },
): Promise<ArtifactSummary> {
  const projectId = await projectIdFor(db, actor, input.projectId, "Viewer");
  if ("artifactId" in input && !UUID_RE.test(input.artifactId))
    throw notFound();
  const artifact = await db.artifact.findFirst({
    where:
      "artifactId" in input
        ? { id: input.artifactId, projectId }
        : { projectId, filenameKey: artifactFilenameKey(input.filename) },
    select: SUMMARY,
  });
  if (!artifact) throw notFound();
  return artifact;
}

/** Runs before any request byte reaches disk. */
export async function authorizeArtifactUpload(
  db: PrismaClient,
  actor: ProjectActor,
  projectId: string,
): Promise<{ projectId: string }> {
  return { projectId: await projectIdFor(db, actor, projectId, "Editor") };
}

async function unlinkUnreferenced(
  db: PrismaClient,
  projectId: string,
  digests: readonly string[],
  dataDir: string,
): Promise<number> {
  if (digests.length === 0) return 0;
  return withProjectIngestionLifecycleLock(db, projectId, async (tx) => {
    let removed = 0;
    for (const digest of new Set(digests)) {
      if (await isBlobReferenced(tx, projectId, digest)) continue;
      await deleteBlob(dataDir, projectId, digest);
      removed += 1;
    }
    return removed;
  });
}

async function reconcileLater(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    console.warn("Committed artifact follow-up deferred to reconciliation");
  }
}

export async function finalizeArtifactUpload(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; files: ArtifactUploadFile[] },
  options: { dataDir: string; projectQuotaBytes?: number },
): Promise<{ artifacts: ArtifactSummary[] }> {
  if (
    input.files.length === 0 ||
    input.files.length > MAX_INGESTION_UPLOAD_FILES
  )
    throw new CoreError(
      "BAD_REQUEST",
      `files must contain 1 to ${MAX_INGESTION_UPLOAD_FILES} entries`,
    );
  const files = input.files.map((file) => {
    validateArtifactFilename(file.filename);
    if (
      !UUID_RE.test(file.uploadId) ||
      !DIGEST_RE.test(file.contentDigest) ||
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize < 0 ||
      file.byteSize > 2_147_483_647
    )
      throw new CoreError("BAD_REQUEST", "upload reference is invalid");
    return { ...file, key: artifactFilenameKey(file.filename) };
  });
  if (new Set(files.map((file) => file.key)).size !== files.length)
    throw new CoreError(
      "BAD_REQUEST",
      "the same filename appears more than once in this upload",
    );

  const stored = await withProjectIngestionLifecycleLock(
    db,
    input.projectId,
    async (tx) => {
      const projectId = await projectIdFor(
        tx,
        actor,
        input.projectId,
        "Editor",
      );
      const existing = await tx.artifact.findMany({
        where: {
          projectId,
          filenameKey: { in: files.map((file) => file.key) },
        },
        select: { id: true, filenameKey: true, contentDigest: true },
      });
      const byKey = new Map(existing.map((row) => [row.filenameKey, row]));
      const conflicts = files
        .filter((file) => byKey.has(file.key) && !file.replace)
        .map((file) => file.filename);
      if (conflicts.length)
        throw new CoreError(
          "CONFLICT",
          "a file with this name already exists",
          { conflicts },
        );
      await assertNotWikiSources(
        tx,
        projectId,
        existing.map((row) => row.id),
      );
      const retained = await retainedBytes(
        tx,
        projectId,
        files.map((file) => ({
          digest: file.contentDigest,
          byteSize: file.byteSize,
        })),
        existing.map((row) => row.id),
      );
      if (retained > BigInt(options.projectQuotaBytes ?? 5 * 1024 ** 3))
        throw new CoreError(
          "PRECONDITION_FAILED",
          "Project upload storage quota exceeded; delete an old import batch or file before uploading more files",
        );

      const artifacts: { artifact: ArtifactSummary; replaced: boolean }[] = [];
      const replacedDigests: string[] = [];
      const notebookJobs: Awaited<
        ReturnType<typeof queueNotebookPreparation>
      >[] = [];
      for (const file of files) {
        await promoteUpload(
          options.dataDir,
          projectId,
          file.uploadId,
          file.contentDigest,
        );
        const current = byKey.get(file.key);
        try {
          if (current) {
            if (current.contentDigest !== file.contentDigest)
              replacedDigests.push(current.contentDigest);
            artifacts.push({
              artifact: await tx.artifact.update({
                where: { id: current.id },
                data: {
                  contentDigest: file.contentDigest,
                  byteSize: file.byteSize,
                  uploadedById: actor.userId,
                },
                select: SUMMARY,
              }),
              replaced: true,
            });
          } else {
            artifacts.push({
              artifact: await tx.artifact.create({
                data: {
                  projectId,
                  filename: file.filename,
                  filenameKey: file.key,
                  contentDigest: file.contentDigest,
                  byteSize: file.byteSize,
                  contentType: contentTypeForFilename(file.filename),
                  uploadedById: actor.userId,
                },
                select: SUMMARY,
              }),
              replaced: false,
            });
          }
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          )
            throw new CoreError(
              "CONFLICT",
              "a file with this name already exists",
              { conflicts: [file.filename] },
            );
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2025"
          )
            throw new CoreError(
              "CONFLICT",
              "the file being replaced was deleted; upload it again",
              { conflicts: [file.filename] },
            );
          throw error;
        }
        const stored = artifacts.at(-1)!.artifact;
        if (isNotebookFilename(stored.filename))
          notebookJobs.push(
            await queueNotebookPreparation(tx, stored, actor.userId),
          );
      }
      return { projectId, artifacts, replacedDigests, notebookJobs };
    },
  );

  await reconcileLater(() => requestNotebookPreparation(stored.notebookJobs));
  await reconcileLater(() =>
    unlinkUnreferenced(
      db,
      stored.projectId,
      stored.replacedDigests,
      options.dataDir,
    ),
  );
  for (const job of stored.notebookJobs)
    if (job)
      await reconcileLater(() =>
        sweepArtifactNotebook(
          db,
          options.dataDir,
          job.projectId,
          job.artifactId,
        ),
      );
  for (const { artifact, replaced } of stored.artifacts) {
    emitDiagnostic({
      event: replaced ? "artifact.replaced" : "artifact.uploaded",
      severity: "info",
      message: "artifact stored",
      projectId: stored.projectId,
      details: { artifactId: artifact.id, byteSize: artifact.byteSize },
    });
  }
  return { artifacts: stored.artifacts.map((entry) => entry.artifact) };
}

export async function renameArtifact(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; artifactId: string; filename: string },
): Promise<ArtifactSummary> {
  validateArtifactFilename(input.filename);
  if (!UUID_RE.test(input.projectId)) throw notFound();
  const renamed = await withProjectIngestionLifecycleLock(
    db,
    input.projectId,
    async (tx) => {
      const projectId = await projectIdFor(
        tx,
        actor,
        input.projectId,
        "Editor",
      );
      if (!UUID_RE.test(input.artifactId)) throw notFound();
      const current = await tx.artifact.findFirst({
        where: { id: input.artifactId, projectId },
        select: {
          id: true,
          filename: true,
          contentType: true,
          contentDigest: true,
        },
      });
      if (!current) throw notFound();
      const contentType = contentTypeForFilename(input.filename);
      if (contentType !== current.contentType) {
        const file = await open(
          blobPath(
            parseServerEnv(process.env).WEAVER_DATA_DIR,
            projectId,
            current.contentDigest,
          ),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const head = Buffer.alloc(16);
          const { bytesRead } = await file.read(head, 0, head.length, 0);
          if (!artifactContentMatches(contentType, head.subarray(0, bytesRead)))
            throw new CoreError(
              "BAD_REQUEST",
              "file content does not match the new filename",
              { field: "filename" },
            );
        } finally {
          await file.close();
        }
      }
      try {
        const artifact = await tx.artifact.update({
          where: { id: current.id },
          data: {
            filename: input.filename,
            filenameKey: artifactFilenameKey(input.filename),
            contentType: contentTypeForFilename(input.filename),
          },
          select: SUMMARY,
        });
        const wasNotebook = isNotebookFilename(current.filename);
        const isNotebook = isNotebookFilename(input.filename);
        if (wasNotebook && !isNotebook)
          await tx.artifactNotebook.deleteMany({
            where: { artifactId: current.id },
          });
        const notebookJob = isNotebook
          ? await queueNotebookPreparation(tx, artifact, actor.userId)
          : null;
        return { artifact, notebookJob, sweep: wasNotebook && !isNotebook };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
          throw new CoreError(
            "CONFLICT",
            "a file with this name already exists",
            { field: "filename" },
          );
        throw error;
      }
    },
  );
  await reconcileLater(() => requestNotebookPreparation([renamed.notebookJob]));
  if (renamed.sweep)
    await reconcileLater(() =>
      sweepArtifactNotebook(
        db,
        parseServerEnv(process.env).WEAVER_DATA_DIR,
        renamed.artifact.projectId,
        renamed.artifact.id,
      ),
    );
  emitDiagnostic({
    event: "artifact.renamed",
    severity: "info",
    message: "artifact renamed",
    projectId: renamed.artifact.projectId,
    details: { artifactId: input.artifactId },
  });
  return renamed.artifact;
}

export async function deleteArtifact(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; artifactId: string },
  options: { dataDir: string },
): Promise<{ deletedBlob: boolean }> {
  const removed = await withProjectIngestionLifecycleLock(
    db,
    input.projectId,
    async (tx) => {
      const projectId = await projectIdFor(
        tx,
        actor,
        input.projectId,
        "Editor",
      );
      if (!UUID_RE.test(input.artifactId)) throw notFound();
      const artifact = await tx.artifact.findFirst({
        where: { id: input.artifactId, projectId },
        select: { id: true, contentDigest: true },
      });
      if (!artifact) throw notFound();
      await assertNotWikiSources(tx, projectId, [artifact.id]);
      await tx.artifact.delete({ where: { id: artifact.id } });
      return {
        projectId,
        artifactId: artifact.id,
        digest: artifact.contentDigest,
      };
    },
  );
  const count = await unlinkUnreferenced(
    db,
    removed.projectId,
    [removed.digest],
    options.dataDir,
  );
  await sweepArtifactNotebook(
    db,
    options.dataDir,
    removed.projectId,
    removed.artifactId,
  );
  emitDiagnostic({
    event: "artifact.deleted",
    severity: "info",
    message: "artifact deleted",
    projectId: removed.projectId,
    details: { artifactId: input.artifactId, deletedBlob: count > 0 },
  });
  return { deletedBlob: count > 0 };
}

const contentGone = () =>
  new CoreError("NOT_FOUND", "file content is no longer stored");

/** Verifies the bytes while they stream; the body errors at its end on a mismatch. */
function verifyingTransform(expectedDigest: string, expectedSize: number) {
  const hash = createHash("sha256");
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      seen += chunk.byteLength;
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        seen === expectedSize && hash.digest("hex") === expectedDigest
          ? null
          : contentGone(),
      );
    },
  });
}

/** Opens a Viewer-authorized download as a web stream; the caller must consume or cancel `body`. */
export async function openArtifactStream(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; artifactId: string },
  options: { dataDir: string; maxBytes: number },
): Promise<{
  artifact: ArtifactSummary;
  size: number;
  body: ReadableStream<Uint8Array>;
}> {
  const artifact = await getArtifact(db, actor, input);
  let opened: Awaited<ReturnType<typeof openBlobStream>>;
  try {
    opened = await openBlobStream(
      options.dataDir,
      artifact.projectId,
      artifact.contentDigest,
      options.maxBytes,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw contentGone();
    if (error instanceof RangeError)
      throw new CoreError("BAD_REQUEST", "file is larger than the read limit", {
        reason: "PAYLOAD_TOO_LARGE",
      });
    throw error;
  }
  if (opened.size !== artifact.byteSize) {
    opened.stream.destroy();
    throw contentGone();
  }
  const verified = pipeline(
    opened.stream,
    verifyingTransform(artifact.contentDigest, opened.size),
    () => undefined,
  );
  return {
    artifact,
    size: opened.size,
    body: Readable.toWeb(verified) as ReadableStream<Uint8Array>,
  };
}

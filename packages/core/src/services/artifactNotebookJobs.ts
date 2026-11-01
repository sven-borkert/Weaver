import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { parseServerEnv } from "@weaver/config/server";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  NOTEBOOK_PARSER_VERSION,
  NOTEBOOK_TIMEOUT_MS,
  isNotebookFilename,
} from "../artifacts/notebookSchema";
import {
  assertNotebookPath,
  createNotebookDirectory,
  notebookClaimDir,
  validateNotebookSnapshot,
} from "../artifacts/notebookStorage";
import type { NotebookManifest } from "../artifacts/notebookSchema";
import { retainedBytes } from "../ingestion/blobReferences";
import { blobPath, DIGEST_RE, UUID_RE } from "../ingestion/paths";
import { requestKnowledgeJob } from "../jobs/queue";
import type {
  ArtifactNotebookRunner,
  KnowledgeJobPayloads,
} from "../jobs/types";
import { withProjectIngestionLifecycleLock } from "./ingestion";

export type RunNotebookParser = (input: {
  sourcePath: string;
  outputDir: string;
  signal: AbortSignal;
}) => Promise<void>;

type Tx = Prisma.TransactionClient;
type ArtifactNotebookPayload =
  KnowledgeJobPayloads["artifact.notebook.prepare"];

export const CLEARED_NOTEBOOK_SUMMARY = {
  sectionCount: null,
  pageCount: null,
  emptySectionCount: null,
  unreadableSectionCount: null,
};

/** Runs in the caller's lifecycle-locked transaction; returns the payload to enqueue after commit. */
export async function queueNotebookPreparation(
  tx: Tx,
  artifact: { id: string; projectId: string; contentDigest: string },
  requestedById: string | null,
  options: { force?: boolean } = {},
): Promise<ArtifactNotebookPayload | null> {
  const current = await tx.artifactNotebook.findUnique({
    where: { artifactId: artifact.id },
  });
  if (
    !options.force &&
    current?.contentDigest === artifact.contentDigest &&
    current.parserVersion === NOTEBOOK_PARSER_VERSION &&
    current.status !== "failed"
  )
    return null;
  const data = {
    contentDigest: artifact.contentDigest,
    parserVersion: NOTEBOOK_PARSER_VERSION,
    status: "queued" as const,
    claimToken: null,
    startedAt: null,
    error: null,
    snapshotBytes: 0,
    requestedById,
    queuedAt: new Date(),
    finishedAt: null,
    ...CLEARED_NOTEBOOK_SUMMARY,
  };
  await tx.artifactNotebook.upsert({
    where: { artifactId: artifact.id },
    create: { artifactId: artifact.id, ...data },
    update: data,
  });
  return {
    projectId: artifact.projectId,
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
  };
}

export async function requestNotebookPreparation(
  payloads: readonly (ArtifactNotebookPayload | null)[],
): Promise<void> {
  for (const payload of payloads)
    if (payload)
      await requestKnowledgeJob("artifact.notebook.prepare", payload);
}

function manifestSummary(manifest: NotebookManifest) {
  const count = (content: string) =>
    manifest.sections.filter((section) => section.content === content).length;
  return {
    sectionCount: manifest.sections.length,
    pageCount: manifest.sections.reduce(
      (total, section) => total + section.pages.length,
      0,
    ),
    emptySectionCount: count("empty"),
    unreadableSectionCount: count("unreadable"),
  };
}

async function verifySource(
  dataDir: string,
  sourcePath: string,
  digest: string,
  maxBytes: number,
  signal: AbortSignal,
) {
  await assertNotebookPath(dataDir, sourcePath);
  const file = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("invalid_notebook_source");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("invalid_notebook_source");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== info.size || hash.digest("hex") !== digest)
      throw new Error("invalid_notebook_source");
  } finally {
    await file.close();
  }
}

export function createArtifactNotebookRunner(options: {
  db: PrismaClient;
  dataDir: string;
  runNotebookParser: RunNotebookParser;
  maxSourceBytes?: number;
  projectQuotaBytes?: number;
}): ArtifactNotebookRunner {
  return async (payload, execution) => {
    if (
      !UUID_RE.test(payload.projectId) ||
      !UUID_RE.test(payload.artifactId) ||
      !DIGEST_RE.test(payload.contentDigest) ||
      execution.signal.aborted
    )
      return;
    const claimToken = randomUUID();
    const dir = notebookClaimDir(
      options.dataDir,
      payload.projectId,
      payload.artifactId,
      payload.contentDigest,
      NOTEBOOK_PARSER_VERSION,
      claimToken,
    );
    const claimed = await withProjectIngestionLifecycleLock(
      options.db,
      payload.projectId,
      async (tx) => {
        const artifact = await tx.artifact.findFirst({
          where: {
            id: payload.artifactId,
            projectId: payload.projectId,
            contentDigest: payload.contentDigest,
            project: { deletedAt: null },
          },
        });
        if (!artifact || !isNotebookFilename(artifact.filename)) return false;
        const result = await tx.artifactNotebook.updateMany({
          where: {
            artifactId: artifact.id,
            contentDigest: payload.contentDigest,
            parserVersion: NOTEBOOK_PARSER_VERSION,
            status: "queued",
          },
          data: {
            status: "running",
            claimToken,
            startedAt: new Date(),
            error: null,
          },
        });
        if (result.count !== 1) return false;
        // Created under the lock so a concurrent delete sweep cannot prune it.
        await createNotebookDirectory(options.dataDir, dir);
        return true;
      },
    );
    if (!claimed) return;
    const signal = AbortSignal.any([
      execution.signal,
      AbortSignal.timeout(NOTEBOOK_TIMEOUT_MS),
    ]);
    let published = false;
    try {
      const sourcePath = blobPath(
        options.dataDir,
        payload.projectId,
        payload.contentDigest,
      );
      await verifySource(
        options.dataDir,
        sourcePath,
        payload.contentDigest,
        options.maxSourceBytes ??
          parseServerEnv(process.env).WEAVER_ARTIFACT_MAX_FILE_BYTES,
        signal,
      );
      await assertNotebookPath(options.dataDir, dir);
      await options.runNotebookParser({ sourcePath, outputDir: dir, signal });
      signal.throwIfAborted();
      const { byteSize, manifest } = await validateNotebookSnapshot(
        options.dataDir,
        dir,
        signal,
      );
      signal.throwIfAborted();
      published = await withProjectIngestionLifecycleLock(
        options.db,
        payload.projectId,
        async (tx) => {
          if (signal.aborted) return false;
          const artifact = await tx.artifact.findFirst({
            where: {
              id: payload.artifactId,
              projectId: payload.projectId,
              contentDigest: payload.contentDigest,
              project: { deletedAt: null },
            },
          });
          if (!artifact || !isNotebookFilename(artifact.filename)) return false;
          const quota =
            options.projectQuotaBytes ??
            parseServerEnv(process.env).WEAVER_INGESTION_PROJECT_QUOTA_BYTES;
          const reserved = await tx.uploadReservation.aggregate({
            where: {
              projectId: payload.projectId,
              expiresAt: { gt: new Date() },
            },
            _sum: { bytes: true },
          });
          if (
            (await retainedBytes(tx, payload.projectId, [])) +
              (reserved._sum.bytes ?? 0n) +
              BigInt(byteSize) >
            BigInt(quota)
          )
            throw new Error("quota_exceeded");
          const result = await tx.artifactNotebook.updateMany({
            where: {
              artifactId: artifact.id,
              contentDigest: payload.contentDigest,
              parserVersion: NOTEBOOK_PARSER_VERSION,
              status: "running",
              claimToken,
            },
            data: {
              status: "ready",
              error: null,
              snapshotBytes: BigInt(byteSize),
              finishedAt: new Date(),
              ...manifestSummary(manifest),
            },
          });
          return result.count === 1;
        },
      );
    } catch (error) {
      await options.db.artifactNotebook.updateMany({
        where: {
          artifactId: payload.artifactId,
          status: "running",
          contentDigest: payload.contentDigest,
          claimToken,
        },
        data: {
          status: execution.signal.aborted ? "queued" : "failed",
          claimToken: null,
          startedAt: null,
          finishedAt: execution.signal.aborted ? null : new Date(),
          error: execution.signal.aborted
            ? null
            : signal.aborted
              ? "parse_timeout"
              : error instanceof Error && error.message === "quota_exceeded"
                ? "quota_exceeded"
                : "parse_failed",
        },
      });
    } finally {
      if (!published)
        await sweepArtifactNotebook(
          options.db,
          options.dataDir,
          payload.projectId,
          payload.artifactId,
        );
    }
  };
}

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function removeIfEmpty(dir: string) {
  try {
    await rmdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT")
      throw error;
  }
}

/** Under the lifecycle lock, so it never races a claim creating its directory. */
export async function sweepArtifactNotebook(
  db: PrismaClient,
  dataDir: string,
  projectId: string,
  artifactId: string,
): Promise<void> {
  if (!UUID_RE.test(projectId) || !UUID_RE.test(artifactId)) return;
  const projectDir = path.join(dataDir, "notebooks", projectId);
  const artifactDir = path.join(projectDir, artifactId);
  await withProjectIngestionLifecycleLock(db, projectId, async (tx) => {
    try {
      await assertNotebookPath(dataDir, artifactDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = await tx.artifactNotebook.findFirst({
      where: {
        artifactId,
        artifact: { projectId, project: { deletedAt: null } },
      },
      include: {
        artifact: { select: { contentDigest: true, filename: true } },
      },
    });
    const keep =
      state?.claimToken &&
      state.contentDigest === state.artifact.contentDigest &&
      state.parserVersion === NOTEBOOK_PARSER_VERSION &&
      isNotebookFilename(state.artifact.filename) &&
      ["running", "ready"].includes(state.status)
        ? notebookClaimDir(
            dataDir,
            projectId,
            artifactId,
            state.contentDigest,
            state.parserVersion,
            state.claimToken,
          )
        : null;
    if (!keep) {
      await rm(artifactDir, { recursive: true, force: true });
    } else {
      for (const digest of await entries(artifactDir)) {
        const digestDir = path.join(artifactDir, digest.name);
        if (!digest.isDirectory() || !DIGEST_RE.test(digest.name)) {
          await rm(digestDir, { recursive: true, force: true });
          continue;
        }
        for (const version of await entries(digestDir)) {
          const versionDir = path.join(digestDir, version.name);
          if (!version.isDirectory() || !/^\d+$/.test(version.name)) {
            await rm(versionDir, { recursive: true, force: true });
            continue;
          }
          for (const claim of await entries(versionDir)) {
            const target = path.join(versionDir, claim.name);
            if (target !== keep)
              await rm(target, { recursive: true, force: true });
          }
          await removeIfEmpty(versionDir);
        }
        await removeIfEmpty(digestDir);
      }
      await removeIfEmpty(artifactDir);
    }
    await removeIfEmpty(projectDir);
  });
}

async function sweepNotebookSnapshots(db: PrismaClient, dataDir: string) {
  const root = path.join(dataDir, "notebooks");
  try {
    await assertNotebookPath(dataDir, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const project of await entries(root)) {
    const projectDir = path.join(root, project.name);
    if (!project.isDirectory() || !UUID_RE.test(project.name)) {
      await rm(projectDir, { recursive: true, force: true });
      continue;
    }
    await assertNotebookPath(dataDir, projectDir);
    for (const artifact of await entries(projectDir)) {
      if (!artifact.isDirectory() || !UUID_RE.test(artifact.name)) {
        await rm(path.join(projectDir, artifact.name), {
          recursive: true,
          force: true,
        });
        continue;
      }
      await sweepArtifactNotebook(db, dataDir, project.name, artifact.name);
    }
    await removeIfEmpty(projectDir);
  }
}

export async function reconcileArtifactNotebooks(
  db: PrismaClient,
  options: { dataDir?: string; now?: Date } = {},
) {
  const dataDir =
    options.dataDir ?? parseServerEnv(process.env).WEAVER_DATA_DIR;
  const now = options.now ?? new Date();
  const expired = new Date(now.getTime() - NOTEBOOK_TIMEOUT_MS - 60_000);
  // One row's failure must not skip the rest of the pass or the sweep that
  // reclaims snapshot disk; every error is collected and thrown at the end.
  const errors: unknown[] = [];
  let cursor: string | undefined;
  while (true) {
    const rows = await db.artifactNotebook.findMany({
      orderBy: { artifactId: "asc" },
      take: 250,
      ...(cursor ? { cursor: { artifactId: cursor }, skip: 1 } : {}),
      include: {
        artifact: {
          select: {
            projectId: true,
            contentDigest: true,
            filename: true,
            project: { select: { deletedAt: true } },
          },
        },
      },
    });
    if (!rows.length) break;
    for (const row of rows) {
      try {
        await reconcileArtifactNotebookRow(db, dataDir, row, expired);
      } catch (error) {
        errors.push(error);
      }
    }
    cursor = rows.at(-1)!.artifactId;
  }
  try {
    await queueUnpreparedNotebooks(db);
  } catch (error) {
    errors.push(error);
  }
  await sweepNotebookSnapshots(db, dataDir);
  if (errors.length)
    throw new AggregateError(
      errors,
      "artifact notebook reconciliation failed for some notebooks",
    );
}

/** Notebooks uploaded before preparation started on upload. */
async function queueUnpreparedNotebooks(db: PrismaClient) {
  let cursor: string | undefined;
  while (true) {
    const artifacts = await db.artifact.findMany({
      where: {
        contentType: "application/onenote",
        notebook: null,
        project: { deletedAt: null },
      },
      orderBy: { id: "asc" },
      take: 250,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, projectId: true },
    });
    if (!artifacts.length) return;
    for (const candidate of artifacts) {
      const payload = await withProjectIngestionLifecycleLock(
        db,
        candidate.projectId,
        async (tx) => {
          const artifact = await tx.artifact.findFirst({
            where: {
              id: candidate.id,
              projectId: candidate.projectId,
              notebook: null,
              project: { deletedAt: null },
            },
            select: {
              id: true,
              projectId: true,
              contentDigest: true,
              filename: true,
            },
          });
          if (!artifact || !isNotebookFilename(artifact.filename)) return null;
          return queueNotebookPreparation(tx, artifact, null);
        },
      );
      await requestNotebookPreparation([payload]);
    }
    cursor = artifacts.at(-1)!.id;
  }
}

type ReconcileRow = Prisma.ArtifactNotebookGetPayload<{
  include: {
    artifact: {
      select: {
        projectId: true;
        contentDigest: true;
        filename: true;
        project: { select: { deletedAt: true } };
      };
    };
  };
}>;

async function reconcileArtifactNotebookRow(
  db: PrismaClient,
  dataDir: string,
  row: ReconcileRow,
  expired: Date,
): Promise<void> {
  const orphaned =
    row.artifact.project.deletedAt !== null ||
    !isNotebookFilename(row.artifact.filename);
  if (
    !orphaned &&
    (row.artifact.contentDigest !== row.contentDigest ||
      row.parserVersion !== NOTEBOOK_PARSER_VERSION)
  ) {
    // A replaced file or an upgraded parser: rebuild instead of dropping.
    const payload = await withProjectIngestionLifecycleLock(
      db,
      row.artifact.projectId,
      async (tx) => {
        const artifact = await tx.artifact.findFirst({
          where: {
            id: row.artifactId,
            projectId: row.artifact.projectId,
            project: { deletedAt: null },
          },
          select: {
            id: true,
            projectId: true,
            contentDigest: true,
            filename: true,
          },
        });
        const current = await tx.artifactNotebook.findUnique({
          where: { artifactId: row.artifactId },
          select: { updatedAt: true },
        });
        if (
          !artifact ||
          !isNotebookFilename(artifact.filename) ||
          current?.updatedAt.getTime() !== row.updatedAt.getTime()
        )
          return null;
        return queueNotebookPreparation(tx, artifact, null);
      },
    );
    await requestNotebookPreparation([payload]);
    return;
  }
  if (orphaned) {
    await db.artifactNotebook.deleteMany({
      where: {
        artifactId: row.artifactId,
        contentDigest: row.contentDigest,
        updatedAt: row.updatedAt,
      },
    });
    return;
  }
  if (row.status === "running" && (!row.startedAt || row.startedAt < expired)) {
    await db.artifactNotebook.updateMany({
      where: {
        artifactId: row.artifactId,
        status: "running",
        claimToken: row.claimToken,
        updatedAt: row.updatedAt,
      },
      data: {
        status: "queued",
        claimToken: null,
        startedAt: null,
        error: null,
      },
    });
  }
  if (row.status === "ready" && row.claimToken) {
    const manifest = path.join(
      notebookClaimDir(
        dataDir,
        row.artifact.projectId,
        row.artifactId,
        row.contentDigest,
        row.parserVersion,
        row.claimToken,
      ),
      "manifest.json",
    );
    try {
      await assertNotebookPath(dataDir, manifest);
      if (!(await lstat(manifest)).isFile())
        throw new Error("missing_snapshot");
    } catch {
      await db.artifactNotebook.updateMany({
        where: {
          artifactId: row.artifactId,
          status: "ready",
          claimToken: row.claimToken,
        },
        data: {
          status: "failed",
          claimToken: null,
          error: "snapshot_unavailable",
          snapshotBytes: 0,
          finishedAt: new Date(),
          ...CLEARED_NOTEBOOK_SUMMARY,
        },
      });
    }
  }
  const current = await db.artifactNotebook.findUnique({
    where: { artifactId: row.artifactId },
  });
  if (current?.status === "queued")
    await requestKnowledgeJob("artifact.notebook.prepare", {
      projectId: row.artifact.projectId,
      artifactId: row.artifactId,
      contentDigest: current.contentDigest,
    });
}

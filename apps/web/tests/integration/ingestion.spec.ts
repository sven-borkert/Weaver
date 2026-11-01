import { composeRootFolderMetadata } from "@weaver/core/documents/folderMetadata";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  blobExists,
  openUploadSink,
  readBlob,
} from "@weaver/core/ingestion/blobStore";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { proposedLinksSchema } from "@weaver/core/ingestion/links";
import {
  MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
  projectDocumentSectionAnchors,
} from "@weaver/core/knowledge/sectionAnchors";
import { loadLexicalDocuments } from "@weaver/core/services/searchLexical";
import { CoreError } from "@weaver/core/errors";
import { blobPath, tmpPath } from "@weaver/core/ingestion/paths";
import {
  FakeJobQueue,
  requestKnowledgeJob,
  setJobQueueForTests,
  type JobExecution,
  type JobQueue,
} from "@weaver/core/jobs/queue";
import { PgBossQueue } from "@weaver/core/jobs/pgBossQueue";
import type { KnowledgeJobPayloads } from "@weaver/core/jobs/types";
import {
  reconcileIngestionFiles,
  sweepAbandonedUploads,
} from "@weaver/core/jobs/ingestionHandlers";
import type { ProjectRoleName } from "@weaver/core/roles";
import type { Prisma } from "@weaver/db/client";
import { getSessionUser, type SessionUser } from "~/server/auth";
import { createCaller } from "~/server/api/root";
import {
  authorizeIngestionUpload,
  claimFileForAnalysis,
  claimFileForLinking,
  claimFileForParsing,
  completeAnalysis,
  completeLinking,
  completeParse,
  createUploadBatch,
  deleteBatch,
  failFile,
  finalizeUploadBatch,
  getBatch,
  getFile,
  listBatches,
  INGESTION_EXHAUSTED_MESSAGE,
  listStaleIngestionFiles,
  MAX_INGESTION_ATTEMPTS,
  recordParseAttemptDetails,
  reserveIngestionFileRecovery,
  registerUploadedFile,
  retryFile,
  updateDraft,
  withProjectIngestionLifecycleLock,
} from "@weaver/core/services/ingestion";
import { invalidateIngestionSettingsCache } from "@weaver/core/services/ingestionSettings";
import { MockLanguageModelV4 } from "ai/test";
import { createIngestionParseRunner } from "@weaver/ingestion/parseStage";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
} from "@weaver/core/diagnostics/writer";
import {
  invalidateDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import { createIngestionAnalyzeRunner } from "@weaver/ingestion/analyzeStage";
import {
  docxFixture,
  pdfFixture,
  pngFixture,
  xlsxFixture,
} from "@weaver/ingestion/fixtures";
import { DEFAULT_INGESTION_SETTINGS } from "@weaver/core/ingestion/settings";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import {
  createDocument,
  getDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import * as contentOperations from "@weaver/core/services/contentOperations";
import * as diagnosticWriter from "@weaver/core/diagnostics/writer";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { searchKnowledge } from "@weaver/core/services/search";
import {
  acceptDraft,
  buildAcceptOperation,
} from "@weaver/core/services/ingestionAccept";
import { getTable } from "@weaver/core/services/tables";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { createFolder } from "@weaver/core/services/folders";
import { syncDocumentKeywordIndex } from "@weaver/core/services/keywordIndex";
import { invalidateLlmRouteCache } from "@weaver/core/services/llmRouteCache";
import { createIngestionLinkRunner } from "@weaver/ingestion/linkStage";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  noKnowledgeRouting,
  securityContextFor,
  seedTestLlmRouting,
  TEST_PASSWORD,
  testAuth,
  markdownContent,
} from "./_harness";

const DIGEST = "b".repeat(64);
const testDataDirs: string[] = [];

async function projectWithMember(role: ProjectRoleName | null, suffix: string) {
  const owner = await makeUser("User", `owner-${suffix}`);
  const project = await makeProject(`P-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  if (role === null) {
    const outsider = await makeUser("User", `out-${suffix}`);
    return { project, actor: securityContextFor(outsider), owner };
  }
  const member = await makeUser("User", `member-${suffix}`);
  await addMembership(project.id, member.id, role);
  return { project, actor: securityContextFor(member), owner };
}

async function makeBatchFile(
  suffix: string,
  status:
    | "pending"
    | "parsing"
    | "ready"
    | "failed"
    | "blocked_configuration" = "pending",
) {
  const db = getPrisma();
  const fixture = await projectWithMember("Editor", suffix);
  const { batchId } = await createUploadBatch(db, fixture.actor, {
    projectId: fixture.project.id,
    origin: "upload",
  });
  const { fileId } = await registerUploadedFile(db, fixture.actor, {
    batchId,
    fileName: `${suffix}.md`,
    mimeType: "text/markdown",
    byteSize: 1,
    contentDigest: DIGEST,
  });
  if (status !== "pending") {
    await db.ingestionFile.update({ where: { id: fileId }, data: { status } });
  }
  return { ...fixture, batchId, fileId };
}

async function temporaryDataDir() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "weaver-ingestion-"));
  testDataDirs.push(dataDir);
  return dataDir;
}

async function writeBlob(
  dataDir: string,
  projectId: string,
  body: string | Buffer,
) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const target = blobPath(dataDir, projectId, digest);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { digest, byteSize: bytes.byteLength, target };
}

async function stageUpload(dataDir: string, projectId: string, body: string) {
  const uploadId = randomUUID();
  const sink = await openUploadSink(dataDir, projectId, uploadId);
  await sink.write(Buffer.from(body));
  const stored = await sink.finish();
  return {
    uploadId,
    contentDigest: stored.digest,
    byteSize: stored.byteSize,
  };
}

function parseExecution(
  retryCount: number,
  options: { jobId?: string; signal?: AbortSignal } = {},
): JobExecution {
  return {
    jobId: options.jobId ?? "ingestion-job-1",
    retryCount,
    signal: options.signal ?? new AbortController().signal,
  };
}

/** Drives the two 5C worker stages the way the runners do, with no model and no links. */
async function advanceToReady(fileId: string) {
  const db = getPrisma();
  const analysis = await claimFileForAnalysis(db, fileId);
  if (!analysis) throw new Error(`file ${fileId} is not queued for analysis`);
  await completeAnalysis(db, {
    fileId,
    attemptCount: analysis.attemptCount,
    proposedTitle: analysis.draft.proposedTitle,
    proposedFolderPath: "",
    linkQueries: [],
    warnings: [],
  });
  const linking = await claimFileForLinking(db, fileId);
  if (!linking) throw new Error(`file ${fileId} is not queued for linking`);
  await completeLinking(db, {
    fileId,
    attemptCount: linking.attemptCount,
    links: [],
  });
}

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function visionModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

async function registerParse(
  queue: FakeJobQueue,
  dataDir: string,
  overrides: Partial<Parameters<typeof createIngestionParseRunner>[0]> = {},
) {
  await queue.work(
    "ingestion.parse",
    createIngestionParseRunner({
      db: getPrisma(),
      dataDir,
      ring: null,
      maxOcrPages: 50,
      maxFileBytes: 52_428_800,
      loadSettings: async () => DEFAULT_INGESTION_SETTINGS,
      ...overrides,
    }),
  );
}

async function uploadedFile(
  dataDir: string,
  suffix: string,
  fileName: string,
  mimeType: string,
  body: Buffer | string,
) {
  const db = getPrisma();
  const { project, actor } = await projectWithMember("Editor", suffix);
  const blob = await writeBlob(dataDir, project.id, body);
  const { batchId } = await createUploadBatch(db, actor, {
    projectId: project.id,
    origin: "upload",
  });
  const { fileId } = await registerUploadedFile(db, actor, {
    batchId,
    fileName,
    mimeType,
    byteSize: blob.byteSize,
    contentDigest: blob.digest,
  });
  const payload = {
    fileId,
    projectId: project.id,
    contentDigest: blob.digest,
    baseAttemptCount: 0,
  };
  return { db, project, actor, fileId, payload };
}

async function waitForAdvisoryWaiter(): Promise<void> {
  const db = getPrisma();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
    `;
    if ((row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("second lifecycle operation did not wait for the lock");
}

/** What a reviewer who just loaded the draft would send: the current revision. */
async function reviewed(
  fileId: string,
): Promise<{ fileId: string; expectedRevision: number }> {
  const draft = await getPrisma().ingestionDraft.findUnique({
    where: { fileId },
    select: { revision: true },
  });
  return { fileId, expectedRevision: draft?.revision ?? 0 };
}

async function waitForDatabaseLockWaiter(): Promise<void> {
  const db = getPrisma();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if ((row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("retry did not wait for the row lock");
}

async function waitForDatabaseLockWaiters(expected: number): Promise<void> {
  const db = getPrisma();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if ((row?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${expected} operations did not wait for database locks`);
}

beforeEach(async () => {
  await resetDb();
  invalidateIngestionSettingsCache();
});

afterEach(async () => {
  await Promise.all(
    testDataDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ingestion actor services", () => {
  it("creates a pending file and reports its creator", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember("Editor", "create");
    const creator = await db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { name: true, email: true },
    });

    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
      label: "January scans",
    });
    const registered = await registerUploadedFile(db, actor, {
      batchId,
      fileName: "notes.md",
      mimeType: "text/markdown",
      byteSize: 12,
      contentDigest: DIGEST,
    });

    expect(registered).toMatchObject({
      projectId: project.id,
      contentDigest: DIGEST,
    });
    const detail = await getBatch(db, actor, { batchId });
    expect(detail).toMatchObject({
      label: "January scans",
      createdBy: { id: actor.userId, ...creator },
      fileCount: 1,
      status: "pending",
      hasActiveFiles: true,
    });
    expect(detail.files[0]).toMatchObject({
      id: registered.fileId,
      fileName: "notes.md",
      status: "pending",
    });
  });

  it("lists batches in stable newest-first cursor pages", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember("Editor", "pages");
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const batch = await createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "upload",
        label: `batch-${index}`,
      });
      ids.push(batch.batchId);
      await db.ingestionBatch.update({
        where: { id: batch.batchId },
        data: { createdAt: new Date(Date.UTC(2026, 0, index + 1)) },
      });
    }

    const first = await listBatches(db, actor, {
      projectId: project.id,
      limit: 2,
    });
    const second = await listBatches(db, actor, {
      projectId: project.id,
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await listBatches(db, actor, {
      projectId: project.id,
      limit: 2,
      cursor: second.nextCursor!,
    });

    expect(
      [...first.items, ...second.items, ...third.items].map((b) => b.id),
    ).toEqual([...ids].reverse());
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain(first.items[1]!.id);
    expect(second.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).not.toContain(second.items[1]!.id);
    expect(third.nextCursor).toBeNull();
  });

  it("continues a filtered page after its boundary changes status", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember(
      "Editor",
      "cursor-status",
    );
    const files: Array<{ batchId: string; fileId: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      const batch = await createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "upload",
      });
      const file = await registerUploadedFile(db, actor, {
        batchId: batch.batchId,
        fileName: `cursor-${index}.md`,
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: `${index + 1}`.repeat(64),
      });
      await db.ingestionBatch.update({
        where: { id: batch.batchId },
        data: { createdAt: new Date(Date.UTC(2026, 1, index + 1)) },
      });
      files.push({ batchId: batch.batchId, fileId: file.fileId });
    }
    const first = await listBatches(db, actor, {
      projectId: project.id,
      status: "pending",
      limit: 1,
    });
    expect(first.nextCursor).not.toContain(first.items[0]!.id);
    await db.ingestionFile.update({
      where: { id: files[2]!.fileId },
      data: { status: "ready" },
    });

    const second = await listBatches(db, actor, {
      projectId: project.id,
      status: "pending",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((batch) => batch.id)).toEqual([files[1]!.batchId]);
  });

  it("continues a page after its boundary batch is deleted", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember(
      "Editor",
      "cursor-delete",
    );
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const batch = await createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "upload",
      });
      ids.push(batch.batchId);
      await db.ingestionBatch.update({
        where: { id: batch.batchId },
        data: { createdAt: new Date(Date.UTC(2026, 2, index + 1)) },
      });
    }
    const first = await listBatches(db, actor, {
      projectId: project.id,
      limit: 1,
    });
    const otherProject = await makeProject("Other cursor project");
    await addMembership(otherProject.id, actor.userId, "Editor");
    await expect(
      listBatches(db, actor, {
        projectId: otherProject.id,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "cursor" },
    });
    await db.ingestionBatch.delete({ where: { id: first.items[0]!.id } });

    const second = await listBatches(db, actor, {
      projectId: project.id,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((batch) => batch.id)).toEqual([ids[1]]);
  });

  it("filters on the exact derived status and exposes mixed-batch activity", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember("Editor", "filter");
    const attention = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const ready = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    for (const [batchId, fileName, status, digest] of [
      [attention.batchId, "failed.md", "failed", "c".repeat(64)],
      [attention.batchId, "running.md", "parsing", "d".repeat(64)],
      [ready.batchId, "ready.md", "ready", "e".repeat(64)],
    ] as const) {
      const registered = await registerUploadedFile(db, actor, {
        batchId,
        fileName,
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: digest,
      });
      await db.ingestionFile.update({
        where: { id: registered.fileId },
        data: { status },
      });
    }

    const page = await listBatches(db, actor, {
      projectId: project.id,
      status: "attention",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: attention.batchId,
      status: "attention",
      hasActiveFiles: true,
    });
  });

  it("enforces the complete project-role matrix without a global Admin bypass", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "matrix-owner");
    const project = await makeProject("Matrix");
    await addMembership(project.id, owner.id, "Owner");
    for (const role of ["Maintainer", "Editor"] as const) {
      const member = await makeUser("User", `matrix-${role.toLowerCase()}`);
      await addMembership(project.id, member.id, role);
      await expect(
        createUploadBatch(db, securityContextFor(member), {
          projectId: project.id,
          origin: "upload",
        }),
      ).resolves.toHaveProperty("batchId");
    }
    await expect(
      createUploadBatch(db, securityContextFor(owner), {
        projectId: project.id,
        origin: "upload",
      }),
    ).resolves.toHaveProperty("batchId");

    const viewer = await makeUser("User", "matrix-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      listBatches(db, securityContextFor(viewer), { projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const admin = await makeUser("Admin", "matrix-outsider");
    await expect(
      listBatches(db, securityContextFor(admin), { projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const knownBatch = await createUploadBatch(db, securityContextFor(owner), {
      projectId: project.id,
      origin: "upload",
    });
    await expect(
      getBatch(db, securityContextFor(admin), {
        batchId: knownBatch.batchId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const outsider = await makeUser("User", "matrix-outsider-user");
    await expect(
      listBatches(db, securityContextFor(outsider), {
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("preserves FORBIDDEN for a Viewer of a known record", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember("Editor", "visible");
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const viewer = await makeUser("User", "visible-viewer");
    await addMembership(project.id, viewer.id, "Viewer");

    await expect(
      getBatch(db, securityContextFor(viewer), { batchId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("hides records and rejects writes after a project is soft-deleted", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember("Editor", "deleted");
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    await db.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });

    await expect(getBatch(db, actor, { batchId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      listBatches(db, actor, { projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "upload",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates metadata, pagination, and opaque identifiers for direct callers", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember("Editor", "validation");
    await expect(
      createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "upload",
        label: "x".repeat(201),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "label" },
    });
    await expect(
      createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "feed" as "upload",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "origin" },
    });
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    for (const bad of [
      {
        fileName: "bad\nname.md",
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: DIGEST,
      },
      {
        fileName: "ok.md",
        mimeType: "application/octet-stream",
        byteSize: 1,
        contentDigest: DIGEST,
      },
      {
        fileName: "ok.md",
        mimeType: "text/markdown",
        byteSize: -1,
        contentDigest: DIGEST,
      },
      {
        fileName: "ok.md",
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: DIGEST.toUpperCase(),
      },
    ]) {
      await expect(
        registerUploadedFile(db, actor, { batchId, ...bad }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    await expect(
      listBatches(db, actor, { projectId: project.id, limit: 0 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "limit" },
    });
    await expect(
      listBatches(db, actor, {
        projectId: project.id,
        status: "unknown" as "ready",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "status" },
    });
    await expect(
      listBatches(db, actor, { projectId: project.id, cursor: randomUUID() }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "cursor" },
    });
    await expect(
      listBatches(db, actor, { projectId: project.id, cursor: "" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "cursor" },
    });
    for (const batchId of [randomUUID(), "not-a-uuid"]) {
      await expect(getBatch(db, actor, { batchId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });

  it("edits only ready drafts and validates proposed placement metadata", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("draft");
    await expect(
      updateDraft(db, fixture.actor, {
        fileId: fixture.fileId,
        proposedTitle: "Not ready",
        proposedFolderPath: "imports",
        proposedTags: [],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { status: "ready" },
    });
    await db.ingestionDraft.create({
      data: {
        fileId: fixture.fileId,
        targetKind: "document",
        proposedTitle: "Notes",
        markdown: "# Notes\n",
      },
    });
    const updated = await updateDraft(db, fixture.actor, {
      fileId: fixture.fileId,
      proposedTitle: "Reviewed notes",
      proposedFolderPath: "imports/2026",
      proposedTags: ["january"],
    });
    expect(updated.draft).toMatchObject({
      proposedTitle: "Reviewed notes",
      proposedFolderPath: "imports/2026",
      proposedTags: ["january"],
      editedById: fixture.actor.userId,
    });

    await expect(
      updateDraft(db, fixture.actor, {
        fileId: fixture.fileId,
        proposedTitle: "bad\ntitle",
        proposedFolderPath: "imports",
        proposedTags: [],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "proposedTitle" },
    });
  });

  it("rejects a draft edit after a concurrent ready-state claim", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("draft-claim-first", "ready");
    await db.ingestionDraft.create({
      data: {
        fileId: fixture.fileId,
        targetKind: "document",
        proposedTitle: "Original",
        markdown: "# Original\n",
      },
    });
    let rowLocked!: () => void;
    let releaseClaim!: () => void;
    const locked = new Promise<void>((resolve) => {
      rowLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claim = db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM "IngestionFile"
        WHERE id = ${fixture.fileId}::uuid
        FOR UPDATE
      `;
      await tx.ingestionFile.update({
        where: { id: fixture.fileId },
        data: { status: "accepting" },
      });
      rowLocked();
      await released;
    });
    await locked;
    const edit = updateDraft(db, fixture.actor, {
      fileId: fixture.fileId,
      proposedTitle: "Too late",
      proposedFolderPath: "",
      proposedTags: [],
    });
    try {
      await waitForDatabaseLockWaiter();
    } finally {
      releaseClaim();
    }
    await claim;
    await expect(edit).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await db.ingestionDraft.findUniqueOrThrow({
        where: { fileId: fixture.fileId },
        select: { proposedTitle: true },
      }),
    ).toEqual({ proposedTitle: "Original" });
  });

  it("commits a queued draft edit before a later ready-state claim", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("draft-edit-first", "ready");
    await db.ingestionDraft.create({
      data: {
        fileId: fixture.fileId,
        targetKind: "document",
        proposedTitle: "Original",
        markdown: "# Original\n",
      },
    });
    let releaseBlocker!: () => void;
    let blockerLocked!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      blockerLocked = resolve;
    });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM "IngestionFile"
        WHERE id = ${fixture.fileId}::uuid
        FOR UPDATE
      `;
      blockerLocked();
      await released;
    });
    await locked;
    const edit = updateDraft(db, fixture.actor, {
      fileId: fixture.fileId,
      proposedTitle: "Reviewed first",
      proposedFolderPath: "",
      proposedTags: [],
    });
    let claim!: Promise<string | null>;
    try {
      await waitForDatabaseLockWaiter();
      claim = db.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM "IngestionFile"
          WHERE id = ${fixture.fileId}::uuid
          FOR UPDATE
        `;
        const draft = await tx.ingestionDraft.findUniqueOrThrow({
          where: { fileId: fixture.fileId },
          select: { proposedTitle: true },
        });
        await tx.ingestionFile.update({
          where: { id: fixture.fileId },
          data: { status: "accepting" },
        });
        return draft.proposedTitle;
      });
      await waitForDatabaseLockWaiters(2);
    } finally {
      releaseBlocker();
    }
    await blocker;
    await expect(edit).resolves.toMatchObject({
      draft: { proposedTitle: "Reviewed first" },
    });
    await expect(claim).resolves.toBe("Reviewed first");
  });

  it("promotes a staged upload while registering its row", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember("Editor", "promote");
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const uploadId = randomUUID();
    const sink = await openUploadSink(dataDir, project.id, uploadId);
    await sink.write(Buffer.from("promoted body"));
    const staged = await sink.finish();

    await registerUploadedFile(
      db,
      actor,
      {
        batchId,
        fileName: "promoted.md",
        mimeType: "text/markdown",
        byteSize: staged.byteSize,
        contentDigest: staged.digest,
      },
      { promote: { dataDir, uploadId } },
    );

    expect(await readBlob(dataDir, project.id, staged.digest)).toEqual(
      Buffer.from("promoted body"),
    );
    await expect(
      stat(tmpPath(dataDir, project.id, uploadId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes project blob lifecycle operations on the transaction lock", async () => {
    const db = getPrisma();
    const project = await makeProject("Lifecycle lock");
    const events: string[] = [];
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withProjectIngestionLifecycleLock(
      db,
      project.id,
      async () => {
        events.push("first-enter");
        enterFirst();
        await firstReleased;
        events.push("first-exit");
      },
    );
    await firstEntered;
    const second = withProjectIngestionLifecycleLock(
      db,
      project.id,
      async () => {
        events.push("second-enter");
      },
    );
    try {
      await waitForAdvisoryWaiter();
      expect(events).toEqual(["first-enter"]);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("locks the same project key for an upper-cased project id", async () => {
    const db = getPrisma();
    const project = await makeProject("Lifecycle lock casing");
    const events: string[] = [];
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withProjectIngestionLifecycleLock(
      db,
      project.id,
      async () => {
        events.push("first-enter");
        enterFirst();
        await firstReleased;
        events.push("first-exit");
      },
    );
    await firstEntered;
    const second = withProjectIngestionLifecycleLock(
      db,
      project.id.toUpperCase(),
      async () => {
        events.push("second-enter");
      },
    );
    try {
      await waitForAdvisoryWaiter();
      expect(events).toEqual(["first-enter"]);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("deletes only real blobs with no remaining project reference", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember("Editor", "delete");
    const kept = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const removed = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const shared = createHash("sha256").update("shared").digest("hex");
    const lonely = createHash("sha256").update("lonely").digest("hex");
    for (const [digest, body] of [
      [shared, "shared"],
      [lonely, "lonely"],
    ] as const) {
      const target = blobPath(dataDir, project.id, digest);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    await registerUploadedFile(db, actor, {
      batchId: kept.batchId,
      fileName: "keep.md",
      mimeType: "text/markdown",
      byteSize: 6,
      contentDigest: shared,
    });
    for (const [fileName, contentDigest] of [
      ["duplicate.md", shared],
      ["only.md", lonely],
    ] as const) {
      await registerUploadedFile(db, actor, {
        batchId: removed.batchId,
        fileName,
        mimeType: "text/markdown",
        byteSize: 6,
        contentDigest,
      });
    }

    await expect(
      deleteBatch(db, actor, { batchId: removed.batchId }, { dataDir }),
    ).resolves.toEqual({ deletedBlobs: 1 });
    expect(await blobExists(dataDir, project.id, shared)).toBe(true);
    expect(await blobExists(dataDir, project.id, lonely)).toBe(false);
  });

  it("does not restore deleted rows when later blob cleanup fails", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember(
      "Editor",
      "partial-delete",
    );
    const batch = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const removedDigest = createHash("sha256").update("removed").digest("hex");
    const failingDigest = createHash("sha256")
      .update("directory")
      .digest("hex");
    const removedPath = blobPath(dataDir, project.id, removedDigest);
    const failingPath = blobPath(dataDir, project.id, failingDigest);
    await mkdir(path.dirname(removedPath), { recursive: true });
    await writeFile(removedPath, "removed");
    await mkdir(failingPath, { recursive: true });
    for (const [index, contentDigest] of [
      removedDigest,
      failingDigest,
    ].entries()) {
      const file = await registerUploadedFile(db, actor, {
        batchId: batch.batchId,
        fileName: `partial-${index}.md`,
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest,
      });
      await db.ingestionFile.update({
        where: { id: file.fileId },
        data: { createdAt: new Date(Date.UTC(2026, 3, index + 1)) },
      });
    }

    await expect(
      deleteBatch(db, actor, { batchId: batch.batchId }, { dataDir }),
    ).rejects.toThrow();
    expect(
      await db.ingestionBatch.count({ where: { id: batch.batchId } }),
    ).toBe(0);
    expect(await blobExists(dataDir, project.id, removedDigest)).toBe(false);
    expect((await stat(failingPath)).isDirectory()).toBe(true);
  });
});

describe("ingestion worker transitions", () => {
  it("claims pending work once and records parser identity before parsing", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("claim");
    const claimed = await claimFileForParsing(db, fixture.fileId, {
      expectedProjectId: fixture.project.id,
      expectedContentDigest: DIGEST,
      parser: { id: "passthrough", version: "1" },
    });
    expect(claimed).toMatchObject({
      id: fixture.fileId,
      projectId: fixture.project.id,
      contentDigest: DIGEST,
      attemptCount: 1,
      parserAdapterId: "passthrough",
      parserVersion: "1",
    });
    expect(await claimFileForParsing(db, fixture.fileId)).toBeNull();
    const identity = await makeBatchFile("claim-identity");
    expect(
      await claimFileForParsing(db, identity.fileId, {
        expectedProjectId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await claimFileForParsing(db, identity.fileId, {
        expectedProjectId: identity.project.id,
        expectedContentDigest: "a".repeat(64),
      }),
    ).toBeNull();
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: identity.fileId },
        select: { status: true, attemptCount: true },
      }),
    ).toEqual({ status: "pending", attemptCount: 0 });
  });

  it("recovers only a newer delivery of the same job and fences stale writes", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recovery");
    const first = await claimFileForParsing(db, fixture.fileId, {
      baseAttemptCount: 0,
      delivery: { jobId: "job-recovery", retryCount: 0 },
    });
    const duplicateRecoveries = await Promise.all([
      claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: 0,
        delivery: { jobId: "job-recovery", retryCount: 1 },
        parser: { id: "passthrough", version: "2" },
      }),
      claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: 0,
        delivery: { jobId: "job-recovery", retryCount: 1 },
        parser: { id: "passthrough", version: "2" },
      }),
    ]);
    const recovered = duplicateRecoveries.find((claim) => claim !== null);
    expect(duplicateRecoveries.filter((claim) => claim !== null)).toHaveLength(
      1,
    );
    expect(recovered?.attemptCount).toBe(2);
    expect(
      await claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: 0,
        delivery: { jobId: "different-job", retryCount: 2 },
      }),
    ).toBeNull();
    expect(
      await claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: 0,
        delivery: { jobId: "job-recovery", retryCount: 1 },
      }),
    ).toBeNull();

    expect(
      await completeParse(db, {
        fileId: fixture.fileId,
        attemptCount: first!.attemptCount,
        parserAdapterId: "passthrough",
        parserVersion: "1",
        proposedTitle: "Stale",
        draft: { targetKind: "document", markdown: "stale" },
        warnings: [],
      }),
    ).toBe(false);
    expect(
      await failFile(db, {
        fileId: fixture.fileId,
        attemptCount: first!.attemptCount,
        failureKind: "parser",
        message: "stale",
      }),
    ).toBe(false);
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "parsing",
      parserVersion: "2",
      draft: null,
    });

    expect(
      await completeParse(db, {
        fileId: fixture.fileId,
        attemptCount: recovered!.attemptCount,
        parserAdapterId: "passthrough",
        parserVersion: "2",
        proposedTitle: "Current",
        draft: { targetKind: "document", markdown: "# Current\n" },
        warnings: [],
      }),
    ).toBe(true);
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "extracting",
      draft: { proposedTitle: "Current" },
    });
  });

  it("rejects stale pending job identities after an actor retry", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("manual-retry", "failed");
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { attemptCount: 3 },
    });
    const publication = await retryFile(db, fixture.actor, {
      fileId: fixture.fileId,
    });
    expect(publication.attemptCount).toBe(3);
    expect(
      await claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: 2,
        delivery: { jobId: "stale-job", retryCount: 5 },
      }),
    ).toBeNull();
    expect(
      await claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: publication.attemptCount,
        delivery: { jobId: "current-job", retryCount: 0 },
      }),
    ).toMatchObject({ attemptCount: 4 });
  });

  it("keeps parser claim metadata when parsing fails", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("metadata");
    const claimed = await claimFileForParsing(db, fixture.fileId, {
      baseAttemptCount: 0,
      delivery: { jobId: "metadata-job", retryCount: 0 },
      parser: { id: "passthrough", version: "2" },
    });
    expect(
      await failFile(db, {
        fileId: fixture.fileId,
        attemptCount: claimed!.attemptCount,
        failureKind: "parser",
        message: "unsupported",
      }),
    ).toBe(true);
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "failed",
      parserAdapterId: "passthrough",
      parserVersion: "2",
    });
  });

  it("treats worker completions for terminal or deleted files as no-ops", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("stale", "ready");
    await completeParse(db, {
      fileId: fixture.fileId,
      attemptCount: 0,
      parserAdapterId: "passthrough",
      parserVersion: "1",
      proposedTitle: "Ignored",
      draft: { targetKind: "document", markdown: "ignored" },
      warnings: [],
    });
    expect(
      (await getFile(db, fixture.actor, { fileId: fixture.fileId })).draft,
    ).toBeNull();

    await db.ingestionBatch.delete({ where: { id: fixture.batchId } });
    await expect(
      failFile(db, {
        fileId: fixture.fileId,
        attemptCount: 0,
        failureKind: "internal",
        message: "late",
      }),
    ).resolves.toBe(false);
  });

  it("does not complete work after its project is soft-deleted", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("worker-soft-delete");
    const claimed = await claimFileForParsing(db, fixture.fileId);
    await db.project.update({
      where: { id: fixture.project.id },
      data: { deletedAt: new Date() },
    });

    await completeParse(db, {
      fileId: fixture.fileId,
      attemptCount: claimed!.attemptCount,
      parserAdapterId: "passthrough",
      parserVersion: "1",
      proposedTitle: "Ignored",
      draft: { targetKind: "document", markdown: "ignored" },
      warnings: [],
    });
    const file = await db.ingestionFile.findUniqueOrThrow({
      where: { id: fixture.fileId },
      include: { draft: true },
    });
    expect(file).toMatchObject({ status: "parsing", draft: null });
  });

  it("records a fenced parser failure with a bounded message", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("failure");
    const claimed = await claimFileForParsing(db, fixture.fileId);
    await failFile(db, {
      fileId: fixture.fileId,
      attemptCount: claimed!.attemptCount,
      failureKind: "configuration",
      message: "x".repeat(600),
    });

    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "blocked_configuration",
      failureKind: "configuration",
      failureMessage: "x".repeat(500),
    });
  });

  it("retries only failed states with a conditional transition", async () => {
    const db = getPrisma();
    const pending = await makeBatchFile("retry-pending");
    await expect(
      retryFile(db, pending.actor, { fileId: pending.fileId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db.ingestionFile.update({
      where: { id: pending.fileId },
      data: { status: "failed", failureKind: "parser", failureMessage: "bad" },
    });
    await expect(
      retryFile(db, pending.actor, { fileId: pending.fileId }),
    ).resolves.toEqual({
      stage: "parse",
      fileId: pending.fileId,
      projectId: pending.project.id,
      contentDigest: DIGEST,
      attemptCount: 0,
    });
    expect(
      await getFile(db, pending.actor, { fileId: pending.fileId }),
    ).toMatchObject({
      status: "pending",
      failureKind: null,
      failureMessage: null,
    });
  });

  it("does not return a stale attempt count when retry races a worker write", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("retry-race", "failed");
    let rowLocked!: () => void;
    let releaseRow!: () => void;
    const locked = new Promise<void>((resolve) => {
      rowLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRow = resolve;
    });
    const workerWrite = db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM "IngestionFile"
        WHERE id = ${fixture.fileId}::uuid
        FOR UPDATE
      `;
      await tx.ingestionFile.update({
        where: { id: fixture.fileId },
        data: { attemptCount: { increment: 1 } },
      });
      rowLocked();
      await released;
    });
    await locked;
    const retry = retryFile(db, fixture.actor, { fileId: fixture.fileId });
    try {
      await waitForDatabaseLockWaiter();
    } finally {
      releaseRow();
    }
    await workerWrite;

    await expect(retry).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
        select: { status: true, attemptCount: true },
      }),
    ).toEqual({ status: "failed", attemptCount: 1 });
  });

  it("stores a bounded table draft and exposes its columns and sample rows", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("table-draft", "pending");
    const claimed = await claimFileForParsing(db, fixture.fileId, {
      baseAttemptCount: 0,
    });
    expect(claimed?.attemptCount).toBe(1);
    const rows = Array.from({ length: 25 }, (_, index) => [
      `Row ${index}`,
      String(index),
    ]);
    expect(
      await completeParse(db, {
        fileId: fixture.fileId,
        attemptCount: 1,
        parserAdapterId: "native",
        parserVersion: "1",
        proposedTitle: "Sheet",
        warnings: ["1 additional worksheet was skipped: Notes"],
        draft: {
          targetKind: "table",
          columns: [
            { name: "Name", type: "text" },
            { name: "Count", type: "text" },
          ],
          rows,
        },
      }),
    ).toBe(true);
    const detail = await getFile(db, fixture.actor, { fileId: fixture.fileId });
    expect(detail.draft).toMatchObject({
      targetKind: "table",
      markdown: null,
      table: {
        columns: [
          { name: "Name", type: "text" },
          { name: "Count", type: "text" },
        ],
        rowCount: 25,
      },
      warnings: ["1 additional worksheet was skipped: Notes"],
    });
    expect(detail.draft?.table?.sampleRows).toHaveLength(20);
    expect(detail.draft?.table?.sampleRows[0]).toEqual(["Row 0", "0"]);
  });

  it("rejects an over-bound table draft before any transition", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("table-bounds", "pending");
    await claimFileForParsing(db, fixture.fileId, { baseAttemptCount: 0 });
    await expect(
      completeParse(db, {
        fileId: fixture.fileId,
        attemptCount: 1,
        parserAdapterId: "native",
        parserVersion: "1",
        proposedTitle: "Sheet",
        warnings: [],
        draft: {
          targetKind: "table",
          columns: [{ name: "A", type: "text" }],
          rows: [["x", "y"]],
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
        select: { status: true },
      }),
    ).toEqual({ status: "parsing" });
  });

  it("records parser identity and route snapshot only for the live attempt", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("attempt-details", "pending");
    await claimFileForParsing(db, fixture.fileId, { baseAttemptCount: 0 });
    expect(
      await recordParseAttemptDetails(db, {
        fileId: fixture.fileId,
        attemptCount: 1,
        parser: { id: "docling", version: "1" },
        routeSnapshot: {
          providerModelId: "vision",
          promptVersion: "ingestion-ocr-v1",
        },
      }),
    ).toBe(true);
    expect(
      await recordParseAttemptDetails(db, {
        fileId: fixture.fileId,
        attemptCount: 0,
        parser: { id: "native", version: "1" },
      }),
    ).toBe(false);
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
        select: {
          parserAdapterId: true,
          parserVersion: true,
          routeSnapshot: true,
        },
      }),
    ).toEqual({
      parserAdapterId: "docling",
      parserVersion: "1",
      routeSnapshot: {
        providerModelId: "vision",
        promptVersion: "ingestion-ocr-v1",
      },
    });
  });
});

describe("ingestion.analyze", () => {
  afterEach(async () => {
    setJobQueueForTests(null);
    invalidateLlmRouteCache();
    await stopDiagnosticWriter();
    invalidateDiagnosticsSettingsCache();
  });

  function jsonModel(answer: unknown) {
    return visionModel(JSON.stringify(answer));
  }

  async function extractingDocument(
    suffix: string,
    markdown = "# Notes\n\nQuarterly revenue grew.\n",
  ) {
    const db = getPrisma();
    const fixture = await makeBatchFile(suffix);
    const claim = await claimFileForParsing(db, fixture.fileId);
    await completeParse(db, {
      fileId: fixture.fileId,
      attemptCount: claim!.attemptCount,
      parserAdapterId: "native",
      parserVersion: "1",
      proposedTitle: "Notes",
      warnings: [],
      draft: { targetKind: "document", markdown },
    });
    await db.document.create({
      data: {
        id: randomUUID(),
        projectId: fixture.project.id,
        path: "reports/existing.md",
        slug: "existing",
        title: "Existing report",
        excerpt: "",
        headCommitSha: "c".repeat(40),
        lastEditedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    return {
      db,
      fixture,
      queue,
      payload: {
        fileId: fixture.fileId,
        projectId: fixture.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 1,
      },
    };
  }

  it("proposes title, an existing folder, and link queries through the routed model", async () => {
    const { db, fixture, queue, payload } =
      await extractingDocument("analyze-ok");
    await seedTestLlmRouting({ ingestion: { capabilities: ["chat"] } });
    const doGenerate = vi.fn(
      jsonModel({
        title: "Quarterly notes",
        folder: "reports",
        linkQueries: ["quarterly revenue"],
      }).doGenerate,
    );
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({
        db,
        ring: null,
        modelFactory: () => new MockLanguageModelV4({ doGenerate }),
      }),
    );
    await queue.run(
      "ingestion.analyze",
      payload,
      parseExecution(0, { jobId: "analyze-1" }),
    );
    const prompt = JSON.stringify(doGenerate.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain("- reports");
    expect(prompt).toContain("Quarterly revenue grew.");
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "linking",
      attemptCount: 2,
      draft: {
        proposedTitle: "Quarterly notes",
        proposedFolderPath: "reports",
        warnings: [],
      },
    });
    expect(
      await db.ingestionDraft.findUniqueOrThrow({
        where: { fileId: fixture.fileId },
        select: { linkQueries: true },
      }),
    ).toEqual({ linkQueries: ["quarterly revenue"] });
    expect(queue.jobs).toContainEqual({
      name: "ingestion.link",
      data: { ...payload, baseAttemptCount: 2 },
    });
    expect(
      await db.aiUsage.count({
        where: {
          projectId: fixture.project.id,
          operation: "ingestion.analyze",
          outcome: "success",
        },
      }),
    ).toBe(1);
    const row = await db.ingestionFile.findUniqueOrThrow({
      where: { id: fixture.fileId },
      select: { routeSnapshot: true },
    });
    expect(row.routeSnapshot).toMatchObject({
      promptVersion: "ingestion-analyze-v1",
    });
  });

  it("keeps the parse title and queues linking without a routed model", async () => {
    const { db, fixture, queue, payload } =
      await extractingDocument("analyze-no-route");
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({ db, ring: null }),
    );
    await queue.run("ingestion.analyze", payload, parseExecution(0));
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "linking",
      draft: {
        proposedTitle: "Notes",
        proposedFolderPath: "",
        warnings: [expect.stringContaining("no model is routed")],
      },
    });
    expect(queue.jobs.map((job) => job.name)).toEqual(["ingestion.link"]);
  });

  it("drops a non-existent proposed folder and unusable output with warnings", async () => {
    const { db, fixture, queue, payload } =
      await extractingDocument("analyze-invalid");
    await seedTestLlmRouting({ ingestion: { capabilities: ["chat"] } });
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({
        db,
        ring: null,
        modelFactory: () => jsonModel({ title: "T", folder: "made-up" }),
      }),
    );
    await queue.run("ingestion.analyze", payload, parseExecution(0));
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "linking",
      draft: {
        proposedTitle: "T",
        proposedFolderPath: "",
        warnings: [expect.stringContaining("does not exist")],
      },
    });
    const second = await extractingDocument("analyze-garbage");
    await second.queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({
        db,
        ring: null,
        modelFactory: () => visionModel("I cannot help with that."),
      }),
    );
    await second.queue.run(
      "ingestion.analyze",
      second.payload,
      parseExecution(0),
    );
    expect(
      await getFile(db, second.fixture.actor, {
        fileId: second.fixture.fileId,
      }),
    ).toMatchObject({
      status: "linking",
      draft: {
        proposedTitle: "Notes",
        warnings: [expect.stringContaining("unusable answer")],
      },
    });
  });

  it("preserves successful analysis when accounting fails", async () => {
    const { db, fixture, queue, payload } =
      await extractingDocument("analyze-accounting");
    await seedTestLlmRouting({ ingestion: { capabilities: ["chat"] } });
    // The first route assignment queues project reconciliation; only ingestion jobs matter here.
    queue.jobs.length = 0;
    const recordUsage = vi.fn(async () => {
      throw new Error("accounting unavailable");
    });
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({
        db,
        ring: null,
        modelFactory: () =>
          jsonModel({ title: "Complete analysis", folder: "" }),
        recordUsage,
      }),
    );
    await queue.run("ingestion.analyze", payload, parseExecution(0));
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "linking",
      draft: { proposedTitle: "Complete analysis", warnings: [] },
    });
    expect(queue.jobs.map((job) => job.name)).toEqual(["ingestion.link"]);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("fails the file as a provider failure when the model call throws", async () => {
    const { db, fixture, queue, payload } =
      await extractingDocument("analyze-provider");
    await seedTestLlmRouting({ ingestion: { capabilities: ["chat"] } });
    // The first route assignment queues project reconciliation; only ingestion jobs matter here.
    queue.jobs.length = 0;
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({
        db,
        ring: null,
        modelFactory: () =>
          new MockLanguageModelV4({
            doGenerate: async () => {
              throw new Error("upstream exploded");
            },
          }),
      }),
    );
    await queue.run("ingestion.analyze", payload, parseExecution(0));
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({ status: "failed", failureKind: "provider" });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
        select: { analyzeEndedAt: true, linkEndedAt: true },
      }),
    ).toMatchObject({ analyzeEndedAt: expect.any(Date), linkEndedAt: null });
    expect(queue.jobs).toEqual([]);
    expect(
      await db.aiUsage.count({
        where: {
          projectId: fixture.project.id,
          operation: "ingestion.analyze",
          outcome: "provider_failure",
        },
      }),
    ).toBe(1);
  });

  it("ends a failed file with a diagnostic reference and records the error summary", async () => {
    const { db, fixture, queue, payload } =
      await extractingDocument("analyze-reference");
    await seedTestLlmRouting({ ingestion: { capabilities: ["chat"] } });
    const admin = await makeUser("Admin", "ingestion-reference-admin");
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "errors",
    });
    startDiagnosticWriter({
      db,
      runtime: "worker",
      flushIntervalMs: 60_000,
    });
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({
        db,
        ring: null,
        modelFactory: () =>
          new MockLanguageModelV4({
            doGenerate: async () => {
              throw new Error("upstream exploded");
            },
          }),
      }),
    );
    await queue.run("ingestion.analyze", payload, parseExecution(0));
    const file = await db.ingestionFile.findUniqueOrThrow({
      where: { id: fixture.fileId },
      select: { status: true, failureKind: true, failureMessage: true },
    });
    expect(file).toMatchObject({ status: "failed", failureKind: "provider" });
    expect(file.failureMessage).toMatch(/ \(ref [0-9a-f]{8}\)$/);
    const reference = /\(ref ([0-9a-f]{8})\)$/.exec(file.failureMessage!)![1]!;
    await flushDiagnostics(true);
    const event = await db.diagnosticEvent.findFirstOrThrow({
      where: { event: "ingestion.analyze.failed" },
    });
    expect(event.id.startsWith(reference)).toBe(true);
    expect(event.details).toMatchObject({
      reference,
      error: { name: expect.any(String) },
    });
  });

  it("fails model construction as a provider failure", async () => {
    const { db, fixture, queue, payload } = await extractingDocument(
      "analyze-construction",
    );
    await seedTestLlmRouting({ ingestion: { capabilities: ["chat"] } });
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({
        db,
        ring: null,
        modelFactory: () => {
          throw new Error("construction exploded");
        },
      }),
    );
    await queue.run("ingestion.analyze", payload, parseExecution(0));
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({ status: "failed", failureKind: "provider" });
  });

  it("types spreadsheet columns from the stored rows", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("analyze-table");
    const claim = await claimFileForParsing(db, fixture.fileId);
    await completeParse(db, {
      fileId: fixture.fileId,
      attemptCount: claim!.attemptCount,
      parserAdapterId: "native",
      parserVersion: "1",
      proposedTitle: "Budget",
      warnings: [],
      draft: {
        targetKind: "table",
        columns: [
          { name: "Item", type: "text" },
          { name: "Amount", type: "text" },
          { name: "Paid", type: "text" },
        ],
        rows: [
          ["Rent", "1200", "true"],
          ["Food", "300.5", ""],
        ],
      },
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await queue.work(
      "ingestion.analyze",
      createIngestionAnalyzeRunner({ db, ring: null }),
    );
    await queue.run(
      "ingestion.analyze",
      {
        fileId: fixture.fileId,
        projectId: fixture.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 1,
      },
      parseExecution(0),
    );
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "linking",
      draft: {
        table: {
          columns: [
            { name: "Item", type: "text" },
            { name: "Amount", type: "number" },
            { name: "Paid", type: "boolean" },
          ],
        },
      },
    });
  });

  it("records extracting route details only for the live attempt", async () => {
    const { db, fixture } = await extractingDocument("analyze-route-fence");
    const claim = await claimFileForAnalysis(db, fixture.fileId);
    expect(
      await recordParseAttemptDetails(db, {
        fileId: fixture.fileId,
        attemptCount: claim!.attemptCount,
        status: "extracting",
        routeSnapshot: { providerModelId: "live" },
      }),
    ).toBe(true);
    expect(
      await recordParseAttemptDetails(db, {
        fileId: fixture.fileId,
        attemptCount: claim!.attemptCount - 1,
        status: "extracting",
        routeSnapshot: { providerModelId: "stale" },
      }),
    ).toBe(false);
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
        select: { routeSnapshot: true },
      }),
    ).toEqual({ routeSnapshot: { providerModelId: "live" } });
  });
});

describe("ingestion.link", () => {
  afterEach(() => setJobQueueForTests(null));

  async function indexedDocument(
    fixture: Awaited<ReturnType<typeof makeBatchFile>>,
    title: string,
    body: string,
  ) {
    const db = getPrisma();
    const document = await createDocument(
      db,
      {
        projectId: fixture.project.id,
        folderPath: [],
        title,
        content: { kind: "markdown", contentJson: parseDocumentBody(body) },
      },
      {
        ...fixture.actor,
        name: "Editor",
        email: "editor@example.test",
      },
    );
    await syncDocumentKeywordIndex(knowledgeSystemContextForTests(), db, {
      projectId: fixture.project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    return document;
  }

  async function linkingFile(suffix: string, linkQueries: string[]) {
    const db = getPrisma();
    const fixture = await makeBatchFile(suffix);
    const parse = await claimFileForParsing(db, fixture.fileId);
    await completeParse(db, {
      fileId: fixture.fileId,
      attemptCount: parse!.attemptCount,
      parserAdapterId: "native",
      parserVersion: "1",
      proposedTitle: "Import",
      warnings: [],
      draft: {
        targetKind: "document",
        markdown: "# Import\n\n## Onboarding checklist\n\nSteps.\n",
      },
    });
    const analysis = await claimFileForAnalysis(db, fixture.fileId);
    await completeAnalysis(db, {
      fileId: fixture.fileId,
      attemptCount: analysis!.attemptCount,
      proposedTitle: "Import",
      proposedFolderPath: "",
      linkQueries,
      warnings: [],
    });
    return {
      db,
      fixture,
      payload: {
        fileId: fixture.fileId,
        projectId: fixture.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 2,
      },
    };
  }

  it("proposes same-project documents found by the analysis phrases and headings", async () => {
    const { db, fixture, payload } = await linkingFile("link-ok", [
      "quarterly revenue",
    ]);
    const revenue = await indexedDocument(
      fixture,
      "Quarterly revenue",
      "Revenue grew in every region.",
    );
    const onboarding = await indexedDocument(
      fixture,
      "New hire onboarding",
      "The onboarding checklist has ten steps.",
    );
    const other = await makeBatchFile("link-other");
    await indexedDocument(
      other,
      "Quarterly revenue",
      "Another project's revenue.",
    );
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await queue.work("ingestion.link", createIngestionLinkRunner({ db }));
    await queue.run(
      "ingestion.link",
      payload,
      parseExecution(0, { jobId: "link-1" }),
    );

    const detail = await getFile(db, fixture.actor, { fileId: fixture.fileId });
    expect(detail.status).toBe("ready");
    expect(detail.attemptCount).toBe(3);
    const ids = detail.draft!.links.map((link) => link.documentId);
    expect(ids).toContain(revenue.id);
    expect(ids).toContain(onboarding.id);
    expect(ids).toHaveLength(2);
    expect(
      detail.draft!.links.find((link) => link.documentId === revenue.id),
    ).toMatchObject({ title: "Quarterly revenue", confidence: 1, keep: true });
    for (const link of detail.draft!.links) {
      expect(link.confidence).toBeGreaterThanOrEqual(0.4);
      expect(link.excerpt.length).toBeGreaterThan(0);
    }
    expect(queue.jobs).toEqual([]);
  });

  it("reaches ready with the unchanged canonical Unicode anchor from a matching indexed section", async () => {
    const { db, fixture, payload } = await linkingFile("link-unicode", [
      "astronomy",
    ]);
    const heading = "𐐀".repeat(48);
    const markdown = `# ${heading}\n\n## ${heading}\n\n### ${heading}\n\nAstronomy observations.`;
    const anchor = projectDocumentSectionAnchors(markdown).at(-1)!.anchor;
    expect(anchor.length).toBeGreaterThan(200);
    expect(Array.from(anchor).length).toBeLessThanOrEqual(
      MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
    );
    const target = await indexedDocument(fixture, "Unicode sections", markdown);
    const candidates = await loadLexicalDocuments(
      db,
      [fixture.project.id],
      "astronomy",
      10,
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({
        documentId: target.id,
        navigationAnchor: anchor,
      }),
    );
    const queue = new FakeJobQueue();
    await queue.work("ingestion.link", createIngestionLinkRunner({ db }));
    await queue.run("ingestion.link", payload, parseExecution(0));
    const detail = await getFile(db, fixture.actor, { fileId: fixture.fileId });
    expect(detail).toMatchObject({ status: "ready", attemptCount: 3 });
    expect(proposedLinksSchema.parse(detail.draft!.links)).toEqual([
      expect.objectContaining({ documentId: target.id, anchor, keep: true }),
    ]);
  });

  it("reaches ready with no links when nothing matches, and fails as internal when search throws", async () => {
    const empty = await linkingFile("link-empty", []);
    const queue = new FakeJobQueue();
    await queue.work(
      "ingestion.link",
      createIngestionLinkRunner({ db: empty.db }),
    );
    await queue.run("ingestion.link", empty.payload, parseExecution(0));
    expect(
      await getFile(empty.db, empty.fixture.actor, {
        fileId: empty.fixture.fileId,
      }),
    ).toMatchObject({ status: "ready", draft: { links: [] } });

    const broken = await linkingFile("link-broken", ["anything"]);
    await queue.work(
      "ingestion.link",
      createIngestionLinkRunner({
        db: broken.db,
        searchDocuments: async () => {
          throw new Error("db down");
        },
      }),
    );
    await queue.run("ingestion.link", broken.payload, parseExecution(0));
    expect(
      await getFile(broken.db, broken.fixture.actor, {
        fileId: broken.fixture.fileId,
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "internal",
      failureMessage: "related-document search failed",
    });
    expect(
      await broken.db.ingestionFile.findUniqueOrThrow({
        where: { id: broken.fixture.fileId },
        select: { linkEndedAt: true },
      }),
    ).toEqual({ linkEndedAt: expect.any(Date) });
  });
});

describe("ingestion stage transitions", () => {
  const DOC_ID = "33333333-3333-4333-8333-333333333333";

  async function extractingFile(
    suffix: string,
    draft?: Parameters<typeof completeParse>[1]["draft"],
  ) {
    const db = getPrisma();
    const fixture = await makeBatchFile(suffix);
    const claim = await claimFileForParsing(db, fixture.fileId);
    await completeParse(db, {
      fileId: fixture.fileId,
      attemptCount: claim!.attemptCount,
      parserAdapterId: "native",
      parserVersion: "1",
      proposedTitle: "Parsed title",
      warnings: ["parser warning"],
      draft: draft ?? {
        targetKind: "document",
        markdown: "# Parsed\n\nBody.\n",
      },
    });
    return fixture;
  }

  it("parses into extracting with analysis queued, then walks to linking and ready", async () => {
    const db = getPrisma();
    const fixture = await extractingFile("stages");
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "extracting",
      attemptCount: 1,
      draft: { proposedTitle: "Parsed title", links: [] },
    });
    expect(await claimFileForLinking(db, fixture.fileId)).toBeNull();
    const analysis = await claimFileForAnalysis(db, fixture.fileId, {
      expectedProjectId: fixture.project.id,
      expectedContentDigest: DIGEST,
      baseAttemptCount: 1,
      delivery: { jobId: "analyze-1", retryCount: 0 },
    });
    expect(analysis).toMatchObject({
      attemptCount: 2,
      draft: {
        targetKind: "document",
        markdown: "# Parsed\n\nBody.\n",
        warnings: ["parser warning"],
      },
    });
    expect(
      await completeAnalysis(db, {
        fileId: fixture.fileId,
        attemptCount: 2,
        proposedTitle: "Analyzed title",
        proposedFolderPath: "guides",
        linkQueries: ["setup guide"],
        warnings: ["analysis warning"],
      }),
    ).toBe(true);
    const linking = await claimFileForLinking(db, fixture.fileId, {
      baseAttemptCount: 2,
    });
    expect(linking).toMatchObject({
      attemptCount: 3,
      draft: { linkQueries: ["setup guide"] },
    });
    const links = [
      {
        documentId: DOC_ID,
        title: "Setup",
        anchor: null,
        confidence: 0.8,
        excerpt: "e",
        keep: true,
      },
    ];
    expect(
      await completeLinking(db, {
        fileId: fixture.fileId,
        attemptCount: 3,
        links,
      }),
    ).toBe(true);
    const detail = await getFile(db, fixture.actor, { fileId: fixture.fileId });
    expect(detail.status).toBe("ready");
    expect(detail.draft?.links).toEqual(links);
  });

  for (const stage of ["analyze", "link"] as const) {
    it(`recovers only one newer ${stage} delivery and fences duplicate and stale terminal writes`, async () => {
      const db = getPrisma();
      const fixture = await extractingFile(`delivery-${stage}`);
      if (stage === "link") {
        const analysis = await claimFileForAnalysis(db, fixture.fileId);
        await completeAnalysis(db, {
          fileId: fixture.fileId,
          attemptCount: analysis!.attemptCount,
          proposedTitle: "Analyzed",
          proposedFolderPath: "",
          linkQueries: [],
          warnings: [],
        });
      }
      const claim =
        stage === "analyze" ? claimFileForAnalysis : claimFileForLinking;
      const complete =
        stage === "analyze"
          ? (attemptCount: number) =>
              completeAnalysis(db, {
                fileId: fixture.fileId,
                attemptCount,
                proposedTitle: "Done",
                proposedFolderPath: "",
                linkQueries: [],
                warnings: [],
              })
          : (attemptCount: number) =>
              completeLinking(db, {
                fileId: fixture.fileId,
                attemptCount,
                links: [],
              });
      const baseAttemptCount = stage === "analyze" ? 1 : 2;
      const first = await claim(db, fixture.fileId, {
        baseAttemptCount,
        delivery: { jobId: `${stage}-job`, retryCount: 0 },
      });
      const recoveries = await Promise.all([
        claim(db, fixture.fileId, {
          baseAttemptCount,
          delivery: { jobId: `${stage}-job`, retryCount: 1 },
        }),
        claim(db, fixture.fileId, {
          baseAttemptCount,
          delivery: { jobId: `${stage}-job`, retryCount: 1 },
        }),
      ]);
      const recovered = recoveries.find((value) => value !== null)!;
      expect(recoveries.filter((value) => value !== null)).toHaveLength(1);
      expect(
        await claim(db, fixture.fileId, {
          baseAttemptCount,
          delivery: { jobId: `${stage}-job`, retryCount: 1 },
        }),
      ).toBeNull();
      expect(
        await claim(db, fixture.fileId, {
          baseAttemptCount,
          delivery: { jobId: "other-job", retryCount: 2 },
        }),
      ).toBeNull();
      expect(await complete(first!.attemptCount)).toBe(false);
      expect(
        await failFile(db, {
          fileId: fixture.fileId,
          attemptCount: first!.attemptCount,
          fromStatus: stage === "analyze" ? "extracting" : "linking",
          failureKind: "provider",
          message: "stale",
        }),
      ).toBe(false);
      expect(await complete(recovered.attemptCount)).toBe(true);
      expect(await complete(recovered.attemptCount)).toBe(false);
    });
  }

  it("stores inferred column types and rejects a type the rows cannot take", async () => {
    const db = getPrisma();
    const fixture = await extractingFile("stage-columns", {
      targetKind: "table",
      columns: [
        { name: "Amount", type: "text" },
        { name: "Note", type: "text" },
      ],
      rows: [
        ["1", "a"],
        ["2", ""],
      ],
    });
    const analysis = await claimFileForAnalysis(db, fixture.fileId);
    await expect(
      completeAnalysis(db, {
        fileId: fixture.fileId,
        attemptCount: analysis!.attemptCount,
        proposedTitle: "Amounts",
        proposedFolderPath: "",
        columns: [
          { name: "Amount", type: "number" },
          { name: "Note", type: "number" },
        ],
        linkQueries: [],
        warnings: [],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "columns" },
    });
    expect(
      await completeAnalysis(db, {
        fileId: fixture.fileId,
        attemptCount: analysis!.attemptCount,
        proposedTitle: "Amounts",
        proposedFolderPath: "",
        columns: [
          { name: "Amount", type: "number" },
          { name: "Note", type: "text" },
        ],
        linkQueries: [],
        warnings: [],
      }),
    ).toBe(true);
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      draft: {
        table: {
          columns: [
            { name: "Amount", type: "number" },
            { name: "Note", type: "text" },
          ],
        },
      },
    });
  });

  it("reports the accepted target on file summaries", async () => {
    const db = getPrisma();
    const fixture = await extractingFile("stage-summary");
    await advanceToReady(fixture.fileId);
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { status: "accepted" },
    });
    await db.ingestionDraft.update({
      where: { fileId: fixture.fileId },
      data: { acceptedResourceId: DOC_ID, acceptedCommitSha: "a".repeat(40) },
    });
    const batch = await getBatch(db, fixture.actor, {
      batchId: fixture.batchId,
    });
    expect(batch.files[0]).toMatchObject({
      targetKind: "document",
      acceptedResourceId: DOC_ID,
    });
  });
});

describe("ingestion.parse", () => {
  afterEach(() => {
    setJobQueueForTests(null);
  });

  it("parses a Markdown blob into an extracting draft", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember("Editor", "parse-ok");
    const blob = await writeBlob(dataDir, project.id, "# Hello\n\nBody.\n");
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const { fileId } = await registerUploadedFile(db, actor, {
      batchId,
      fileName: "hello_world.md",
      mimeType: "text/markdown",
      byteSize: blob.byteSize,
      contentDigest: blob.digest,
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await registerParse(queue, dataDir);

    await queue.run(
      "ingestion.parse",
      {
        fileId,
        projectId: project.id,
        contentDigest: blob.digest,
        baseAttemptCount: 0,
      },
      parseExecution(0),
    );

    expect(await getFile(db, actor, { fileId })).toMatchObject({
      status: "extracting",
      parserAdapterId: "native",
      parserVersion: "1",
      attemptCount: 1,
      draft: {
        targetKind: "document",
        proposedTitle: "Hello world",
        markdown: "# Hello\n\nBody.\n",
      },
    });
    expect(queue.jobs).toContainEqual({
      name: "ingestion.analyze",
      data: {
        fileId,
        projectId: project.id,
        contentDigest: blob.digest,
        baseAttemptCount: 1,
      },
    });
  });

  it("fails NUL-containing text without creating a draft or removing its original", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember("Editor", "parse-nul");
    const blob = await writeBlob(dataDir, project.id, "# Notes\n\0Body\n");
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const { fileId } = await registerUploadedFile(db, actor, {
      batchId,
      fileName: "notes.md",
      mimeType: "text/markdown",
      byteSize: blob.byteSize,
      contentDigest: blob.digest,
    });
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);

    await queue.run(
      "ingestion.parse",
      {
        fileId,
        projectId: project.id,
        contentDigest: blob.digest,
        baseAttemptCount: 0,
      },
      parseExecution(0),
    );

    expect(await getFile(db, actor, { fileId })).toMatchObject({
      status: "failed",
      failureKind: "validation",
      failureMessage: "file contains a NUL character",
      draft: null,
    });
    await expect(readBlob(dataDir, project.id, blob.digest)).resolves.toEqual(
      Buffer.from("# Notes\n\0Body\n"),
    );
  });

  it("commits a canonical title when truncation lands on a separator", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember(
      "Editor",
      "parse-title-boundary",
    );
    const blob = await writeBlob(dataDir, project.id, "# Boundary\n");
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const { fileId } = await registerUploadedFile(db, actor, {
      batchId,
      fileName: `${"a".repeat(199)}_b.md`,
      mimeType: "text/markdown",
      byteSize: blob.byteSize,
      contentDigest: blob.digest,
    });
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);

    await queue.run(
      "ingestion.parse",
      {
        fileId,
        projectId: project.id,
        contentDigest: blob.digest,
        baseAttemptCount: 0,
      },
      parseExecution(0),
    );

    expect(await getFile(db, actor, { fileId })).toMatchObject({
      status: "extracting",
      attemptCount: 1,
      draft: { proposedTitle: `A${"a".repeat(198)}` },
    });
  });

  it("parses a Word document into a document draft", async () => {
    const dataDir = await temporaryDataDir();
    const file = await uploadedFile(
      dataDir,
      "parse-docx",
      "report.docx",
      DOCX,
      docxFixture({
        heading: "Report",
        paragraphs: ["Body."],
        table: [
          ["A", "B"],
          ["1", "2"],
        ],
      }),
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);
    await queue.run("ingestion.parse", file.payload, parseExecution(0));
    expect(
      await getFile(file.db, file.actor, { fileId: file.fileId }),
    ).toMatchObject({
      status: "extracting",
      parserAdapterId: "native",
      parserVersion: "1",
      draft: {
        targetKind: "document",
        proposedTitle: "Report",
        markdown: "# Report\n\nBody.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
        table: null,
      },
    });
  });

  it("parses a workbook and a CSV into table drafts", async () => {
    const dataDir = await temporaryDataDir();
    const xlsx = await uploadedFile(
      dataDir,
      "parse-xlsx",
      "sales.xlsx",
      XLSX,
      await xlsxFixture([
        {
          name: "Sales",
          rows: [
            ["Region", "Total"],
            ["North", 12],
          ],
        },
        { name: "Notes", rows: [["x"]] },
      ]),
    );
    const csv = await uploadedFile(
      dataDir,
      "parse-csv",
      "people.csv",
      "text/csv",
      'Name,Age\n"Doe, Jane",42\n',
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);
    await queue.run("ingestion.parse", xlsx.payload, parseExecution(0));
    await queue.run("ingestion.parse", csv.payload, parseExecution(0));
    expect(
      await getFile(xlsx.db, xlsx.actor, { fileId: xlsx.fileId }),
    ).toMatchObject({
      status: "extracting",
      draft: {
        targetKind: "table",
        proposedTitle: "Sales",
        markdown: null,
        table: {
          columns: [
            { name: "Region", type: "text" },
            { name: "Total", type: "text" },
          ],
          rowCount: 1,
          sampleRows: [["North", "12"]],
        },
        warnings: ['1 additional worksheet was skipped: "Notes"'],
      },
    });
    expect(
      (await getFile(csv.db, csv.actor, { fileId: csv.fileId })).draft?.table,
    ).toEqual({
      columns: [
        { name: "Name", type: "text" },
        { name: "Age", type: "text" },
      ],
      rowCount: 1,
      sampleRows: [["Doe, Jane", "42"]],
    });
  });

  it("parses a text PDF natively", async () => {
    const dataDir = await temporaryDataDir();
    const file = await uploadedFile(
      dataDir,
      "parse-pdf",
      "notes.pdf",
      "application/pdf",
      pdfFixture(["Hello PDF"]),
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);
    await queue.run("ingestion.parse", file.payload, parseExecution(0));
    const detail = await getFile(file.db, file.actor, { fileId: file.fileId });
    expect(detail.status).toBe("extracting");
    expect(detail.draft?.markdown).toContain("Hello PDF");
  });

  it("blocks a scan until a vision model is routed, then transcribes it on retry", async () => {
    const dataDir = await temporaryDataDir();
    const file = await uploadedFile(
      dataDir,
      "parse-scan",
      "scan.png",
      "image/png",
      pngFixture(),
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir, {
      modelFactory: () => visionModel("# Scanned\n\nBody"),
    });
    await queue.run("ingestion.parse", file.payload, parseExecution(0));
    expect(
      await getFile(file.db, file.actor, { fileId: file.fileId }),
    ).toMatchObject({
      status: "blocked_configuration",
      failureKind: "configuration",
      failureMessage: expect.stringContaining("Import parsing route"),
      // Only the pre-parse attribution write can have set this: the file never parsed.
      parserAdapterId: "native",
    });

    await seedTestLlmRouting({
      ingestion: { capabilities: ["chat", "vision"] },
    });
    invalidateLlmRouteCache();
    setJobQueueForTests(queue);
    const retried = await retryFile(file.db, file.actor, {
      fileId: file.fileId,
    });
    await requestKnowledgeJob("ingestion.parse", {
      fileId: retried.fileId,
      projectId: retried.projectId,
      contentDigest: retried.contentDigest,
      baseAttemptCount: retried.attemptCount,
    });
    const job = queue.jobs.at(-1);
    expect(job?.name).toBe("ingestion.parse");
    await queue.run(
      "ingestion.parse",
      job!.data as never,
      parseExecution(0, { jobId: "retry-job" }),
    );

    const detail = await getFile(file.db, file.actor, { fileId: file.fileId });
    expect(detail).toMatchObject({
      status: "extracting",
      parserAdapterId: "native",
      attemptCount: 2,
      draft: { targetKind: "document", markdown: "# Scanned\n\nBody" },
    });
    const row = await file.db.ingestionFile.findUniqueOrThrow({
      where: { id: file.fileId },
      select: { routeSnapshot: true },
    });
    expect(row.routeSnapshot).toMatchObject({
      providerModelId: "test-vision",
      promptVersion: "ingestion-ocr-v1",
    });
    expect(
      await file.db.aiUsage.findMany({ where: { operation: "ingestion.ocr" } }),
    ).toHaveLength(1);
  });

  it("blocks a scan when the routed model lacks the vision capability", async () => {
    await seedTestLlmRouting({ ingestion: { capabilities: ["chat"] } });
    invalidateLlmRouteCache();
    const dataDir = await temporaryDataDir();
    const file = await uploadedFile(
      dataDir,
      "parse-novision",
      "scan.png",
      "image/png",
      pngFixture(),
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir, {
      modelFactory: () => visionModel("unused"),
    });
    await queue.run("ingestion.parse", file.payload, parseExecution(0));
    expect(
      await getFile(file.db, file.actor, { fileId: file.fileId }),
    ).toMatchObject({
      status: "blocked_configuration",
      failureMessage: expect.stringContaining("Vision capability"),
    });
  });

  it("applies the OCR budget to image-only PDF pages", async () => {
    await seedTestLlmRouting({
      ingestion: { capabilities: ["chat", "vision"] },
    });
    invalidateLlmRouteCache();
    const dataDir = await temporaryDataDir();
    const file = await uploadedFile(
      dataDir,
      "parse-budget",
      "scan.pdf",
      "application/pdf",
      pdfFixture(["Typed page", null, null]),
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir, {
      maxOcrPages: 1,
      modelFactory: () => visionModel("Transcribed page"),
    });
    await queue.run("ingestion.parse", file.payload, parseExecution(0));
    const detail = await getFile(file.db, file.actor, { fileId: file.fileId });
    expect(detail.failureMessage).toBeNull();
    expect(detail.status).toBe("extracting");
    expect(detail.draft?.markdown).toContain("Typed page");
    expect(detail.draft?.markdown).toContain("Transcribed page");
    expect(detail.draft?.warnings).toEqual([
      "OCR budget of 1 page reached; 1 scanned page was skipped",
    ]);
    expect(
      await file.db.aiUsage.count({ where: { operation: "ingestion.ocr" } }),
    ).toBe(1);
  });

  it("prefers a configured Docling endpoint and falls back when it is unreachable", async () => {
    const dataDir = await temporaryDataDir();
    const settings = {
      ...DEFAULT_INGESTION_SETTINGS,
      doclingBaseUrl: "http://docling.test:5001",
    };
    const served = await uploadedFile(
      dataDir,
      "parse-docling",
      "scan.pdf",
      "application/pdf",
      pdfFixture(["Native text"]),
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir, {
      loadSettings: async () => settings,
      fetchImpl: async () =>
        Response.json({
          document: { md_content: "# From Docling" },
          status: "success",
          errors: [],
        }),
    });
    await queue.run("ingestion.parse", served.payload, parseExecution(0));
    expect(
      await getFile(served.db, served.actor, { fileId: served.fileId }),
    ).toMatchObject({
      status: "extracting",
      parserAdapterId: "docling",
      draft: { markdown: "# From Docling", warnings: [] },
    });

    const fallback = await uploadedFile(
      dataDir,
      "parse-docling-down",
      "typed.pdf",
      "application/pdf",
      pdfFixture(["Native text"]),
    );
    const down = new FakeJobQueue();
    await registerParse(down, dataDir, {
      loadSettings: async () => settings,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await down.run("ingestion.parse", fallback.payload, parseExecution(0));
    const detail = await getFile(fallback.db, fallback.actor, {
      fileId: fallback.fileId,
    });
    expect(detail).toMatchObject({
      status: "extracting",
      parserAdapterId: "native",
    });
    expect(detail.draft?.markdown).toContain("Native text");
    expect(detail.draft?.warnings).toEqual([
      "docling-serve was unreachable; the file was parsed natively",
    ]);
  });

  it("fails legacy Office binaries and TIFF without Docling as parser failures", async () => {
    const dataDir = await temporaryDataDir();
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512),
    ]);
    const doc = await uploadedFile(
      dataDir,
      "parse-doc",
      "old.doc",
      "application/msword",
      ole,
    );
    const tiff = await uploadedFile(
      dataDir,
      "parse-tiff",
      "scan.tiff",
      "image/tiff",
      Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(64)]),
    );
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);
    await queue.run("ingestion.parse", doc.payload, parseExecution(0));
    await queue.run("ingestion.parse", tiff.payload, parseExecution(0));
    expect(
      await getFile(doc.db, doc.actor, { fileId: doc.fileId }),
    ).toMatchObject({
      status: "failed",
      failureKind: "parser",
      failureMessage: expect.stringContaining(".docx/.xlsx"),
    });
    expect(
      await getFile(tiff.db, tiff.actor, { fileId: tiff.fileId }),
    ).toMatchObject({
      status: "failed",
      failureKind: "parser",
      failureMessage: expect.stringContaining("docling-serve"),
    });
  });

  it("classifies only a vanished original as source_missing", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const fixture = await makeBatchFile("parse-missing");
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);

    await queue.run(
      "ingestion.parse",
      {
        fileId: fixture.fileId,
        projectId: fixture.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 0,
      },
      parseExecution(0),
    );

    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "failed",
      failureKind: "source_missing",
    });
  });

  it("rejects bytes whose digest or content type contradicts the row", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    for (const [suffix, mimeType, bytes] of [
      ["digest", "text/markdown", Buffer.from("tampered")],
      ["mime", "text/markdown", Buffer.from("%PDF-1.7")],
    ] as const) {
      const { project, actor } = await projectWithMember(
        "Editor",
        `parse-${suffix}`,
      );
      const digest = createHash("sha256")
        .update(suffix === "digest" ? Buffer.from("expected") : bytes)
        .digest("hex");
      const target = blobPath(dataDir, project.id, digest);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      const { batchId } = await createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "upload",
      });
      const { fileId } = await registerUploadedFile(db, actor, {
        batchId,
        fileName: `${suffix}.md`,
        mimeType,
        byteSize: bytes.byteLength,
        contentDigest: digest,
      });
      const queue = new FakeJobQueue();
      await registerParse(queue, dataDir);
      await queue.run(
        "ingestion.parse",
        {
          fileId,
          projectId: project.id,
          contentDigest: digest,
          baseAttemptCount: 0,
        },
        parseExecution(0, { jobId: `validation-${suffix}` }),
      );
      expect(await getFile(db, actor, { fileId })).toMatchObject({
        status: "failed",
        failureKind: "validation",
      });
    }
  });

  it("retries unexpected pre-claim and source I/O faults without stranding parsing", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember(
      "Editor",
      "parse-redelivery",
    );
    const bytes = Buffer.from("# Recovered\n");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const target = blobPath(dataDir, project.id, digest);
    await mkdir(target, { recursive: true });
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const { fileId } = await registerUploadedFile(db, actor, {
      batchId,
      fileName: "recovered.md",
      mimeType: "text/markdown",
      byteSize: bytes.byteLength,
      contentDigest: digest,
    });
    let failBeforeClaim = true;
    const flakyTransaction = async <T>(
      operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      if (failBeforeClaim) {
        failBeforeClaim = false;
        throw new Error("transient database failure");
      }
      return db.$transaction(operation);
    };
    // A partial stub no longer suffices: the runner also calls db.ingestionFile
    // directly (recordParseAttemptDetails), outside of $transaction.
    const flakyDb = new Proxy(db, {
      get: (target, prop): unknown =>
        prop === "$transaction" ? flakyTransaction : Reflect.get(target, prop),
    }) as unknown as typeof db;
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir, { db: flakyDb });
    const payload = {
      fileId,
      projectId: project.id,
      contentDigest: digest,
      baseAttemptCount: 0,
    };

    await expect(
      queue.run("ingestion.parse", payload, parseExecution(0)),
    ).rejects.toThrow("transient database failure");
    expect(
      await db.ingestionFile.findUniqueOrThrow({ where: { id: fileId } }),
    ).toMatchObject({ status: "pending", attemptCount: 0 });

    await expect(
      queue.run("ingestion.parse", payload, parseExecution(1)),
    ).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(
      await db.ingestionFile.findUniqueOrThrow({ where: { id: fileId } }),
    ).toMatchObject({ status: "parsing", attemptCount: 1 });

    await rm(target, { recursive: true });
    await writeFile(target, bytes);
    await queue.run("ingestion.parse", payload, parseExecution(2));
    expect(await getFile(db, actor, { fileId })).toMatchObject({
      status: "extracting",
      attemptCount: 2,
      draft: { markdown: "# Recovered\n" },
    });
  });

  it("ignores terminal, missing, deleted-project, and mismatched deliveries", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const terminal = await makeBatchFile("parse-terminal", "ready");
    const mismatch = await makeBatchFile("parse-mismatch");
    const deleted = await makeBatchFile("parse-deleted");
    await db.project.update({
      where: { id: deleted.project.id },
      data: { deletedAt: new Date() },
    });
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);
    for (const payload of [
      {
        fileId: terminal.fileId,
        projectId: terminal.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 0,
      },
      {
        fileId: randomUUID(),
        projectId: terminal.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 0,
      },
      {
        fileId: deleted.fileId,
        projectId: deleted.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 0,
      },
      {
        fileId: mismatch.fileId,
        projectId: randomUUID(),
        contentDigest: DIGEST,
        baseAttemptCount: 0,
      },
      {
        fileId: mismatch.fileId,
        projectId: mismatch.project.id,
        contentDigest: "a".repeat(64),
        baseAttemptCount: 0,
      },
      {
        fileId: mismatch.fileId,
        projectId: mismatch.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 1,
      },
    ]) {
      await queue.run("ingestion.parse", payload, parseExecution(0));
    }
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: mismatch.fileId },
      }),
    ).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: deleted.fileId },
      }),
    ).toMatchObject({ status: "pending", attemptCount: 0 });
  });

  it("does not claim a delivery cancelled before work starts", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const fixture = await makeBatchFile("parse-cancelled");
    const controller = new AbortController();
    controller.abort();
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir);

    await expect(
      queue.run(
        "ingestion.parse",
        {
          fileId: fixture.fileId,
          projectId: fixture.project.id,
          contentDigest: DIGEST,
          baseAttemptCount: 0,
        },
        parseExecution(0, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
      }),
    ).toMatchObject({ status: "pending", attemptCount: 0 });
  });

  it("leaves a claim recoverable when cancellation arrives after claiming", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember(
      "Editor",
      "parse-cancelled-after-claim",
    );
    const blob = await writeBlob(dataDir, project.id, "# After cancel\n");
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const { fileId } = await registerUploadedFile(db, actor, {
      batchId,
      fileName: "after-cancel.md",
      mimeType: "text/markdown",
      byteSize: blob.byteSize,
      contentDigest: blob.digest,
    });
    const controller = new AbortController();
    const cancellingTransaction = async <T>(
      operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const result = await db.$transaction(operation);
      controller.abort();
      return result;
    };
    const cancellingDb = {
      $transaction: cancellingTransaction as unknown as typeof db.$transaction,
    } as unknown as typeof db;
    const queue = new FakeJobQueue();
    await registerParse(queue, dataDir, { db: cancellingDb });
    const payload = {
      fileId,
      projectId: project.id,
      contentDigest: blob.digest,
      baseAttemptCount: 0,
    };

    await expect(
      queue.run(
        "ingestion.parse",
        payload,
        parseExecution(0, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      await db.ingestionFile.findUniqueOrThrow({ where: { id: fileId } }),
    ).toMatchObject({
      status: "parsing",
      attemptCount: 1,
      stageClaimJobId: "ingestion-job-1",
      stageClaimRetryCount: 0,
    });

    const recoveryQueue = new FakeJobQueue();
    await registerParse(recoveryQueue, dataDir);
    await recoveryQueue.run("ingestion.parse", payload, parseExecution(1));
    expect(await getFile(db, actor, { fileId })).toMatchObject({
      status: "extracting",
      attemptCount: 2,
    });
  });
});

describe("upload finalization service", () => {
  it("returns the canonical authorized project id", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithMember(
      "Editor",
      "upload-preflight",
    );

    await expect(
      authorizeIngestionUpload(db, actor, project.id.toUpperCase(), "upload"),
    ).resolves.toEqual({ projectId: project.id });
  });

  it("ingestion review: project quota admits duplicate bytes and serializes competing uploads", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember("Editor", "quota");
    const finalize = async (body: string) => {
      const file = await stageUpload(dataDir, project.id, body);
      return finalizeUploadBatch(
        db,
        actor,
        {
          projectId: project.id,
          origin: "upload",
          files: [{ ...file, fileName: "quota.md", mimeType: "text/markdown" }],
        },
        { dataDir, projectQuotaBytes: 5 },
      );
    };
    await finalize("same");
    await finalize("same");
    const results = await Promise.allSettled([finalize("a"), finalize("b")]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await db.ingestionFile.count({ where: { projectId: project.id } }),
    ).toBe(3);
  });

  it.each(["parsing", "extracting", "linking"] as const)(
    "ingestion review: refuses deleting a claimed %s file",
    async (status) => {
      const db = getPrisma();
      const fixture = await makeBatchFile(`delete-active-${status}`);
      const started =
        status === "parsing"
          ? "parseStartedAt"
          : status === "extracting"
            ? "analyzeStartedAt"
            : "linkStartedAt";
      await db.ingestionFile.update({
        where: { id: fixture.fileId },
        data: { status, [started]: new Date() },
      });
      await expect(
        deleteBatch(
          db,
          fixture.actor,
          { batchId: fixture.batchId },
          { dataDir: await temporaryDataDir() },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        await db.ingestionFile.findUnique({ where: { id: fixture.fileId } }),
      ).not.toBeNull();
    },
  );

  it("registers every promoted file in one batch", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember(
      "Editor",
      "upload-finalize",
    );
    const first = await stageUpload(dataDir, project.id, "same");
    const second = await stageUpload(dataDir, project.id, "same");

    const result = await finalizeUploadBatch(
      db,
      actor,
      {
        projectId: project.id,
        origin: "upload",
        label: " Batch ",
        files: [
          {
            ...first,
            fileName: "first.md",
            mimeType: "text/markdown",
          },
          {
            ...second,
            fileName: "second.md",
            mimeType: "text/markdown",
          },
        ],
      },
      { dataDir },
    );

    expect(result).toMatchObject({
      projectId: project.id,
      files: [
        { fileName: "first.md", status: "pending" },
        { fileName: "second.md", status: "pending" },
      ],
    });
    const batch = await db.ingestionBatch.findUniqueOrThrow({
      where: { id: result.batchId },
      include: { files: true },
    });
    expect(batch.label).toBe("Batch");
    expect(batch.files).toHaveLength(2);
    expect(await blobExists(dataDir, project.id, first.contentDigest)).toBe(
      true,
    );
  });

  it("rolls back the complete batch when a later promotion fails", async () => {
    const db = getPrisma();
    const dataDir = await temporaryDataDir();
    const { project, actor } = await projectWithMember(
      "Editor",
      "upload-rollback",
    );
    const first = await stageUpload(dataDir, project.id, "first");
    const missing = {
      uploadId: randomUUID(),
      contentDigest: "c".repeat(64),
      byteSize: 6,
    };

    await expect(
      finalizeUploadBatch(
        db,
        actor,
        {
          projectId: project.id,
          origin: "upload",
          files: [
            {
              ...first,
              fileName: "first.md",
              mimeType: "text/markdown",
            },
            {
              ...missing,
              fileName: "missing.md",
              mimeType: "text/markdown",
            },
          ],
        },
        { dataDir },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await db.ingestionFile.count()).toBe(0);
    expect(await blobExists(dataDir, project.id, first.contentDigest)).toBe(
      true,
    );
  });
});

describe("ingestion router", () => {
  afterEach(() => {
    setJobQueueForTests(null);
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  });

  async function makeRouterFile(
    suffix: string,
    status: "pending" | "ready" | "failed" | "blocked_configuration",
  ) {
    const db = getPrisma();
    const owner = await makeUser("User", `router-${suffix}`);
    const project = await makeProject(`Router ${suffix}`);
    await addMembership(project.id, owner.id, "Owner");
    const actor = securityContextFor(owner);
    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
      label: suffix,
    });
    const { fileId } = await registerUploadedFile(db, actor, {
      batchId,
      fileName: `${suffix}.md`,
      mimeType: "text/markdown",
      byteSize: 1,
      contentDigest: DIGEST,
    });
    if (status === "ready") {
      const claim = await claimFileForParsing(db, fileId);
      await completeParse(db, {
        fileId,
        attemptCount: claim!.attemptCount,
        parserAdapterId: "passthrough",
        parserVersion: "1",
        proposedTitle: "Router draft",
        draft: { targetKind: "document", markdown: "# Router draft\n" },
        warnings: [],
      });
      await advanceToReady(fileId);
    } else if (status !== "pending") {
      await db.ingestionFile.update({
        where: { id: fileId },
        data: {
          status,
          failureKind: status === "failed" ? "parser" : "configuration",
          failureMessage: "retry me",
        },
      });
    }
    return { batchId, fileId, owner, project };
  }

  describe("ingestion accept and reject", () => {
    afterEach(() => setJobQueueForTests(null));

    async function readyDocument(
      suffix: string,
      options: { folder?: string; markdown?: string } = {},
    ) {
      const db = getPrisma();
      const { fileId, batchId, owner, project } = await makeRouterFile(
        suffix,
        "pending",
      );
      const actor = {
        ...securityContextFor(owner),
        name: "Owner",
        email: "owner@example.test",
      };
      if (options.folder)
        await createFolder(
          db,
          { projectId: project.id, parentPath: [], name: options.folder },
          actor,
        );
      const parse = await claimFileForParsing(db, fileId);
      await completeParse(db, {
        fileId,
        attemptCount: parse!.attemptCount,
        parserAdapterId: "native",
        parserVersion: "1",
        proposedTitle: "Imported notes",
        warnings: [],
        draft: {
          targetKind: "document",
          markdown: options.markdown ?? "# Imported notes\n\nBody.\n",
        },
      });
      await advanceToReady(fileId);
      if (options.folder)
        await db.ingestionDraft.update({
          where: { fileId },
          data: { proposedFolderPath: options.folder },
        });
      return { db, fileId, batchId, owner, project, actor };
    }

    async function commitsWithOperation(
      projectId: string,
      operationId: string,
    ) {
      return withProjectRepo(projectId, (repo) =>
        repo.logForPath(".", { skip: 0, limit: 10, operationId }),
      );
    }

    it("accepted document drafts materialize current destination folder reviewers", async () => {
      const { db, fileId, owner, project, actor } = await readyDocument(
        "accept-folder-reviewers",
        { folder: "guides" },
      );
      const reviewer = await makeUser("User", "accept-reviewer");
      await addMembership(project.id, reviewer.id, "Viewer");
      await withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic(
          ".folder.json",
          composeRootFolderMetadata({
            reviewDefaults: {
              reviewers: [
                { type: "user", id: reviewer.id, name: "Stale reviewer" },
              ],
            },
          }),
        );
        await repo.commitAll("test: reviewer defaults", {
          name: "Owner",
          email: owner.email,
          userId: owner.id,
        });
      });
      setJobQueueForTests(new FakeJobQueue());
      const result = await callerFor(owner).ingestion.accept(
        await reviewed(fileId),
      );
      const document = await getDocument(
        db,
        { projectId: project.id, documentId: result.resourceId },
        actor,
      );
      expect(document.review).toMatchObject({
        reviewers: [
          {
            type: "user",
            id: reviewer.id,
            name: "User accept-reviewer",
            resolved: true,
          },
        ],
        everyMonths: 12,
        lastReviewedAt: null,
        reviewedBy: null,
      });
      expect(document.review!.since).toEqual(document.createdAt);
    });

    it("accepts Markdown with bold inline code and preserves its formatting", async () => {
      const markdown = "**`host` is shared.**\n";
      const { db, fileId, owner, project, actor } = await readyDocument(
        "accept-bold-code",
        { markdown },
      );
      setJobQueueForTests(new FakeJobQueue());

      const result = await callerFor(owner).ingestion.accept(
        await reviewed(fileId),
      );
      expect(result.file.status).toBe("accepted");
      const document = await getDocument(
        db,
        { projectId: project.id, documentId: result.resourceId },
        actor,
      );
      expect(serializeDocumentBody(markdownContent(document))).toBe(markdown);
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it("commits a document draft exactly once with the ingestion trailer and kept links", async () => {
      const { db, fileId, owner, project, actor } = await readyDocument(
        "accept-doc",
        { folder: "guides" },
      );
      const target = await createDocument(
        db,
        {
          projectId: project.id,
          folderPath: [],
          title: "Setup guide",
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("Setup."),
          },
        },
        actor,
      );
      await db.ingestionDraft.update({
        where: { fileId },
        data: {
          proposedLinks: [
            {
              documentId: target.id,
              title: "Setup guide",
              anchor: null,
              confidence: 0.9,
              excerpt: "",
              keep: true,
            },
            {
              documentId: randomUUID(),
              title: "Dropped",
              anchor: null,
              confidence: 0.4,
              excerpt: "",
              keep: false,
            },
          ],
        },
      });
      const queue = new FakeJobQueue();
      setJobQueueForTests(queue);

      const result = await callerFor(owner).ingestion.accept(
        await reviewed(fileId),
      );
      expect(result).toMatchObject({
        targetKind: "document",
        file: { status: "accepted" },
      });
      expect(result.file.draft).toMatchObject({
        acceptedResourceId: result.resourceId,
        acceptedCommitSha: result.commitSha,
      });

      const document = await getDocument(
        db,
        { projectId: project.id, documentId: result.resourceId },
        actor,
      );
      expect(document.title).toBe("Imported notes");
      expect(document.path).toBe("guides/imported-notes.md");
      const commits = await commitsWithOperation(
        project.id,
        `ingestion:${fileId}`,
      );
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({
        sha: result.commitSha,
        userId: owner.id,
        authorEmail: owner.email,
        message: "create: guides/imported-notes.md",
      });
      expect(
        await db.documentLink.findMany({
          where: { sourceDocumentId: result.resourceId },
          select: { targetDocumentId: true },
        }),
      ).toEqual([{ targetDocumentId: target.id }]);
      expect(queue.jobs).toContainEqual(
        expect.objectContaining({
          name: "document.search-sync",
          data: expect.objectContaining({ documentId: result.resourceId }),
        }),
      );

      await registerKnowledgeJobHandlers({
        queue,
        context: knowledgeSystemContextForTests(),
        db,
        config: parseKnowledgeConfig({ WEAVER_JOBS_ENABLED: "true" }),
        routing: noKnowledgeRouting,
        roles: new Set(["knowledge"]),
      });
      const sync = queue.jobs.find(
        (job) =>
          job.name === "document.search-sync" &&
          job.data.documentId === result.resourceId,
      );
      if (sync?.name !== "document.search-sync")
        throw new Error("missing search job");
      await queue.run("document.search-sync", sync.data);
      const search = await searchKnowledge(
        db,
        { projectIds: [project.id], query: "Imported notes" },
        actor,
      );
      expect(search.documents).toContainEqual(
        expect.objectContaining({
          documentId: result.resourceId,
          sourceCommitSha: result.commitSha,
        }),
      );

      // Accepting again returns the stored result instead of a second commit.
      const again = await callerFor(owner).ingestion.accept(
        await reviewed(fileId),
      );
      expect(again.commitSha).toBe(result.commitSha);
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it("keeps an exact-bound draft ready with actionable Related overflow and accepts once after deselection", async () => {
      const markdown = "x".repeat(MAX_MARKDOWN_CHARS);
      const { db, fileId, owner, project } = await readyDocument(
        "accept-related-overflow",
        { markdown },
      );
      const links = [
        {
          documentId: randomUUID(),
          title: "Related guide",
          anchor: null,
          confidence: 1,
          excerpt: "",
          keep: true,
        },
      ];
      await db.ingestionDraft.update({
        where: { fileId },
        data: { proposedLinks: links },
      });
      const caller = callerFor(owner);
      await expect(
        caller.ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/deselect.*related/i),
        cause: expect.objectContaining({ field: "markdown" }),
      });
      const ready = await caller.ingestion.getFile({ fileId });
      expect(ready).toMatchObject({
        status: "ready",
        draft: {
          markdown,
          links,
          acceptedResourceId: null,
          acceptedCommitSha: null,
        },
      });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(0);
      expect(
        await db.document.count({ where: { projectId: project.id } }),
      ).toBe(0);
      await caller.ingestion.updateDraft({
        fileId,
        expectedRevision: (await reviewed(fileId)).expectedRevision,
        proposedTitle: ready.draft!.proposedTitle,
        proposedFolderPath: ready.draft!.proposedFolderPath,
        proposedTags: ready.draft!.proposedTags,
        links: links.map(({ documentId }) => ({ documentId, keep: false })),
      });
      const result = await caller.ingestion.accept(await reviewed(fileId));
      expect(result.file).toMatchObject({
        status: "accepted",
        draft: { markdown, links: [expect.objectContaining({ keep: false })] },
      });
      const created = await caller.document.get({
        projectId: project.id,
        documentId: result.resourceId,
      });
      expect(markdownContent(created)).toEqual(parseDocumentBody(markdown));
      expect(
        (await caller.ingestion.accept(await reviewed(fileId))).commitSha,
      ).toBe(result.commitSha);
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it("creates a typed table from a spreadsheet draft", async () => {
      const db = getPrisma();
      const { fileId, owner, project } = await makeRouterFile(
        "accept-table",
        "pending",
      );
      const parse = await claimFileForParsing(db, fileId);
      await completeParse(db, {
        fileId,
        attemptCount: parse!.attemptCount,
        parserAdapterId: "native",
        parserVersion: "1",
        proposedTitle: "Budget",
        warnings: [],
        draft: {
          targetKind: "table",
          columns: [
            { name: "Item", type: "text" },
            { name: "Amount", type: "text" },
            { name: "Paid", type: "text" },
          ],
          rows: [
            ["Rent", "1200", "true"],
            ["Food", "", "false"],
          ],
        },
      });
      const analysis = await claimFileForAnalysis(db, fileId);
      await completeAnalysis(db, {
        fileId,
        attemptCount: analysis!.attemptCount,
        proposedTitle: "Budget",
        proposedFolderPath: "",
        columns: [
          { name: "Item", type: "text" },
          { name: "Amount", type: "number" },
          { name: "Paid", type: "boolean" },
        ],
        linkQueries: [],
        warnings: [],
      });
      const linking = await claimFileForLinking(db, fileId);
      await completeLinking(db, {
        fileId,
        attemptCount: linking!.attemptCount,
        links: [],
      });

      await db.ingestionDraft.update({
        where: { fileId },
        data: {
          proposedLinks: [
            {
              documentId: randomUUID(),
              title: "Reference only",
              anchor: null,
              confidence: 1,
              excerpt: "",
              keep: true,
            },
          ],
        },
      });
      const diagnostic = vi.spyOn(diagnosticWriter, "emitDiagnostic");
      const result = await callerFor(owner).ingestion.accept(
        await reviewed(fileId),
      );
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "ingestion.draft.accepted",
          details: expect.objectContaining({
            targetKind: "table",
            keptLinks: 0,
          }),
        }),
      );
      diagnostic.mockRestore();
      expect(result.targetKind).toBe("table");
      const table = await getTable(
        db,
        { projectId: project.id, tableId: result.resourceId },
        securityContextFor(owner),
      );
      expect(table.columns.map((column) => [column.name, column.type])).toEqual(
        [
          ["Item", "text"],
          ["Amount", "number"],
          ["Paid", "boolean"],
        ],
      );
      const amount = table.columns[1]!.id;
      expect(table.rows.map((row) => row.cells[amount])).toEqual([
        1200,
        undefined,
      ]);
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it("refuses to save or accept a draft version the reviewer did not see", async () => {
      const { db, fileId, owner, project } = await readyDocument("accept-rev");
      const reviewerA = callerFor(owner);
      const seenByA = await reviewed(fileId);
      const seen = await reviewerA.ingestion.getFile({ fileId });
      expect(seen.draft?.revision).toBe(seenByA.expectedRevision);

      // Someone else saves a different choice after A loaded the draft.
      const saved = await callerFor(owner).ingestion.updateDraft({
        fileId,
        expectedRevision: seenByA.expectedRevision,
        proposedTitle: "Changed by someone else",
        proposedFolderPath: "",
        proposedTags: [],
      });
      expect(saved.draft?.revision).toBe(seenByA.expectedRevision + 1);

      await expect(reviewerA.ingestion.accept(seenByA)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        reviewerA.ingestion.updateDraft({
          fileId,
          expectedRevision: seenByA.expectedRevision,
          proposedTitle: "A's stale save",
          proposedFolderPath: "",
          proposedTags: [],
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        await db.ingestionFile.findUniqueOrThrow({
          where: { id: fileId },
          select: { status: true },
        }),
      ).toEqual({ status: "ready" });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(0);

      const accepted = await reviewerA.ingestion.accept(await reviewed(fileId));
      expect(accepted.targetKind).toBe("document");
    });

    it("recovers an interrupted acceptance from its commit and re-applies one that never committed", async () => {
      const { db, fileId, owner, project } =
        await readyDocument("accept-recover");
      const first = await callerFor(owner).ingestion.accept(
        await reviewed(fileId),
      );
      // Simulate a crash after the commit but before the acknowledgement was stored.
      await db.ingestionFile.update({
        where: { id: fileId },
        data: { status: "accepting" },
      });
      await db.ingestionDraft.update({
        where: { fileId },
        data: { acceptedResourceId: null, acceptedCommitSha: null },
      });
      // Recovery is not a fresh review, so a stale revision must not block it.
      const recovered = await callerFor(owner).ingestion.accept({
        fileId,
        expectedRevision: 99,
      });
      expect(recovered.commitSha).toBe(first.commitSha);
      expect(recovered.resourceId).toBe(first.resourceId);
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);

      // A claim with no commit behind it applies the operation normally.
      const fresh = await readyDocument("accept-claimed");
      await fresh.db.ingestionFile.update({
        where: { id: fresh.fileId },
        data: { status: "accepting" },
      });
      const applied = await callerFor(fresh.owner).ingestion.accept(
        await reviewed(fresh.fileId),
      );
      expect(applied.file.status).toBe("accepted");
      expect(
        await commitsWithOperation(
          fresh.project.id,
          `ingestion:${fresh.fileId}`,
        ),
      ).toHaveLength(1);
    });

    it("reports a vanished folder as a field error and releases the claim", async () => {
      const { db, fileId, owner, project } =
        await readyDocument("accept-folder");
      await db.ingestionDraft.update({
        where: { fileId },
        data: { proposedFolderPath: "missing" },
      });
      await expect(
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        cause: { field: "proposedFolderPath" },
      });
      expect(
        await getFile(db, securityContextFor(owner), { fileId }),
      ).toMatchObject({ status: "ready" });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(0);
    });

    it("rejects a ready draft, keeps its original, and refuses other states", async () => {
      const { db, fileId, owner, project } = await readyDocument("reject");
      const dataDir = await temporaryDataDir();
      const blob = await writeBlob(dataDir, project.id, "original upload");
      await db.ingestionFile.update({
        where: { id: fileId },
        data: { contentDigest: blob.digest, byteSize: blob.byteSize },
      });
      const rejected = await callerFor(owner).ingestion.reject({ fileId });
      expect(rejected).toMatchObject({
        status: "rejected",
        draft: { proposedTitle: "Imported notes" },
      });
      expect(await blobExists(dataDir, project.id, blob.digest)).toBe(true);
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(0);
      await expect(
        callerFor(owner).ingestion.reject({ fileId }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      await expect(
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      await db.ingestionFile.update({
        where: { id: fileId },
        data: { status: "accepting" },
      });
      await expect(
        callerFor(owner).ingestion.reject({ fileId }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("hides accept and reject from viewers and nonmembers", async () => {
      const { fileId, project } = await readyDocument("accept-roles");
      const viewer = await makeUser("User", "accept-viewer");
      await addMembership(project.id, viewer.id, "Viewer");
      const outsider = await makeUser("User", "accept-outsider");
      const admin = await makeUser("Admin", "accept-admin-outsider");
      await expect(
        callerFor(admin).ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        callerFor(admin).ingestion.reject({ fileId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        callerFor(viewer).ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerFor(viewer).ingestion.reject({ fileId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerFor(outsider).ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        callerFor(outsider).ingestion.reject({ fileId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it.each(["Editor", "Maintainer"] as const)(
      "permits %s acceptance and rejection",
      async (role) => {
        const accepting = await readyDocument(`role-accept-${role}`);
        const rejecting = await readyDocument(`role-reject-${role}`);
        const member = await makeUser("User", `accept-member-${role}`);
        await addMembership(accepting.project.id, member.id, role);
        await addMembership(rejecting.project.id, member.id, role);
        await expect(
          callerFor(member).ingestion.accept(await reviewed(accepting.fileId)),
        ).resolves.toMatchObject({ file: { status: "accepted" } });
        await expect(
          callerFor(member).ingestion.reject({ fileId: rejecting.fileId }),
        ).resolves.toMatchObject({ status: "rejected" });
      },
    );

    it("hides deleted projects before acceptance and rejection", async () => {
      const { db, fileId, owner, project } = await readyDocument(
        "accept-deleted-project",
      );
      await db.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });
      await expect(
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        callerFor(owner).ingestion.reject({ fileId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(0);
    });

    function barrier() {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { waiting, release };
    }

    async function blockFile(fileId: string) {
      const locked = barrier();
      const released = barrier();
      const transaction = getPrisma().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "IngestionFile" WHERE id = ${fileId}::uuid FOR UPDATE`;
        locked.release();
        await released.waiting;
      });
      await locked.waiting;
      return { transaction, release: released.release };
    }

    it("accepts the committed review edit when editing wins the file lock", async () => {
      const { db, fileId, owner, project, actor } =
        await readyDocument("edit-wins");
      const before = await reviewed(fileId);
      const blocker = await blockFile(fileId);
      const edit = callerFor(owner).ingestion.updateDraft({
        ...before,
        proposedTitle: "Reviewed title",
        proposedFolderPath: "",
        proposedTags: [],
      });
      let accept!: ReturnType<
        ReturnType<typeof callerFor>["ingestion"]["accept"]
      >;
      try {
        await waitForDatabaseLockWaiter();
        // The reviewer accepts what their own save produces, not the version before it.
        accept = callerFor(owner).ingestion.accept({
          fileId,
          expectedRevision: before.expectedRevision + 1,
        });
        await waitForDatabaseLockWaiters(2);
      } finally {
        blocker.release();
      }
      await blocker.transaction;
      await expect(edit).resolves.toMatchObject({
        draft: { proposedTitle: "Reviewed title" },
      });
      const accepted = await accept;
      expect(
        await getDocument(
          db,
          { projectId: project.id, documentId: accepted.resourceId },
          actor,
        ),
      ).toMatchObject({ title: "Reviewed title" });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it("refuses edits, rejection, and batch deletion after acceptance claims the file", async () => {
      const { db, fileId, batchId, owner, project, actor } =
        await readyDocument("accept-wins");
      const entered = barrier();
      const resume = barrier();
      const apply = contentOperations.applyOperationInRepo;
      const spy = vi
        .spyOn(contentOperations, "applyOperationInRepo")
        .mockImplementationOnce(async (...args) => {
          entered.release();
          await resume.waiting;
          return apply(...args);
        });
      const accept = callerFor(owner).ingestion.accept(await reviewed(fileId));
      await entered.waiting;
      try {
        await expect(
          callerFor(owner).ingestion.updateDraft({
            fileId,
            expectedRevision: (await reviewed(fileId)).expectedRevision,
            proposedTitle: "Too late",
            proposedFolderPath: "",
            proposedTags: [],
          }),
        ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
        await expect(
          callerFor(owner).ingestion.reject({ fileId }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
          callerFor(owner).ingestion.deleteBatch({ batchId }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
          await db.ingestionFile.findUniqueOrThrow({ where: { id: fileId } }),
        ).toMatchObject({ status: "accepting" });
      } finally {
        resume.release();
        spy.mockRestore();
      }
      const result = await accept;
      expect(
        await getDocument(
          db,
          { projectId: project.id, documentId: result.resourceId },
          actor,
        ),
      ).toMatchObject({ title: "Imported notes" });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it("serializes a queued deletion behind the acceptance claim", async () => {
      const { fileId, batchId, owner, project } = await readyDocument(
        "delete-behind-accept",
      );
      const blocker = await blockFile(fileId);
      const entered = barrier();
      const resume = barrier();
      const apply = contentOperations.applyOperationInRepo;
      const spy = vi
        .spyOn(contentOperations, "applyOperationInRepo")
        .mockImplementationOnce(async (...args) => {
          entered.release();
          await resume.waiting;
          return apply(...args);
        });
      const accept = callerFor(owner).ingestion.accept(await reviewed(fileId));
      let deletion!: Promise<unknown>;
      try {
        await waitForDatabaseLockWaiter();
        deletion = callerFor(owner)
          .ingestion.deleteBatch({ batchId })
          .catch((error: unknown) => error);
        await waitForDatabaseLockWaiters(2);
      } finally {
        blocker.release();
      }
      try {
        await blocker.transaction;
        await entered.waiting;
        expect(await deletion).toMatchObject({ code: "CONFLICT" });
      } finally {
        resume.release();
        spy.mockRestore();
      }
      await expect(accept).resolves.toMatchObject({
        file: { status: "accepted" },
      });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it("writes no content when batch deletion wins the file lock", async () => {
      const { fileId, batchId, owner, project } =
        await readyDocument("delete-wins");
      const blocker = await blockFile(fileId);
      const deletion = callerFor(owner).ingestion.deleteBatch({ batchId });
      let accept!: Promise<unknown>;
      try {
        await waitForDatabaseLockWaiter();
        accept = callerFor(owner)
          .ingestion.accept(await reviewed(fileId))
          .catch((error: unknown) => error);
        await waitForDatabaseLockWaiters(2);
      } finally {
        blocker.release();
      }
      await blocker.transaction;
      await deletion;
      expect(await accept).toMatchObject({ code: "NOT_FOUND" });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(0);
    });

    it("serializes simultaneous accepts into one operation commit", async () => {
      const { fileId, owner, project } = await readyDocument("accept-parallel");
      const results = await Promise.all([
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
      ]);
      expect(results[1]).toEqual(results[0]);
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
    });

    it.each(["document", "table"] as const)(
      "recovers a durable %s commit after acknowledgement rollback",
      async (targetKind) => {
        const { db, fileId, batchId, owner, project, actor } =
          await readyDocument(`durable-${targetKind}`);
        if (targetKind === "table")
          await db.ingestionDraft.update({
            where: { fileId },
            data: {
              targetKind,
              tableSchema: { columns: [{ name: "Amount", type: "number" }] },
              tableRows: [["12"]],
              markdown: null,
            },
          });
        const failingDb = db.$extends({
          query: {
            ingestionDraft: {
              async update({ args, query }) {
                if (args.data.acceptedCommitSha)
                  throw new Error("acknowledgement interrupted");
                return query(args);
              },
            },
          },
        });
        await expect(
          acceptDraft(failingDb as unknown as typeof db, actor, { fileId }),
        ).rejects.toThrow("acknowledgement interrupted");
        const commits = await commitsWithOperation(
          project.id,
          `ingestion:${fileId}`,
        );
        expect(commits).toHaveLength(1);
        expect(await getFile(db, actor, { fileId })).toMatchObject({
          status: "accepting",
          draft: { acceptedCommitSha: null, acceptedResourceId: null },
        });
        await expect(
          callerFor(owner).ingestion.reject({ fileId }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
          callerFor(owner).ingestion.deleteBatch({ batchId }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        const recovered = await callerFor(owner).ingestion.accept(
          await reviewed(fileId),
        );
        expect(recovered).toMatchObject({
          targetKind,
          commitSha: commits[0]!.sha,
          file: { status: "accepted" },
        });
        expect(
          await commitsWithOperation(project.id, `ingestion:${fileId}`),
        ).toHaveLength(1);
        expect(
          (await db.document.count({ where: { projectId: project.id } })) +
            (await db.dataTable.count({ where: { projectId: project.id } })),
        ).toBe(1);
      },
    );

    it("requires one finalized claim before storing the resource acknowledgement", async () => {
      const { db, fileId, owner, project, actor } =
        await readyDocument("lost-finalize");
      const failingDb = db.$extends({
        query: {
          ingestionFile: {
            async updateMany({ args, query }) {
              if (args.data.status === "accepted") return { count: 0 };
              return query(args);
            },
          },
        },
      });
      await expect(
        acceptDraft(failingDb as unknown as typeof db, actor, { fileId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await getFile(db, actor, { fileId })).toMatchObject({
        status: "accepting",
        draft: { acceptedCommitSha: null, acceptedResourceId: null },
      });
      expect(
        await commitsWithOperation(project.id, `ingestion:${fileId}`),
      ).toHaveLength(1);
      await expect(
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
      ).resolves.toMatchObject({ file: { status: "accepted" } });
    });

    it.each([false, true])(
      "only releases a validation failure without a commit (committed=%s)",
      async (committed) => {
        const { db, fileId, owner, project } = await readyDocument(
          `validation-${committed}`,
        );
        if (committed)
          await callerFor(owner).ingestion.accept(await reviewed(fileId));
        await db.ingestionFile.update({
          where: { id: fileId },
          data: { status: "accepting" },
        });
        await db.ingestionDraft.update({
          where: { fileId },
          data: {
            proposedTitle: "",
            acceptedResourceId: null,
            acceptedCommitSha: null,
          },
        });
        await expect(
          callerFor(owner).ingestion.accept(await reviewed(fileId)),
        ).rejects.toMatchObject({
          code: "BAD_REQUEST",
          cause: { field: "proposedTitle" },
        });
        expect(
          await getFile(db, securityContextFor(owner), { fileId }),
        ).toMatchObject({ status: committed ? "accepting" : "ready" });
        expect(
          await commitsWithOperation(project.id, `ingestion:${fileId}`),
        ).toHaveLength(committed ? 1 : 0);
      },
    );

    it.each([false, true])(
      "only releases a recovery error without a commit (committed=%s)",
      async (committed) => {
        const { db, fileId, owner, project } = await readyDocument(
          `recovery-error-${committed}`,
        );
        if (committed)
          await callerFor(owner).ingestion.accept(await reviewed(fileId));
        await db.ingestionFile.update({
          where: { id: fileId },
          data: { status: "accepting" },
        });
        const spy = vi
          .spyOn(contentOperations, "recoverPriorOperation")
          .mockRejectedValueOnce(new Error("recovery unavailable"));
        try {
          await expect(
            callerFor(owner).ingestion.accept(await reviewed(fileId)),
          ).rejects.toThrow("recovery unavailable");
        } finally {
          spy.mockRestore();
        }
        expect(
          await getFile(db, securityContextFor(owner), { fileId }),
        ).toMatchObject({ status: committed ? "accepting" : "ready" });
        expect(
          await commitsWithOperation(project.id, `ingestion:${fileId}`),
        ).toHaveLength(committed ? 1 : 0);
      },
    );

    it.each([false, true])(
      "only releases an apply error without a commit (committed=%s)",
      async (committed) => {
        const { db, fileId, owner, project } = await readyDocument(
          `apply-error-${committed}`,
        );
        const apply = contentOperations.applyOperationInRepo;
        const spy = vi
          .spyOn(contentOperations, "applyOperationInRepo")
          .mockImplementationOnce(async (...args) => {
            if (committed) await apply(...args);
            throw new Error("write interrupted");
          });
        try {
          await expect(
            callerFor(owner).ingestion.accept(await reviewed(fileId)),
          ).rejects.toThrow("write interrupted");
        } finally {
          spy.mockRestore();
        }
        expect(
          await getFile(db, securityContextFor(owner), { fileId }),
        ).toMatchObject({ status: committed ? "accepting" : "ready" });
        expect(
          await commitsWithOperation(project.id, `ingestion:${fileId}`),
        ).toHaveLength(committed ? 1 : 0);
        await expect(
          callerFor(owner).ingestion.accept(await reviewed(fileId)),
        ).resolves.toMatchObject({ file: { status: "accepted" } });
        expect(
          await commitsWithOperation(project.id, `ingestion:${fileId}`),
        ).toHaveLength(1);
      },
    );

    async function addLookalikeHistory(
      fixture: Awaited<ReturnType<typeof readyDocument>>,
      count: number,
    ) {
      const { db, fileId, project, actor } = fixture;
      let other = await createDocument(
        db,
        {
          projectId: project.id,
          folderPath: [],
          title: "Other notes",
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("Original unrelated content."),
          },
        },
        actor,
      );
      for (let index = 0; index < count; index += 1) {
        other = await saveDocument(
          db,
          {
            projectId: project.id,
            documentId: other.id,
            baseCommitSha: other.headCommitSha,
            content: {
              kind: "markdown",
              contentJson: parseDocumentBody(`Unrelated revision ${index}.`),
            },
            changeSummary: `Weaver-Operation-Id: ingestion:${fileId}`,
          },
          actor,
        );
      }
      return other;
    }

    it.each([false, true])(
      "proves complete release history behind a lookalike summary (committed=%s)",
      async (committed) => {
        const fixture = await readyDocument(`lookalike-${committed}`);
        const { db, fileId, batchId, owner, project, actor } = fixture;
        if (committed) {
          const failingDb = db.$extends({
            query: {
              ingestionDraft: {
                async update({ args, query }) {
                  if (args.data.acceptedCommitSha)
                    throw new Error("acknowledgement interrupted");
                  return query(args);
                },
              },
            },
          });
          await expect(
            acceptDraft(failingDb as unknown as typeof db, actor, { fileId }),
          ).rejects.toThrow("acknowledgement interrupted");
        } else {
          await db.ingestionFile.update({
            where: { id: fileId },
            data: { status: "accepting" },
          });
        }
        await addLookalikeHistory(fixture, 1);
        const candidates = await commitsWithOperation(
          project.id,
          `ingestion:${fileId}`,
        );
        expect(candidates).toHaveLength(committed ? 2 : 1);
        expect(candidates[0]).toMatchObject({
          operationId: null,
          message: expect.stringContaining(
            `Weaver-Operation-Id: ingestion:${fileId}`,
          ),
        });
        const original = candidates.find(
          (entry) => entry.operationId === `ingestion:${fileId}`,
        );
        expect(Boolean(original)).toBe(committed);
        const recovery = vi
          .spyOn(contentOperations, "recoverPriorOperation")
          .mockRejectedValueOnce(new Error("recovery unavailable"));
        try {
          await expect(
            callerFor(owner).ingestion.accept(await reviewed(fileId)),
          ).rejects.toThrow("recovery unavailable");
        } finally {
          recovery.mockRestore();
        }
        expect(await getFile(db, actor, { fileId })).toMatchObject({
          status: committed ? "accepting" : "ready",
        });
        if (committed) {
          await expect(
            callerFor(owner).ingestion.reject({ fileId }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          await expect(
            callerFor(owner).ingestion.deleteBatch({ batchId }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
        }
        const accepted = await callerFor(owner).ingestion.accept(
          await reviewed(fileId),
        );
        if (original) expect(accepted.commitSha).toBe(original.sha);
        expect(
          (
            await commitsWithOperation(project.id, `ingestion:${fileId}`)
          ).filter((entry) => entry.operationId === `ingestion:${fileId}`),
        ).toHaveLength(1);
      },
    );

    it("retains accepting when release history exceeds the candidate bound", async () => {
      const fixture = await readyDocument("lookalike-bound");
      const { db, fileId, batchId, owner, project, actor } = fixture;
      await addLookalikeHistory(fixture, 11);
      const candidates = await withProjectRepo(project.id, (repo) =>
        repo.logForPath(".", {
          skip: 0,
          limit: 12,
          operationId: `ingestion:${fileId}`,
        }),
      );
      expect(candidates).toHaveLength(11);
      expect(candidates.every((entry) => entry.operationId === null)).toBe(
        true,
      );
      await db.ingestionFile.update({
        where: { id: fileId },
        data: { status: "accepting" },
      });
      await db.ingestionDraft.update({
        where: { fileId },
        data: { proposedTitle: "" },
      });
      await expect(
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await getFile(db, actor, { fileId })).toMatchObject({
        status: "accepting",
      });
      await expect(
        callerFor(owner).ingestion.reject({ fileId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        callerFor(owner).ingestion.deleteBatch({ batchId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("retains accepting when release history cannot be read", async () => {
      const { db, fileId, owner, actor } = await readyDocument(
        "history-unavailable",
      );
      const recovery = vi
        .spyOn(contentOperations, "recoverPriorOperation")
        .mockImplementationOnce(async (_db, repo) => {
          vi.spyOn(repo, "logForPath").mockRejectedValueOnce(
            new Error("history unavailable"),
          );
          throw new Error("recovery unavailable");
        });
      try {
        await expect(
          callerFor(owner).ingestion.accept(await reviewed(fileId)),
        ).rejects.toThrow("history unavailable");
      } finally {
        recovery.mockRestore();
      }
      expect(await getFile(db, actor, { fileId })).toMatchObject({
        status: "accepting",
      });
      await expect(
        callerFor(owner).ingestion.accept(await reviewed(fileId)),
      ).resolves.toMatchObject({ file: { status: "accepted" } });
    });

    it("maps a draft to a content operation the schema accepts", () => {
      const operation = buildAcceptOperation(
        "11111111-1111-4111-8111-111111111111",
        {
          targetKind: "table",
          proposedTitle: "Budget",
          proposedFolderPath: "finance/2026",
          markdown: null,
          columns: [{ name: "Amount", type: "number" }],
          rows: [["1"], [" "]],
          links: [],
        },
      );
      expect(operation).toMatchObject({
        kind: "table.create",
        folderPath: ["finance", "2026"],
        columns: [{ name: "Amount", type: "number" }],
      });
      if (operation.kind !== "table.create") throw new Error("unexpected kind");
      expect(Object.values(operation.rows[0]!.cells)).toEqual([1]);
      expect(operation.rows[1]!.cells).toEqual({});
    });
  });

  it("edits column types and link selection on a ready draft", async () => {
    const db = getPrisma();
    const { fileId, owner } = await makeRouterFile("edit-columns", "pending");
    const parse = await claimFileForParsing(db, fileId);
    await completeParse(db, {
      fileId,
      attemptCount: parse!.attemptCount,
      parserAdapterId: "native",
      parserVersion: "1",
      proposedTitle: "Budget",
      warnings: [],
      draft: {
        targetKind: "table",
        columns: [
          { name: "Item", type: "text" },
          { name: "Amount", type: "text" },
        ],
        rows: [
          ["Rent", "1200"],
          ["Food", "abc"],
        ],
      },
    });
    await advanceToReady(fileId);
    const caller = callerFor(owner);
    await expect(
      caller.ingestion.updateDraft({
        fileId,
        expectedRevision: (await reviewed(fileId)).expectedRevision,
        proposedTitle: "Budget",
        proposedFolderPath: "",
        proposedTags: [],
        columns: [
          { name: "Item", type: "text" },
          { name: "Amount", type: "number" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: { field: "columns" },
    });
    const updated = await caller.ingestion.updateDraft({
      fileId,
      expectedRevision: (await reviewed(fileId)).expectedRevision,
      proposedTitle: "Budget 2026",
      proposedFolderPath: "",
      proposedTags: [],
      columns: [
        { name: "Line item", type: "text" },
        { name: "Amount", type: "text" },
      ],
    });
    expect(updated.draft?.table?.columns).toEqual([
      { name: "Line item", type: "text" },
      { name: "Amount", type: "text" },
    ]);

    const linked = await makeRouterFile("edit-links", "ready");
    const DOC = "44444444-4444-4444-8444-444444444444";
    const OTHER = "55555555-5555-4555-8555-555555555555";
    await db.ingestionDraft.update({
      where: { fileId: linked.fileId },
      data: {
        proposedLinks: [
          {
            documentId: DOC,
            title: "Doc",
            anchor: null,
            confidence: 0.9,
            excerpt: "",
            keep: true,
          },
        ],
      },
    });
    const result = await callerFor(linked.owner).ingestion.updateDraft({
      fileId: linked.fileId,
      expectedRevision: (await reviewed(linked.fileId)).expectedRevision,
      proposedTitle: "Router draft",
      proposedFolderPath: "",
      proposedTags: [],
      links: [
        { documentId: DOC, keep: false },
        { documentId: OTHER, keep: true },
      ],
    });
    expect(result.draft?.links).toEqual([
      {
        documentId: DOC,
        title: "Doc",
        anchor: null,
        confidence: 0.9,
        excerpt: "",
        keep: false,
      },
    ]);
  });

  it("pages filtered batches and reads batch and file details", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "router-list");
    const project = await makeProject("Router list");
    await addMembership(project.id, owner.id, "Owner");
    const actor = securityContextFor(owner);
    const createdAt = new Date("2026-09-05T10:00:00.000Z");
    const attention: Array<{ batchId: string; fileId: string }> = [];
    for (const suffix of ["a", "b"]) {
      const { batchId } = await createUploadBatch(db, actor, {
        projectId: project.id,
        origin: "upload",
        label: suffix,
      });
      const { fileId } = await registerUploadedFile(db, actor, {
        batchId,
        fileName: `${suffix}.md`,
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: DIGEST,
      });
      await db.ingestionBatch.update({
        where: { id: batchId },
        data: { createdAt },
      });
      await db.ingestionFile.update({
        where: { id: fileId },
        data: {
          status: "failed",
          failureKind: "parser",
          failureMessage: "bad",
        },
      });
      attention.push({ batchId, fileId });
    }
    await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
      label: "pending",
    });

    const caller = callerFor(owner);
    const first = await caller.ingestion.listBatches({
      projectId: project.id,
      status: "attention",
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ status: "attention" });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await caller.ingestion.listBatches({
      projectId: project.id,
      status: "attention",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.nextCursor).toBeNull();
    const detail = await caller.ingestion.getBatch({
      batchId: attention[0]!.batchId,
    });
    expect(detail.files.map((file) => file.id)).toContain(attention[0]!.fileId);
    await expect(
      caller.ingestion.getFile({ fileId: attention[0]!.fileId }),
    ).resolves.toMatchObject({ id: attention[0]!.fileId, status: "failed" });
  });

  it("trims draft metadata and enforces its public size limits", async () => {
    const fixture = await makeRouterFile("draft", "ready");
    const maxTag = "x".repeat(60);
    const proposedTags = [
      " reviewed ",
      maxTag,
      ...Array.from({ length: 18 }, (_, index) => `tag-${index}`),
    ];
    const updated = await callerFor(fixture.owner).ingestion.updateDraft({
      fileId: fixture.fileId,
      expectedRevision: (await reviewed(fixture.fileId)).expectedRevision,
      proposedTitle: "Reviewed draft",
      proposedFolderPath: " imports/2026 ",
      proposedTags,
    });
    expect(updated.draft).toMatchObject({
      proposedTitle: "Reviewed draft",
      proposedFolderPath: "imports/2026",
      proposedTags: [
        "reviewed",
        maxTag,
        ...Array.from({ length: 18 }, (_, index) => `tag-${index}`),
      ],
      editedById: fixture.owner.id,
    });
    await expect(
      callerFor(fixture.owner).ingestion.updateDraft({
        fileId: fixture.fileId,
        expectedRevision: (await reviewed(fixture.fileId)).expectedRevision,
        proposedTitle: "Reviewed draft",
        proposedFolderPath: "imports/2026",
        proposedTags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      callerFor(fixture.owner).ingestion.updateDraft({
        fileId: fixture.fileId,
        expectedRevision: (await reviewed(fixture.fileId)).expectedRevision,
        proposedTitle: "Reviewed draft",
        proposedFolderPath: "imports/2026",
        proposedTags: ["x".repeat(61)],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("enforces authentication and maps access and service errors", async () => {
    const fixture = await makeRouterFile("access", "pending");
    const viewer = await makeUser("User", "router-viewer");
    const outsider = await makeUser("User", "router-outsider");
    await addMembership(fixture.project.id, viewer.id, "Viewer");
    const anonymous = createCaller({
      db: getPrisma(),
      session: null,
      security: null,
      headers: new Headers(),
    } as never);
    await expect(
      anonymous.ingestion.listBatches({ projectId: fixture.project.id }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      callerFor(viewer).ingestion.listBatches({
        projectId: fixture.project.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(outsider).ingestion.getBatch({ batchId: fixture.batchId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(fixture.owner).ingestion.getBatch({ batchId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("retries blocked files with the full job payload and rejects other states", async () => {
    const db = getPrisma();
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const blocked = await makeRouterFile(
      "retry-blocked",
      "blocked_configuration",
    );
    const pending = await makeRouterFile("retry-pending", "pending");
    const ready = await makeRouterFile("retry-ready", "ready");
    await db.ingestionFile.update({
      where: { id: blocked.fileId },
      data: { attemptCount: 3 },
    });
    await expect(
      callerFor(blocked.owner).ingestion.retry({ fileId: blocked.fileId }),
    ).resolves.toEqual({
      stage: "parse",
      fileId: blocked.fileId,
      projectId: blocked.project.id,
      contentDigest: DIGEST,
      attemptCount: 3,
    });
    expect(queue.jobs).toEqual([
      {
        name: "ingestion.parse",
        data: {
          fileId: blocked.fileId,
          projectId: blocked.project.id,
          contentDigest: DIGEST,
          baseAttemptCount: 3,
        },
      },
    ]);
    await expect(
      callerFor(pending.owner).ingestion.retry({ fileId: pending.fileId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      callerFor(ready.owner).ingestion.retry({ fileId: ready.fileId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("does not mutate a retry when jobs are disabled", async () => {
    const db = getPrisma();
    const fixture = await makeRouterFile("retry-disabled", "failed");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");
    await expect(
      callerFor(fixture.owner).ingestion.retry({ fileId: fixture.fileId }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "background jobs are disabled",
    });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
        select: { status: true, failureKind: true, failureMessage: true },
      }),
    ).toEqual({
      status: "failed",
      failureKind: "parser",
      failureMessage: "retry me",
    });
  });

  it("retries the failed stage only and publishes that stage's job", async () => {
    const db = getPrisma();
    const { fileId, owner, project } = await makeRouterFile(
      "retry-stage",
      "pending",
    );
    const parse = await claimFileForParsing(db, fileId);
    await completeParse(db, {
      fileId,
      attemptCount: parse!.attemptCount,
      parserAdapterId: "native",
      parserVersion: "1",
      proposedTitle: "Retry me",
      warnings: [],
      draft: { targetKind: "document", markdown: "x" },
    });
    const analysis = await claimFileForAnalysis(db, fileId);
    await failFile(db, {
      fileId,
      attemptCount: analysis!.attemptCount,
      fromStatus: "extracting",
      failureKind: "provider",
      message: "model down",
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const result = await callerFor(owner).ingestion.retry({ fileId });
    expect(result).toMatchObject({ stage: "analyze", attemptCount: 2 });
    expect(queue.jobs).toEqual([
      {
        name: "ingestion.analyze",
        data: {
          fileId,
          projectId: project.id,
          contentDigest: DIGEST,
          baseAttemptCount: 2,
        },
      },
    ]);
    expect(
      await getFile(db, securityContextFor(owner), { fileId }),
    ).toMatchObject({
      status: "extracting",
      failureKind: null,
      draft: { proposedTitle: "Retry me" },
    });
  });

  it.each([
    [
      "throws a regular error",
      async (): Promise<string | null> => {
        throw new Error("queue unavailable");
      },
    ],
    [
      "throws a CoreError",
      async (): Promise<string | null> => {
        throw new CoreError("FORBIDDEN", "queue boundary error");
      },
    ],
    ["returns null", async (): Promise<string | null> => null],
  ] as const)("leaves retry pending when publication %s", async (_, send) => {
    const db = getPrisma();
    const fixture = await makeRouterFile(
      `retry-publish-failure-${randomUUID()}`,
      "failed",
    );
    setJobQueueForTests({
      send,
      work: async () => undefined,
      schedule: async () => undefined,
      stop: async () => undefined,
    });
    await expect(
      callerFor(fixture.owner).ingestion.retry({ fileId: fixture.fileId }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "retry was stored but job publication failed",
    });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
        select: { status: true, failureKind: true, failureMessage: true },
      }),
    ).toEqual({ status: "pending", failureKind: null, failureMessage: null });
  });

  it("deletes through configured storage and preserves shared blobs", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "router-delete");
    const project = await makeProject("Router delete");
    await addMembership(project.id, owner.id, "Owner");
    const actor = securityContextFor(owner);
    const kept = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const removed = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    const dataDir = process.env.WEAVER_DATA_DIR!;
    const shared = await writeBlob(dataDir, project.id, "shared router blob");
    const lonely = await writeBlob(dataDir, project.id, "lonely router blob");
    for (const [batchId, fileName, blob] of [
      [kept.batchId, "kept.md", shared],
      [removed.batchId, "shared.md", shared],
      [removed.batchId, "lonely.md", lonely],
    ] as const) {
      await registerUploadedFile(db, actor, {
        batchId,
        fileName,
        mimeType: "text/markdown",
        byteSize: blob.byteSize,
        contentDigest: blob.digest,
      });
    }
    await expect(
      callerFor(owner).ingestion.deleteBatch({ batchId: removed.batchId }),
    ).resolves.toEqual({ deletedBlobs: 1 });
    expect(await blobExists(dataDir, project.id, shared.digest)).toBe(true);
    expect(await blobExists(dataDir, project.id, lonely.digest)).toBe(false);
  });
});

type UploadRoute = (request: Request) => Promise<Response>;
type MultipartPart = {
  name: string;
  value: string;
  fileName?: string;
  contentType?: string;
};

let uploadRoute: UploadRoute;

function uploadRequest(form: FormData): Request {
  return new Request("http://localhost:3000/api/ingestion/uploads", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
    body: form,
  });
}

function rawUploadRequest(
  body: BodyInit | null,
  contentType: string,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request("http://localhost:3000/api/ingestion/uploads", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": contentType,
      ...extraHeaders,
    },
    body,
    signal,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" });
}

function withSession(request: Request, cookie: string): Request {
  request.headers.set("cookie", cookie);
  return request;
}

async function sessionCookieFor(email: string): Promise<string> {
  const response = await testAuth().api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    asResponse: true,
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  expect(cookie).toMatch(/session_token=/);
  return cookie!;
}

async function sessionForRole(role: ProjectRoleName, suffix: string) {
  const user = await makeUser("User", `upload-${suffix}`);
  const project = await makeProject(`Upload ${suffix}`);
  await addMembership(project.id, user.id, role);
  return { project, user, session: await sessionCookieFor(user.email) };
}

async function sessionForEditor(suffix: string) {
  return sessionForRole("Editor", suffix);
}

async function resolveTestSession(
  headers: Headers,
): Promise<SessionUser | null> {
  const session = await testAuth().api.getSession({ headers });
  if (!session || session.user.banned) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === "Admin" ? "Admin" : "User",
    sessionId: session.session.id,
    mustChangePassword: session.user.mustChangePassword === true,
  };
}

function multipartBody(
  boundary: string,
  parts: readonly MultipartPart[],
  close = true,
): string {
  const body = parts
    .map((part) => {
      const disposition = part.fileName
        ? `form-data; name="${part.name}"; filename="${part.fileName}"`
        : `form-data; name="${part.name}"`;
      return [
        `--${boundary}`,
        `Content-Disposition: ${disposition}`,
        ...(part.contentType ? [`Content-Type: ${part.contentType}`] : []),
        "",
        part.value,
      ].join("\r\n");
    })
    .join("\r\n");
  return `${body}\r\n${close ? `--${boundary}--\r\n` : ""}`;
}

async function uploadEntries(projectId: string): Promise<string[]> {
  const filesRoot = path.join(process.env.WEAVER_DATA_DIR!, "files", projectId);
  try {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(filesRoot, {
      recursive: true,
    });
    const inspected = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        info: await fs.stat(path.join(filesRoot, entry)),
      })),
    );
    return inspected
      .filter(({ info }) => info.isFile())
      .map(({ entry }) => entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  const route = await import("~/app/api/ingestion/uploads/route");
  uploadRoute = route.POST as unknown as UploadRoute;
});

afterAll(() => {
  vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null));
  vi.unstubAllEnvs();
});

describe("upload route", () => {
  let queue: FakeJobQueue;

  beforeEach(() => {
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  });

  it("authenticates before reading the multipart body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("the anonymous body must not be read");
      },
    });
    const request = rawUploadRequest(
      body,
      "multipart/form-data; boundary=anonymous",
    );

    const response = await uploadRoute(request);

    expect(response.status).toBe(401);
  });

  it("blocks a user who must change their password before reading the body, but uploads normally once they don't", async () => {
    const db = getPrisma();
    const { project, user, session } = await sessionForEditor("forced-change");
    await db.user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("a flagged user's body must not be read");
      },
    });
    const blockedRequest = rawUploadRequest(
      body,
      "multipart/form-data; boundary=forced-change",
    );

    const blocked = await uploadRoute(withSession(blockedRequest, session));

    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({
      error: "password change required",
    });
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);

    await db.user.update({
      where: { id: user.id },
      data: { mustChangePassword: false },
    });
    const form = new FormData();
    form.set("projectId", project.id);
    form.append("file", new File(["x"], "a.md", { type: "text/markdown" }));

    const allowed = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(allowed.status).toBe(201);
    expect(await db.ingestionBatch.count()).toBe(1);
  });

  it("rejects authenticated cross-origin and origin-less uploads before writes", async () => {
    const db = getPrisma();
    const { project, session } = await sessionForEditor("origins");
    for (const origin of ["https://evil.test", null]) {
      const form = new FormData();
      form.set("projectId", project.id);
      form.append("file", new File(["x"], "a.md", { type: "text/markdown" }));
      const request = uploadRequest(form);
      if (origin === null) request.headers.delete("origin");
      else request.headers.set("origin", origin);

      const response = await uploadRoute(withSession(request, session));

      expect(response.status).toBe(403);
    }
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("fails explicitly when jobs are disabled before reading or writing", async () => {
    const db = getPrisma();
    const { project, session } = await sessionForEditor("jobs-disabled");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("the disabled upload body must not be read");
      },
    });
    const request = rawUploadRequest(
      body,
      "multipart/form-data; boundary=disabled",
    );

    const response = await uploadRoute(withSession(request, session));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "jobs are disabled" });
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it.each([
    ["Viewer", 403],
    ["outsider", 404],
    ["soft-deleted", 404],
  ] as const)(
    "rejects a %s before staging file bytes",
    async (kind, status) => {
      const db = getPrisma();
      const owner = await sessionForEditor(`access-owner-${kind}`);
      let session: string;
      if (kind === "Viewer") {
        const viewer = await sessionForRole("Viewer", `access-${kind}`);
        session = viewer.session;
        await addMembership(owner.project.id, viewer.user.id, "Viewer");
      } else if (kind === "soft-deleted") {
        session = owner.session;
        await db.project.update({
          where: { id: owner.project.id },
          data: { deletedAt: new Date() },
        });
      } else {
        ({ session } = await sessionForEditor(`access-${kind}`));
      }
      const form = new FormData();
      form.set("projectId", owner.project.id);
      form.append("file", new File(["x"], "a.md", { type: "text/markdown" }));

      const response = await uploadRoute(
        withSession(uploadRequest(form), session),
      );

      expect(response.status).toBe(status);
      expect(await db.ingestionBatch.count()).toBe(0);
      expect(await uploadEntries(owner.project.id)).toEqual([]);
    },
  );

  it("rejects a disallowed declared content type", async () => {
    const { project, session } = await sessionForEditor("declared-type");
    const form = new FormData();
    form.set("projectId", project.id);
    form.append(
      "file",
      new File(["MZ"], "tool.exe", { type: "application/x-msdownload" }),
    );

    const response = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(response.status).toBe(415);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("rejects bytes that contradict the declared type", async () => {
    const { project, session } = await sessionForEditor("sniffed-type");
    const form = new FormData();
    form.set("projectId", project.id);
    form.append(
      "file",
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        "fake.pdf",
        { type: "application/pdf" },
      ),
    );

    const response = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(response.status).toBe(415);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("accepts exactly the configured cap and rejects one byte more", async () => {
    const { project, session } = await sessionForEditor("file-cap");
    for (const [size, status] of [
      [1024, 201],
      [1025, 413],
    ] as const) {
      const form = new FormData();
      form.set("projectId", project.id);
      form.append(
        "file",
        new File(["x".repeat(size)], `${size}.md`, {
          type: "text/markdown",
        }),
      );

      const response = await uploadRoute(
        withSession(uploadRequest(form), session),
      );

      expect(response.status, `${size} bytes`).toBe(status);
    }
    expect(await getPrisma().ingestionBatch.count()).toBe(1);
  });

  it("rejects more than twenty files without creating a batch", async () => {
    const { project, session } = await sessionForEditor("file-count");
    const form = new FormData();
    form.set("projectId", project.id);
    for (let index = 0; index < 21; index += 1) {
      form.append(
        "file",
        new File(["x"], `${index}.md`, { type: "text/markdown" }),
      );
    }

    const response = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(response.status).toBe(413);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("accepts exactly twenty files together with projectId and label", async () => {
    const { project, session } = await sessionForEditor("file-count-boundary");
    const form = new FormData();
    form.set("projectId", project.id);
    form.set("label", "Twenty files");
    for (let index = 0; index < 20; index += 1) {
      form.append(
        "file",
        new File(["x"], `${index}.md`, { type: "text/markdown" }),
      );
    }

    const response = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { files: unknown[] };
    expect(body.files).toHaveLength(20);
  });

  it.each([
    [
      "file-before-project",
      [
        {
          name: "file",
          value: "x",
          fileName: "a.md",
          contentType: "text/markdown",
        },
        { name: "projectId", value: randomUUID() },
      ],
    ],
    [
      "duplicate-project",
      [
        { name: "projectId", value: randomUUID() },
        { name: "projectId", value: randomUUID() },
        {
          name: "file",
          value: "x",
          fileName: "a.md",
          contentType: "text/markdown",
        },
      ],
    ],
    [
      "duplicate-label",
      [
        { name: "projectId", value: randomUUID() },
        { name: "label", value: "one" },
        { name: "label", value: "two" },
        {
          name: "file",
          value: "x",
          fileName: "a.md",
          contentType: "text/markdown",
        },
      ],
    ],
    [
      "unknown-field",
      [
        { name: "projectId", value: randomUUID() },
        { name: "extra", value: "x" },
        {
          name: "file",
          value: "x",
          fileName: "a.md",
          contentType: "text/markdown",
        },
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, readonly MultipartPart[]]>)(
    "rejects malformed field layout: %s",
    async (name, parts) => {
      const { project, session } = await sessionForEditor(`fields-${name}`);
      const withProject = parts.map((part) =>
        part.name === "projectId" && !part.fileName
          ? { ...part, value: project.id }
          : part,
      );
      const boundary = `fields-${randomUUID()}`;
      const request = rawUploadRequest(
        multipartBody(boundary, withProject),
        `multipart/form-data; boundary=${boundary}`,
      );

      const response = await uploadRoute(withSession(request, session));

      expect(response.status).toBe(400);
      expect(await getPrisma().ingestionBatch.count()).toBe(0);
      expect(await uploadEntries(project.id)).toEqual([]);
    },
  );

  it("bounds the complete multipart request before parsing", async () => {
    const { session } = await sessionForEditor("request-budget");
    const request = rawUploadRequest(
      "x",
      "multipart/form-data; boundary=budget",
      { "content-length": "999999" },
    );

    const response = await uploadRoute(withSession(request, session));

    expect(response.status).toBe(413);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
  });

  it("cleans staging after an unterminated multipart body", async () => {
    const { project, session } = await sessionForEditor("malformed-body");
    const boundary = `malformed-${randomUUID()}`;
    const request = rawUploadRequest(
      multipartBody(
        boundary,
        [
          { name: "projectId", value: project.id },
          {
            name: "file",
            value: "partial",
            fileName: "partial.md",
            contentType: "text/markdown",
          },
        ],
        false,
      ),
      `multipart/form-data; boundary=${boundary}`,
    );

    const response = await uploadRoute(withSession(request, session));

    expect(response.status).toBe(400);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("settles and cleans staging when the request stream aborts", async () => {
    const { project, session } = await sessionForEditor("aborted-body");
    const boundary = `abort-${randomUUID()}`;
    const prefix = multipartBody(
      boundary,
      [
        { name: "projectId", value: project.id },
        {
          name: "file",
          value: "partial",
          fileName: "partial.md",
          contentType: "text/markdown",
        },
      ],
      false,
    );
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(Buffer.from(prefix));
        } else {
          controller.error(new Error("client aborted"));
        }
      },
    });
    const request = rawUploadRequest(
      body,
      `multipart/form-data; boundary=${boundary}`,
    );

    const response = await uploadRoute(withSession(request, session));

    expect(response.status).toBe(400);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("cancels a pending body read when the request signal aborts", async () => {
    const { project, session } = await sessionForEditor("aborted-signal");
    const boundary = `signal-${randomUUID()}`;
    const prefix = multipartBody(
      boundary,
      [
        { name: "projectId", value: project.id },
        {
          name: "file",
          value: "partial",
          fileName: "partial.md",
          contentType: "text/markdown",
        },
      ],
      false,
    );
    let pendingReadStarted!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      pendingReadStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(prefix));
      },
      pull() {
        pendingReadStarted();
        return new Promise<void>(() => undefined);
      },
    });
    const controller = new AbortController();
    const request = rawUploadRequest(
      body,
      `multipart/form-data; boundary=${boundary}`,
      {},
      controller.signal,
    );
    const requestBody = request.body!;
    Object.defineProperty(requestBody, Symbol.asyncIterator, {
      configurable: true,
      value: (): AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> => {
        const reader = requestBody.getReader();
        return {
          next: () => reader.read(),
          return: () =>
            new Promise<IteratorResult<Uint8Array>>(() => undefined),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    });
    const responsePending = uploadRoute(withSession(request, session));
    await pendingRead;
    let staged = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await uploadEntries(project.id)).length > 0) {
        staged = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(staged).toBe(true);

    controller.abort();
    const response = await Promise.race([
      responsePending,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1_000),
      ),
    ]);

    expect(response).not.toBe("timeout");
    expect((response as Response).status).toBe(400);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("does not create a partial batch when a later file fails validation", async () => {
    const { project, session } = await sessionForEditor("late-failure");
    const form = new FormData();
    form.set("projectId", project.id);
    form.append(
      "file",
      new File(["good"], "good.md", { type: "text/markdown" }),
    );
    form.append(
      "file",
      new File(["MZ"], "bad.exe", { type: "application/x-msdownload" }),
    );

    const response = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(response.status).toBe(415);
    expect(await getPrisma().ingestionBatch.count()).toBe(0);
    expect(await uploadEntries(project.id)).toEqual([]);
  });

  it("stores a batch, deduplicates blobs, and enqueues complete parse identities", async () => {
    const db = getPrisma();
    const { project, session } = await sessionForEditor("success");
    const form = new FormData();
    form.set("projectId", project.id.toUpperCase());
    form.set("label", " First import ");
    form.append(
      "file",
      new File(["# Hi\n"], "greeting.md", { type: "text/markdown" }),
    );
    form.append(
      "file",
      new File(["# Hi\n"], "copy.md", { type: "text/markdown" }),
    );

    const response = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      batchId: string;
      files: Array<{ id: string; fileName: string; status: string }>;
    };
    expect(body.files).toEqual([
      { id: expect.any(String), fileName: "greeting.md", status: "pending" },
      { id: expect.any(String), fileName: "copy.md", status: "pending" },
    ]);
    const batch = await db.ingestionBatch.findUniqueOrThrow({
      where: { id: body.batchId },
      include: { files: { orderBy: { createdAt: "asc" } } },
    });
    expect(batch).toMatchObject({
      projectId: project.id,
      label: "First import",
    });
    expect(batch.files.map((file) => file.byteSize)).toEqual([5, 5]);
    expect(new Set(batch.files.map((file) => file.contentDigest)).size).toBe(1);
    // Both files share a createdAt millisecond, so compare as a set.
    const byKey = (job: unknown) => JSON.stringify(job);
    expect(
      [...queue.jobs].sort((a, b) => byKey(a).localeCompare(byKey(b))),
    ).toEqual(
      batch.files
        .map((file) => ({
          name: "ingestion.parse",
          data: {
            fileId: file.id,
            projectId: project.id,
            contentDigest: file.contentDigest,
            baseAttemptCount: 0,
          },
        }))
        .sort((a, b) => byKey(a).localeCompare(byKey(b))),
    );
    const entries = await uploadEntries(project.id);
    expect(
      entries.filter((entry) => /^[0-9a-f]{64}$/.test(path.basename(entry))),
    ).toHaveLength(1);
    expect(entries.some((entry) => entry.includes("tmp/"))).toBe(false);
  });

  it("returns a recoverable batch identity when queue publication fails", async () => {
    const db = getPrisma();
    const { project, session } = await sessionForEditor("queue-failure");
    const failingQueue: JobQueue = {
      send: async () => {
        throw new Error("queue unavailable");
      },
      work: async () => undefined,
      schedule: async () => undefined,
      stop: async () => undefined,
    };
    setJobQueueForTests(failingQueue);
    const form = new FormData();
    form.set("projectId", project.id);
    form.append("file", new File(["x"], "a.md", { type: "text/markdown" }));

    const response = await uploadRoute(
      withSession(uploadRequest(form), session),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; batchId: string };
    expect(body).toMatchObject({
      error: "files stored but parse job publication failed",
      batchId: expect.any(String),
    });
    expect(
      await db.ingestionBatch.findUnique({ where: { id: body.batchId } }),
    ).not.toBeNull();
    expect(
      await db.ingestionFile.count({ where: { batchId: body.batchId } }),
    ).toBe(1);
  });
});

describe("ingestion reconciliation", () => {
  const old = () => new Date(Date.now() - 120 * 60_000);
  const options = { ttlMinutes: 60 };

  it("preserves a live parser claim when temporary-file cleanup uses a short TTL", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("short-cleanup-live-parse");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const claim = await claimFileForParsing(db, fixture.fileId);
    const startedAt = new Date(Date.now() - 20 * 60_000);
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { parseStartedAt: startedAt, updatedAt: startedAt },
    });
    await registerKnowledgeJobHandlers({
      queue,
      db,
      context: knowledgeSystemContextForTests(),
      dataDir: await temporaryDataDir(),
      config: parseKnowledgeConfig({ WEAVER_INGESTION_TMP_TTL_MINUTES: "5" }),
      routing: noKnowledgeRouting,
      roles: new Set(["ingestion"]),
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });

    await queue.run("system.reconcile", {});

    expect(queue.jobs.filter((job) => job.name === "ingestion.parse")).toEqual(
      [],
    );
    expect(
      await completeParse(db, {
        fileId: fixture.fileId,
        attemptCount: claim!.attemptCount,
        parserAdapterId: "native",
        parserVersion: "1",
        proposedTitle: "Completed scan",
        warnings: [],
        draft: { targetKind: "document", markdown: "Preserved OCR output" },
      }),
    ).toBe(true);
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
      }),
    ).toMatchObject({
      status: "extracting",
      attemptCount: claim!.attemptCount,
    });
  });

  it("sweeps stale tmp and old orphan blobs, preserving fresh and referenced bytes", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("sweep-storage");
    const dataDir = await temporaryDataDir();
    const stale = await stageUpload(dataDir, fixture.project.id, "stale");
    const fresh = await stageUpload(dataDir, fixture.project.id, "fresh");
    const orphan = await writeBlob(dataDir, fixture.project.id, "orphan");
    const recent = await writeBlob(dataDir, fixture.project.id, "recent");
    const live = await writeBlob(dataDir, fixture.project.id, "live");
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { contentDigest: live.digest },
    });
    for (const target of [
      tmpPath(dataDir, fixture.project.id, stale.uploadId),
      orphan.target,
      live.target,
    ]) {
      await utimes(target, old(), old());
    }
    expect(await sweepAbandonedUploads(db, { dataDir, ...options })).toEqual({
      projects: 1,
      removed: 2,
    });
    await expect(stat(orphan.target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(tmpPath(dataDir, fixture.project.id, stale.uploadId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const target of [
      recent.target,
      live.target,
      tmpPath(dataDir, fixture.project.id, fresh.uploadId),
    ])
      await expect(stat(target)).resolves.toBeTruthy();
  });

  it.each(["hard", "soft"] as const)(
    "ingestion review: reclaims aged storage from %s-deleted projects",
    async (deletion) => {
      const db = getPrisma();
      const fixture = await makeBatchFile(`sweep-${deletion}-old`);
      const dataDir = await temporaryDataDir();
      const blob = await writeBlob(dataDir, fixture.project.id, "old");
      await utimes(blob.target, old(), old());
      if (deletion === "hard")
        await db.project.delete({ where: { id: fixture.project.id } });
      else
        await db.project.update({
          where: { id: fixture.project.id },
          data: { deletedAt: new Date(Date.now() - 8 * 86400000) },
        });
      expect(
        await sweepAbandonedUploads(db, { dataDir, ...options }),
      ).toMatchObject({ removed: 1 });
      await expect(stat(blob.target)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("skips soft-deleted projects for storage and recovery", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("sweep-deleted");
    const dataDir = await temporaryDataDir();
    const blob = await writeBlob(dataDir, fixture.project.id, "old");
    await utimes(blob.target, old(), old());
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { updatedAt: old() },
    });
    await db.project.update({
      where: { id: fixture.project.id },
      data: { deletedAt: new Date() },
    });
    expect(await sweepAbandonedUploads(db, { dataDir, ...options })).toEqual({
      projects: 0,
      removed: 0,
    });
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 0 });
    await expect(stat(blob.target)).resolves.toBeTruthy();
  });

  it.each(["reference", "age", "deleted"] as const)(
    "rechecks %s after waiting for the project lifecycle lock",
    async (change) => {
      const db = getPrisma();
      const fixture = await makeBatchFile(`sweep-race-${change}`);
      const dataDir = await temporaryDataDir();
      const blob = await writeBlob(dataDir, fixture.project.id, "racing");
      await utimes(blob.target, old(), old());
      let sweep!: ReturnType<typeof sweepAbandonedUploads>;
      await withProjectIngestionLifecycleLock(
        db,
        fixture.project.id,
        async (tx) => {
          sweep = sweepAbandonedUploads(db, { dataDir, ...options });
          await waitForAdvisoryWaiter();
          if (change === "reference")
            await tx.ingestionFile.update({
              where: { id: fixture.fileId },
              data: { contentDigest: blob.digest },
            });
          if (change === "age")
            await utimes(blob.target, new Date(), new Date());
          if (change === "deleted")
            await tx.project.update({
              where: { id: fixture.project.id },
              data: { deletedAt: new Date() },
            });
        },
      );
      expect(await sweep).toMatchObject({ removed: 0 });
      await expect(stat(blob.target)).resolves.toBeTruthy();
    },
  );

  it("propagates unexpected filesystem errors", async () => {
    const fixture = await makeBatchFile("sweep-io");
    const dataDir = await temporaryDataDir();
    await mkdir(path.join(dataDir, "files"));
    await writeFile(path.join(dataDir, "files", fixture.project.id), "blocked");
    await expect(
      sweepAbandonedUploads(getPrisma(), { dataDir, ...options }),
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: "ENOTDIR" })],
    });
  });

  it("republishes a pending publication gap with full identity and throttles concurrent reconciliation", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recovery-pending");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { updatedAt: old() },
    });
    const results = await Promise.all([
      reconcileIngestionFiles(db),
      reconcileIngestionFiles(db),
    ]);
    expect(results.reduce((sum, result) => sum + result.enqueued, 0)).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      name: "ingestion.parse",
      data: {
        fileId: fixture.fileId,
        projectId: fixture.project.id,
        contentDigest: DIGEST,
        baseAttemptCount: 0,
      },
    });
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 0 });
  });

  it("recovers stalled parsing and fences old completions before and after the new claim", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recovery-parsing");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const claim = await claimFileForParsing(db, fixture.fileId, {
      baseAttemptCount: 0,
      delivery: { jobId: "old", retryCount: 0 },
    });
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { updatedAt: old(), parseStartedAt: old() },
    });
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 1 });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
      }),
    ).toMatchObject({
      status: "pending",
      attemptCount: 1,
      parseStartedAt: null,
      parseEndedAt: null,
      stageClaimJobId: null,
      stageClaimRetryCount: null,
    });
    const completion = {
      fileId: fixture.fileId,
      attemptCount: claim!.attemptCount,
      parserAdapterId: "stub",
      parserVersion: "1",
      proposedTitle: "Old",
      draft: { targetKind: "document" as const, markdown: "Old" },
      warnings: [],
    };
    expect(await completeParse(db, completion)).toBe(false);
    expect(queue.jobs[0]).toMatchObject({ data: { baseAttemptCount: 1 } });
    expect(
      await claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: 1,
        delivery: { jobId: "new", retryCount: 0 },
      }),
    ).toMatchObject({ attemptCount: 2 });
    expect(await completeParse(db, completion)).toBe(false);
    expect(
      await failFile(db, {
        fileId: fixture.fileId,
        attemptCount: 1,
        failureKind: "parser",
        message: "old",
      }),
    ).toBe(false);
  });

  it("republishes a stalled analysis stage and republishes the right job", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recover-stages");
    const parse = await claimFileForParsing(db, fixture.fileId);
    await completeParse(db, {
      fileId: fixture.fileId,
      attemptCount: parse!.attemptCount,
      parserAdapterId: "native",
      parserVersion: "1",
      proposedTitle: "Stalled",
      warnings: [],
      draft: { targetKind: "document", markdown: "x" },
    });
    await claimFileForAnalysis(db, fixture.fileId, {
      delivery: { jobId: "dead-job", retryCount: 0 },
    });
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: { updatedAt: old(), analyzeStartedAt: old() },
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 1 });
    expect(queue.jobs).toEqual([
      {
        name: "ingestion.analyze",
        data: {
          fileId: fixture.fileId,
          projectId: fixture.project.id,
          contentDigest: DIGEST,
          baseAttemptCount: 2,
        },
      },
    ]);
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
      }),
    ).toMatchObject({
      status: "extracting",
      analyzeStartedAt: null,
      stageClaimJobId: null,
    });
    expect(
      await claimFileForAnalysis(db, fixture.fileId, { baseAttemptCount: 2 }),
    ).not.toBeNull();
  });

  it.each(["analyze", "link"] as const)(
    "revokes stale %s writes immediately when recovery reserves the stage",
    async (stage) => {
      const db = getPrisma();
      for (const staleWrite of ["complete", "fail"] as const) {
        const fixture = await makeBatchFile(`revoke-${stage}-${staleWrite}`);
        const parse = await claimFileForParsing(db, fixture.fileId);
        await completeParse(db, {
          fileId: fixture.fileId,
          attemptCount: parse!.attemptCount,
          parserAdapterId: "native",
          parserVersion: "1",
          proposedTitle: "Before",
          warnings: [],
          draft: { targetKind: "document", markdown: "x" },
        });
        if (stage === "link") {
          const analysis = await claimFileForAnalysis(db, fixture.fileId);
          await completeAnalysis(db, {
            fileId: fixture.fileId,
            attemptCount: analysis!.attemptCount,
            proposedTitle: "Before",
            proposedFolderPath: "",
            linkQueries: [],
            warnings: [],
          });
        }
        const claim =
          stage === "analyze"
            ? await claimFileForAnalysis(db, fixture.fileId)
            : await claimFileForLinking(db, fixture.fileId);
        await db.ingestionFile.update({
          where: { id: fixture.fileId },
          data: {
            updatedAt: old(),
            ...(stage === "analyze"
              ? { analyzeStartedAt: old() }
              : { linkStartedAt: old() }),
          },
        });
        const [snapshot] = await listStaleIngestionFiles(
          db,
          new Date(Date.now() - 60 * 60_000),
        );
        expect(snapshot?.id).toBe(fixture.fileId);
        expect(await reserveIngestionFileRecovery(db, snapshot!)).toBe(true);

        if (stage === "analyze") {
          expect(
            await recordParseAttemptDetails(db, {
              fileId: fixture.fileId,
              attemptCount: claim!.attemptCount,
              status: "extracting",
              routeSnapshot: { providerModelId: "stale" },
            }),
          ).toBe(false);
        }
        if (staleWrite === "complete") {
          expect(
            stage === "analyze"
              ? await completeAnalysis(db, {
                  fileId: fixture.fileId,
                  attemptCount: claim!.attemptCount,
                  proposedTitle: "Stale",
                  proposedFolderPath: "",
                  linkQueries: [],
                  warnings: [],
                })
              : await completeLinking(db, {
                  fileId: fixture.fileId,
                  attemptCount: claim!.attemptCount,
                  links: [],
                }),
          ).toBe(false);
        } else {
          expect(
            await failFile(db, {
              fileId: fixture.fileId,
              attemptCount: claim!.attemptCount,
              fromStatus: stage === "analyze" ? "extracting" : "linking",
              failureKind: "provider",
              message: "stale",
            }),
          ).toBe(false);
        }

        const replacement =
          stage === "analyze"
            ? await claimFileForAnalysis(db, fixture.fileId, {
                baseAttemptCount: claim!.attemptCount,
              })
            : await claimFileForLinking(db, fixture.fileId, {
                baseAttemptCount: claim!.attemptCount,
              });
        expect(replacement).not.toBeNull();
        expect(
          stage === "analyze"
            ? await completeAnalysis(db, {
                fileId: fixture.fileId,
                attemptCount: replacement!.attemptCount,
                proposedTitle: "Replacement",
                proposedFolderPath: "",
                linkQueries: [],
                warnings: [],
              })
            : await completeLinking(db, {
                fileId: fixture.fileId,
                attemptCount: replacement!.attemptCount,
                links: [],
              }),
        ).toBe(true);
      }
    },
  );

  it.each(["extracting", "linking"] as const)(
    "exhausts queued %s and retries only that stage",
    async (status) => {
      const db = getPrisma();
      const fixture = await makeBatchFile(`recover-queued-${status}`);
      const parse = await claimFileForParsing(db, fixture.fileId);
      await completeParse(db, {
        fileId: fixture.fileId,
        attemptCount: parse!.attemptCount,
        parserAdapterId: "native",
        parserVersion: "1",
        proposedTitle: "Queued",
        warnings: [],
        draft: { targetKind: "document", markdown: "x" },
      });
      if (status === "linking") {
        const analysis = await claimFileForAnalysis(db, fixture.fileId);
        await completeAnalysis(db, {
          fileId: fixture.fileId,
          attemptCount: analysis!.attemptCount,
          proposedTitle: "Queued",
          proposedFolderPath: "",
          linkQueries: [],
          warnings: [],
        });
      }
      await db.ingestionFile.update({
        where: { id: fixture.fileId },
        data: {
          attemptCount: MAX_INGESTION_ATTEMPTS,
          updatedAt: old(),
        },
      });
      const recoveryQueue = new FakeJobQueue();
      setJobQueueForTests(recoveryQueue);
      expect(await reconcileIngestionFiles(db)).toEqual({
        enqueued: 0,
      });
      expect(
        await db.ingestionFile.findUniqueOrThrow({
          where: { id: fixture.fileId },
        }),
      ).toMatchObject({
        status: "failed",
        failureMessage: INGESTION_EXHAUSTED_MESSAGE,
        ...(status === "extracting"
          ? { analyzeEndedAt: expect.any(Date) }
          : { linkEndedAt: expect.any(Date) }),
      });
      const retried = await retryFile(db, fixture.actor, {
        fileId: fixture.fileId,
      });
      expect(retried.stage).toBe(status === "extracting" ? "analyze" : "link");
      expect(
        await db.ingestionFile.findUniqueOrThrow({
          where: { id: fixture.fileId },
        }),
      ).toMatchObject({
        status,
        ...(status === "extracting"
          ? { analyzeStartedAt: null, analyzeEndedAt: null }
          : { linkStartedAt: null, linkEndedAt: null }),
      });
    },
  );

  it("ends a file that exhausted its cumulative attempts in any stage", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recover-exhausted-stage");
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: {
        status: "linking",
        linkStartedAt: old(),
        updatedAt: old(),
        attemptCount: MAX_INGESTION_ATTEMPTS,
      },
    });
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 0 });
    expect(
      await getFile(db, fixture.actor, { fileId: fixture.fileId }),
    ).toMatchObject({
      status: "failed",
      failureKind: "internal",
      failureMessage: INGESTION_EXHAUSTED_MESSAGE,
    });
  });

  it(
    "lets a newer real pg-boss analysis delivery reclaim a crashed claim",
    { timeout: 30_000 },
    async () => {
      const db = getPrisma();
      const fixture = await makeBatchFile("real-analysis-retry");
      const parse = await claimFileForParsing(db, fixture.fileId);
      await completeParse(db, {
        fileId: fixture.fileId,
        attemptCount: parse!.attemptCount,
        parserAdapterId: "native",
        parserVersion: "1",
        proposedTitle: "Retry",
        warnings: [],
        draft: { targetKind: "document", markdown: "x" },
      });
      const queue = new PgBossQueue<
        Pick<KnowledgeJobPayloads, "ingestion.analyze">
      >({
        connectionString: process.env.DATABASE_URL!,
        queueNames: ["ingestion.analyze"],
        workerConcurrency: 1,
      });
      const deliveries: number[] = [];
      try {
        await queue.start();
        await queue.work("ingestion.analyze", async (payload, execution) => {
          deliveries.push(execution.retryCount ?? -1);
          if (!execution.jobId)
            throw new Error("pg-boss delivery has no job ID");
          const claim = await claimFileForAnalysis(db, payload.fileId, {
            expectedProjectId: payload.projectId,
            expectedContentDigest: payload.contentDigest,
            baseAttemptCount: payload.baseAttemptCount,
            delivery: {
              jobId: execution.jobId,
              retryCount: execution.retryCount ?? 0,
            },
          });
          if (execution.retryCount === 0)
            throw new Error("simulated worker loss");
          if (!claim) return;
          await completeAnalysis(db, {
            fileId: payload.fileId,
            attemptCount: claim.attemptCount,
            proposedTitle: "Recovered",
            proposedFolderPath: "",
            linkQueries: [],
            warnings: [],
          });
        });
        await queue.send("ingestion.analyze", {
          fileId: fixture.fileId,
          projectId: fixture.project.id,
          contentDigest: DIGEST,
          baseAttemptCount: 1,
        });
        await vi.waitFor(
          async () => {
            expect(
              await db.ingestionFile.findUniqueOrThrow({
                where: { id: fixture.fileId },
              }),
            ).toMatchObject({ status: "linking", attemptCount: 3 });
          },
          { timeout: 20_000, interval: 250 },
        );
        expect(deliveries).toEqual([0, 1]);
      } finally {
        await queue.stop();
      }
    },
  );

  it("does not publish fresh pending, active parsing, or terminal work", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recovery-active");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    for (const status of [
      "pending",
      "parsing",
      "ready",
      "failed",
      "blocked_configuration",
      "accepted",
      "rejected",
    ] as const) {
      await db.ingestionFile.update({
        where: { id: fixture.fileId },
        data: {
          status,
          updatedAt: status === "pending" ? new Date() : old(),
          parseStartedAt: new Date(),
        },
      });
      expect(await reconcileIngestionFiles(db)).toEqual({
        enqueued: 0,
      });
    }
    expect(queue.jobs).toHaveLength(0);
  });

  it.each(["newer delivery", "manual retry"] as const)(
    "a concurrent %s defeats the recovery snapshot",
    async (change) => {
      const db = getPrisma();
      const fixture = await makeBatchFile(
        `recovery-cas-${change.replaceAll(" ", "-")}`,
      );
      const queue = new FakeJobQueue();
      setJobQueueForTests(queue);
      await claimFileForParsing(db, fixture.fileId, {
        baseAttemptCount: 0,
        delivery: { jobId: "delivery", retryCount: 0 },
      });
      await db.ingestionFile.update({
        where: { id: fixture.fileId },
        data: { updatedAt: old(), parseStartedAt: old() },
      });
      const [snapshot] = await listStaleIngestionFiles(
        db,
        new Date(Date.now() - 60 * 60_000),
      );
      expect(snapshot).toBeDefined();
      if (change === "newer delivery") {
        await claimFileForParsing(db, fixture.fileId, {
          baseAttemptCount: 0,
          delivery: { jobId: "delivery", retryCount: 1 },
        });
      } else {
        await failFile(db, {
          fileId: fixture.fileId,
          attemptCount: 1,
          failureKind: "parser",
          message: "retry",
        });
        await retryFile(db, fixture.actor, { fileId: fixture.fileId });
      }
      expect(await reserveIngestionFileRecovery(db, snapshot!)).toBe(false);
      expect(await reconcileIngestionFiles(db)).toEqual({
        enqueued: 0,
      });
      expect(queue.jobs).toHaveLength(0);
      expect(
        await db.ingestionFile.findUniqueOrThrow({
          where: { id: fixture.fileId },
        }),
      ).toMatchObject(
        change === "newer delivery"
          ? { status: "parsing", attemptCount: 2, stageClaimRetryCount: 1 }
          : { status: "pending", attemptCount: 1 },
      );
    },
  );

  it.each([0, 1] as const)(
    "gives up on a file %s attempts past the cap instead of republishing it forever",
    async (over) => {
      const db = getPrisma();
      const fixture = await makeBatchFile(`recovery-exhausted-${over}`);
      const queue = new FakeJobQueue();
      setJobQueueForTests(queue);
      await db.ingestionFile.update({
        where: { id: fixture.fileId },
        data: {
          status: "parsing",
          attemptCount: MAX_INGESTION_ATTEMPTS + over,
          updatedAt: old(),
          parseStartedAt: old(),
          stageClaimJobId: "delivery",
          stageClaimRetryCount: 5,
        },
      });
      expect(await reconcileIngestionFiles(db)).toEqual({
        enqueued: 0,
      });
      expect(queue.jobs).toHaveLength(0);
      expect(
        await db.ingestionFile.findUniqueOrThrow({
          where: { id: fixture.fileId },
        }),
      ).toMatchObject({
        status: "failed",
        failureKind: "internal",
        failureMessage: INGESTION_EXHAUSTED_MESSAGE,
        attemptCount: MAX_INGESTION_ATTEMPTS + over,
      });
      // Terminal: the next pass has nothing left to publish or fail.
      expect(await reconcileIngestionFiles(db)).toEqual({
        enqueued: 0,
      });
      expect(queue.jobs).toHaveLength(0);
    },
  );

  it("still republishes a stalled file one attempt below the cap", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recovery-under-cap");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await db.ingestionFile.update({
      where: { id: fixture.fileId },
      data: {
        status: "parsing",
        attemptCount: MAX_INGESTION_ATTEMPTS - 1,
        updatedAt: old(),
        parseStartedAt: old(),
      },
    });
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 1 });
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: fixture.fileId },
      }),
    ).toMatchObject({
      status: "pending",
      attemptCount: MAX_INGESTION_ATTEMPTS - 1,
    });
  });

  it("bounds recovery to 100 files per pass", async () => {
    const db = getPrisma();
    const fixture = await makeBatchFile("recovery-bounded");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await db.ingestionFile.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        batchId: fixture.batchId,
        projectId: fixture.project.id,
        fileName: `extra-${i}.md`,
        mimeType: "text/markdown",
        byteSize: 1,
        contentDigest: DIGEST,
        updatedAt: old(),
      })),
    });
    expect(await reconcileIngestionFiles(db)).toEqual({
      enqueued: 100,
    });
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 1 });
    expect(await reconcileIngestionFiles(db)).toEqual({ enqueued: 0 });
  });

  it.each(["throw", "null"] as const)(
    "keeps failed %s publication recoverable after the cooldown",
    async (failure) => {
      const db = getPrisma();
      const fixture = await makeBatchFile(`recovery-failure-${failure}`);
      const queue = new FakeJobQueue();
      setJobQueueForTests(queue);
      const send = vi.spyOn(queue, "send");
      if (failure === "throw")
        send.mockRejectedValueOnce(new Error("queue offline"));
      else send.mockResolvedValueOnce(null);
      await db.ingestionFile.update({
        where: { id: fixture.fileId },
        data: { updatedAt: old() },
      });
      await expect(reconcileIngestionFiles(db)).rejects.toThrow();
      expect(
        await db.ingestionFile.findUniqueOrThrow({
          where: { id: fixture.fileId },
        }),
      ).toMatchObject({ status: "pending", attemptCount: 0 });
      expect(await reconcileIngestionFiles(db)).toEqual({
        enqueued: 0,
      });
      await db.ingestionFile.update({
        where: { id: fixture.fileId },
        data: { updatedAt: old() },
      });
      expect(await reconcileIngestionFiles(db)).toEqual({
        enqueued: 1,
      });
    },
  );
});

describe("ingestion settings", () => {
  it("lets an Admin configure Docling and hides the surface from Editors", async () => {
    const admin = await makeUser("Admin");
    const editor = await makeUser("User");
    const adminCaller = callerFor(admin);
    expect(await adminCaller.ingestionAdmin.getSettings()).toEqual({
      doclingBaseUrl: null,
      doclingTimeoutMs: 120_000,
    });
    expect(
      await adminCaller.ingestionAdmin.setSettings({
        doclingBaseUrl: "http://docling.test:5001",
      }),
    ).toEqual({
      doclingBaseUrl: "http://docling.test:5001",
      doclingTimeoutMs: 120_000,
    });
    expect(
      (await adminCaller.ingestionAdmin.getSettings()).doclingBaseUrl,
    ).toBe("http://docling.test:5001");
    await expect(
      adminCaller.ingestionAdmin.setSettings({ doclingBaseUrl: "ftp://x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      callerFor(editor).ingestionAdmin.getSettings(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("probes docling-serve health through the injected fetch", async () => {
    const admin = await makeUser("Admin");
    const calls: string[] = [];
    const llmFetch: typeof fetch = async (input) => {
      calls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Response.json({ status: "ok" });
    };
    const caller = callerFor(admin, { llmFetch });
    expect(
      await caller.ingestionAdmin.probeDocling({
        baseUrl: "http://docling.test:5001",
      }),
    ).toMatchObject({ ok: true, message: "docling-serve is reachable" });
    expect(calls).toEqual(["http://docling.test:5001/health"]);
    const down = callerFor(admin, {
      llmFetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(
      await down.ingestionAdmin.probeDocling({
        baseUrl: "http://docling.test",
      }),
    ).toMatchObject({ ok: false, message: "docling-serve is not reachable" });
  });
});

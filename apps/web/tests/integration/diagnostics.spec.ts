import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyIssuer,
  createBearerVerifiers,
  createPasswordChanger,
  createUserAdministrator,
} from "@weaver/auth";
import {
  adminProcedure,
  createCallerFactory,
  createTRPCRouter,
} from "~/server/api/trpc";
import {
  emitDiagnostic,
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
} from "@weaver/core/diagnostics/writer";
import { OutboundPolicyError } from "@weaver/config/outboundFetch";
import {
  createAdapterForSnapshot,
  createDbCredentialSource,
} from "@weaver/core/ai/registry";
import { AiProviderError, type AiProvider } from "@weaver/core/ai/types";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { resolveBearerSecurityContext } from "@weaver/core/security/bearer";
import {
  invalidateDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import {
  getDiagnosticEvent,
  listDiagnosticEvents,
  pruneDiagnosticEvents,
} from "@weaver/core/services/diagnosticEvents";
import { createDocument } from "@weaver/core/services/documents";
import { syncDocumentKeywordIndex } from "@weaver/core/services/keywordIndex";
import {
  activateCompletedGeneration,
  processGenerationDocument,
} from "@weaver/core/services/knowledgeGenerations";
import { reconcileProjectKnowledge } from "@weaver/core/services/knowledgeReconciliation";
import { resolveKnowledgeRouting } from "@weaver/core/services/llmRoutes";
import { searchKnowledge } from "@weaver/core/services/search";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  noKnowledgeRouting,
  resetDb,
  seedTestLlmRouting,
  securityContextFor,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  testAuth,
  testEncryptionKeys,
} from "./_harness";

async function makeDiagnosticGeneration(suffix: string, fingerprint: string) {
  const db = getPrisma();
  const admin = await makeUser("Admin", suffix);
  await setDiagnosticsSettings(db, securityContextFor(admin), {
    level: "standard",
  });
  const project = await makeProject(`Diagnostic generation ${suffix}`);
  await addMembership(project.id, admin.id, "Editor");
  const document = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: `Diagnostic generation ${suffix}`,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("# Diagnostic source\n\nSafe text.\n"),
      },
    },
    { ...securityContextFor(admin), name: "Admin", email: admin.email },
  );
  const context = knowledgeSystemContextForTests();
  await syncDocumentKeywordIndex(context, db, {
    projectId: project.id,
    documentId: document.id,
    sourceCommitSha: document.headCommitSha,
    pathAtSha: document.path,
  });
  const configFingerprint = fingerprint.repeat(64);
  const generation = await db.knowledgeGeneration.create({
    data: {
      projectId: project.id,
      configFingerprint,
      embeddingModel: "diagnostic-embedding",
      embeddingDimensions: 1536,
      extractionSchemaVersion: 1,
      promptVersion: "prompt-v1",
      status: "building",
    },
  });
  await db.knowledgeGenerationDocument.create({
    data: {
      generationId: generation.id,
      documentId: document.id,
      projectId: project.id,
      targetSha: document.headCommitSha,
      configFingerprint,
      status: "pending",
    },
  });
  return {
    db,
    context,
    project,
    document,
    generation,
    input: {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      configFingerprint,
      providerName: "diagnostic-provider",
      embeddingConnectionId: "11111111-1111-4111-8111-111111111111",
      embeddingModel: "diagnostic-embedding",
      embeddingDimensions: 1536 as const,
      inputCostMicrosPerMillion: null,
      outputCostMicrosPerMillion: null,
      currency: null,
      extractionModel: "diagnostic-extraction",
      extractionFingerprint: "test-extraction-fingerprint",
      extractionProviderName: "diagnostic-provider",
      extractionConnectionId: "22222222-2222-4222-8222-222222222222",
      extractionInputCostMicrosPerMillion: null,
      extractionOutputCostMicrosPerMillion: null,
      extractionCurrency: null,
    },
  };
}

function successfulDiagnosticProvider(): AiProvider {
  return {
    embeddingRequestByteLength: (values) =>
      Buffer.byteLength(JSON.stringify({ values }), "utf8"),
    async embed(values) {
      return {
        vectors: values.map(() => Array(1536).fill(0.25) as number[]),
        usage: {
          inputTokens: values.length,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: values.length,
          durationMs: 1,
        },
      };
    },
    async extract() {
      return {
        data: { entities: [], relations: [] },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          totalTokens: 2,
          durationMs: 1,
        },
      };
    },
  };
}

describe("diagnostic persistence", () => {
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
    invalidateDiagnosticsSettingsCache();
    startDiagnosticWriter({
      db: getPrisma(),
      runtime: "worker",
      flushIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    await stopDiagnosticWriter();
    setJobQueueForTests(null);
    invalidateDiagnosticsSettingsCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("requires the process to provide diagnostic event timestamps", async () => {
    const [column] = await getPrisma().$queryRaw<
      Array<{ columnDefault: string | null }>
    >`
      SELECT column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'DiagnosticEvent'
        AND column_name = 'createdAt'
    `;

    expect(column?.columnDefault).toBeNull();
  });

  it("persists and retrieves settings and diagnostic events without foreign-key rows", async () => {
    const db = getPrisma();
    const createdAt = new Date("2026-09-04T19:00:00.000Z");

    await db.systemSetting.create({
      data: {
        key: "diagnostics.retention",
        value: { days: 30 },
      },
    });
    const event = await db.diagnosticEvent.create({
      data: {
        createdAt,
        runtime: "mcp",
        severity: "warn",
        category: "request",
        event: "request.completed",
        message: "MCP request completed with warnings",
        requestId: "request-1",
        runId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        details: { retries: 1 },
      },
    });

    await expect(
      db.systemSetting.findUnique({
        where: { key: "diagnostics.retention" },
      }),
    ).resolves.toMatchObject({ value: { days: 30 } });
    await expect(
      db.diagnosticEvent.findUnique({ where: { id: event.id } }),
    ).resolves.toMatchObject({
      runtime: "mcp",
      severity: "warn",
      createdAt,
      requestId: "request-1",
      runId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      details: { retries: 1 },
    });
  });

  it("serializes concurrent partial settings patches without losing either field", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "diag-concurrent-settings");
    const actor = securityContextFor(admin);
    const initial = await setDiagnosticsSettings(db, actor, {
      level: "verbose",
      retentionDays: 7,
    });
    expect(initial).toMatchObject({ level: "verbose", retentionDays: 7 });

    const originalFindUnique = db.systemSetting.findUnique.bind(
      db.systemSetting,
    );
    let reads = 0;
    let releaseReads!: () => void;
    const bothReadsFinished = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    vi.spyOn(db.systemSetting, "findUnique").mockImplementation((async (
      args,
    ) => {
      const row = await originalFindUnique(args);
      reads += 1;
      if (reads === 2) releaseReads();
      await bothReadsFinished;
      return row;
    }) as typeof db.systemSetting.findUnique);

    const [levelResult, retentionResult] = await Promise.all([
      setDiagnosticsSettings(db, actor, { level: "off" }),
      setDiagnosticsSettings(db, actor, { retentionDays: 3 }),
    ]);

    const stored = await db.systemSetting.findUniqueOrThrow({
      where: { key: "diagnostics" },
      select: { value: true },
    });
    const final = {
      level: "off",
      retentionDays: 3,
      verboseRetentionHours: 24,
      maxRows: 1_000_000,
    };
    expect(stored.value).toEqual(final);
    expect(levelResult).toMatchObject({ level: "off" });
    expect(retentionResult).toMatchObject({ retentionDays: 3 });
    expect(
      [levelResult, retentionResult].filter(
        (result) => JSON.stringify(result) === JSON.stringify(final),
      ),
    ).toHaveLength(1);
  });

  it("logs a job run with its correlation ids at level standard", async () => {
    const admin = await makeUser("Admin", "diag-jobs");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "standard",
    });
    const project = await makeProject("Diag jobs");
    await addMembership(project.id, admin.id, "Editor");
    const document = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Diag",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("# Diag\n\nHello.\n"),
        },
      },
      { ...securityContextFor(admin), name: "Admin", email: admin.email },
    );
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db: getPrisma(),
      config: parseKnowledgeConfig(process.env),
      routing: noKnowledgeRouting,
    });

    await queue.run("document.search-sync", {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    await flushDiagnostics();

    const rows = await getPrisma().diagnosticEvent.findMany({
      where: { category: "job" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((row) => row.event)).toEqual([
      "job.started",
      "job.completed",
    ]);
    expect(rows[0]).toMatchObject({
      runtime: "worker",
      jobId: "fake-run-1",
      projectId: project.id,
      documentId: document.id,
      details: { job: "document.search-sync", retryCount: 0 },
    });
    expect(rows[1]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[1]!.outcome).toBe("ok");
  });

  it("logs document attempt and chunk metadata without document content", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "diag-knowledge-document");
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "standard",
    });
    const project = await makeProject("Diag knowledge document");
    await addMembership(project.id, admin.id, "Editor");
    const document = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Diagnostic source",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(
            "# Diagnostic source\n\nPrivate document marker MUST_NOT_BE_LOGGED.\n",
          ),
        },
      },
      { ...securityContextFor(admin), name: "Admin", email: admin.email },
    );
    const context = knowledgeSystemContextForTests();
    await syncDocumentKeywordIndex(context, db, {
      projectId: project.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
    });
    const configFingerprint = "c".repeat(64);
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint,
        embeddingModel: "diagnostic-embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "building",
      },
    });
    await db.knowledgeGenerationDocument.create({
      data: {
        generationId: generation.id,
        documentId: document.id,
        projectId: project.id,
        targetSha: document.headCommitSha,
        configFingerprint,
        status: "pending",
      },
    });
    let failFirstEmbedding = true;
    const provider: AiProvider = {
      embeddingRequestByteLength: (values) =>
        Buffer.byteLength(JSON.stringify({ values }), "utf8"),
      async embed(values) {
        if (failFirstEmbedding) {
          failFirstEmbedding = false;
          throw new AiProviderError("provider unavailable", {
            kind: "provider",
            retryable: true,
          });
        }
        return {
          vectors: values.map(() => Array(1536).fill(0.25) as number[]),
          usage: {
            inputTokens: values.length,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: values.length,
            durationMs: 1,
          },
        };
      },
      async extract() {
        return {
          data: { entities: [], relations: [] },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            totalTokens: 2,
            durationMs: 1,
          },
        };
      },
    };
    const input = {
      projectId: project.id,
      generationId: generation.id,
      documentId: document.id,
      sourceCommitSha: document.headCommitSha,
      pathAtSha: document.path,
      configFingerprint,
      providerName: "diagnostic-provider",
      embeddingConnectionId: "11111111-1111-4111-8111-111111111111",
      embeddingModel: "diagnostic-embedding",
      embeddingDimensions: 1536 as const,
      inputCostMicrosPerMillion: null,
      outputCostMicrosPerMillion: null,
      currency: null,
      extractionModel: "diagnostic-extraction",
      extractionFingerprint: "test-extraction-fingerprint",
      extractionProviderName: "diagnostic-provider",
      extractionConnectionId: "22222222-2222-4222-8222-222222222222",
      extractionInputCostMicrosPerMillion: null,
      extractionOutputCostMicrosPerMillion: null,
      extractionCurrency: null,
    };

    await expect(
      processGenerationDocument(context, db, provider, input),
    ).rejects.toThrow("provider unavailable");
    await expect(
      processGenerationDocument(context, db, provider, input),
    ).resolves.toEqual({ outcome: "ready" });
    const chunkCount = await db.documentSearchChunk.count({
      where: { documentId: document.id },
    });
    await flushDiagnostics();

    const events = await db.diagnosticEvent.findMany({
      where: {
        category: "knowledge",
        documentId: document.id,
        event: {
          in: [
            "knowledge.document.started",
            "knowledge.document.failed",
            "knowledge.document.ready",
          ],
        },
      },
      orderBy: { createdAt: "asc" },
      select: { event: true, details: true, message: true },
    });
    expect(events).toEqual([
      {
        event: "knowledge.document.started",
        message: `document ${document.id.slice(0, 8)} started`,
        details: { attempt: 1 },
      },
      {
        event: "knowledge.document.failed",
        message: `document ${document.id.slice(0, 8)} failed`,
        details: {
          attempt: 1,
          kind: "provider",
          retryable: true,
          summary: expect.stringMatching(
            /^provider unavailable \(ref [0-9a-f]{8}\)$/,
          ),
          reference: expect.stringMatching(/^[0-9a-f]{8}$/),
          error: expect.objectContaining({ name: "AiProviderError" }),
        },
      },
      {
        event: "knowledge.document.started",
        message: `document ${document.id.slice(0, 8)} started`,
        details: { attempt: 2 },
      },
      {
        event: "knowledge.document.ready",
        message: `document ${document.id.slice(0, 8)} is ready`,
        details: { attempt: 2, chunks: chunkCount },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("MUST_NOT_BE_LOGGED");
  });

  it("stores the failure cause with a reference and records the error summary", async () => {
    const fixture = await makeDiagnosticGeneration("diag-failure-ref", "9");
    const provider = successfulDiagnosticProvider();
    provider.embed = async () => {
      throw new AiProviderError(
        "AI provider request failed: connection refused [ECONNREFUSED]",
        { kind: "provider", retryable: false },
      );
    };

    await expect(
      processGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        fixture.input,
      ),
    ).resolves.toEqual({ outcome: "failed" });
    const state =
      await fixture.db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: fixture.generation.id,
            documentId: fixture.document.id,
          },
        },
        select: { status: true, failureSummary: true },
      });
    expect(state.status).toBe("failed");
    expect(state.failureSummary).toMatch(
      /^AI provider request failed: connection refused \[ECONNREFUSED\] \(ref [0-9a-f]{8}\)$/,
    );
    const reference = /\(ref ([0-9a-f]{8})\)$/.exec(state.failureSummary!)![1]!;
    await flushDiagnostics(true);
    const event = await fixture.db.diagnosticEvent.findFirstOrThrow({
      where: {
        event: "knowledge.document.failed",
        documentId: fixture.document.id,
      },
    });
    expect(event.id.startsWith(reference)).toBe(true);
    expect(event.details).toMatchObject({
      reference,
      error: { name: "AiProviderError" },
    });
  });

  it("stores which extraction fields were rejected without the provider text", async () => {
    const fixture = await makeDiagnosticGeneration("diag-invalid-extract", "b");
    const provider = successfulDiagnosticProvider();
    provider.extract = async () => ({
      data: {
        entities: [
          {
            key: "e1",
            name: "SECRET-ENTITY-NAME",
            type: "product",
            aliases: [],
            description: null,
            mentionText: "SECRET-MENTION",
            confidence: "high",
          },
        ],
        relations: [],
      } as never,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        totalTokens: 2,
        durationMs: 1,
      },
    });

    await expect(
      processGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        fixture.input,
      ),
    ).resolves.toEqual({ outcome: "failed" });
    const state =
      await fixture.db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: fixture.generation.id,
            documentId: fixture.document.id,
          },
        },
        select: { status: true, failureKind: true, failureSummary: true },
      });
    expect(state.status).toBe("failed");
    expect(state.failureKind).toBe("validation");
    expect(state.failureSummary).toMatch(
      /^AI provider returned invalid extraction: entities\.0\.confidence: invalid_type [^;]+ \(ref [0-9a-f]{8}\)$/,
    );
    await flushDiagnostics(true);
    const event = await fixture.db.diagnosticEvent.findFirstOrThrow({
      where: {
        event: "knowledge.document.failed",
        documentId: fixture.document.id,
      },
    });
    expect(event.details).toMatchObject({
      kind: "validation",
      retryable: false,
      validation: {
        stage: "schema",
        issueCount: 1,
        issues: [
          expect.stringMatching(/^entities\.0\.confidence: invalid_type/),
        ],
      },
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });

  it("records paced embedding statistics for each document without its content", async () => {
    const fixture = await makeDiagnosticGeneration("diag-embedding-pace", "a");
    const provider = successfulDiagnosticProvider();
    const embed = provider.embed.bind(provider);
    let budget = 0;
    provider.embeddingCharacterBudget = () => budget;
    provider.embed = async (values, options) => {
      const result = await embed(values, options);
      budget = 1_000_000;
      return result;
    };

    await expect(
      processGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        fixture.input,
      ),
    ).resolves.toEqual({ outcome: "ready" });
    const chunks = await fixture.db.documentSearchChunk.findMany({
      where: { documentId: fixture.document.id },
      select: { content: true },
    });
    await flushDiagnostics(true);

    const event = await fixture.db.diagnosticEvent.findFirstOrThrow({
      where: {
        event: "knowledge.document.embedded",
        documentId: fixture.document.id,
      },
      select: { category: true, severity: true, message: true, details: true },
    });
    expect(event).toEqual({
      category: "knowledge",
      severity: "info",
      message: `document ${fixture.document.id.slice(0, 8)} embedded`,
      details: {
        attempt: 1,
        chunks: chunks.length,
        embedded: chunks.length,
        reused: 0,
        requests: 1,
        largestRequest: chunks.length,
        characters: chunks.reduce(
          (total, chunk) => total + chunk.content.length,
          0,
        ),
        durationMs: expect.any(Number),
        characterBudget: 1_000_000,
      },
    });
    expect(JSON.stringify(event)).not.toContain("Safe text");
  });

  it("fails a document retryably when enrichment outlives its deadline", async () => {
    const fixture = await makeDiagnosticGeneration("diag-deadline", "b");
    const provider = successfulDiagnosticProvider();
    provider.embed = (_values, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Embedding aborted", "AbortError")),
        );
      });

    await expect(
      processGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        fixture.input,
        { deadlineMs: 50 },
      ),
    ).rejects.toThrow("AI enrichment exceeded its time budget");
    const state =
      await fixture.db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: fixture.generation.id,
            documentId: fixture.document.id,
          },
        },
        select: { failureKind: true, failureSummary: true },
      });
    expect(state.failureKind).toBe("provider");
    expect(state.failureSummary).toMatch(
      /^AI enrichment exceeded its time budget \(ref [0-9a-f]{8}\)$/,
    );
    await flushDiagnostics(true);
    const event = await fixture.db.diagnosticEvent.findFirstOrThrow({
      where: {
        event: "knowledge.document.failed",
        documentId: fixture.document.id,
      },
      select: { details: true },
    });
    expect(event.details).toMatchObject({ kind: "provider", retryable: true });
  }, 10_000);

  it("warns when search falls back to keywords after a slow query embedding", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "diag-search");
    const project = await makeProject("Diagnostic search");
    await addMembership(project.id, user.id, "Viewer");
    await seedTestLlmRouting();
    const routing = (await resolveKnowledgeRouting(db))!;
    const provider = successfulDiagnosticProvider();
    provider.embed = (_values, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Query embedding aborted", "AbortError")),
        );
      });

    const result = await searchKnowledge(
      db,
      { query: "PRIVATE_QUERY_TEXT" },
      securityContextFor(user),
      { routing, provider, queryEmbeddingTimeoutMs: 50 },
    );
    await flushDiagnostics(true);

    expect(result.partial).toEqual(["semantic_unavailable"]);
    const events = await db.diagnosticEvent.findMany({
      where: { event: "knowledge.search.degraded" },
      select: { category: true, severity: true, details: true },
    });
    expect(events).toEqual([
      {
        category: "knowledge",
        severity: "warn",
        details: {
          reason: "timeout",
          timeoutMs: 50,
          durationMs: expect.any(Number),
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_QUERY_TEXT");
  });

  it("reports stale instead of failed when a provider failure loses its claimed document state", async () => {
    const fixture = await makeDiagnosticGeneration(
      "diag-stale-provider-failure",
      "7",
    );
    const nextSha = "b".repeat(40);
    const provider = successfulDiagnosticProvider();
    provider.embed = async () => {
      await fixture.db.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: fixture.document.id },
          data: { headCommitSha: nextSha },
        });
        await tx.knowledgeGenerationDocument.update({
          where: {
            generationId_documentId: {
              generationId: fixture.generation.id,
              documentId: fixture.document.id,
            },
          },
          data: { targetSha: nextSha, status: "pending" },
        });
      });
      throw new AiProviderError("nonretryable provider failure", {
        kind: "provider",
        retryable: false,
      });
    };

    await expect(
      processGenerationDocument(
        fixture.context,
        fixture.db,
        provider,
        fixture.input,
      ),
    ).resolves.toEqual({ outcome: "stale" });
    await flushDiagnostics();

    await expect(
      fixture.db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: fixture.generation.id,
            documentId: fixture.document.id,
          },
        },
        select: {
          targetSha: true,
          status: true,
          failureKind: true,
          failureSummary: true,
        },
      }),
    ).resolves.toEqual({
      targetSha: nextSha,
      status: "pending",
      failureKind: null,
      failureSummary: null,
    });
    const transitions = await fixture.db.diagnosticEvent.findMany({
      where: {
        documentId: fixture.document.id,
        event: {
          in: ["knowledge.document.failed", "knowledge.document.stale"],
        },
      },
      select: { event: true, outcome: true },
    });
    expect(transitions).toEqual([
      { event: "knowledge.document.stale", outcome: "stale" },
    ]);
  });

  it("preserves an activation error when the database stays unavailable after the document became ready", async () => {
    const fixture = await makeDiagnosticGeneration(
      "diag-ready-activation-error",
      "8",
    );
    const activationError = new Error("activation unavailable");
    const finalizationError = new Error("failure finalization unavailable");
    const originalTransaction = fixture.db.$transaction.bind(fixture.db);
    let activationRejected = false;
    let readyTransactions = 0;
    vi.spyOn(fixture.db, "$transaction").mockImplementation(
      async (...args: Parameters<typeof fixture.db.$transaction>) => {
        const state = await fixture.db.knowledgeGenerationDocument.findUnique({
          where: {
            generationId_documentId: {
              generationId: fixture.generation.id,
              documentId: fixture.document.id,
            },
          },
          select: { status: true },
        });
        if (state?.status === "ready") {
          readyTransactions += 1;
          if (readyTransactions >= 2) {
            if (!activationRejected) {
              activationRejected = true;
              throw activationError;
            }
            throw finalizationError;
          }
        }
        return originalTransaction(...args);
      },
    );

    await expect(
      processGenerationDocument(
        fixture.context,
        fixture.db,
        successfulDiagnosticProvider(),
        fixture.input,
      ),
    ).rejects.toBe(activationError);
    expect(activationRejected).toBe(true);
    expect(readyTransactions).toBe(2);
    await flushDiagnostics();

    await expect(
      fixture.db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: fixture.generation.id,
            documentId: fixture.document.id,
          },
        },
        select: { status: true, failureKind: true, failureSummary: true },
      }),
    ).resolves.toEqual({
      status: "ready",
      failureKind: null,
      failureSummary: null,
    });
    const transitions = await fixture.db.diagnosticEvent.findMany({
      where: {
        documentId: fixture.document.id,
        event: {
          in: ["knowledge.document.failed", "knowledge.document.stale"],
        },
      },
      select: { event: true },
    });
    expect(transitions).toEqual([]);
  });

  it("counts only reconciliation jobs accepted by the queue", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "diag-reconcile-count");
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "standard",
    });
    const project = await makeProject("Diag reconcile count");
    await addMembership(project.id, admin.id, "Editor");
    await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Reconcile source",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("# Reconcile source\n\nSafe text.\n"),
        },
      },
      { ...securityContextFor(admin), name: "Admin", email: admin.email },
    );
    await db.knowledgeGeneration.createMany({
      data: [
        {
          projectId: project.id,
          configFingerprint: "d".repeat(64),
          embeddingModel: "model-active",
          embeddingDimensions: 1536,
          extractionSchemaVersion: 1,
          promptVersion: "prompt-v1",
          status: "active",
        },
        {
          projectId: project.id,
          configFingerprint: "e".repeat(64),
          embeddingModel: "model-building",
          embeddingDimensions: 1536,
          extractionSchemaVersion: 1,
          promptVersion: "prompt-v1",
          status: "building",
        },
      ],
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    let enrichmentEnqueues = 0;
    vi.spyOn(queue, "send").mockImplementation(async (name) => {
      if (name === "document.search-sync") return "accepted-search";
      if (name === "document.ai-enrich") {
        enrichmentEnqueues += 1;
        if (enrichmentEnqueues === 1) return null;
        throw new Error("queue unavailable");
      }
      return "accepted-other";
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await reconcileProjectKnowledge(
      knowledgeSystemContextForTests(),
      db,
      project.id,
    );
    await flushDiagnostics();

    await expect(
      db.diagnosticEvent.findFirstOrThrow({
        where: {
          event: "knowledge.reconcile.completed",
          projectId: project.id,
        },
        select: { details: true },
      }),
    ).resolves.toEqual({
      details: {
        documentsChecked: 1,
        jobsEnqueued: 1,
        generations: 2,
      },
    });
  });

  it("logs committed supersessions once and not an idempotent reactivation", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "diag-generation-transition");
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "standard",
    });
    const project = await makeProject("Diag generation transition");
    const prior = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "1".repeat(64),
        embeddingModel: "prior",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "active",
      },
    });
    const target = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "f".repeat(64),
        embeddingModel: "target",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "building",
      },
    });

    await expect(
      activateCompletedGeneration(knowledgeSystemContextForTests(), db, {
        projectId: project.id,
        generationId: target.id,
      }),
    ).resolves.toBe(true);
    await expect(
      activateCompletedGeneration(knowledgeSystemContextForTests(), db, {
        projectId: project.id,
        generationId: target.id,
      }),
    ).resolves.toBe(true);
    await flushDiagnostics();

    const transitions = await db.diagnosticEvent.findMany({
      where: {
        projectId: project.id,
        event: {
          in: [
            "knowledge.generation.activated",
            "knowledge.generation.superseded",
          ],
        },
      },
      select: { event: true, generationId: true, details: true },
    });
    expect(
      transitions
        .filter((event) => event.event === "knowledge.generation.superseded")
        .map((event) => event.generationId)
        .sort(),
    ).toEqual([prior.id]);
    expect(
      transitions.filter(
        (event) => event.event === "knowledge.generation.activated",
      ),
    ).toEqual([
      {
        event: "knowledge.generation.activated",
        generationId: target.id,
        details: { superseded: 1 },
      },
    ]);
    expect(transitions).toContainEqual({
      event: "knowledge.generation.superseded",
      generationId: prior.id,
      details: { replacementGenerationId: target.id },
    });
  });

  it("logs provider calls made through a routed adapter", async () => {
    const admin = await makeUser("Admin", "diag-provider");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "standard",
    });
    const { routing } = await seedTestLlmRouting();
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    const adapter = createAdapterForSnapshot(
      routing.extraction,
      createDbCredentialSource(getPrisma(), testEncryptionKeys()),
      fetchImpl,
    );
    await adapter.listModels();
    await flushDiagnostics();

    const [row] = await getPrisma().diagnosticEvent.findMany({
      where: { event: "ai.request" },
    });
    expect(row).toMatchObject({
      connectionId: routing.extraction.connectionId,
      statusCode: 200,
      outcome: "ok",
      details: {
        path: "/v1/models",
        providerType: routing.extraction.providerType,
      },
    });
  });

  it("classifies routed provider failures without storing their body at standard", async () => {
    const admin = await makeUser("Admin", "diag-provider-private");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "standard",
    });
    const { routing } = await seedTestLlmRouting();
    const privateMarker = "PRIVATE_DOCUMENT_PROMPT_MARKER";
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: { detail: privateMarker, prompt: privateMarker },
        }),
        { status: 503 },
      );
    const adapter = createAdapterForSnapshot(
      routing.extraction,
      createDbCredentialSource(getPrisma(), testEncryptionKeys()),
      fetchImpl,
    );

    await expect(adapter.listModels()).rejects.toBeInstanceOf(AiProviderError);
    await flushDiagnostics(true);

    const row = await getPrisma().diagnosticEvent.findFirstOrThrow({
      where: { event: "ai.request" },
    });
    expect(row).toMatchObject({
      connectionId: routing.extraction.connectionId,
      statusCode: 503,
      outcome: "error",
      requestBody: null,
      responseBody: null,
      hasRequestBody: false,
      hasResponseBody: false,
      details: {
        path: "/v1/models",
        providerType: routing.extraction.providerType,
        error: "http_error",
      },
    });
    expect(JSON.stringify(row)).not.toContain(privateMarker);
  });

  it("names the outbound policy in a provider failure and records its code", async () => {
    const admin = await makeUser("Admin", "diag-outbound");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "errors",
    });
    const { routing } = await seedTestLlmRouting();
    const fetchImpl: typeof fetch = async () => {
      throw new OutboundPolicyError();
    };
    const adapter = createAdapterForSnapshot(
      routing.extraction,
      createDbCredentialSource(getPrisma(), testEncryptionKeys()),
      fetchImpl,
    );
    await expect(adapter.listModels()).rejects.toThrow(
      "endpoint not allowed by the outbound policy (WEAVER_OUTBOUND_ALLOWED_ORIGINS)",
    );
    await flushDiagnostics(true);
    const row = await getPrisma().diagnosticEvent.findFirstOrThrow({
      where: { event: "ai.request" },
    });
    expect(row).toMatchObject({
      severity: "error",
      outcome: "error",
      details: {
        classification: "transport_error",
        error: { name: "OutboundPolicyError", code: "OUTBOUND_NOT_ALLOWED" },
      },
    });
  });

  it("logs settings changes and tRPC mutations at verbose only", async () => {
    const admin = await makeUser("Admin", "diag-trpc");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "standard",
    });
    const caller = callerFor(admin);
    await caller.llm.setRoute({ purpose: "assistant", modelId: null });
    await flushDiagnostics();
    let events = await getPrisma().diagnosticEvent.findMany();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "settings.changed",
        userId: admin.id,
        details: expect.objectContaining({ setting: "llm.route" }),
      }),
    );
    expect(events.map((row) => row.event)).not.toContain("trpc.mutation");

    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "verbose",
    });
    await caller.llm.overview();
    await caller.llm.setRoute({ purpose: "assistant", modelId: null });
    const user = await makeUser("User", "diag-trpc-failed-query");
    await expect(callerFor(user).llm.overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await flushDiagnostics();
    events = await getPrisma().diagnosticEvent.findMany();
    const trpcEvents = events.filter((row) => row.category === "trpc");
    expect(trpcEvents.map((row) => row.event).sort()).toEqual([
      "trpc.mutation",
      "trpc.query.failed",
    ]);
    expect(trpcEvents.every((row) => row.verbose)).toBe(true);
    expect(trpcEvents).toContainEqual(
      expect.objectContaining({
        event: "trpc.mutation",
        userId: admin.id,
        details: expect.objectContaining({ path: "llm.setRoute" }),
      }),
    );
    expect(trpcEvents).toContainEqual(
      expect.objectContaining({
        event: "trpc.query.failed",
        userId: user.id,
        details: expect.objectContaining({
          path: "llm.overview",
          errorCode: "FORBIDDEN",
        }),
      }),
    );
  });

  it("logs rejected bearer credentials", async () => {
    const admin = await makeUser("Admin", "diag-bearer");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "standard",
    });
    const token = "wvr_not_a_real_key";
    await expect(
      resolveBearerSecurityContext(
        getPrisma(),
        createBearerVerifiers(testAuth(), {
          issuer: TEST_ISSUER,
          audience: TEST_MCP_RESOURCE,
        }),
        `Bearer ${token}`,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await flushDiagnostics();
    const row = await getPrisma().diagnosticEvent.findFirst({
      where: { event: "auth.bearer.rejected" },
    });
    expect(row).toMatchObject({
      severity: "warn",
      message: "authentication rejected: invalid",
      details: { reason: "invalid", prefix: "wvr_not_" },
    });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain("Bearer ");
  });

  it("lists events deterministically newest first without bodies and pages with truthful truncation", async () => {
    const admin = await makeUser("Admin", "diag-list-order");
    const actor = securityContextFor(admin);
    const tiedAt = new Date("2026-09-01T00:00:00.000Z");
    await getPrisma().diagnosticEvent.createMany({
      data: [
        {
          id: "10000000-0000-4000-8000-000000000001",
          createdAt: tiedAt,
          runtime: "worker",
          severity: "info",
          category: "job",
          event: "job.started",
          message: "tied 1",
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          createdAt: tiedAt,
          runtime: "worker",
          severity: "info",
          category: "job",
          event: "job.started",
          message: "tied 2",
        },
        {
          id: "10000000-0000-4000-8000-000000000003",
          createdAt: tiedAt,
          runtime: "worker",
          severity: "error",
          verbose: true,
          category: "ai",
          event: "ai.request",
          message: "tied 3",
          hasRequestBody: true,
          requestBody: "PRIVATE_PROMPT_BODY",
        },
        {
          id: "10000000-0000-4000-8000-000000000004",
          createdAt: new Date(tiedAt.getTime() + 1_000),
          runtime: "mcp",
          severity: "warn",
          category: "mcp",
          event: "mcp.tool.called",
          message: "newest",
        },
      ],
    });

    const page = await listDiagnosticEvents(getPrisma(), actor, { limit: 2 });
    expect(page.items.map((item) => item.message)).toEqual([
      "newest",
      "tied 3",
    ]);
    expect(page.items[1]).toMatchObject({
      hasRequestBody: true,
      hasResponseBody: false,
    });
    expect(page.items.every((item) => !("requestBody" in item))).toBe(true);
    expect(page.items.every((item) => !("responseBody" in item))).toBe(true);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_PROMPT_BODY");
    expect(page).toMatchObject({ truncated: true });
    expect(page.nextCursor).not.toBeNull();

    const next = await listDiagnosticEvents(getPrisma(), actor, {
      limit: 2,
      cursor: page.nextCursor!,
    });
    expect(next.items.map((item) => item.message)).toEqual([
      "tied 2",
      "tied 1",
    ]);
    expect(next).toMatchObject({ nextCursor: null, truncated: false });
  });

  it("excludes debug events before pagination while preserving default and explicit severity queries", async () => {
    const admin = await makeUser("Admin", "diag-exclude-debug");
    const caller = callerFor(admin);
    const severities = [
      "info",
      "debug",
      "error",
      "debug",
      "warn",
      "debug",
      "info",
      "debug",
    ] as const;
    await getPrisma().diagnosticEvent.createMany({
      data: severities.map((severity, index) => ({
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)),
        runtime: "worker",
        category: "job",
        event: "job.started",
        severity,
        message: `${severity} ${index}`,
      })),
    });

    const unfiltered = await caller.diagnostics.listEvents({ limit: 2 });
    expect(unfiltered.items.map((item) => item.message)).toEqual([
      "debug 7",
      "info 6",
    ]);
    expect(
      await caller.diagnostics.listEvents({ limit: 2, excludeDebug: false }),
    ).toEqual(unfiltered);

    const page = await caller.diagnostics.listEvents({
      limit: 2,
      excludeDebug: true,
    });
    expect(page.items.map((item) => item.message)).toEqual([
      "info 6",
      "warn 4",
    ]);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const next = await caller.diagnostics.listEvents({
      limit: 2,
      excludeDebug: true,
      cursor: page.nextCursor!,
    });
    expect(next.items.map((item) => item.message)).toEqual([
      "error 2",
      "info 0",
    ]);
    expect(next).toMatchObject({ nextCursor: null, truncated: false });

    for (const severity of ["debug", "info", "warn", "error"] as const) {
      const explicit = await caller.diagnostics.listEvents({
        severity,
        excludeDebug: true,
      });
      expect(explicit.items.map((item) => item.message)).toEqual(
        severities
          .flatMap((candidate, index) =>
            candidate === severity ? [`${severity} ${index}`] : [],
          )
          .reverse(),
      );
    }
  });

  it("reclassifies only historical routine job info events without deleting or changing other data", async () => {
    const routineJobs = [
      "project.git-sync",
      "task.tick",
      "assistant.reconcile",
    ];
    const cases = [
      ...routineJobs.flatMap((job) =>
        ["job.started", "job.completed"].map((event) => ({
          job,
          event,
          category: "job",
          severity: "info" as const,
          expected: "debug" as const,
        })),
      ),
      {
        job: "project.git-sync",
        event: "job.started",
        category: "job",
        severity: "warn" as const,
        expected: "warn" as const,
      },
      {
        job: "task.tick",
        event: "job.completed",
        category: "job",
        severity: "error" as const,
        expected: "error" as const,
      },
      {
        job: "assistant.reconcile",
        event: "job.started",
        category: "job",
        severity: "debug" as const,
        expected: "debug" as const,
      },
      {
        job: "knowledge.extract",
        event: "job.started",
        category: "job",
        severity: "info" as const,
        expected: "info" as const,
      },
      {
        job: "task.tick",
        event: "job.failed",
        category: "job",
        severity: "info" as const,
        expected: "info" as const,
      },
      {
        job: "task.tick",
        event: "job.started",
        category: "runtime",
        severity: "info" as const,
        expected: "info" as const,
      },
      {
        job: null,
        event: "job.started",
        category: "job",
        severity: "info" as const,
        expected: "info" as const,
      },
    ];
    const db = getPrisma();
    await db.diagnosticEvent.createMany({
      data: cases.map(({ job, event, category, severity }, index) => ({
        id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        runtime: "worker",
        severity,
        category,
        event,
        message: `Historical event ${index}`,
        details: job === null ? {} : { job, count: index },
        durationMs: index,
      })),
    });
    const before = await db.diagnosticEvent.findMany({
      orderBy: { id: "asc" },
    });
    const migrationSql = await readFile(
      new URL(
        "../../../../packages/db/prisma/migrations/20260921001300_routine_job_diagnostic_severity/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.$executeRawUnsafe(migrationSql);
    expect(
      await db.diagnosticEvent.findMany({ orderBy: { id: "asc" } }),
    ).toEqual(
      before.map((row, index) => ({
        ...row,
        severity: cases[index]!.expected,
      })),
    );
  });

  it("applies every diagnostic event filter with inclusive time boundaries and case-insensitive text", async () => {
    const admin = await makeUser("Admin", "diag-list-filters");
    const actor = securityContextFor(admin);
    const targetId = "20000000-0000-4000-8000-000000000002";
    const targetAt = new Date("2026-09-01T12:00:00.000Z");
    const ids = {
      runId: "21000000-0000-4000-8000-000000000001",
      userId: "21000000-0000-4000-8000-000000000002",
      projectId: "21000000-0000-4000-8000-000000000003",
      generationId: "21000000-0000-4000-8000-000000000004",
      documentId: "21000000-0000-4000-8000-000000000005",
      connectionId: "21000000-0000-4000-8000-000000000006",
    };
    await getPrisma().diagnosticEvent.createMany({
      data: [
        {
          id: "20000000-0000-4000-8000-000000000001",
          createdAt: new Date(targetAt.getTime() - 1_000),
          runtime: "web",
          severity: "debug",
          category: "runtime",
          event: "runtime.started",
          message: "before",
        },
        {
          id: targetId,
          createdAt: targetAt,
          runtime: "worker",
          severity: "error",
          category: "knowledge",
          event: "knowledge.document.failed",
          message: "Target NEEDLE message",
          requestId: "request-target",
          jobId: "job-target",
          ...ids,
        },
        {
          id: "20000000-0000-4000-8000-000000000003",
          createdAt: new Date(targetAt.getTime() + 1_000),
          runtime: "mcp",
          severity: "info",
          category: "admin",
          event: "admin.tool.called",
          message: "after",
        },
      ],
    });

    const cases = [
      { filter: { category: "knowledge" }, expected: [targetId] },
      {
        filter: { event: "knowledge.document.failed" },
        expected: [targetId],
      },
      { filter: { severity: "error" as const }, expected: [targetId] },
      { filter: { requestId: "request-target" }, expected: [targetId] },
      { filter: { jobId: "job-target" }, expected: [targetId] },
      { filter: { runId: ids.runId }, expected: [targetId] },
      { filter: { userId: ids.userId }, expected: [targetId] },
      { filter: { projectId: ids.projectId }, expected: [targetId] },
      { filter: { generationId: ids.generationId }, expected: [targetId] },
      { filter: { documentId: ids.documentId }, expected: [targetId] },
      { filter: { connectionId: ids.connectionId }, expected: [targetId] },
      { filter: { text: "needle" }, expected: [targetId] },
      {
        filter: { since: targetAt },
        expected: ["20000000-0000-4000-8000-000000000003", targetId],
      },
      {
        filter: { until: targetAt },
        expected: [targetId, "20000000-0000-4000-8000-000000000001"],
      },
      {
        filter: { since: targetAt, until: targetAt },
        expected: [targetId],
      },
    ];
    for (const { filter, expected } of cases) {
      const result = await listDiagnosticEvents(getPrisma(), actor, filter);
      expect(result.items.map((item) => item.id)).toEqual(expected);
    }
  });

  it("requires membership to read project provider bodies", async () => {
    const admin = await makeUser("Admin", "diag-no-membership");
    const project = await makeProject("Private diagnostic project");
    const row = await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date(),
        runtime: "worker",
        severity: "info",
        verbose: true,
        category: "ai",
        event: "ai.request",
        message: "provider request",
        projectId: project.id,
        requestBody: "private",
        hasRequestBody: true,
      },
    });
    await expect(
      getDiagnosticEvent(getPrisma(), securityContextFor(admin), {
        id: row.id,
        body: "request",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await getDiagnosticEvent(getPrisma(), securityContextFor(admin), {
          id: row.id,
        })
      ).body,
    ).toBeNull();
  });

  it("returns bodies only by explicit selector in bounded offset slices", async () => {
    const admin = await makeUser("Admin", "diag-body");
    const actor = securityContextFor(admin);
    const privatePrompt = "PRIVATE_PROMPT_BODY_";
    const privateCredential = "PRIVATE_CREDENTIAL_BODY_";
    const requestBody =
      privatePrompt + "r".repeat(20_000 - privatePrompt.length);
    const responseBody =
      privateCredential + "s".repeat(13_000 - privateCredential.length);
    const row = await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        runtime: "web",
        severity: "error",
        verbose: true,
        category: "ai",
        event: "ai.request",
        message: "provider request",
        hasRequestBody: true,
        hasResponseBody: true,
        requestBody,
        responseBody,
      },
    });

    const withoutBody = await getDiagnosticEvent(getPrisma(), actor, {
      id: row.id,
    });
    expect(withoutBody.body).toBeNull();
    expect(withoutBody.event).not.toHaveProperty("requestBody");
    expect(withoutBody.event).not.toHaveProperty("responseBody");
    expect(JSON.stringify(withoutBody)).not.toContain(privatePrompt);
    expect(JSON.stringify(withoutBody)).not.toContain(privateCredential);

    const firstRequest = await getDiagnosticEvent(getPrisma(), actor, {
      id: row.id,
      body: "request",
      offset: -20,
    });
    expect(firstRequest.body).toMatchObject({
      part: "request",
      offset: 0,
      nextOffset: 12_000,
      total: 20_000,
    });
    expect(firstRequest.body?.text).toHaveLength(12_000);
    expect(firstRequest.body?.text.startsWith(privatePrompt)).toBe(true);
    expect(firstRequest.event).not.toHaveProperty("requestBody");

    const finalRequest = await getDiagnosticEvent(getPrisma(), actor, {
      id: row.id,
      body: "request",
      offset: 12_000,
    });
    expect(finalRequest.body).toMatchObject({
      part: "request",
      offset: 12_000,
      nextOffset: null,
      total: 20_000,
    });
    expect(finalRequest.body?.text).toHaveLength(8_000);

    const firstResponse = await getDiagnosticEvent(getPrisma(), actor, {
      id: row.id,
      body: "response",
    });
    expect(firstResponse.body).toMatchObject({
      part: "response",
      offset: 0,
      nextOffset: 12_000,
      total: 13_000,
    });
    expect(firstResponse.body?.text.startsWith(privateCredential)).toBe(true);
    expect(firstResponse.event).not.toHaveProperty("responseBody");

    const pastEnd = await getDiagnosticEvent(getPrisma(), actor, {
      id: row.id,
      body: "response",
      offset: 99_999,
    });
    expect(pastEnd.body).toEqual({
      part: "response",
      text: "",
      offset: 13_000,
      nextOffset: null,
      total: 13_000,
    });
  });

  it("reconstructs a writer-sanitized emoji body across service pages", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "diag-body-emoji-pages");
    const actor = securityContextFor(admin);
    const project = await makeProject("Diagnostic emoji source");
    await addMembership(project.id, admin.id, "Viewer");
    await setDiagnosticsSettings(db, actor, { level: "verbose" });
    const requestBody = JSON.stringify({
      text: Array.from({ length: 14 }, () => "😀".repeat(1_000)),
    });
    emitDiagnostic({
      event: "ai.request",
      message: "service emoji body pages",
      projectId: project.id,
      requestBody,
    });
    await flushDiagnostics(true);
    const event = await db.diagnosticEvent.findFirstOrThrow({
      where: { event: "ai.request", message: "service emoji body pages" },
    });
    expect(event.requestBody).toBe(requestBody);

    const pages = [];
    let requestedOffset: number | null = 0;
    while (requestedOffset !== null && pages.length < 10) {
      const result = await getDiagnosticEvent(db, actor, {
        id: event.id,
        body: "request",
        offset: requestedOffset,
      });
      const body = result.body!;
      expect(body.text.length).toBeLessThanOrEqual(12_000);
      expect(body.total).toBe(requestBody.length);
      expect(
        requestBody.slice(body.offset, body.offset + body.text.length),
      ).toBe(body.text);
      if (body.nextOffset !== null) {
        expect(body.nextOffset).toBe(body.offset + body.text.length);
        expect(body.nextOffset).toBeGreaterThan(body.offset);
      }
      pages.push(body);
      requestedOffset = body.nextOffset;
    }

    expect(requestedOffset).toBeNull();
    const reconstructed = pages.map((body) => body.text).join("");
    expect(reconstructed.length).toBe(requestBody.length);
    expect(reconstructed).toBe(requestBody);
    for (const body of pages) {
      const first = body.text.charCodeAt(0);
      const last = body.text.charCodeAt(body.text.length - 1);
      expect(first < 0xdc00 || first > 0xdfff).toBe(true);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
  });

  it("returns null for an explicitly selected absent body", async () => {
    const admin = await makeUser("Admin", "diag-body-absent");
    const row = await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        runtime: "web",
        severity: "info",
        category: "runtime",
        event: "runtime.started",
        message: "started",
      },
    });

    await expect(
      getDiagnosticEvent(getPrisma(), securityContextFor(admin), {
        id: row.id,
        body: "request",
      }),
    ).resolves.toMatchObject({ body: null });
  });

  it("rejects missing system administration before querying and maps invalid cursors and missing events", async () => {
    const admin = await makeUser("Admin", "diag-access-admin");
    const user = await makeUser("User", "diag-access-user");
    const missingId = "30000000-0000-4000-8000-000000000001";

    await expect(
      listDiagnosticEvents(getPrisma(), securityContextFor(user), {}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "System administration required",
    });
    await expect(
      getDiagnosticEvent(getPrisma(), securityContextFor(user), {
        id: missingId,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "System administration required",
    });
    await expect(
      listDiagnosticEvents(getPrisma(), securityContextFor(admin), {
        cursor: "not-a-cursor",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid cursor",
      details: { field: "cursor" },
    });
    await expect(
      getDiagnosticEvent(getPrisma(), securityContextFor(admin), {
        id: missingId,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Diagnostic event not found",
    });
  });

  it("clears expired provider bodies while retaining standard request metadata", async () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const event = await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date(now.getTime() - 30 * 3_600_000),
        runtime: "web",
        severity: "info",
        verbose: true,
        category: "ai",
        event: "ai.request",
        message: "completed",
        requestBody: "{}",
        hasRequestBody: true,
      },
    });
    await pruneDiagnosticEvents(
      getPrisma(),
      {
        level: "off",
        retentionDays: 7,
        verboseRetentionHours: 24,
        maxRows: 10_000,
      },
      now,
    );
    expect(
      await getPrisma().diagnosticEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({
      event: "ai.request",
      requestBody: null,
      hasRequestBody: false,
      verbose: false,
    });
  });

  it("prunes verbose and expired rows with strict UTC cutoffs and reports exact counts", async () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const hoursAgo = (hours: number) =>
      new Date(now.getTime() - hours * 3_600_000);
    const row = (createdAt: Date, verbose: boolean, message: string) => ({
      createdAt,
      runtime: "web" as const,
      severity: "info" as const,
      verbose,
      category: "job",
      event: "job.started",
      message,
    });
    await getPrisma().diagnosticEvent.createMany({
      data: [
        row(hoursAgo(30), true, "old verbose"),
        row(hoursAgo(24), true, "verbose at cutoff"),
        row(hoursAgo(2), true, "fresh verbose"),
        row(hoursAgo(24 * 8), false, "older than retention"),
        row(hoursAgo(24 * 7), false, "retained at cutoff"),
        row(hoursAgo(1), false, "kept 1"),
        row(hoursAgo(3), false, "kept 2"),
      ],
    });

    const result = await pruneDiagnosticEvents(
      getPrisma(),
      {
        level: "off",
        retentionDays: 7,
        verboseRetentionHours: 24,
        maxRows: 10_000,
      },
      now,
    );

    expect(result).toEqual({
      verboseRemoved: 1,
      expiredRemoved: 1,
      overflowRemoved: 0,
      batches: 2,
    });
    const remaining = (
      await getPrisma().diagnosticEvent.findMany({
        where: { category: "job" },
      })
    )
      .map((event) => event.message)
      .sort();
    expect(remaining).toEqual([
      "fresh verbose",
      "kept 1",
      "kept 2",
      "retained at cutoff",
      "verbose at cutoff",
    ]);
  });

  it("prunes only the oldest overflow beyond maxRows and reports its batch", async () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    const oldest = await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date(now.getTime() - 60_000),
        runtime: "web",
        severity: "info",
        category: "job",
        event: "job.started",
        message: "overflow oldest",
      },
    });
    for (let chunk = 0; chunk < 2; chunk += 1) {
      await getPrisma().diagnosticEvent.createMany({
        data: Array.from({ length: 5_000 }, (_, index) => ({
          createdAt: new Date(now.getTime() + chunk * 5_000 + index),
          runtime: "worker" as const,
          severity: "info" as const,
          category: "job",
          event: "job.started",
          message: `overflow kept ${chunk}-${index}`,
        })),
      });
    }

    const result = await pruneDiagnosticEvents(
      getPrisma(),
      {
        level: "off",
        retentionDays: 90,
        verboseRetentionHours: 168,
        maxRows: 10_000,
      },
      now,
    );

    expect(result).toEqual({
      verboseRemoved: 0,
      expiredRemoved: 0,
      overflowRemoved: 1,
      batches: 1,
    });
    await expect(
      getPrisma().diagnosticEvent.findUnique({ where: { id: oldest.id } }),
    ).resolves.toBeNull();
    await expect(getPrisma().diagnosticEvent.count()).resolves.toBe(10_000);
  });

  it("keeps concurrent overflow pruning from deleting below maxRows", async () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    for (let chunk = 0; chunk < 4; chunk += 1) {
      await getPrisma().diagnosticEvent.createMany({
        data: Array.from({ length: 5_000 }, (_, index) => ({
          createdAt: new Date(now.getTime() + chunk * 5_000 + index),
          runtime: "worker" as const,
          severity: "info" as const,
          category: "job",
          event: "job.started",
          message: `concurrent overflow ${chunk}-${index}`,
        })),
      });
    }
    const settings = {
      level: "off" as const,
      retentionDays: 90,
      verboseRetentionHours: 168,
      maxRows: 10_000,
    };

    const results = await Promise.all([
      pruneDiagnosticEvents(getPrisma(), settings, now),
      pruneDiagnosticEvents(getPrisma(), settings, now),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        {
          verboseRemoved: 0,
          expiredRemoved: 0,
          overflowRemoved: 10_000,
          batches: 1,
        },
        {
          verboseRemoved: 0,
          expiredRemoved: 0,
          overflowRemoved: 0,
          batches: 0,
        },
      ]),
    );
    expect(
      results.reduce((total, result) => total + result.overflowRemoved, 0),
    ).toBe(10_000);
    await expect(getPrisma().diagnosticEvent.count()).resolves.toBe(10_000);
  });

  it("emits a body-free pruning diagnostic with the returned counts", async () => {
    const admin = await makeUser("Admin", "diag-prune-event");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "standard",
      retentionDays: 1,
    });
    await flushDiagnostics();
    await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        runtime: "worker",
        severity: "info",
        category: "job",
        event: "job.started",
        message: "expired",
      },
    });

    const result = await pruneDiagnosticEvents(
      getPrisma(),
      {
        level: "standard",
        retentionDays: 1,
        verboseRetentionHours: 24,
        maxRows: 10_000,
      },
      new Date("2026-09-10T12:00:00.000Z"),
    );
    await flushDiagnostics();

    const event = await getPrisma().diagnosticEvent.findFirstOrThrow({
      where: { event: "diagnostics.pruned" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).toMatchObject({
      severity: "info",
      outcome: "ok",
      details: result,
      hasRequestBody: false,
      hasResponseBody: false,
      requestBody: null,
      responseBody: null,
    });
  });

  it("runs diagnostic housekeeping after system reconciliation even when logging is off", async () => {
    const admin = await makeUser("Admin", "diag-housekeeping");
    const project = await makeProject("Diagnostics housekeeping");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "off",
      retentionDays: 1,
      verboseRetentionHours: 1,
    });
    const expired = await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        runtime: "worker",
        severity: "info",
        category: "job",
        event: "job.started",
        message: "expired by reconcile",
      },
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db: getPrisma(),
      config: parseKnowledgeConfig(process.env),
      routing: noKnowledgeRouting,
    });

    await queue.run("system.reconcile", {});

    expect(queue.jobs).toContainEqual({
      name: "project.reconcile",
      data: { projectId: project.id },
    });
    await expect(
      getPrisma().diagnosticEvent.findUnique({ where: { id: expired.id } }),
    ).resolves.toBeNull();
  });

  it("finishes independent reconciliation and reports a safe housekeeping failure", async () => {
    const privateMarker = "PRIVATE_DATABASE_FAILURE_DETAIL";
    const admin = await makeUser("Admin", "diag-housekeeping-failure");
    const project = await makeProject("Diagnostics housekeeping failure");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "standard",
      retentionDays: 1,
    });
    await flushDiagnostics();
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db: getPrisma(),
      config: parseKnowledgeConfig(process.env),
      routing: noKnowledgeRouting,
    });
    const cleanup = vi
      .spyOn(
        await import("@weaver/core/services/diagnosticEvents"),
        "pruneDiagnosticEvents",
      )
      .mockRejectedValueOnce(new Error(privateMarker));

    try {
      await expect(queue.run("system.reconcile", {})).rejects.toThrow(
        "System reconciliation failed",
      );
    } finally {
      cleanup.mockRestore();
    }
    await flushDiagnostics();

    expect(queue.jobs).toContainEqual({
      name: "project.reconcile",
      data: { projectId: project.id },
    });
    const events = await getPrisma().diagnosticEvent.findMany({
      where: {
        event: {
          in: ["runtime.housekeeping.failed", "job.completed", "job.failed"],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "runtime.housekeeping.failed",
        severity: "warn",
        outcome: "error",
        message: "System housekeeping operation failed",
        details: { operation: "diagnostics", errorClass: "Error" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "job.failed",
        outcome: "error",
      }),
    );
    expect(events.map((event) => event.event)).not.toContain("job.completed");
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  });

  it("resolves an eight-character reference to its event by primary-key range", async () => {
    const admin = await makeUser("Admin", "diag-reference");
    const actor = securityContextFor(admin);
    const db = getPrisma();
    const base = {
      createdAt: new Date("2026-09-12T10:00:00.000Z"),
      runtime: "worker" as const,
      severity: "error" as const,
      category: "assistant",
      event: "assistant.attempt.failed",
    };
    const target = await db.diagnosticEvent.create({
      data: {
        ...base,
        id: "a3f9c2e1-1111-4111-8111-111111111111",
        message: "target",
      },
    });
    await db.diagnosticEvent.create({
      data: {
        ...base,
        id: "a3f9c2e2-1111-4111-8111-111111111111",
        message: "neighbour",
      },
    });
    const page = await listDiagnosticEvents(db, actor, {
      reference: "a3f9c2e1",
    });
    expect(page.items.map((item) => item.id)).toEqual([target.id]);
    const one = await getDiagnosticEvent(db, actor, { reference: "A3F9C2E1" });
    expect(one.event.id).toBe(target.id);
    await expect(
      getDiagnosticEvent(db, actor, { reference: "zzzz" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      getDiagnosticEvent(db, actor, { id: target.id, reference: "a3f9c2e1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      getDiagnosticEvent(db, actor, { reference: "00000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("captures internal tRPC failures with a reference the client can quote", async () => {
    const admin = await makeUser("Admin", "diag-trpc-internal");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "errors",
    });
    const router = createTRPCRouter({
      boom: adminProcedure.query(() => {
        throw Object.assign(new Error("db exploded at /private/path"), {
          code: "ECONNRESET",
        });
      }),
    });
    const caller = createCallerFactory(router)({
      db: getPrisma(),
      session: {
        user: {
          id: admin.id,
          role: admin.role,
          email: admin.email,
          name: "Admin test user",
          sessionId: "integration-session",
          mustChangePassword: false,
        },
      },
      security: securityContextFor(admin),
      apiKeyIssuer: createApiKeyIssuer(testAuth()),
      userAdministrator: createUserAdministrator(testAuth()),
      passwordChanger: createPasswordChanger(testAuth()),
      encryptionKeys: testEncryptionKeys(),
      llmFetch: fetch,
      headers: new Headers(),
    } as never);
    let thrown: unknown;
    await caller.boom().catch((error: unknown) => {
      thrown = error;
    });
    expect(thrown).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      diagnosticReference: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
    const reference = (thrown as { diagnosticReference: string })
      .diagnosticReference;
    await flushDiagnostics(true);
    const event = await getPrisma().diagnosticEvent.findFirstOrThrow({
      where: { event: "trpc.error" },
    });
    expect(event.id.startsWith(reference)).toBe(true);
    expect(event).toMatchObject({
      severity: "error",
      verbose: false,
      userId: admin.id,
      details: {
        path: "boom",
        type: "query",
        errorCode: "INTERNAL_SERVER_ERROR",
        error: { code: "ECONNRESET" },
      },
    });
    expect(JSON.stringify(event.details)).toContain("db exploded");
  });

  it("lists and reads events through the router for Admin sessions only", async () => {
    const admin = await makeUser("Admin", "diag-router-events");
    const user = await makeUser("User", "diag-router-events-user");
    const event = await getPrisma().diagnosticEvent.create({
      data: {
        id: "c5d6e7f8-3333-4333-8333-333333333333",
        createdAt: new Date("2026-09-12T10:00:00.000Z"),
        runtime: "web",
        severity: "error",
        category: "trpc",
        event: "trpc.error",
        message: "router target",
        details: { error: { name: "Error", message: "boom" } },
      },
    });
    const caller = callerFor(admin);
    const page = await caller.diagnostics.listEvents({
      severity: "error",
      reference: "c5d6e7f8",
      since: new Date("2026-09-12T00:00:00.000Z"),
    });
    expect(page.items.map((item) => item.id)).toEqual([event.id]);
    expect(
      await caller.diagnostics.getEvent({ reference: "c5d6e7f8" }),
    ).toMatchObject({
      event: { id: event.id, details: { error: { message: "boom" } } },
      body: null,
    });
    await expect(
      callerFor(user).diagnostics.listEvents({}),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("exposes settings, stats, and prune to Admin sessions only", async () => {
    const admin = await makeUser("Admin", "diag-router");
    const user = await makeUser("User", "diag-router-user");
    const caller = callerFor(admin);
    expect(await caller.diagnostics.getSettings()).toMatchObject({
      settings: { level: "standard" },
      stats: { rows: 0 },
    });
    const updated = await caller.diagnostics.setSettings({
      level: "verbose",
      verboseRetentionHours: 6,
    });
    expect(updated.settings).toMatchObject({
      level: "verbose",
      verboseRetentionHours: 6,
    });
    expect(await caller.diagnostics.prune()).toMatchObject({ batches: 0 });
    await expect(
      callerFor(user).diagnostics.getSettings(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads and updates retention settings as admin only", async () => {
    const admin = await makeUser("Admin", "ret-trpc");
    const caller = callerFor(admin);
    expect(await caller.diagnostics.getRetentionSettings()).toEqual({
      settings: {
        ingestionDays: 30,
        assistantConversationDays: 90,
        taskRunDays: 30,
        aiUsageDays: 90,
      },
    });
    const updated = await caller.diagnostics.setRetentionSettings({
      ingestionDays: 7,
    });
    expect(updated.settings.ingestionDays).toBe(7);
    await expect(
      caller.diagnostics.setRetentionSettings({ taskRunDays: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const user = await makeUser("User", "ret-user");
    await expect(
      callerFor(user).diagnostics.getRetentionSettings(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

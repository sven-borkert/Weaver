import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import {
  createAdapterForSnapshot,
  createDbCredentialSource,
} from "../ai/registry";
import { composeDocumentFile } from "../documents/frontmatter";
import { emitDiagnostic } from "../diagnostics/writer";
import { requestKnowledgeJob } from "../jobs/queue";
import { recordAiUsage } from "./aiUsage";
import {
  queueDocumentChangeSummary,
  runDocumentChangeSummary,
} from "./documentChangeSummaries";
import { resolveLlmRoute, type LlmModelSnapshot } from "./llmRoutes";

vi.mock("../diagnostics/writer", () => ({ emitDiagnostic: vi.fn() }));
vi.mock("../jobs/queue", () => ({ requestKnowledgeJob: vi.fn() }));
vi.mock("./llmRoutes", () => ({ resolveLlmRoute: vi.fn() }));
vi.mock("./documents", () => ({ saveDocument: vi.fn() }));
vi.mock("@weaver/git-store", () => ({ openProjectRepo: vi.fn() }));
vi.mock("../ai/registry", () => ({
  createAdapterForSnapshot: vi.fn(),
  createDbCredentialSource: vi.fn(),
}));
vi.mock("./aiUsage", () => ({ recordAiUsage: vi.fn() }));

const payload = {
  projectId: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  commitSha: "b".repeat(40),
  baseCommitSha: "a".repeat(40),
  pathAtSha: "doc.md",
};

function fakeDb(create = vi.fn(async () => ({}))) {
  return {
    db: { documentChangeSummary: { create } } as unknown as PrismaClient,
    create,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  vi.mocked(resolveLlmRoute).mockResolvedValue({} as LlmModelSnapshot);
  vi.mocked(requestKnowledgeJob).mockResolvedValue("job-1");
});
afterEach(() => vi.unstubAllEnvs());

describe("queueDocumentChangeSummary", () => {
  it("inserts a pending row and publishes the job", async () => {
    const { db, create } = fakeDb();
    await queueDocumentChangeSummary(db, payload);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ...payload,
        status: "pending",
      }) as object,
    });
    expect(requestKnowledgeJob).toHaveBeenCalledWith(
      "document.change-summary",
      payload,
    );
    expect(emitDiagnostic).not.toHaveBeenCalled();
  });

  it("writes nothing without a ready route or with jobs disabled", async () => {
    const { db, create } = fakeDb();
    vi.mocked(resolveLlmRoute).mockResolvedValueOnce(null);
    await queueDocumentChangeSummary(db, payload);
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");
    await queueDocumentChangeSummary(db, payload);
    expect(create).not.toHaveBeenCalled();
    expect(requestKnowledgeJob).not.toHaveBeenCalled();
    expect(emitDiagnostic).not.toHaveBeenCalled();
  });

  it("reports a failed insert as a failed enqueue", async () => {
    const { db } = fakeDb(
      vi.fn(async () => {
        throw new Error("insert failed");
      }),
    );
    await queueDocumentChangeSummary(db, payload);
    expect(requestKnowledgeJob).not.toHaveBeenCalled();
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "document.summary.failed",
        severity: "error",
        details: expect.objectContaining({
          reason: "enqueue",
          commitSha: payload.commitSha,
        }) as object,
      }),
    );
  });

  it("keeps the pending row and warns when publishing fails", async () => {
    const { db, create } = fakeDb();
    vi.mocked(requestKnowledgeJob).mockRejectedValueOnce(new Error("down"));
    await queueDocumentChangeSummary(db, payload);
    expect(create).toHaveBeenCalledOnce();
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "document.summary.retrying",
        severity: "warn",
        details: expect.objectContaining({
          reason: "enqueue",
          attempt: 0,
        }) as object,
      }),
    );
  });
});

describe("runDocumentChangeSummary", () => {
  it("reports a failed usage write without failing the summary", async () => {
    const file = (body: string) =>
      composeDocumentFile(
        {
          id: payload.documentId,
          title: "Doc",
          created: "2026-09-16T00:00:00.000Z",
          createdBy: null,
          updated: "2026-09-16T00:00:00.000Z",
          updatedBy: null,
          review: null,
        },
        body,
        "markdown",
      );
    const readCommittedFileAt = vi.fn(async (sha: string) => ({
      content: file(sha === payload.baseCommitSha ? "Old body" : "New body"),
      baseCommitSha: sha,
    }));
    const renamedPathBetween = vi.fn(async () => null);
    vi.mocked(openProjectRepo).mockResolvedValue({
      readCommittedFileAt,
      renamedPathBetween,
    } as never);
    vi.mocked(createDbCredentialSource).mockReturnValue({} as never);
    vi.mocked(createAdapterForSnapshot).mockReturnValue({
      completeText: vi.fn(async () => ({
        text: "Rewrite the body",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          totalTokens: 2,
          durationMs: 1,
        },
      })),
    } as never);
    vi.mocked(recordAiUsage).mockRejectedValue(new TypeError("db down"));
    vi.mocked(resolveLlmRoute).mockResolvedValue({
      connectionId: "connection",
      providerType: "openai_compatible",
      providerModelId: "model",
      contextWindow: 16_000,
      maxOutputTokens: 512,
      currency: null,
    } as LlmModelSnapshot);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      documentChangeSummary: {
        findUnique: vi.fn(async () => ({
          status: "pending",
          attempts: 0,
          failureReason: null,
          basePathAtSha: "old-doc.md",
        })),
        updateMany,
      },
    } as unknown as PrismaClient;

    await runDocumentChangeSummary(
      db,
      payload,
      { jobId: "job-1", retryCount: 0, signal: new AbortController().signal },
      { ring: null },
    );

    expect(readCommittedFileAt).toHaveBeenCalledWith(
      payload.baseCommitSha,
      "old-doc.md",
    );
    expect(renamedPathBetween).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attempts: 1,
          lastJobId: "job-1",
        }) as object,
      }),
    );
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "document.summary.usage_failed",
        severity: "warn",
        outcome: "error",
        details: expect.objectContaining({
          outcome: "success",
          errorClass: "TypeError",
          commitSha: payload.commitSha,
        }) as object,
      }),
    );
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "document.summary.completed" }),
    );
  });
});

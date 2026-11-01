import { describe, expect, it, vi } from "vitest";
import { emitDiagnostic } from "../diagnostics/writer";
import { recordAiUsageSafely } from "./aiUsageBestEffort";

vi.mock("../diagnostics/writer", () => ({ emitDiagnostic: vi.fn() }));

describe("best-effort usage accounting", () => {
  it("reports a correlated failure without leaking the database error or changing the provider outcome", async () => {
    const record = vi.fn(async () => {
      throw new Error("secret provider content");
    });
    const input = {
      projectId: "project",
      documentId: "document",
      runId: "run",
      jobId: "job",
      connectionId: "connection",
      operation: "ingestion.ocr",
      outcome: "success" as const,
      provider: "openai_compatible",
      model: "model",
      configFingerprint: "fingerprint",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        totalTokens: 3,
        durationMs: 10,
      },
      pricing: { inputCostMicrosPerMillion: 1, outputCostMicrosPerMillion: 2 },
    };
    expect(await recordAiUsageSafely({} as never, input, record)).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(emitDiagnostic).toHaveBeenCalledWith({
      event: "ai.usage.failed",
      severity: "warn",
      message: "AI usage could not be recorded",
      outcome: "error",
      projectId: "project",
      documentId: "document",
      runId: "run",
      jobId: "job",
      connectionId: "connection",
      details: {
        operation: "ingestion.ocr",
        usageOutcome: "success",
        failureKind: "accounting",
      },
    });
  });
});

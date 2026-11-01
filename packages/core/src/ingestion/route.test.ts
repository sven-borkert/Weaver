import { describe, expect, it } from "vitest";
import type { LlmModelSnapshot } from "../services/llmRoutes";
import {
  INGESTION_ANALYZE_PROMPT_VERSION,
  ingestionRouteFingerprint,
  ingestionRouteSnapshot,
} from "./route";

const snapshot: LlmModelSnapshot = {
  connectionId: "c1",
  connectionName: "Provider",
  providerType: "openai_compatible",
  endpoint: "https://ai.test/v1",
  requestTimeoutMs: 1000,
  enabled: true,
  modelId: "m1",
  providerModelId: "vision-model",
  displayName: "Vision",
  contextWindow: 128_000,
  maxOutputTokens: 8192,
  embeddingDimensions: null,
  embeddingDimensionMode: "native",
  upstreamProvider: null,
  reasoningMode: "provider_default",
  capabilities: ["chat", "vision"],
  inputCostMicrosPerMillion: null,
  outputCostMicrosPerMillion: null,
  currency: null,
};

describe("ingestion route snapshot", () => {
  it("excludes credentials, prices, and timeouts from the fingerprint", () => {
    const a = ingestionRouteFingerprint(snapshot);
    const b = ingestionRouteFingerprint({
      ...snapshot,
      connectionId: "other",
      requestTimeoutMs: 5,
      inputCostMicrosPerMillion: 10,
    });
    expect(a).toBe(b);
    expect(
      ingestionRouteFingerprint({ ...snapshot, providerModelId: "x" }),
    ).not.toBe(a);
  });

  it("records the non-secret identity", () => {
    expect(ingestionRouteSnapshot(snapshot)).toEqual({
      connectionId: "c1",
      providerType: "openai_compatible",
      endpoint: "https://ai.test/v1",
      modelId: "m1",
      providerModelId: "vision-model",
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      promptVersion: "ingestion-ocr-v1",
      configFingerprint: ingestionRouteFingerprint(snapshot),
    });
  });

  it("distinguishes the analysis prompt from the OCR prompt in the fingerprint", () => {
    expect(ingestionRouteFingerprint(snapshot)).not.toBe(
      ingestionRouteFingerprint(snapshot, INGESTION_ANALYZE_PROMPT_VERSION),
    );
    expect(
      ingestionRouteSnapshot(snapshot, INGESTION_ANALYZE_PROMPT_VERSION)
        .promptVersion,
    ).toBe("ingestion-analyze-v1");
  });
});

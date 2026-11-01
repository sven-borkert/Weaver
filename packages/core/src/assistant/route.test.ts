import { describe, expect, it } from "vitest";
import type { LlmModelSnapshot } from "../services/llmRoutes";
import { assistantRouteFingerprint, assistantRouteSnapshot } from "./route";

const model: LlmModelSnapshot = {
  connectionId: "c1",
  connectionName: "Conn",
  providerType: "openai_compatible",
  endpoint: "https://ai.test/v1",
  requestTimeoutMs: 1000,
  enabled: true,
  modelId: "m1",
  providerModelId: "gpt-x",
  displayName: "GPT X",
  contextWindow: 128000,
  embeddingDimensions: null,
  embeddingDimensionMode: "native",
  upstreamProvider: null,
  reasoningMode: "provider_default",
  capabilities: ["chat", "tool_use"],
  inputCostMicrosPerMillion: 1,
  outputCostMicrosPerMillion: 2,
  currency: "USD",
};

describe("assistant route snapshot", () => {
  it("excludes prices, names, and timeouts from the fingerprint", () => {
    const a = assistantRouteFingerprint(model);
    const b = assistantRouteFingerprint({
      ...model,
      connectionId: "c2",
      connectionName: "Other",
      requestTimeoutMs: 5,
      inputCostMicrosPerMillion: 99,
    });
    const c = assistantRouteFingerprint({ ...model, providerModelId: "gpt-y" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("keeps only non-secret route fields", () => {
    expect(assistantRouteSnapshot(model)).toEqual({
      connectionId: "c1",
      providerType: "openai_compatible",
      endpoint: "https://ai.test/v1",
      modelId: "m1",
      providerModelId: "gpt-x",
      contextWindow: 128000,
      maxOutputTokens: null,
      promptVersion: "assistant-v2",
      configFingerprint: assistantRouteFingerprint(model),
    });
  });
});

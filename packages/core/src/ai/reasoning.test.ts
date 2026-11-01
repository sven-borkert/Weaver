import { describe, expect, it } from "vitest";

import {
  aiSdkReasoning,
  anthropicThinkingParams,
  openAiReasoningParams,
} from "./reasoning";

describe("reasoning parameters", () => {
  it("sends reasoning_effort only for an explicit mode", () => {
    expect(openAiReasoningParams(undefined)).toEqual({});
    expect(openAiReasoningParams("provider_default")).toEqual({});
    expect(openAiReasoningParams("none")).toEqual({ reasoning_effort: "none" });
    expect(openAiReasoningParams("high")).toEqual({ reasoning_effort: "high" });
  });

  it("enables Anthropic thinking only with room left for the answer", () => {
    expect(anthropicThinkingParams("none", 4096)).toEqual({});
    expect(anthropicThinkingParams("provider_default", 4096)).toEqual({});
    expect(anthropicThinkingParams("low", 4096)).toEqual({
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect(anthropicThinkingParams("high", 4096)).toEqual({
      thinking: { type: "enabled", budget_tokens: 3072 },
    });
    expect(anthropicThinkingParams("high", 32_768)).toEqual({
      thinking: { type: "enabled", budget_tokens: 16_384 },
    });
    expect(anthropicThinkingParams("medium", 1500)).toEqual({});
  });

  it("maps to the AI SDK's generic reasoning option", () => {
    expect(aiSdkReasoning(undefined)).toBeUndefined();
    expect(aiSdkReasoning("provider_default")).toBeUndefined();
    expect(aiSdkReasoning("none")).toBe("none");
    expect(aiSdkReasoning("medium")).toBe("medium");
  });
});

import type { LlmReasoningMode } from "@weaver/db/client";

/** `reasoning_effort` for OpenAI-style chat completions; LiteLLM maps it onto each provider's thinking controls. */
export function openAiReasoningParams(mode: LlmReasoningMode | undefined): {
  reasoning_effort?: "none" | "low" | "medium" | "high";
} {
  return mode === undefined || mode === "provider_default"
    ? {}
    : { reasoning_effort: mode };
}

const ANTHROPIC_THINKING_BUDGETS = { low: 1_024, medium: 4_096, high: 16_384 };
const ANTHROPIC_MIN_ANSWER_TOKENS = 1_024;

/** Anthropic thinking is opt-in, so `none` and the default send nothing; the budget must leave room for the answer. */
export function anthropicThinkingParams(
  mode: LlmReasoningMode | undefined,
  maxTokens: number,
): { thinking?: { type: "enabled"; budget_tokens: number } } {
  if (mode !== "low" && mode !== "medium" && mode !== "high") return {};
  const budget = Math.min(
    ANTHROPIC_THINKING_BUDGETS[mode],
    maxTokens - ANTHROPIC_MIN_ANSWER_TOKENS,
  );
  if (budget < ANTHROPIC_THINKING_BUDGETS.low) return {};
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

/** The AI SDK's provider-agnostic `reasoning` call option. */
export function aiSdkReasoning(
  mode: LlmReasoningMode | undefined,
): "none" | "low" | "medium" | "high" | undefined {
  return mode === undefined || mode === "provider_default" ? undefined : mode;
}

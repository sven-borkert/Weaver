import { createHash } from "node:crypto";
import type { LlmModelSnapshot } from "@weaver/core/services/llmRoutes";

export const WIKI_MIN_CONTEXT_WINDOW = 100_000;
export const WIKI_MIN_OUTPUT_TOKENS = 8_192;
export const WIKI_PROMPT_VERSION = "wiki-v1";
export function routeUnsuitableReason(
  route: LlmModelSnapshot | null,
): string | null {
  if (!route) return "no model is routed to the wiki agent";
  if ((route.contextWindow ?? 0) < WIKI_MIN_CONTEXT_WINDOW)
    return `the wiki model needs a context window of at least ${WIKI_MIN_CONTEXT_WINDOW}`;
  if ((route.maxOutputTokens ?? 0) < WIKI_MIN_OUTPUT_TOKENS)
    return `the wiki model needs a maximum output of at least ${WIKI_MIN_OUTPUT_TOKENS} tokens`;
  return null;
}

export function usageId(runId: string, attempt: number): string {
  const hex = createHash("sha256")
    .update(`wiki-run-usage:${runId}:${attempt}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function routeFingerprint(route: LlmModelSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        route.providerType,
        route.endpoint,
        route.providerModelId,
        WIKI_PROMPT_VERSION,
      ]),
    )
    .digest("hex");
}

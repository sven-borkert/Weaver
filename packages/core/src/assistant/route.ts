import { createHash } from "node:crypto";
import type { LlmModelSnapshot } from "../services/llmRoutes";

export const ASSISTANT_PROMPT_VERSION = "assistant-v2";

export type AssistantRouteSnapshot = {
  connectionId: string;
  providerType: LlmModelSnapshot["providerType"];
  endpoint: string;
  modelId: string;
  providerModelId: string;
  contextWindow: number | null;
  maxOutputTokens?: number | null;
  promptVersion: string;
  configFingerprint: string;
};

/** Mirrors 4C: identity excludes connection ids/names, credentials, prices, and timeouts. */
export function assistantRouteFingerprint(model: LlmModelSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        model.providerType,
        model.endpoint,
        model.providerModelId,
        ASSISTANT_PROMPT_VERSION,
      ]),
    )
    .digest("hex");
}

export function assistantRouteSnapshot(
  model: LlmModelSnapshot,
): AssistantRouteSnapshot {
  return {
    connectionId: model.connectionId,
    providerType: model.providerType,
    endpoint: model.endpoint,
    modelId: model.modelId,
    providerModelId: model.providerModelId,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? null,
    promptVersion: ASSISTANT_PROMPT_VERSION,
    configFingerprint: assistantRouteFingerprint(model),
  };
}

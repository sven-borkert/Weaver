import { createHash } from "node:crypto";
import type { LlmModelSnapshot } from "../services/llmRoutes";

export const INGESTION_OCR_PROMPT_VERSION = "ingestion-ocr-v1";
export const INGESTION_ANALYZE_PROMPT_VERSION = "ingestion-analyze-v1";

export type IngestionRouteSnapshot = {
  connectionId: string;
  providerType: LlmModelSnapshot["providerType"];
  endpoint: string;
  modelId: string;
  providerModelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  promptVersion: string;
  configFingerprint: string;
};

/** Mirrors assistant/route.ts: identity excludes connection ids/names, credentials, prices, and timeouts. */
export function ingestionRouteFingerprint(
  model: LlmModelSnapshot,
  promptVersion: string = INGESTION_OCR_PROMPT_VERSION,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        model.providerType,
        model.endpoint,
        model.providerModelId,
        promptVersion,
      ]),
    )
    .digest("hex");
}

export function ingestionRouteSnapshot(
  model: LlmModelSnapshot,
  promptVersion: string = INGESTION_OCR_PROMPT_VERSION,
): IngestionRouteSnapshot {
  return {
    connectionId: model.connectionId,
    providerType: model.providerType,
    endpoint: model.endpoint,
    modelId: model.modelId,
    providerModelId: model.providerModelId,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? null,
    promptVersion,
    configFingerprint: ingestionRouteFingerprint(model, promptVersion),
  };
}

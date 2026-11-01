import type { LlmModelCapability, LlmProviderType } from "@weaver/db/client";

import type { DiscoveredModel } from "./adapter";
import { isRecord } from "./http";
import { NON_LLM_ID_PATTERN, lookupModelCatalog } from "./modelCatalog";
import {
  POSTGRES_INTEGER_MAX,
  MAX_EMBEDDING_DIMENSIONS,
  MAX_LLM_NAME_LENGTH,
  MAX_PROVIDER_MODEL_ID_LENGTH,
} from "./validation";

export const MAX_DISPLAY_NAME = MAX_LLM_NAME_LENGTH;
const CAPABILITY_ORDER: LlmModelCapability[] = [
  "chat",
  "json_output",
  "tool_use",
  "vision",
  "embedding",
];

export function optionalPositiveInt(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= POSTGRES_INTEGER_MAX
    ? value
    : null;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function normalizeCapabilities(
  capabilities: Iterable<LlmModelCapability>,
): LlmModelCapability[] {
  const set = new Set(capabilities);
  return CAPABILITY_ORDER.filter((capability) => set.has(capability));
}

export function unknownModel(
  providerModelId: string,
  displayName: string | null = null,
): DiscoveredModel {
  return {
    providerModelId,
    displayName: displayName ?? providerModelId,
    contextWindow: null,
    maxOutputTokens: null,
    embeddingDimensions: null,
    capabilities: [],
    source: "inferred",
  };
}

/** Marks a model as endpoint-sourced when the adapter learned anything about it. */
export function withReportedSource(model: DiscoveredModel): DiscoveredModel {
  const reported =
    model.contextWindow !== null ||
    model.maxOutputTokens !== null ||
    model.embeddingDimensions !== null ||
    model.capabilities.length > 0;
  return { ...model, source: reported ? "endpoint" : "inferred" };
}

/** OpenAI `/v1/models` items plus common OpenRouter, vLLM, and LiteLLM extensions. */
export function discoveredModelFromOpenAiItem(
  item: unknown,
): DiscoveredModel | null {
  if (!isRecord(item)) return null;
  const providerModelId = optionalString(item.id);
  if (providerModelId === null) return null;
  const capabilities: LlmModelCapability[] = [];
  if (Array.isArray(item.supported_parameters)) {
    const parameters = new Set(item.supported_parameters);
    capabilities.push("chat");
    if (parameters.has("tools")) capabilities.push("tool_use");
    if (
      parameters.has("response_format") ||
      parameters.has("structured_outputs")
    )
      capabilities.push("json_output");
  }
  const modalities =
    isRecord(item.architecture) &&
    Array.isArray(item.architecture.input_modalities)
      ? item.architecture.input_modalities
      : [];
  if (item.supports_vision === true || modalities.includes("image")) {
    capabilities.push("chat", "vision");
  }
  // LiteLLM attaches `mode` when it knows the model; only "embedding" asserts a capability.
  if (optionalString(item.mode)?.toLowerCase() === "embedding") {
    capabilities.push("embedding");
  }
  return withReportedSource({
    ...unknownModel(providerModelId, optionalString(item.name)),
    contextWindow:
      optionalPositiveInt(item.context_length) ??
      optionalPositiveInt(item.max_model_len) ??
      optionalPositiveInt(item.max_input_tokens),
    maxOutputTokens:
      (isRecord(item.top_provider)
        ? optionalPositiveInt(item.top_provider.max_completion_tokens)
        : null) ?? optionalPositiveInt(item.max_output_tokens),
    capabilities: normalizeCapabilities(capabilities),
  });
}

export type LiteLlmModelInfo = {
  mode: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  supportsFunctionCalling: boolean | null;
  outputVectorSize: number | null;
};

/** LiteLLM `/model/info` entries keyed by public model name; unusable entries are skipped. */
export function liteLlmModelInfoById(
  body: unknown,
): Map<string, LiteLlmModelInfo> {
  const result = new Map<string, LiteLlmModelInfo>();
  if (!isRecord(body) || !Array.isArray(body.data)) return result;
  for (const entry of body.data as unknown[]) {
    if (!isRecord(entry) || !isRecord(entry.model_info)) continue;
    const name = optionalString(entry.model_name);
    if (name === null || result.has(name)) continue;
    const info = entry.model_info;
    result.set(name, {
      mode: optionalString(info.mode)?.toLowerCase() ?? null,
      maxInputTokens: optionalPositiveInt(info.max_input_tokens),
      maxOutputTokens: optionalPositiveInt(info.max_output_tokens),
      supportsFunctionCalling:
        typeof info.supports_function_calling === "boolean"
          ? info.supports_function_calling
          : null,
      outputVectorSize: optionalPositiveInt(info.output_vector_size),
    });
  }
  return result;
}

const LITELLM_CHAT_BASELINE: LlmModelCapability[] = ["chat", "json_output"];

/** Applies only what LiteLLM asserts: embedding mode, explicit function calling, and limits the list omitted. */
export function applyLiteLlmModelInfo(
  model: DiscoveredModel,
  info: LiteLlmModelInfo,
): DiscoveredModel {
  let capabilities = model.capabilities;
  let embeddingDimensions = model.embeddingDimensions;
  if (info.mode === "embedding") {
    capabilities = ["embedding"];
    embeddingDimensions ??= info.outputVectorSize;
  } else if (info.supportsFunctionCalling === true) {
    capabilities = normalizeCapabilities([
      ...(capabilities.length > 0 ? capabilities : LITELLM_CHAT_BASELINE),
      "tool_use",
    ]);
  }
  return withReportedSource({
    ...model,
    contextWindow: model.contextWindow ?? info.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens ?? info.maxOutputTokens,
    embeddingDimensions,
    capabilities,
  });
}

export function defaultCapabilities(
  providerType: LlmProviderType,
  providerModelId: string,
): LlmModelCapability[] {
  if (NON_LLM_ID_PATTERN.test(providerModelId)) return [];
  if (/embed/i.test(providerModelId)) return ["embedding"];
  switch (providerType) {
    case "anthropic":
      return ["chat", "json_output", "tool_use"];
    case "openai_compatible":
      return ["chat", "json_output"];
    default:
      return ["chat"];
  }
}

function clampDimensions(value: number | null): number | null {
  return value !== null && value >= 1 && value <= MAX_EMBEDDING_DIMENSIONS
    ? value
    : null;
}

/** Dedupe, fill gaps from the catalog or defaults, and bound every field for the UI. */
export function finalizeDiscoveredModels(
  providerType: LlmProviderType,
  models: readonly DiscoveredModel[],
): DiscoveredModel[] {
  const seen = new Set<string>();
  const result: DiscoveredModel[] = [];
  for (const model of models) {
    if (
      !model.providerModelId.trim() ||
      model.providerModelId.length > MAX_PROVIDER_MODEL_ID_LENGTH ||
      seen.has(model.providerModelId)
    )
      continue;
    seen.add(model.providerModelId);
    const catalog = lookupModelCatalog(providerType, model.providerModelId);
    let capabilities = normalizeCapabilities(model.capabilities);
    if (capabilities.length === 0) {
      capabilities =
        catalog && catalog.capabilities.length > 0
          ? catalog.capabilities
          : defaultCapabilities(providerType, model.providerModelId);
    }
    const isEmbedding = capabilities.includes("embedding");
    result.push({
      providerModelId: model.providerModelId,
      displayName: (model.displayName.trim() || model.providerModelId).slice(
        0,
        MAX_DISPLAY_NAME,
      ),
      contextWindow: model.contextWindow ?? catalog?.contextWindow ?? null,
      maxOutputTokens:
        model.maxOutputTokens ?? catalog?.maxOutputTokens ?? null,
      embeddingDimensions: isEmbedding
        ? clampDimensions(
            model.embeddingDimensions ?? catalog?.embeddingDimensions ?? null,
          )
        : null,
      capabilities,
      source:
        model.source === "endpoint"
          ? "endpoint"
          : catalog
            ? "catalog"
            : "inferred",
    });
  }
  return result;
}

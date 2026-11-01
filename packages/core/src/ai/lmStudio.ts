import type { LlmModelCapability } from "@weaver/db/client";

import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderAdapterConfig,
} from "./adapter";
import { boundedJsonRequest, isRecord, validationError } from "./http";
import {
  optionalPositiveInt,
  optionalString,
  unknownModel,
  withReportedSource,
} from "./modelDiscovery";
import {
  bearerHeaders,
  createOpenAiCompatibleAdapter,
} from "./openaiCompatible";

// LM Studio's server implements response_format and tool calling for every chat model.
const LM_STUDIO_TYPE_CAPABILITIES: Record<string, LlmModelCapability[]> = {
  llm: ["chat", "json_output", "tool_use"],
  vlm: ["chat", "json_output", "tool_use", "vision"],
  embeddings: ["embedding"],
};

/** The stored endpoint is the server root; chat/embeddings go to `/v1`, discovery to `/api/v0`. */
export function createLmStudioAdapter(
  config: ProviderAdapterConfig,
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  const root = config.baseUrl.replace(/\/+$/, "");
  const inner = createOpenAiCompatibleAdapter(
    { ...config, baseUrl: `${root}/v1` },
    fetchImpl,
    "lmstudio",
  );

  return {
    ...inner,
    providerType: "lmstudio",
    async listModels(options) {
      // Bounded request directly: the /v1 wrapper would parse a non-OpenAI `usage` key.
      const { body, durationMs } = await boundedJsonRequest({
        fetchImpl,
        url: `${root}/api/v0/models`,
        method: "GET",
        headers: bearerHeaders(await config.resolveCredential()),
        timeoutMs: config.requestTimeoutMs,
        signal: options?.signal,
      });
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw validationError("AI provider returned an invalid model list");
      }
      const models = (body.data as unknown[])
        .map(discoveredModelFromLmStudioItem)
        .filter((model) => model !== null);
      return { models, durationMs };
    },
  };
}

function discoveredModelFromLmStudioItem(
  item: unknown,
): DiscoveredModel | null {
  if (!isRecord(item)) return null;
  const providerModelId = optionalString(item.id);
  if (providerModelId === null) return null;
  const type = optionalString(item.type);
  return withReportedSource({
    ...unknownModel(providerModelId),
    contextWindow: optionalPositiveInt(item.max_context_length),
    capabilities:
      type !== null ? (LM_STUDIO_TYPE_CAPABILITIES[type] ?? []) : [],
  });
}

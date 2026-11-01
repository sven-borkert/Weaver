import type { LlmModelCapability } from "@weaver/db/client";

import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderAdapterConfig,
} from "./adapter";
import { MAX_DISCOVERED_MODELS } from "./adapter";
import { mapWithConcurrency } from "./concurrency";
import {
  boundedJsonRequest,
  isRecord,
  providerError,
  validationError,
} from "./http";
import {
  normalizeCapabilities,
  optionalPositiveInt,
  optionalString,
  unknownModel,
  withReportedSource,
} from "./modelDiscovery";
import {
  bearerHeaders,
  createOpenAiCompatibleAdapter,
} from "./openaiCompatible";
import { AiProviderError, type AiCallOptions } from "./types";

/** Per-model `/api/show` calls are bounded; models past the cap keep unknown metadata. */
export const MAX_OLLAMA_SHOW_CALLS = 100;
export const MODEL_DISCOVERY_DEADLINE_MESSAGE =
  "AI provider model discovery deadline exceeded";
const SHOW_CONCURRENCY = 4;

/** The stored endpoint is the server root; chat/embeddings go to `/v1`, discovery to `/api`. */
export function createOllamaAdapter(
  config: ProviderAdapterConfig,
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  const root = config.baseUrl.replace(/\/+$/, "");
  const inner = createOpenAiCompatibleAdapter(
    { ...config, baseUrl: `${root}/v1` },
    fetchImpl,
    "ollama",
    { embeddingDimensionsTransport: "matryoshka" },
  );

  async function nativeRequest(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    credential: string,
    options?: AiCallOptions,
  ): Promise<unknown> {
    // Bounded request directly: the /v1 wrapper would parse a non-OpenAI `usage` key.
    const { body } = await boundedJsonRequest({
      fetchImpl,
      url: `${root}${path}`,
      method,
      headers: bearerHeaders(credential),
      payload,
      timeoutMs: config.requestTimeoutMs,
      signal: options?.signal,
    });
    return body;
  }

  return {
    ...inner,
    providerType: "ollama",
    async listModels(options) {
      const startedAt = Date.now();
      const callerSignal = options?.signal;
      const deadline = AbortSignal.timeout(60_000);
      options = {
        signal: options?.signal
          ? AbortSignal.any([options.signal, deadline])
          : deadline,
      };
      try {
        options.signal?.throwIfAborted();
        const credential = await config.resolveCredential();
        const tags = await nativeRequest(
          "GET",
          "/api/tags",
          undefined,
          credential,
          options,
        );
        if (!isRecord(tags) || !Array.isArray(tags.models)) {
          throw validationError("AI provider returned an invalid model list");
        }
        const names = (tags.models as unknown[])
          .map((item) => (isRecord(item) ? optionalString(item.name) : null))
          .filter((name) => name !== null)
          .slice(0, MAX_DISCOVERED_MODELS);
        const enriched = await mapWithConcurrency(
          names.slice(0, MAX_OLLAMA_SHOW_CALLS),
          SHOW_CONCURRENCY,
          async (name) => {
            options?.signal?.throwIfAborted();
            try {
              // Never `verbose: true`: tokenizer arrays would exceed the response cap.
              const shown = await nativeRequest(
                "POST",
                "/api/show",
                { model: name },
                credential,
                options,
              );
              return discoveredModelFromOllamaShow(name, shown);
            } catch (error) {
              // One broken model must not fail the whole listing.
              if (error instanceof AiProviderError) return unknownModel(name);
              throw error;
            }
          },
        );
        const models = names.map(
          (name, index) => enriched[index] ?? unknownModel(name),
        );
        return { models, durationMs: Date.now() - startedAt };
      } catch (error) {
        if (deadline.aborted && !callerSignal?.aborted) {
          throw providerError(MODEL_DISCOVERY_DEADLINE_MESSAGE, true);
        }
        throw error;
      }
    },
  };
}

function discoveredModelFromOllamaShow(
  name: string,
  shown: unknown,
): DiscoveredModel {
  if (!isRecord(shown)) return unknownModel(name);
  const capabilities: LlmModelCapability[] = [];
  if (Array.isArray(shown.capabilities)) {
    const reported = new Set(shown.capabilities);
    // Ollama honours `format` / `response_format` for every completion model.
    if (reported.has("completion")) capabilities.push("chat", "json_output");
    if (reported.has("tools")) capabilities.push("tool_use");
    if (reported.has("vision")) capabilities.push("vision");
    if (reported.has("embedding")) capabilities.push("embedding");
  }
  const info = isRecord(shown.model_info) ? shown.model_info : {};
  const arch = optionalString(info["general.architecture"]);
  const isEmbedding = capabilities.includes("embedding");
  return withReportedSource({
    ...unknownModel(name),
    contextWindow:
      arch === null
        ? null
        : optionalPositiveInt(info[`${arch}.context_length`]),
    // For chat models `embedding_length` is the hidden size, not an output dimension.
    embeddingDimensions:
      arch !== null && isEmbedding
        ? optionalPositiveInt(info[`${arch}.embedding_length`])
        : null,
    capabilities: normalizeCapabilities(capabilities),
  });
}

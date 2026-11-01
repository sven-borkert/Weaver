import type { LlmProviderType } from "@weaver/db/client";

import {
  MAX_DISCOVERED_MODELS,
  type ProviderAdapter,
  type ProviderAdapterConfig,
} from "./adapter";
import {
  finalizeEmbeddingVector,
  type EmbeddingDimensionsRequest,
} from "./embeddingDimensions";
import {
  EXTRACTION_SYSTEM_MESSAGE,
  MAX_TEXT_COMPLETION_RESPONSE_BYTES,
  boundedJsonRequest,
  emptyUsage,
  extractWithCorrection,
  formatExtractionDocument,
  isRecord,
  jsonRequestByteLength,
  parseTokenCount,
  validationError,
  withUsage,
} from "./http";
import {
  applyLiteLlmModelInfo,
  discoveredModelFromOpenAiItem,
  liteLlmModelInfoById,
} from "./modelDiscovery";
import type { AiCallOptions, AiUsageSample } from "./types";
import { AiProviderError } from "./types";
import { openAiReasoningParams } from "./reasoning";
import { isValidEmbeddingVector } from "./validation";

export const EMBEDDING_PROBE_INPUT = "Weaver dimension probe";

export type EmbeddingDimensionsTransport =
  "never" | "matryoshka" | "openai_text_embedding_3";

export type OpenAiCompatibleAdapterOptions = {
  embeddingDimensionsTransport?: EmbeddingDimensionsTransport;
  /** Also read LiteLLM's `/model/info` during discovery; other servers answer 404 and the public list stands alone. */
  liteLlmModelInfo?: boolean;
  openRouter?: boolean;
};

/** Local servers accept requests without a key; never send an empty bearer. */
export function bearerHeaders(apiKey: string): Record<string, string> {
  return apiKey === "" ? {} : { Authorization: `Bearer ${apiKey}` };
}

export function createOpenAiCompatibleAdapter(
  config: ProviderAdapterConfig,
  fetchImpl: typeof fetch = fetch,
  providerType: Exclude<LlmProviderType, "anthropic"> = "openai_compatible",
  adapterOptions: OpenAiCompatibleAdapterOptions = {},
): ProviderAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const completionTokenLimit = (tokens: number) => ({
    [providerType === "openai" ? "max_completion_tokens" : "max_tokens"]:
      tokens,
  });
  const providerRouting =
    adapterOptions.openRouter && config.upstreamProvider
      ? { provider: { only: [config.upstreamProvider] } }
      : {};

  function embeddingRequestPayload(
    model: string,
    input: string[],
    dimensions: EmbeddingDimensionsRequest,
  ) {
    const sendsDimensions =
      dimensions.mode === "matryoshka" &&
      (adapterOptions.embeddingDimensionsTransport === "matryoshka" ||
        (adapterOptions.embeddingDimensionsTransport ===
          "openai_text_embedding_3" &&
          /^text-embedding-3(?:-|$)/.test(model)));
    return {
      model,
      input,
      ...providerRouting,
      ...(sendsDimensions ? { dimensions: dimensions.size } : {}),
    };
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    options?: AiCallOptions,
    maxResponseBytes?: number,
  ) {
    options?.signal?.throwIfAborted();
    const apiKey = await config.resolveCredential();
    options?.signal?.throwIfAborted();
    const { body, durationMs } = await boundedJsonRequest({
      fetchImpl,
      url: `${baseUrl}${path}`,
      method,
      headers: bearerHeaders(apiKey),
      payload,
      timeoutMs: config.requestTimeoutMs,
      signal: options?.signal,
      maxResponseBytes,
    });
    const usage = parseUsage(body, durationMs);
    return {
      body,
      usage: path === "/embeddings" ? { ...usage, outputTokens: 0 } : usage,
    };
  }

  async function optionalLiteLlmModelInfo(options?: AiCallOptions) {
    try {
      const { body, usage } = await request(
        "GET",
        "/model/info",
        undefined,
        options,
      );
      return {
        entries: liteLlmModelInfoById(body),
        durationMs: usage.durationMs,
      };
    } catch (error) {
      if (error instanceof AiProviderError && !options?.signal?.aborted) {
        return null;
      }
      throw error;
    }
  }

  return {
    providerType,
    supportsEmbeddings: true,
    async completeText(model, input, options) {
      const { body, usage } = await request(
        "POST",
        "/chat/completions",
        {
          model,
          ...providerRouting,
          ...completionTokenLimit(input.maxOutputTokens),
          ...openAiReasoningParams(options?.reasoning),
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.prompt },
          ],
        },
        options,
        MAX_TEXT_COMPLETION_RESPONSE_BYTES,
      );
      const choice =
        isRecord(body) && Array.isArray(body.choices)
          ? (body.choices as unknown[])[0]
          : null;
      if (
        !isRecord(choice) ||
        choice.finish_reason !== "stop" ||
        !isRecord(choice.message) ||
        choice.message.role !== "assistant" ||
        typeof choice.message.content !== "string" ||
        !choice.message.content.trim() ||
        (choice.message.tool_calls != null &&
          (!Array.isArray(choice.message.tool_calls) ||
            choice.message.tool_calls.length > 0))
      ) {
        throw validationError("AI provider returned invalid completion", usage);
      }
      return { text: choice.message.content, usage };
    },
    async listModels(options) {
      const { body, usage } = await request(
        "GET",
        adapterOptions.openRouter
          ? `/models?limit=${MAX_DISCOVERED_MODELS}`
          : "/models",
        undefined,
        options,
      );
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw validationError("AI provider returned an invalid model list");
      }
      let models = (body.data as unknown[])
        .map(discoveredModelFromOpenAiItem)
        .filter((model) => model !== null);
      let durationMs = usage.durationMs;
      if (adapterOptions.openRouter) {
        const embeddings = await request(
          "GET",
          "/embeddings/models",
          undefined,
          options,
        );
        if (
          !isRecord(embeddings.body) ||
          !Array.isArray(embeddings.body.data)
        ) {
          throw validationError("AI provider returned an invalid model list");
        }
        const embeddingModels = (embeddings.body.data as unknown[])
          .map(discoveredModelFromOpenAiItem)
          .filter((model) => model !== null)
          .map((model) => ({
            ...model,
            maxOutputTokens: null,
            capabilities: ["embedding" as const],
            source: "endpoint" as const,
          }));
        durationMs += embeddings.usage.durationMs;
        const seen = new Set<string>();
        models = [...embeddingModels, ...models]
          .filter((model) => {
            if (seen.has(model.providerModelId)) return false;
            seen.add(model.providerModelId);
            return true;
          })
          .slice(0, MAX_DISCOVERED_MODELS);
      }
      if (adapterOptions.liteLlmModelInfo) {
        const info = await optionalLiteLlmModelInfo(options);
        if (info) {
          durationMs += info.durationMs;
          models = models.map((model) => {
            const entry = info.entries.get(model.providerModelId);
            return entry ? applyLiteLlmModelInfo(model, entry) : model;
          });
        }
      }
      return { models, durationMs };
    },
    async ping(model, options) {
      const { body, usage } = await request(
        "POST",
        "/chat/completions",
        {
          model,
          ...providerRouting,
          ...completionTokenLimit(1),
          messages: [{ role: "user", content: "ping" }],
        },
        options,
      );
      if (!isRecord(body) || !Array.isArray(body.choices)) {
        throw validationError(
          "AI provider returned an invalid completion",
          usage,
        );
      }
      return { usage };
    },
    async embed(model, input, dimensions, options) {
      const payload = embeddingRequestPayload(model, input, dimensions);
      const response = await request("POST", "/embeddings", payload, options);
      try {
        return {
          vectors: parseEmbeddingVectors(
            response.body,
            input.length,
            dimensions,
          ),
          usage: response.usage,
        };
      } catch (error) {
        throw withUsage(error, response.usage);
      }
    },
    embeddingRequestByteLength(model, input, dimensions) {
      return jsonRequestByteLength(
        embeddingRequestPayload(model, input, dimensions),
      );
    },
    async probeEmbeddingDimensions(model, options) {
      const response = await request(
        "POST",
        "/embeddings",
        { model, input: [EMBEDDING_PROBE_INPUT], ...providerRouting },
        options,
      );
      try {
        const [vector] = parseEmbeddingVectors(response.body, 1, null);
        return { dimensions: vector!.length, usage: response.usage };
      } catch (error) {
        throw withUsage(error, response.usage);
      }
    },
    async extract(model, input, options) {
      const messages = [
        { role: "system", content: EXTRACTION_SYSTEM_MESSAGE },
        { role: "user", content: formatExtractionDocument(input) },
      ];
      return extractWithCorrection(async (correction) => {
        const response = await request(
          "POST",
          "/chat/completions",
          {
            model,
            ...providerRouting,
            response_format: { type: "json_object" },
            tool_choice: "none",
            ...openAiReasoningParams(options?.reasoning),
            messages: correction
              ? [
                  ...messages,
                  { role: "assistant", content: correction.previousContent },
                  { role: "user", content: correction.message },
                ]
              : messages,
          },
          options,
        );
        try {
          return { ...extractionContent(response.body), usage: response.usage };
        } catch (error) {
          throw withUsage(error, response.usage);
        }
      }, options?.signal);
    },
  };
}

function parseEmbeddingVectors(
  body: unknown,
  expectedCount: number,
  dimensions: EmbeddingDimensionsRequest | null,
): number[][] {
  if (
    !isRecord(body) ||
    !Array.isArray(body.data) ||
    body.data.length !== expectedCount
  ) {
    throw validationError("AI provider returned invalid embeddings");
  }
  const vectors = new Array<number[]>(expectedCount);
  for (const item of body.data as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item.index !== "number" ||
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= expectedCount ||
      vectors[item.index] !== undefined
    ) {
      throw validationError("AI provider returned invalid embeddings");
    }
    if (dimensions === null) {
      if (!isValidEmbeddingVector(item.embedding, null)) {
        throw validationError("AI provider returned invalid embeddings");
      }
      vectors[item.index] = item.embedding;
    } else {
      vectors[item.index] = finalizeEmbeddingVector(item.embedding, dimensions);
    }
  }
  if (vectors.some((vector) => vector === undefined)) {
    throw validationError("AI provider returned invalid embeddings");
  }
  return vectors;
}

function extractionContent(body: unknown): {
  content: string;
  finishReason: string | null;
} {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    throw validationError(
      "AI provider returned invalid extraction",
      undefined,
      {
        stage: "envelope",
        reason: "no_choices",
      },
    );
  }
  const firstChoice = (body.choices as unknown[])[0];
  if (
    !isRecord(firstChoice) ||
    !isRecord(firstChoice.message) ||
    firstChoice.message.role !== "assistant" ||
    typeof firstChoice.message.content !== "string"
  ) {
    throw validationError(
      "AI provider returned invalid extraction",
      undefined,
      {
        stage: "envelope",
        reason: "no_assistant_content",
        finishReason: finishReasonOf(firstChoice),
      },
    );
  }
  return {
    content: firstChoice.message.content,
    finishReason: finishReasonOf(firstChoice),
  };
}

function finishReasonOf(choice: unknown): string | null {
  if (!isRecord(choice) || typeof choice.finish_reason !== "string")
    return null;
  return choice.finish_reason.slice(0, 40);
}

function parseUsage(body: unknown, durationMs: number): AiUsageSample {
  if (!isRecord(body) || body.usage === undefined)
    return emptyUsage(durationMs);
  if (!isRecord(body.usage))
    throw validationError("AI provider returned invalid usage");
  const cachedDetails = body.usage.prompt_tokens_details;
  if (cachedDetails != null && !isRecord(cachedDetails)) {
    throw validationError("AI provider returned invalid usage");
  }
  return {
    inputTokens: parseTokenCount(body.usage.prompt_tokens),
    outputTokens: parseTokenCount(body.usage.completion_tokens),
    cachedTokens: parseTokenCount(cachedDetails?.cached_tokens),
    totalTokens: parseTokenCount(body.usage.total_tokens),
    durationMs,
  };
}

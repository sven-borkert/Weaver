import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderAdapterConfig,
} from "./adapter";
import {
  EXTRACTION_SYSTEM_MESSAGE,
  MAX_TEXT_COMPLETION_RESPONSE_BYTES,
  boundedJsonRequest,
  emptyUsage,
  extractWithCorrection,
  formatExtractionDocument,
  isRecord,
  parseTokenCount,
  validationError,
  withUsage,
} from "./http";
import { anthropicThinkingParams } from "./reasoning";
import {
  optionalPositiveInt,
  optionalString,
  unknownModel,
  withReportedSource,
} from "./modelDiscovery";
import {
  AiProviderError,
  type AiCallOptions,
  type AiUsageSample,
} from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const EXTRACTION_MAX_TOKENS = 4096;
const MAX_MODEL_PAGES = 100;

export function createAnthropicAdapter(
  config: ProviderAdapterConfig,
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

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
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      payload,
      timeoutMs: config.requestTimeoutMs,
      signal: options?.signal,
      maxResponseBytes,
    });
    return { body, usage: parseUsage(body, durationMs) };
  }

  return {
    providerType: "anthropic",
    supportsEmbeddings: false,
    async completeText(model, input, options) {
      const { body, usage } = await request(
        "POST",
        "/messages",
        {
          model,
          max_tokens: input.maxOutputTokens,
          ...anthropicThinkingParams(options?.reasoning, input.maxOutputTokens),
          system: input.system,
          messages: [{ role: "user", content: input.prompt }],
        },
        options,
        MAX_TEXT_COMPLETION_RESPONSE_BYTES,
      );
      if (
        !isRecord(body) ||
        body.stop_reason !== "end_turn" ||
        !Array.isArray(body.content) ||
        !(body.content as unknown[]).every(
          (block) =>
            isRecord(block) &&
            block.type === "text" &&
            typeof block.text === "string",
        )
      ) {
        throw validationError("AI provider returned invalid completion", usage);
      }
      const text = (body.content as { text: string }[])
        .map((block) => block.text)
        .join("");
      if (!text.trim())
        throw validationError("AI provider returned invalid completion", usage);
      return { text, usage };
    },
    async listModels(options) {
      const models: DiscoveredModel[] = [];
      let durationMs = 0;
      let afterId: string | null = null;
      let pages = 0;
      do {
        pages += 1;
        if (pages > MAX_MODEL_PAGES) {
          throw validationError("AI provider model list exceeds limits");
        }
        const path = afterId
          ? `/models?${new URLSearchParams({ after_id: afterId })}`
          : "/models";
        const { body, usage } = await request("GET", path, undefined, options);
        durationMs += usage.durationMs;
        if (
          !isRecord(body) ||
          !Array.isArray(body.data) ||
          (body.has_more !== undefined && typeof body.has_more !== "boolean")
        ) {
          throw validationError("AI provider returned an invalid model list");
        }
        models.push(
          ...(body.data as unknown[])
            .map(discoveredModelFromAnthropicItem)
            .filter((model) => model !== null),
        );
        if (body.has_more === true) {
          if (typeof body.last_id !== "string" || body.last_id.length === 0) {
            throw validationError("AI provider returned an invalid model list");
          }
          afterId = body.last_id;
        } else {
          afterId = null;
        }
      } while (afterId);
      return { models, durationMs };
    },
    async ping(model, options) {
      const { body, usage } = await request(
        "POST",
        "/messages",
        { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        options,
      );
      if (!isRecord(body) || !Array.isArray(body.content)) {
        throw validationError("AI provider returned an invalid message", usage);
      }
      return { usage };
    },
    async embed() {
      throw noEmbeddings();
    },
    embeddingRequestByteLength() {
      throw noEmbeddings();
    },
    async probeEmbeddingDimensions() {
      throw noEmbeddings();
    },
    async extract(model, input, options) {
      const document = {
        role: "user",
        content: formatExtractionDocument(input),
      };
      return extractWithCorrection(async (correction) => {
        const response = await request(
          "POST",
          "/messages",
          {
            model,
            max_tokens: EXTRACTION_MAX_TOKENS,
            ...anthropicThinkingParams(
              options?.reasoning,
              EXTRACTION_MAX_TOKENS,
            ),
            system: `${EXTRACTION_SYSTEM_MESSAGE} Respond with a single JSON object and nothing else.`,
            messages: correction
              ? [
                  document,
                  { role: "assistant", content: correction.previousContent },
                  { role: "user", content: correction.message },
                ]
              : [document],
          },
          options,
        );
        try {
          return {
            content: firstText(response.body),
            usage: response.usage,
            finishReason: stopReasonOf(response.body),
          };
        } catch (error) {
          throw withUsage(error, response.usage);
        }
      }, options?.signal);
    },
  };
}

function noEmbeddings(): AiProviderError {
  return new AiProviderError(
    "Anthropic connections do not provide embeddings",
    {
      kind: "validation",
      retryable: false,
    },
  );
}

/** Every Claude model is a tool-capable chat model; newer list responses also carry limits. */
function discoveredModelFromAnthropicItem(
  item: unknown,
): DiscoveredModel | null {
  if (!isRecord(item)) return null;
  const providerModelId = optionalString(item.id);
  if (providerModelId === null) return null;
  return withReportedSource({
    ...unknownModel(providerModelId, optionalString(item.display_name)),
    contextWindow: optionalPositiveInt(item.max_input_tokens),
    maxOutputTokens: optionalPositiveInt(item.max_tokens),
    capabilities:
      item.max_input_tokens !== undefined
        ? ["chat", "json_output", "tool_use", "vision"]
        : [],
  });
}

function stopReasonOf(body: unknown): string | null {
  return isRecord(body) && typeof body.stop_reason === "string"
    ? body.stop_reason.slice(0, 40)
    : null;
}

function firstText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    throw validationError("AI provider returned invalid extraction");
  }
  const text = (body.content as unknown[])
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
  if (!text) throw validationError("AI provider returned invalid extraction");
  return text;
}

function parseUsage(body: unknown, durationMs: number): AiUsageSample {
  if (!isRecord(body) || body.usage === undefined)
    return emptyUsage(durationMs);
  if (!isRecord(body.usage))
    throw validationError("AI provider returned invalid usage");
  const uncachedInputTokens = parseTokenCount(body.usage.input_tokens);
  const outputTokens = parseTokenCount(body.usage.output_tokens);
  const cacheReadTokens = parseTokenCount(body.usage.cache_read_input_tokens);
  const cacheCreationTokens = parseTokenCount(
    body.usage.cache_creation_input_tokens,
  );
  const cachedTokens = cacheReadTokens;
  const inputTokens =
    uncachedInputTokens === null
      ? null
      : parseTokenCount(
          uncachedInputTokens +
            (cacheReadTokens ?? 0) +
            (cacheCreationTokens ?? 0),
        );
  const totalTokens =
    inputTokens === null || outputTokens === null
      ? null
      : parseTokenCount(inputTokens + outputTokens);
  return { inputTokens, outputTokens, cachedTokens, totalTokens, durationMs };
}

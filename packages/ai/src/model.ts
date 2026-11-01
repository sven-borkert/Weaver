import { createPinnedFetch } from "@weaver/config/outboundFetch";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { aiSdkReasoning } from "@weaver/core/ai/reasoning";
import { openAiCompatibleBaseUrl } from "@weaver/core/ai/adapters";
import type { ProviderCredentialSource } from "@weaver/core/ai/registry";
import { diagnosticFetch } from "@weaver/core/diagnostics/fetch";
import type { LlmModelSnapshot } from "@weaver/core/services/llmRoutes";

// The SDK providers require an apiKey at construction; the real value is injected per request.
const PLACEHOLDER_KEY = "weaver-credential-resolved-per-request";

/** `ai`'s `LanguageModel` also admits gateway model-id strings; Weaver always builds a concrete
 * provider model, and the narrower type stays assignable wherever `LanguageModel` is expected. */
export type AssistantLanguageModel = Exclude<LanguageModel, string>;

function providerTimeoutError(): Error {
  // Named so classifyRunError treats a time-to-headers timeout as a transient provider failure.
  const error = new Error("provider request timed out");
  error.name = "TimeoutError";
  return error;
}

export function credentialFetch(options: {
  resolveCredential: () => Promise<string>;
  header: "authorization" | "x-api-key";
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
}): typeof fetch {
  return async (input, init) => {
    // Never decrypt a credential for a request the caller has already cancelled.
    init?.signal?.throwIfAborted();
    const credential = await options.resolveCredential();
    if (/[\u0000-\u001f\u007f-\uffff]/.test(credential)) {
      throw new Error("Invalid provider credential");
    }
    const headers = new Headers(init?.headers);
    if (credential === "") {
      // Local servers need no key; the SDK pre-sets a placeholder that must not leak.
      headers.delete(options.header);
    } else {
      headers.set(
        options.header,
        options.header === "authorization"
          ? `Bearer ${credential}`
          : credential,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(providerTimeoutError()),
      options.requestTimeoutMs,
    );
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    try {
      // The timeout guards time-to-headers; the streamed body stays bound to the caller's signal.
      return await options.fetchImpl(input, { ...init, headers, signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createAssistantLanguageModel(
  snapshot: LlmModelSnapshot,
  credentials: ProviderCredentialSource,
  fetchImpl: typeof fetch = createPinnedFetch(),
): AssistantLanguageModel {
  const model = createProviderModel(snapshot, credentials, fetchImpl);
  const reasoning = aiSdkReasoning(snapshot.reasoningMode);
  if (reasoning === undefined) return model;
  // The SDK maps its generic reasoning option onto each provider's own parameter.
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        reasoning: params.reasoning ?? reasoning,
      }),
    },
  });
}

function createProviderModel(
  snapshot: LlmModelSnapshot,
  credentials: ProviderCredentialSource,
  fetchImpl: typeof fetch,
): AssistantLanguageModel {
  const resolveCredential = () =>
    credentials.resolveCredential(snapshot.connectionId, snapshot);
  const instrumented = diagnosticFetch(fetchImpl, {
    connectionId: snapshot.connectionId,
    providerType: snapshot.providerType,
    requestTimeoutMs: snapshot.requestTimeoutMs,
  });
  const bearer = credentialFetch({
    resolveCredential,
    header: "authorization",
    requestTimeoutMs: snapshot.requestTimeoutMs,
    fetchImpl: instrumented,
  });
  switch (snapshot.providerType) {
    case "anthropic":
      return createAnthropic({
        apiKey: PLACEHOLDER_KEY,
        baseURL: snapshot.endpoint,
        fetch: credentialFetch({
          resolveCredential,
          header: "x-api-key",
          requestTimeoutMs: snapshot.requestTimeoutMs,
          fetchImpl: instrumented,
        }),
      })(snapshot.providerModelId);
    case "openai":
      return createOpenAI({
        apiKey: PLACEHOLDER_KEY,
        baseURL: snapshot.endpoint,
        fetch: bearer,
      }).chat(snapshot.providerModelId);
    case "openai_compatible":
    case "openrouter":
    case "lmstudio":
    case "ollama":
      return createOpenAICompatible({
        name: `weaver-${snapshot.providerType.replace("_", "-")}`,
        apiKey: PLACEHOLDER_KEY,
        baseURL: openAiCompatibleBaseUrl(
          snapshot.providerType,
          snapshot.endpoint,
        ),
        includeUsage: true,
        fetch: bearer,
        ...(snapshot.providerType === "openrouter" && snapshot.upstreamProvider
          ? {
              transformRequestBody: (args: Record<string, unknown>) => ({
                ...args,
                provider: { only: [snapshot.upstreamProvider] },
              }),
            }
          : {}),
      }).chatModel(snapshot.providerModelId);
  }
}

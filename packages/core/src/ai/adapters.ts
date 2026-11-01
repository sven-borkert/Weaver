import type { LlmProviderType } from "@weaver/db/client";

import type { ProviderAdapter, ProviderAdapterConfig } from "./adapter";
import { createAnthropicAdapter } from "./anthropic";
import { createLmStudioAdapter } from "./lmStudio";
import { createOllamaAdapter } from "./ollama";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";

export const PROVIDER_FIXED_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const;

/** Local servers store their root URL; adapters append `/v1` for OpenAI-compatible calls. */
export const PROVIDER_DEFAULT_ENDPOINTS = {
  lmstudio: "http://127.0.0.1:1234",
  ollama: "http://127.0.0.1:11434",
} as const;

export function isLocalProvider(
  providerType: LlmProviderType,
): providerType is keyof typeof PROVIDER_DEFAULT_ENDPOINTS {
  return providerType === "lmstudio" || providerType === "ollama";
}

export function isCredentialOptional(providerType: LlmProviderType): boolean {
  return isLocalProvider(providerType);
}

export function openAiCompatibleBaseUrl(
  providerType: LlmProviderType,
  endpoint: string,
): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return isLocalProvider(providerType) ? `${trimmed}/v1` : trimmed;
}

export function createProviderAdapter(
  providerType: LlmProviderType,
  config: ProviderAdapterConfig,
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  switch (providerType) {
    case "anthropic":
      return createAnthropicAdapter(config, fetchImpl);
    case "openai":
      return createOpenAiCompatibleAdapter(config, fetchImpl, "openai", {
        embeddingDimensionsTransport: "openai_text_embedding_3",
      });
    case "openai_compatible":
      return createOpenAiCompatibleAdapter(
        config,
        fetchImpl,
        "openai_compatible",
        { liteLlmModelInfo: true },
      );
    case "openrouter":
      return createOpenAiCompatibleAdapter(config, fetchImpl, "openrouter", {
        openRouter: true,
      });
    case "lmstudio":
      return createLmStudioAdapter(config, fetchImpl);
    case "ollama":
      return createOllamaAdapter(config, fetchImpl);
  }
}

import type { LlmModelCapability, LlmProviderType } from "@weaver/db/client";

/**
 * Static limits for hosted model families whose list endpoints report nothing.
 * Endpoint-reported values always win; these only fill gaps and stay editable.
 */
export type CatalogFamily = "openai" | "anthropic";

export type CatalogEntry = {
  family: CatalogFamily;
  /** Tested against the lower-cased id with any `openai/` / `anthropic/` prefix removed. */
  match: RegExp;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  embeddingDimensions: number | null;
  capabilities: LlmModelCapability[];
};

/** Ids that are not language models (audio, image, moderation, legacy completions). */
export const NON_LLM_ID_PATTERN =
  /^(whisper|tts|dall-e|gpt-image|omni-moderation|text-moderation|babbage|davinci|sora|computer-use)/i;

const CHAT: LlmModelCapability[] = ["chat", "json_output", "tool_use"];
const VISION_CHAT: LlmModelCapability[] = [...CHAT, "vision"];

function chat(
  family: CatalogFamily,
  match: RegExp,
  contextWindow: number,
  maxOutputTokens: number,
  capabilities: LlmModelCapability[] = VISION_CHAT,
): CatalogEntry {
  return {
    family,
    match,
    contextWindow,
    maxOutputTokens,
    embeddingDimensions: null,
    capabilities,
  };
}

function embedding(
  family: CatalogFamily,
  match: RegExp,
  contextWindow: number,
  embeddingDimensions: number,
): CatalogEntry {
  return {
    family,
    match,
    contextWindow,
    maxOutputTokens: null,
    embeddingDimensions,
    capabilities: ["embedding"],
  };
}

// Most specific pattern first; the first match wins.
const CATALOG: CatalogEntry[] = [
  chat("openai", /^gpt-5-mini/, 400_000, 128_000),
  chat("openai", /^gpt-5-nano/, 400_000, 128_000),
  chat("openai", /^gpt-5/, 400_000, 128_000),
  chat("openai", /^gpt-4\.1-mini/, 1_047_576, 32_768),
  chat("openai", /^gpt-4\.1-nano/, 1_047_576, 32_768),
  chat("openai", /^gpt-4\.1/, 1_047_576, 32_768),
  chat("openai", /^gpt-4o-mini/, 128_000, 16_384),
  chat("openai", /^gpt-4o/, 128_000, 16_384),
  chat("openai", /^chatgpt-4o/, 128_000, 16_384),
  chat("openai", /^o4-mini/, 200_000, 100_000),
  chat("openai", /^o3-mini/, 200_000, 100_000, CHAT),
  chat("openai", /^o3/, 200_000, 100_000),
  chat("openai", /^o1-mini/, 128_000, 65_536, CHAT),
  chat("openai", /^o1/, 200_000, 100_000),
  embedding("openai", /^text-embedding-3-small/, 8191, 1536),
  embedding("openai", /^text-embedding-3-large/, 8191, 3072),
  embedding("openai", /^text-embedding-ada-002/, 8191, 1536),
  chat("anthropic", /^claude-(fable|mythos)-5/, 1_000_000, 128_000),
  chat("anthropic", /^claude-opus-5/, 1_000_000, 128_000),
  chat("anthropic", /^claude-opus-4-[678]/, 1_000_000, 128_000),
  chat("anthropic", /^claude-opus-4-5/, 200_000, 64_000),
  chat("anthropic", /^claude-opus-4/, 200_000, 32_000),
  chat("anthropic", /^claude-sonnet-5/, 1_000_000, 128_000),
  chat("anthropic", /^claude-sonnet-4-6/, 1_000_000, 128_000),
  chat("anthropic", /^claude-sonnet-4-5/, 200_000, 64_000),
  chat("anthropic", /^claude-sonnet-4/, 200_000, 64_000),
  chat("anthropic", /^claude-haiku-4-5/, 200_000, 64_000),
  chat("anthropic", /^claude-3-7-sonnet/, 200_000, 64_000),
  chat("anthropic", /^claude-3-5-sonnet/, 200_000, 8192),
  chat("anthropic", /^claude-3-5-haiku/, 200_000, 8192),
  chat("anthropic", /^claude-3-opus/, 200_000, 4096),
  chat("anthropic", /^claude-3-haiku/, 200_000, 4096),
];

// Local servers may host anything, so hosted numbers must never apply to them.
const FAMILIES_BY_PROVIDER: Record<LlmProviderType, CatalogFamily[]> = {
  openai: ["openai"],
  anthropic: ["anthropic"],
  openai_compatible: ["openai", "anthropic"],
  openrouter: ["openai", "anthropic"],
  lmstudio: [],
  ollama: [],
};

export function lookupModelCatalog(
  providerType: LlmProviderType,
  providerModelId: string,
): CatalogEntry | null {
  const families = FAMILIES_BY_PROVIDER[providerType];
  if (families.length === 0) return null;
  const id = providerModelId
    .trim()
    .toLowerCase()
    .replace(/^(openai|anthropic)\//, "");
  return (
    CATALOG.find(
      (entry) => families.includes(entry.family) && entry.match.test(id),
    ) ?? null
  );
}

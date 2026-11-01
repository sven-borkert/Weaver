import { describe, expect, it } from "vitest";

import { NON_LLM_ID_PATTERN, lookupModelCatalog } from "./modelCatalog";

describe("lookupModelCatalog", () => {
  it("matches the most specific OpenAI family first, ignoring date suffixes", () => {
    const mini = lookupModelCatalog("openai", "gpt-4o-mini-2024-07-18");
    const full = lookupModelCatalog("openai", "gpt-4o");
    expect(mini?.match.source).toContain("gpt-4o-mini");
    expect(full?.match.source).not.toContain("mini");
    expect(full?.contextWindow).toBe(128_000);
    expect(full?.maxOutputTokens).toBe(16_384);
    expect(full?.capabilities).toEqual([
      "chat",
      "json_output",
      "tool_use",
      "vision",
    ]);
  });

  it("returns embedding dimensions for OpenAI embedding families", () => {
    expect(
      lookupModelCatalog("openai", "text-embedding-3-small"),
    ).toMatchObject({ embeddingDimensions: 1536, capabilities: ["embedding"] });
    expect(
      lookupModelCatalog("openai", "text-embedding-3-large"),
    ).toMatchObject({ embeddingDimensions: 3072 });
  });

  it("strips vendor prefixes and consults both families for OpenAI-compatible endpoints", () => {
    expect(
      lookupModelCatalog("openai_compatible", "openai/GPT-4o")?.contextWindow,
    ).toBe(128_000);
    expect(
      lookupModelCatalog("openai_compatible", "anthropic/claude-sonnet-4-5")
        ?.contextWindow,
    ).toBe(200_000);
  });

  it("uses the hosted family fallback for OpenRouter model slugs", () => {
    expect(
      lookupModelCatalog("openrouter", "openai/text-embedding-3-small"),
    ).toMatchObject({ embeddingDimensions: 1536, capabilities: ["embedding"] });
    expect(
      lookupModelCatalog("openrouter", "anthropic/claude-sonnet-4-5")
        ?.contextWindow,
    ).toBe(200_000);
  });

  it("only consults the family that matches the hosted provider", () => {
    expect(lookupModelCatalog("openai", "claude-sonnet-4-5")).toBeNull();
    expect(lookupModelCatalog("anthropic", "gpt-4o")).toBeNull();
  });

  it("never applies hosted numbers to local providers", () => {
    expect(lookupModelCatalog("ollama", "gpt-oss:20b")).toBeNull();
    expect(lookupModelCatalog("lmstudio", "gpt-4o")).toBeNull();
  });

  it("declares vision for multimodal hosted families only", () => {
    expect(lookupModelCatalog("openai", "gpt-4o")?.capabilities).toEqual([
      "chat",
      "json_output",
      "tool_use",
      "vision",
    ]);
    expect(lookupModelCatalog("openai", "o3-mini")?.capabilities).toEqual([
      "chat",
      "json_output",
      "tool_use",
    ]);
    expect(
      lookupModelCatalog("anthropic", "claude-sonnet-4-5")?.capabilities,
    ).toContain("vision");
  });

  it("recognises ids that are not language models", () => {
    expect(NON_LLM_ID_PATTERN.test("whisper-1")).toBe(true);
    expect(NON_LLM_ID_PATTERN.test("dall-e-3")).toBe(true);
    expect(NON_LLM_ID_PATTERN.test("gpt-4o")).toBe(false);
  });
});

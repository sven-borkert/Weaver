import { describe, expect, it } from "vitest";

import { createLmStudioAdapter } from "./lmStudio";
import { AiProviderError } from "./types";

const hrefOf = (url: Parameters<typeof fetch>[0]) =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

const config = {
  baseUrl: "http://127.0.0.1:1234/",
  resolveCredential: async () => "",
  requestTimeoutMs: 1000,
};

function nativeListing(data: unknown[]): Response {
  return new Response(JSON.stringify({ object: "list", data }));
}

describe("LM Studio adapter", () => {
  it("reduces Matryoshka vectors returned at LM Studio native size", async () => {
    let body: unknown;
    const adapter = createLmStudioAdapter(config, async (_url, init) => {
      body = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [3, 4, 99] }] }),
      );
    });

    const result = await adapter.embed("qwen3-embedding", ["hello"], {
      size: 2,
      mode: "matryoshka",
    });
    expect(body).toEqual({ model: "qwen3-embedding", input: ["hello"] });
    expect(result.vectors).toEqual([[0.6, 0.8]]);
  });

  it("lists models from the native API and maps type and context length", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const adapter = createLmStudioAdapter(config, async (url, init) => {
      calls.push({
        url: hrefOf(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return nativeListing([
        {
          id: "qwen/qwen3-8b",
          object: "model",
          type: "llm",
          max_context_length: 40_960,
          loaded_context_length: 4096,
          state: "loaded",
        },
        { id: "nomic-embed", type: "embeddings", max_context_length: 2048 },
        { id: "gemma-vision", type: "vlm", max_context_length: 8192 },
        { id: "mystery", type: "other" },
        { object: "model" },
      ]);
    });

    const listing = await adapter.listModels();

    expect(calls).toEqual([
      { url: "http://127.0.0.1:1234/api/v0/models", authorization: null },
    ]);
    expect(listing.models).toEqual([
      {
        providerModelId: "qwen/qwen3-8b",
        displayName: "qwen/qwen3-8b",
        contextWindow: 40_960,
        maxOutputTokens: null,
        embeddingDimensions: null,
        capabilities: ["chat", "json_output", "tool_use"],
        source: "endpoint",
      },
      expect.objectContaining({
        providerModelId: "nomic-embed",
        contextWindow: 2048,
        capabilities: ["embedding"],
        source: "endpoint",
      }),
      expect.objectContaining({
        providerModelId: "gemma-vision",
        contextWindow: 8192,
        capabilities: ["chat", "json_output", "tool_use", "vision"],
      }),
      expect.objectContaining({
        providerModelId: "mystery",
        contextWindow: null,
        capabilities: [],
        source: "inferred",
      }),
    ]);
  });

  it("sends a bearer token only when a credential is configured", async () => {
    let authorization: string | null = null;
    const adapter = createLmStudioAdapter(
      { ...config, resolveCredential: async () => "lm-key" },
      async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return nativeListing([]);
      },
    );
    await adapter.listModels();
    expect(authorization).toBe("Bearer lm-key");
  });

  it("routes completions through the OpenAI-compatible /v1 API", async () => {
    let url = "";
    const adapter = createLmStudioAdapter(config, async (input) => {
      url = hrefOf(input);
      return new Response(JSON.stringify({ choices: [] }));
    });
    await adapter.ping("qwen/qwen3-8b");
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(adapter.providerType).toBe("lmstudio");
    expect(adapter.supportsEmbeddings).toBe(true);
  });

  it("rejects an invalid native model list", async () => {
    const adapter = createLmStudioAdapter(
      config,
      async () => new Response(JSON.stringify({ models: [] })),
    );
    await expect(adapter.listModels()).rejects.toMatchObject({
      name: "AiProviderError",
      kind: "validation",
    });
    await expect(adapter.listModels()).rejects.toBeInstanceOf(AiProviderError);
  });
});

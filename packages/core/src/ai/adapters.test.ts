import { describe, expect, it } from "vitest";

import {
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_FIXED_ENDPOINTS,
  createProviderAdapter,
  isCredentialOptional,
  openAiCompatibleBaseUrl,
} from "./adapters";

const config = {
  baseUrl: "https://x.test/v1",
  resolveCredential: async () => "k",
  requestTimeoutMs: 1,
};

function hrefOf(url: string | URL | Request): string {
  return typeof url === "string"
    ? url
    : url instanceof URL
      ? url.href
      : url.url;
}

describe("createProviderAdapter", () => {
  it("requests Matryoshka dimensions for OpenAI text-embedding-3 models", async () => {
    let body: unknown;
    const adapter = createProviderAdapter(
      "openai",
      config,
      async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [3, 4, 99] }] }),
        );
      },
    );

    const result = await adapter.embed("text-embedding-3-large", ["hello"], {
      size: 2,
      mode: "matryoshka",
    });

    expect(body).toEqual({
      model: "text-embedding-3-large",
      input: ["hello"],
      dimensions: 2,
    });
    expect(result.vectors).toEqual([[0.6, 0.8]]);
  });

  it("omits dimensions for native OpenAI text-embedding-3 requests", async () => {
    let body: unknown;
    const adapter = createProviderAdapter(
      "openai",
      config,
      async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }] }),
        );
      },
    );

    await adapter.embed("text-embedding-3-large", ["hello"], {
      size: 2,
      mode: "native",
    });

    expect(body).toEqual({
      model: "text-embedding-3-large",
      input: ["hello"],
    });
  });

  it("omits dimensions for OpenAI Matryoshka models outside text-embedding-3", async () => {
    let body: unknown;
    const adapter = createProviderAdapter(
      "openai",
      config,
      async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [3, 4, 99] }] }),
        );
      },
    );

    await adapter.embed("qwen3-embedding", ["hello"], {
      size: 2,
      mode: "matryoshka",
    });

    expect(body).toEqual({
      model: "qwen3-embedding",
      input: ["hello"],
    });
  });

  it("queries LiteLLM model info for generic OpenAI-compatible connections only", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      urls.push(hrefOf(url));
      return new Response(JSON.stringify({ data: [] }));
    };

    await createProviderAdapter(
      "openai_compatible",
      config,
      fetchImpl,
    ).listModels();
    await createProviderAdapter("openai", config, fetchImpl).listModels();

    expect(urls).toEqual([
      "https://x.test/v1/models",
      "https://x.test/v1/model/info",
      "https://x.test/v1/models",
    ]);
  });

  it("pins OpenRouter chat and embedding calls to the selected upstream", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const adapter = createProviderAdapter(
      "openrouter",
      { ...config, upstreamProvider: "google-vertex/us-east5" },
      async (url, init) => {
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        requests.push({ url: hrefOf(url), body });
        return new Response(
          JSON.stringify(
            requests.length === 1
              ? {
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { role: "assistant", content: "ok" },
                    },
                  ],
                }
              : { data: [{ index: 0, embedding: [1, 0] }] },
          ),
        );
      },
    );

    await adapter.completeText("google/gemini", {
      system: "System",
      prompt: "Hello",
      maxOutputTokens: 8,
    });
    await adapter.embed("openai/text-embedding-3-small", ["hello"], {
      size: 2,
      mode: "native",
    });

    expect(requests).toEqual([
      {
        url: "https://x.test/v1/chat/completions",
        body: {
          model: "google/gemini",
          max_tokens: 8,
          provider: { only: ["google-vertex/us-east5"] },
          messages: [
            { role: "system", content: "System" },
            { role: "user", content: "Hello" },
          ],
        },
      },
      {
        url: "https://x.test/v1/embeddings",
        body: {
          model: "openai/text-embedding-3-small",
          input: ["hello"],
          provider: { only: ["google-vertex/us-east5"] },
        },
      },
    ]);
  });

  it("omits OpenRouter provider selection when no upstream is configured", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createProviderAdapter(
      "openrouter",
      config,
      async (_url, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [] }));
      },
    );

    await adapter.ping("openai/gpt-4");

    expect(body).not.toHaveProperty("provider");
  });

  it("discovers OpenRouter embedding models alongside chat models", async () => {
    const urls: string[] = [];
    const adapter = createProviderAdapter("openrouter", config, async (url) => {
      const href = hrefOf(url);
      urls.push(href);
      return new Response(
        JSON.stringify({
          data: href.endsWith("/embeddings/models")
            ? [
                {
                  id: "openai/text-embedding-3-small",
                  name: "Embedding 3 Small",
                  architecture: { output_modalities: ["embeddings"] },
                  supported_parameters: [],
                },
              ]
            : [
                {
                  id: "openai/gpt-4",
                  name: "GPT-4",
                  supported_parameters: ["tools"],
                },
              ],
        }),
      );
    });

    const result = await adapter.listModels();

    expect(urls).toEqual([
      "https://x.test/v1/models?limit=500",
      "https://x.test/v1/embeddings/models",
    ]);
    expect(result.models).toEqual([
      expect.objectContaining({
        providerModelId: "openai/text-embedding-3-small",
        capabilities: ["embedding"],
      }),
      expect.objectContaining({
        providerModelId: "openai/gpt-4",
        capabilities: ["chat", "tool_use"],
      }),
    ]);
  });

  it("selects the adapter by provider type", () => {
    expect(createProviderAdapter("openai", config).providerType).toBe("openai");
    expect(
      createProviderAdapter("openai_compatible", config).supportsEmbeddings,
    ).toBe(true);
    expect(createProviderAdapter("anthropic", config).supportsEmbeddings).toBe(
      false,
    );
    expect(createProviderAdapter("lmstudio", config).providerType).toBe(
      "lmstudio",
    );
    expect(createProviderAdapter("ollama", config)).toMatchObject({
      providerType: "ollama",
      supportsEmbeddings: true,
    });
  });

  it("pins hosted endpoints and defaults local ones", () => {
    expect(PROVIDER_FIXED_ENDPOINTS.openai).toBe("https://api.openai.com/v1");
    expect(PROVIDER_FIXED_ENDPOINTS.anthropic).toBe(
      "https://api.anthropic.com/v1",
    );
    expect(PROVIDER_DEFAULT_ENDPOINTS.lmstudio).toBe("http://127.0.0.1:1234");
    expect(PROVIDER_DEFAULT_ENDPOINTS.ollama).toBe("http://127.0.0.1:11434");
  });

  it("treats the credential as optional only for local servers", () => {
    expect(isCredentialOptional("lmstudio")).toBe(true);
    expect(isCredentialOptional("ollama")).toBe(true);
    expect(isCredentialOptional("openai")).toBe(false);
    expect(isCredentialOptional("anthropic")).toBe(false);
    expect(isCredentialOptional("openai_compatible")).toBe(false);
  });

  it("appends /v1 to local server roots for OpenAI-compatible calls", () => {
    expect(openAiCompatibleBaseUrl("lmstudio", "http://127.0.0.1:1234/")).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(openAiCompatibleBaseUrl("ollama", "http://gpu:11434")).toBe(
      "http://gpu:11434/v1",
    );
    expect(
      openAiCompatibleBaseUrl("openai_compatible", "https://x.test/v1"),
    ).toBe("https://x.test/v1");
  });
});

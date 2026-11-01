import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_OLLAMA_SHOW_CALLS, createOllamaAdapter } from "./ollama";

const hrefOf = (url: Parameters<typeof fetch>[0]) =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

const config = {
  baseUrl: "http://127.0.0.1:11434",
  resolveCredential: async () => "",
  requestTimeoutMs: 1000,
};

afterEach(() => vi.restoreAllMocks());

type Call = { url: string; method: string; body: unknown; headers: Headers };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function parseBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

const showBodies: Record<string, unknown> = {
  "llama3.1:8b": {
    capabilities: ["completion", "tools"],
    model_info: {
      "general.architecture": "llama",
      "llama.context_length": 131_072,
      "llama.embedding_length": 4096,
    },
  },
  "nomic-embed-text:latest": {
    capabilities: ["embedding"],
    model_info: {
      "general.architecture": "nomic-bert",
      "nomic-bert.context_length": 2048,
      "nomic-bert.embedding_length": 768,
    },
  },
  "llava:7b": {
    capabilities: ["completion", "vision"],
    model_info: {
      "general.architecture": "clip",
      "clip.context_length": 4096,
    },
  },
};

describe("Ollama adapter", () => {
  it.each(["/api/tags", "/api/show"])(
    "classifies the internal deadline during %s as a provider timeout",
    async (path) => {
      const deadline = new AbortController();
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
        ms === 60_000 ? deadline.signal : realTimeout(ms),
      );
      const adapter = createOllamaAdapter(config, async (url) => {
        if (hrefOf(url).endsWith(path)) {
          deadline.abort(new DOMException("deadline", "TimeoutError"));
          throw deadline.signal.reason;
        }
        return json({ models: [{ name: "model" }] });
      });
      await expect(adapter.listModels()).rejects.toMatchObject({
        name: "AiProviderError",
        kind: "provider",
        retryable: true,
        message: "AI provider model discovery deadline exceeded",
      });
    },
  );

  it("preserves caller cancellation instead of calling it a discovery timeout", async () => {
    const caller = new AbortController();
    const adapter = createOllamaAdapter(config, async () => {
      caller.abort();
      throw caller.signal.reason;
    });
    await expect(
      adapter.listModels({ signal: caller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("requests Matryoshka dimensions from Ollama", async () => {
    let body: unknown;
    const adapter = createOllamaAdapter(config, async (_url, init) => {
      body = parseBody(init);
      return json({ data: [{ index: 0, embedding: [0, 5] }] });
    });

    await adapter.embed("qwen3-embedding:4b", ["hello"], {
      size: 2,
      mode: "matryoshka",
    });
    expect(body).toEqual({
      model: "qwen3-embedding:4b",
      input: ["hello"],
      dimensions: 2,
    });
  });

  it("lists models via /api/tags and enriches each through /api/show", async () => {
    const calls: Call[] = [];
    const adapter = createOllamaAdapter(config, async (url, init) => {
      const body = parseBody(init);
      calls.push({
        url: hrefOf(url),
        method: init?.method ?? "GET",
        body,
        headers: new Headers(init?.headers),
      });
      if (hrefOf(url).endsWith("/api/tags")) {
        return json({
          models: [
            { name: "llama3.1:8b", model: "llama3.1:8b" },
            { name: "nomic-embed-text:latest" },
            { model: "no-name" },
          ],
        });
      }
      const model = (body as { model: string }).model;
      return json(showBodies[model]);
    });

    const listing = await adapter.listModels();

    expect(calls.map((call) => [call.url, call.method, call.body])).toEqual([
      ["http://127.0.0.1:11434/api/tags", "GET", undefined],
      ["http://127.0.0.1:11434/api/show", "POST", { model: "llama3.1:8b" }],
      [
        "http://127.0.0.1:11434/api/show",
        "POST",
        { model: "nomic-embed-text:latest" },
      ],
    ]);
    expect(calls.every((call) => !call.headers.has("authorization"))).toBe(
      true,
    );
    expect(listing.models).toEqual([
      {
        providerModelId: "llama3.1:8b",
        displayName: "llama3.1:8b",
        contextWindow: 131_072,
        maxOutputTokens: null,
        embeddingDimensions: null,
        capabilities: ["chat", "json_output", "tool_use"],
        source: "endpoint",
      },
      {
        providerModelId: "nomic-embed-text:latest",
        displayName: "nomic-embed-text:latest",
        contextWindow: 2048,
        maxOutputTokens: null,
        embeddingDimensions: 768,
        capabilities: ["embedding"],
        source: "endpoint",
      },
    ]);
  });

  it("marks vision models reported by /api/show capabilities", async () => {
    const adapter = createOllamaAdapter(config, async (url, init) => {
      if (hrefOf(url).endsWith("/api/tags")) {
        return json({ models: [{ name: "llava:7b" }] });
      }
      const model = (parseBody(init) as { model: string }).model;
      return json(showBodies[model]);
    });

    const listing = await adapter.listModels();

    expect(listing.models).toEqual([
      {
        providerModelId: "llava:7b",
        displayName: "llava:7b",
        contextWindow: 4096,
        maxOutputTokens: null,
        embeddingDimensions: null,
        capabilities: ["chat", "json_output", "vision"],
        source: "endpoint",
      },
    ]);
  });

  it("caps the /api/show fan-out and never runs more than four at once", async () => {
    const names = Array.from({ length: 150 }, (_, index) => `model-${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    let showCalls = 0;
    const adapter = createOllamaAdapter(config, async (url) => {
      if (hrefOf(url).endsWith("/api/tags")) {
        return json({ models: names.map((name) => ({ name })) });
      }
      showCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return json({
        capabilities: ["completion"],
        model_info: { "general.architecture": "x", "x.context_length": 10 },
      });
    });

    const listing = await adapter.listModels();

    expect(showCalls).toBe(MAX_OLLAMA_SHOW_CALLS);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(listing.models).toHaveLength(150);
    expect(listing.models[0]).toMatchObject({
      contextWindow: 10,
      source: "endpoint",
    });
    expect(listing.models[149]).toMatchObject({
      providerModelId: "model-149",
      contextWindow: null,
      capabilities: [],
      source: "inferred",
    });
  });

  it("keeps a model with unknown metadata when its /api/show call fails", async () => {
    const adapter = createOllamaAdapter(config, async (url, init) => {
      if (hrefOf(url).endsWith("/api/tags")) {
        return json({ models: [{ name: "broken" }, { name: "llama3.1:8b" }] });
      }
      const model = (parseBody(init) as { model: string }).model;
      return model === "broken"
        ? new Response("nope", { status: 500 })
        : json(showBodies[model]);
    });

    const listing = await adapter.listModels();

    expect(listing.models.map((model) => model.providerModelId)).toEqual([
      "broken",
      "llama3.1:8b",
    ]);
    expect(listing.models[0]).toMatchObject({
      contextWindow: null,
      capabilities: [],
      source: "inferred",
    });
    expect(listing.models[1]?.contextWindow).toBe(131_072);
  });

  it("forwards the caller's signal and never requests verbose model files", async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const bodies: unknown[] = [];
    const adapter = createOllamaAdapter(config, async (url, init) => {
      signals.push(init?.signal);
      bodies.push(parseBody(init));
      return hrefOf(url).endsWith("/api/tags")
        ? json({ models: [{ name: "llama3.1:8b" }] })
        : json(showBodies["llama3.1:8b"]);
    });

    await adapter.listModels({ signal: controller.signal });

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(bodies[1]).toEqual({ model: "llama3.1:8b" });
  });

  it("routes completions and embeddings through the OpenAI-compatible /v1 API", async () => {
    const urls: string[] = [];
    const adapter = createOllamaAdapter(config, async (url) => {
      urls.push(hrefOf(url));
      return json({ choices: [] });
    });
    await adapter.ping("llama3.1:8b");
    expect(urls).toEqual(["http://127.0.0.1:11434/v1/chat/completions"]);
    expect(adapter.providerType).toBe("ollama");
  });

  it("rejects an invalid tag list", async () => {
    const adapter = createOllamaAdapter(config, async () => json({ data: [] }));
    await expect(adapter.listModels()).rejects.toMatchObject({
      kind: "validation",
    });
  });
});

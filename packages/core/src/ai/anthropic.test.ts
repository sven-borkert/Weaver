import { describe, expect, it } from "vitest";

import { ANTHROPIC_VERSION, createAnthropicAdapter } from "./anthropic";
import { AiProviderError } from "./types";

const config = {
  baseUrl: "https://api.anthropic.com/v1",
  resolveCredential: async () => "sk-ant-test",
  requestTimeoutMs: 1000,
};
const extractionInput = {
  documentId: "d1",
  chunkId: "c1",
  title: "Doc",
  headingPath: ["A"],
  text: "The pipeline deploys to production.",
};
const extraction = { entities: [], relations: [] };

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

describe("anthropic adapter", () => {
  it("sends Messages API extraction requests with x-api-key and parses text JSON", async () => {
    const adapter = createAnthropicAdapter(config, async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(headers.get("x-api-key")).toBe("sk-ant-test");
      expect(headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
      const body = requestBody(init);
      expect(body.model).toBe("claude-x");
      expect(body.max_tokens).toBe(4096);
      expect(body.system).toEqual(expect.stringContaining("untrusted"));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "```json\n" + JSON.stringify(extraction) + "\n```",
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 3,
          },
        }),
      );
    });

    const result = await adapter.extract("claude-x", extractionInput);

    expect(result.data).toEqual(extraction);
    expect(result.usage).toMatchObject({
      inputTokens: 15,
      outputTokens: 5,
      cachedTokens: 2,
      totalTokens: 20,
    });
  });

  it("replays a rejected extraction with its validation issues and accepts the correction", async () => {
    const rejected = JSON.stringify({ entities: [], relation: [] });
    const bodies: Record<string, unknown>[] = [];
    const adapter = createAnthropicAdapter(config, async (_url, init) => {
      bodies.push(requestBody(init));
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: bodies.length === 1 ? rejected : JSON.stringify(extraction),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });

    const result = await adapter.extract("claude-x", extractionInput);

    expect(result.data).toEqual(extraction);
    expect(result.usage).toMatchObject({ inputTokens: 20, totalTokens: 30 });
    expect(result.correction?.stage).toBe("schema");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.system).toBe(bodies[0]!.system);
    const messages = bodies[1]!.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[0]).toEqual((bodies[0]!.messages as unknown[])[0]);
    expect(messages[1]!.content).toBe(rejected);
    expect(messages[2]!.content).toContain("unrecognized_keys");
  });

  it("lists models and pings with max_tokens 1", async () => {
    const adapter = createAnthropicAdapter(config, async (_url, init) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ data: [{ id: "claude-x" }] }));
      }
      expect(requestBody(init).max_tokens).toBe(1);
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "p" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });

    expect(
      (await adapter.listModels()).models.map((model) => model.providerModelId),
    ).toEqual(["claude-x"]);
    expect((await adapter.ping("claude-x")).usage.totalTokens).toBe(2);
  });

  it("follows every page of the Anthropic model list", async () => {
    const urls: string[] = [];
    const adapter = createAnthropicAdapter(config, async (url) => {
      urls.push(
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      );
      return new Response(
        JSON.stringify(
          urls.length === 1
            ? {
                data: [{ id: "claude-new" }],
                has_more: true,
                last_id: "claude-new",
              }
            : {
                data: [{ id: "claude-old" }],
                has_more: false,
                last_id: "claude-old",
              },
        ),
      );
    });

    await expect(adapter.listModels()).resolves.toMatchObject({
      models: [
        expect.objectContaining({ providerModelId: "claude-new" }),
        expect.objectContaining({ providerModelId: "claude-old" }),
      ],
    });
    expect(urls).toEqual([
      "https://api.anthropic.com/v1/models",
      "https://api.anthropic.com/v1/models?after_id=claude-new",
    ]);
  });

  it("bounds a provider that never completes model pagination", async () => {
    let calls = 0;
    const adapter = createAnthropicAdapter(config, async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ data: [], has_more: true, last_id: `page-${calls}` }),
      );
    });

    await expect(adapter.listModels()).rejects.toMatchObject({
      kind: "validation",
      retryable: false,
    });
    expect(calls).toBe(100);
  });

  it("rejects a combined usage total outside the PostgreSQL INTEGER range", async () => {
    const adapter = createAnthropicAdapter(
      config,
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "p" }],
            usage: { input_tokens: 2_147_483_647, output_tokens: 1 },
          }),
        ),
    );

    await expect(adapter.ping("claude-x")).rejects.toMatchObject({
      kind: "validation",
      retryable: false,
    });
  });

  it("maps display names and limits when the model list reports them", async () => {
    const adapter = createAnthropicAdapter(
      config,
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-opus-4-8",
                display_name: "Claude Opus 4.8",
                max_input_tokens: 1_000_000,
                max_tokens: 128_000,
              },
              { id: "claude-legacy" },
              { type: "model" },
            ],
          }),
        ),
    );

    const { models } = await adapter.listModels();

    expect(models).toEqual([
      {
        providerModelId: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        embeddingDimensions: null,
        capabilities: ["chat", "json_output", "tool_use", "vision"],
        source: "endpoint",
      },
      {
        providerModelId: "claude-legacy",
        displayName: "claude-legacy",
        contextWindow: null,
        maxOutputTokens: null,
        embeddingDimensions: null,
        capabilities: [],
        source: "inferred",
      },
    ]);
  });

  it("does not probe embedding dimensions", async () => {
    const adapter = createAnthropicAdapter(
      config,
      async () => new Response("{}"),
    );
    await expect(
      adapter.probeEmbeddingDimensions("claude-x"),
    ).rejects.toMatchObject({ kind: "validation", retryable: false });
  });

  it("does not provide embeddings", async () => {
    const adapter = createAnthropicAdapter(
      config,
      async () => new Response("{}"),
    );

    expect(adapter.supportsEmbeddings).toBe(false);
    await expect(
      adapter.embed("m", ["x"], { size: 1536, mode: "native" }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});

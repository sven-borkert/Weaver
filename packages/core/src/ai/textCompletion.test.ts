import { describe, expect, it, vi } from "vitest";
import { createProviderAdapter } from "./adapters";

const input = {
  system: "Summarize in English.",
  prompt: "Changed title",
  maxOutputTokens: 128,
};
const config = {
  baseUrl: "https://provider.test/v1",
  requestTimeoutMs: 1000,
  resolveCredential: async () => "secret",
};
const completion = (text = "Clarify the title") => ({
  choices: [
    { message: { role: "assistant", content: text }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

describe("text completion adapters", () => {
  it.each([null, []])(
    "accepts an empty tool_calls field %j from compatible providers",
    async (toolCalls) => {
      const adapter = createProviderAdapter(
        "openai_compatible",
        config,
        async () =>
          Response.json({
            ...completion(),
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Clarify the title",
                  tool_calls: toolCalls,
                },
                finish_reason: "stop",
              },
            ],
          }),
      );
      expect((await adapter.completeText("model", input)).text).toBe(
        "Clarify the title",
      );
    },
  );

  it("rejects unexpected tool calls even alongside completed text", async () => {
    const adapter = createProviderAdapter(
      "openai_compatible",
      config,
      async () =>
        Response.json({
          ...completion(),
          choices: [
            {
              message: {
                role: "assistant",
                content: "Clarify the title",
                tool_calls: [{ name: "tool" }],
              },
              finish_reason: "stop",
            },
          ],
        }),
    );
    await expect(adapter.completeText("model", input)).rejects.toThrow(
      /completion/,
    );
  });
  it.each(["openai", "openai_compatible", "lmstudio", "ollama"] as const)(
    "bounds a tool-free %s request and returns text with usage",
    async (provider) => {
      let body: Record<string, unknown> = {};
      const adapter = createProviderAdapter(
        provider,
        config,
        async (_url, init) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return Response.json(completion());
        },
      );
      expect(await adapter.completeText("model", input)).toMatchObject({
        text: "Clarify the title",
        usage: { inputTokens: 10, outputTokens: 4 },
      });
      expect(body).toEqual({
        model: "model",
        [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: 128,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
      });
    },
  );

  it("uses the Anthropic Messages contract", async () => {
    let body: unknown;
    const adapter = createProviderAdapter(
      "anthropic",
      config,
      async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return Response.json({
          content: [{ type: "text", text: "Clarify the title" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 4 },
        });
      },
    );
    expect(await adapter.completeText("claude", input)).toMatchObject({
      text: "Clarify the title",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(body).toEqual({
      model: "claude",
      system: input.system,
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: 128,
    });
  });

  it.each(["openai_compatible", "anthropic"] as const)(
    "rejects oversized %s bodies and truncated completions",
    async (provider) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ padding: "x".repeat(65_536) }))
        .mockResolvedValueOnce(
          Response.json(
            provider === "anthropic"
              ? {
                  content: [{ type: "text", text: "Incomplete" }],
                  stop_reason: "max_tokens",
                }
              : {
                  ...completion(),
                  choices: [
                    {
                      message: { content: "Incomplete", role: "assistant" },
                      finish_reason: "length",
                    },
                  ],
                },
          ),
        );
      const adapter = createProviderAdapter(provider, config, fetchImpl);
      await expect(adapter.completeText("model", input)).rejects.toThrow(
        /exceeds limits/,
      );
      await expect(adapter.completeText("model", input)).rejects.toThrow(
        /completion/,
      );
    },
  );

  it("does not resolve credentials for an already cancelled request", async () => {
    const resolveCredential = vi.fn(config.resolveCredential);
    const adapter = createProviderAdapter(
      "openai_compatible",
      { ...config, resolveCredential },
      vi.fn(),
    );
    await expect(
      adapter.completeText("model", input, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it("does not send a request after credentials resolve past cancellation", async () => {
    let release!: (key: string) => void;
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController();
    const adapter = createProviderAdapter(
      "anthropic",
      {
        ...config,
        resolveCredential: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
      fetchImpl,
    );
    const pending = adapter.completeText("model", input, {
      signal: controller.signal,
    });
    controller.abort();
    release("secret");
    await expect(pending).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

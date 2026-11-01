import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import type { LlmModelSnapshot } from "@weaver/core/services/llmRoutes";
import { createAssistantLanguageModel, credentialFetch } from "./model";

const snapshot: LlmModelSnapshot = {
  connectionId: "c1",
  connectionName: "Conn",
  providerType: "openai_compatible",
  endpoint: "https://ai.test/v1",
  requestTimeoutMs: 1000,
  enabled: true,
  modelId: "m1",
  providerModelId: "local-chat",
  displayName: "Local",
  contextWindow: null,
  embeddingDimensions: null,
  embeddingDimensionMode: "native",
  reasoningMode: "provider_default",
  upstreamProvider: null,
  capabilities: ["chat", "tool_use"],
  inputCostMicrosPerMillion: null,
  outputCostMicrosPerMillion: null,
  currency: null,
};

describe("credentialFetch", () => {
  it("never includes invalid credentials in header errors", async () => {
    const wrapped = credentialFetch({
      resolveCredential: async () => "private-first\nprivate-tail",
      header: "authorization",
      requestTimeoutMs: 1000,
      fetchImpl: async () => new Response("{}"),
    });
    await expect(wrapped("https://ai.test")).rejects.toThrow(
      "Invalid provider credential",
    );
  });
  it("resolves the credential per request and injects the header without retaining it", async () => {
    const seen: string[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}");
    };
    const wrapped = credentialFetch({
      resolveCredential: async () => `key-${++calls}`,
      header: "authorization",
      requestTimeoutMs: 1000,
      fetchImpl,
    });
    await wrapped("https://ai.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer placeholder" },
    });
    await wrapped("https://ai.test/v1/chat/completions", { method: "POST" });
    expect(seen).toEqual(["Bearer key-1", "Bearer key-2"]);
  });

  it("sends the raw credential for x-api-key and leaves the caller's headers untouched", async () => {
    let apiKey: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      apiKey = new Headers(init?.headers).get("x-api-key");
      return new Response("{}");
    };
    const callerHeaders = { "x-api-key": "placeholder", accept: "text/plain" };
    const wrapped = credentialFetch({
      resolveCredential: async () => "sk-ant-real",
      header: "x-api-key",
      requestTimeoutMs: 1000,
      fetchImpl,
    });
    await wrapped("https://ai.test/v1/messages", { headers: callerHeaders });
    expect(apiKey).toBe("sk-ant-real");
    expect(callerHeaders["x-api-key"]).toBe("placeholder");
  });

  it("removes the placeholder authorization header when the credential is empty", async () => {
    let authorization: string | null = "unset";
    const wrapped = credentialFetch({
      resolveCredential: async () => "",
      header: "authorization",
      requestTimeoutMs: 1000,
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response("{}");
      },
    });
    await wrapped("http://127.0.0.1:1234/v1/chat/completions", {
      headers: { authorization: "Bearer placeholder" },
    });
    expect(authorization).toBeNull();
  });

  it("does not resolve a credential for an already-cancelled request", async () => {
    let resolved = 0;
    const wrapped = credentialFetch({
      resolveCredential: async () => {
        resolved += 1;
        return "k";
      },
      header: "authorization",
      requestTimeoutMs: 1000,
      fetchImpl: async () => new Response("{}"),
    });
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    await expect(
      wrapped("https://ai.test/v1/chat/completions", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/run cancelled/);
    expect(resolved).toBe(0);
  });

  it("aborts when headers do not arrive in time and forwards caller aborts", async () => {
    // Mirrors real fetch: an already-aborted signal rejects immediately.
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const rejectWithReason = () => reject(signal.reason as Error);
        if (signal.aborted) return rejectWithReason();
        signal.addEventListener("abort", rejectWithReason);
      });
    const wrapped = credentialFetch({
      resolveCredential: async () => "k",
      header: "x-api-key",
      requestTimeoutMs: 10,
      fetchImpl,
    });
    await expect(wrapped("https://ai.test/v1/messages")).rejects.toThrow(
      /timed out/,
    );
    const controller = new AbortController();
    const pending = wrapped("https://ai.test/v1/messages", {
      signal: controller.signal,
    });
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow(/caller cancelled/);
  });
});

describe("createAssistantLanguageModel", () => {
  it("builds a model for each provider type using the snapshot's provider model id", () => {
    const credentials = { resolveCredential: async () => "secret" };
    for (const providerType of [
      "openai",
      "anthropic",
      "openai_compatible",
      "lmstudio",
      "ollama",
    ] as const) {
      const model = createAssistantLanguageModel(
        { ...snapshot, providerType },
        credentials,
        fetch,
      );
      // Must stay assignable to the union `streamText` accepts.
      const asLanguageModel: LanguageModel = model;
      expect(model.modelId).toBe("local-chat");
      expect(asLanguageModel).toBe(model);
    }
  });

  it("sends local provider requests to the server root's /v1 API", async () => {
    let url = "";
    const fetchImpl: typeof fetch = async (input) => {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: "local-chat",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" } },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const model = createAssistantLanguageModel(
      {
        ...snapshot,
        providerType: "lmstudio",
        endpoint: "http://127.0.0.1:1234",
      },
      { resolveCredential: async () => "" },
      fetchImpl,
    );
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
  });

  it("never resolves a credential until a request is made, and resolves it for the snapshot's connection", async () => {
    const asked: string[] = [];
    const credentials = {
      resolveCredential: async (
        connectionId: string,
        expected: Pick<
          LlmModelSnapshot,
          "endpoint" | "providerType" | "enabled"
        >,
      ) => {
        asked.push(connectionId);
        expect(expected).toMatchObject({
          endpoint: snapshot.endpoint,
          providerType: snapshot.providerType,
          enabled: snapshot.enabled,
        });
        return "secret";
      },
    };
    let authorization: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: "local-chat",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" } },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const model = createAssistantLanguageModel(
      snapshot,
      credentials,
      fetchImpl,
    );
    expect(asked).toEqual([]);
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(asked).toEqual(["c1"]);
    expect(authorization).toBe("Bearer secret");
  });
});

describe("createAssistantLanguageModel", () => {
  const credentials = {
    resolveCredential: async () => "k",
  } as unknown as Parameters<typeof createAssistantLanguageModel>[1];
  const capture = () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: "r",
          object: "chat.completion",
          created: 0,
          model: "local-chat",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "ok" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    return { bodies, fetchImpl };
  };
  const call = (model: ReturnType<typeof createAssistantLanguageModel>) =>
    model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

  it("sends the model's reasoning mode as reasoning_effort", async () => {
    const { bodies, fetchImpl } = capture();
    await call(
      createAssistantLanguageModel(
        { ...snapshot, reasoningMode: "none" },
        credentials,
        fetchImpl,
      ),
    );
    expect(bodies[0]?.reasoning_effort).toBe("none");
  });

  it("sends nothing for the provider default", async () => {
    const { bodies, fetchImpl } = capture();
    await call(createAssistantLanguageModel(snapshot, credentials, fetchImpl));
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("pins OpenRouter assistant requests while honoring route reasoning", async () => {
    const { bodies, fetchImpl } = capture();
    await call(
      createAssistantLanguageModel(
        {
          ...snapshot,
          providerType: "openrouter",
          endpoint: "https://openrouter.ai/api/v1",
          providerModelId: "google/gemini",
          upstreamProvider: "google-vertex/us-east5",
          reasoningMode: "none",
        },
        credentials,
        fetchImpl,
      ),
    );

    expect(bodies[0]).toMatchObject({
      model: "google/gemini",
      provider: { only: ["google-vertex/us-east5"] },
      reasoning_effort: "none",
    });
  });

  it("omits OpenRouter provider selection for automatic routing", async () => {
    const { bodies, fetchImpl } = capture();
    await call(
      createAssistantLanguageModel(
        {
          ...snapshot,
          providerType: "openrouter",
          endpoint: "https://openrouter.ai/api/v1",
          upstreamProvider: null,
        },
        credentials,
        fetchImpl,
      ),
    );

    expect(bodies[0]).not.toHaveProperty("provider");
  });
});

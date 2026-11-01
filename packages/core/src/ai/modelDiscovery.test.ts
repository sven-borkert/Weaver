import { describe, expect, it } from "vitest";

import type { DiscoveredModel } from "./adapter";
import {
  type LiteLlmModelInfo,
  applyLiteLlmModelInfo,
  defaultCapabilities,
  discoveredModelFromOpenAiItem,
  finalizeDiscoveredModels,
  liteLlmModelInfoById,
  optionalPositiveInt,
} from "./modelDiscovery";

function discovered(overrides: Partial<DiscoveredModel>): DiscoveredModel {
  return {
    providerModelId: "m",
    displayName: "m",
    contextWindow: null,
    maxOutputTokens: null,
    embeddingDimensions: null,
    capabilities: [],
    source: "inferred",
    ...overrides,
  };
}

describe("optionalPositiveInt", () => {
  it("accepts positive PostgreSQL integers and rejects everything else", () => {
    expect(optionalPositiveInt(4096)).toBe(4096);
    expect(optionalPositiveInt(2_147_483_647)).toBe(2_147_483_647);
    expect(optionalPositiveInt(0)).toBeNull();
    expect(optionalPositiveInt(-1)).toBeNull();
    expect(optionalPositiveInt(1.5)).toBeNull();
    expect(optionalPositiveInt(2_147_483_648)).toBeNull();
    expect(optionalPositiveInt("4096")).toBeNull();
    expect(optionalPositiveInt(undefined)).toBeNull();
  });
});

describe("discoveredModelFromOpenAiItem", () => {
  it("maps a bare OpenAI item to an unknown model", () => {
    expect(discoveredModelFromOpenAiItem({ id: "gpt-x" })).toEqual(
      discovered({ providerModelId: "gpt-x", displayName: "gpt-x" }),
    );
  });

  it("reads OpenRouter metadata and capability hints", () => {
    expect(
      discoveredModelFromOpenAiItem({
        id: "vendor/model",
        name: "Vendor: Model",
        context_length: 131_072,
        top_provider: { max_completion_tokens: 8192 },
        supported_parameters: ["tools", "response_format", "temperature"],
      }),
    ).toEqual(
      discovered({
        providerModelId: "vendor/model",
        displayName: "Vendor: Model",
        contextWindow: 131_072,
        maxOutputTokens: 8192,
        capabilities: ["chat", "json_output", "tool_use"],
        source: "endpoint",
      }),
    );
  });

  it("reads vLLM's max_model_len as the context window", () => {
    expect(
      discoveredModelFromOpenAiItem({ id: "served", max_model_len: 32_768 }),
    ).toMatchObject({ contextWindow: 32_768, source: "endpoint" });
  });

  it("reads LiteLLM's embedding mode from the public model list", () => {
    expect(
      discoveredModelFromOpenAiItem({
        id: "text-embed",
        mode: "embedding",
        max_input_tokens: 8192,
      }),
    ).toEqual(
      discovered({
        providerModelId: "text-embed",
        displayName: "text-embed",
        contextWindow: 8192,
        capabilities: ["embedding"],
        source: "endpoint",
      }),
    );
  });

  it("treats LiteLLM's chat mode as no capability assertion", () => {
    expect(
      discoveredModelFromOpenAiItem({ id: "gpt-x", mode: "chat" }),
    ).toEqual(discovered({ providerModelId: "gpt-x", displayName: "gpt-x" }));
  });

  it("marks vision models from LiteLLM and OpenRouter metadata", () => {
    expect(
      discoveredModelFromOpenAiItem({ id: "gpt-x", supports_vision: true })
        ?.capabilities,
    ).toEqual(["chat", "vision"]);
    expect(
      discoveredModelFromOpenAiItem({
        id: "router/x",
        supported_parameters: ["tools"],
        architecture: { input_modalities: ["text", "image"] },
      })?.capabilities,
    ).toEqual(["chat", "tool_use", "vision"]);
  });

  it("ignores junk metadata and drops items without a string id", () => {
    expect(
      discoveredModelFromOpenAiItem({
        id: "x",
        context_length: "big",
        top_provider: { max_completion_tokens: -5 },
        supported_parameters: "tools",
      }),
    ).toEqual(discovered({ providerModelId: "x", displayName: "x" }));
    expect(discoveredModelFromOpenAiItem({ object: "model" })).toBeNull();
    expect(discoveredModelFromOpenAiItem("gpt")).toBeNull();
  });
});

describe("defaultCapabilities", () => {
  it("infers embeddings, non-LLM ids, and provider-specific chat defaults", () => {
    expect(defaultCapabilities("openai", "text-embedding-3-small")).toEqual([
      "embedding",
    ]);
    expect(defaultCapabilities("ollama", "nomic-embed-text")).toEqual([
      "embedding",
    ]);
    expect(defaultCapabilities("openai", "whisper-1")).toEqual([]);
    expect(defaultCapabilities("anthropic", "claude-future")).toEqual([
      "chat",
      "json_output",
      "tool_use",
    ]);
    expect(defaultCapabilities("openai_compatible", "llama-3")).toEqual([
      "chat",
      "json_output",
    ]);
    expect(defaultCapabilities("openai", "gpt-unknown")).toEqual(["chat"]);
    expect(defaultCapabilities("lmstudio", "mystery")).toEqual(["chat"]);
  });
});

describe("finalizeDiscoveredModels", () => {
  it("fills unknown values from the catalog and marks the source", () => {
    const [model] = finalizeDiscoveredModels("openai", [
      discovered({ providerModelId: "gpt-4o", displayName: "gpt-4o" }),
    ]);
    expect(model).toEqual(
      discovered({
        providerModelId: "gpt-4o",
        displayName: "gpt-4o",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        capabilities: ["chat", "json_output", "tool_use", "vision"],
        source: "catalog",
      }),
    );
  });

  it("lets endpoint-reported values win over the catalog", () => {
    const [model] = finalizeDiscoveredModels("openai_compatible", [
      discovered({
        providerModelId: "openai/gpt-4o",
        contextWindow: 1000,
        capabilities: ["chat"],
        source: "endpoint",
      }),
    ]);
    expect(model).toMatchObject({
      contextWindow: 1000,
      maxOutputTokens: 16_384,
      capabilities: ["chat"],
      source: "endpoint",
    });
  });

  it("falls back to inferred defaults when neither endpoint nor catalog know the model", () => {
    const [chat, embed] = finalizeDiscoveredModels("openai_compatible", [
      discovered({ providerModelId: "llama-3" }),
      discovered({ providerModelId: "bge-embed" }),
    ]);
    expect(chat).toMatchObject({
      capabilities: ["chat", "json_output"],
      source: "inferred",
    });
    expect(embed).toMatchObject({
      capabilities: ["embedding"],
      embeddingDimensions: null,
      source: "inferred",
    });
  });

  it("fills embedding dimensions from the catalog only for embedding models", () => {
    const [embed, chat] = finalizeDiscoveredModels("openai", [
      discovered({ providerModelId: "text-embedding-3-small" }),
      discovered({
        providerModelId: "gpt-4o",
        embeddingDimensions: 4096,
        capabilities: ["chat"],
        source: "endpoint",
      }),
    ]);
    expect(embed).toMatchObject({
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });
    expect(chat?.embeddingDimensions).toBeNull();
  });

  it("dedupes by provider model id, keeps provider order, and bounds display names", () => {
    const models = finalizeDiscoveredModels("lmstudio", [
      discovered({ providerModelId: "b", displayName: "x".repeat(100) }),
      discovered({ providerModelId: "a" }),
      discovered({ providerModelId: "b", displayName: "second" }),
    ]);
    expect(models.map((model) => model.providerModelId)).toEqual(["b", "a"]);
    expect(models[0]?.displayName).toHaveLength(80);
  });
});

function info(overrides: Partial<LiteLlmModelInfo>): LiteLlmModelInfo {
  return {
    mode: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    supportsFunctionCalling: null,
    outputVectorSize: null,
    ...overrides,
  };
}

describe("liteLlmModelInfoById", () => {
  it("indexes LiteLLM /model/info entries by model name and ignores junk", () => {
    const entries = liteLlmModelInfoById({
      data: [
        {
          model_name: "chat-a",
          model_info: {
            mode: "chat",
            max_input_tokens: 1000,
            max_output_tokens: 100,
            supports_function_calling: true,
          },
        },
        {
          model_name: "embed-b",
          model_info: { mode: "Embedding", output_vector_size: 1024 },
        },
        { model_name: "chat-a", model_info: { mode: "embedding" } },
        { model_name: "junk", model_info: "nope" },
        { model_info: { mode: "chat" } },
        "string",
      ],
    });
    expect([...entries.keys()]).toEqual(["chat-a", "embed-b"]);
    expect(entries.get("chat-a")).toEqual(
      info({
        mode: "chat",
        maxInputTokens: 1000,
        maxOutputTokens: 100,
        supportsFunctionCalling: true,
      }),
    );
    expect(entries.get("embed-b")).toEqual(
      info({ mode: "embedding", outputVectorSize: 1024 }),
    );
    expect(liteLlmModelInfoById(null).size).toBe(0);
    expect(liteLlmModelInfoById({ data: "x" }).size).toBe(0);
  });
});

describe("applyLiteLlmModelInfo", () => {
  it("declares tool use only when LiteLLM asserts function calling", () => {
    const base = discovered({ providerModelId: "m", displayName: "m" });
    expect(
      applyLiteLlmModelInfo(
        base,
        info({ mode: "chat", supportsFunctionCalling: true }),
      ),
    ).toEqual(
      discovered({
        providerModelId: "m",
        displayName: "m",
        capabilities: ["chat", "json_output", "tool_use"],
        source: "endpoint",
      }),
    );
    expect(
      applyLiteLlmModelInfo(
        base,
        info({ mode: "chat", supportsFunctionCalling: false }),
      ),
    ).toEqual(base);
    expect(applyLiteLlmModelInfo(base, info({ mode: "chat" }))).toEqual(base);
  });

  it("adds tool use to capabilities the public list already reported", () => {
    const base = discovered({
      providerModelId: "m",
      displayName: "m",
      capabilities: ["chat"],
      source: "endpoint",
    });
    expect(
      applyLiteLlmModelInfo(base, info({ supportsFunctionCalling: true }))
        .capabilities,
    ).toEqual(["chat", "tool_use"]);
  });

  it("marks embedding models and fills dimensions and limits the list omitted", () => {
    const base = discovered({
      providerModelId: "e",
      displayName: "e",
      contextWindow: 512,
    });
    expect(
      applyLiteLlmModelInfo(
        base,
        info({
          mode: "embedding",
          maxInputTokens: 8192,
          maxOutputTokens: 1,
          outputVectorSize: 1024,
        }),
      ),
    ).toEqual(
      discovered({
        providerModelId: "e",
        displayName: "e",
        contextWindow: 512,
        maxOutputTokens: 1,
        embeddingDimensions: 1024,
        capabilities: ["embedding"],
        source: "endpoint",
      }),
    );
  });
});

it("omits model identifiers that cannot be imported", () => {
  expect(
    finalizeDiscoveredModels("openai", [
      discovered({ providerModelId: "x".repeat(201) }),
    ]),
  ).toEqual([]);
});

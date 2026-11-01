import { describe, expect, it } from "vitest";

import {
  changesEmbeddingIdentity,
  connectionFormSchema,
  endpointAfterProviderChange,
  fixedEndpointFor,
  knowledgeDimensionHint,
  modelFormSchema,
  optionalInt,
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_LABELS,
  providerHasEditableEndpoint,
  providerRequiresCredential,
  providerTypes,
  reembedMessage,
  type ProviderType,
} from "./llmSchemas";

const validModel = {
  providerModelId: "gpt-test",
  displayName: "GPT Test",
  contextWindow: "",
  maxOutputTokens: "",
  embeddingDimensions: "",
  embeddingDimensionMode: "native" as const,
  upstreamProvider: "",
  capabilities: ["chat"] as const,
  inputCostMicrosPerMillion: "",
  outputCostMicrosPerMillion: "",
  currency: "",
};

function issuePaths(input: Record<string, unknown>) {
  const result = modelFormSchema.safeParse({ ...validModel, ...input });
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path[0]);
}

describe("modelFormSchema numeric fields", () => {
  it.each(["native", "matryoshka"] as const)(
    "accepts the %s embedding dimension mode",
    (embeddingDimensionMode) => {
      expect(
        modelFormSchema.safeParse({
          ...validModel,
          capabilities: ["embedding"],
          embeddingDimensions: "1536",
          embeddingDimensionMode,
        }).success,
      ).toBe(true);
    },
  );

  it.each(["-1", "1.5", "2147483648", "not-a-number"])(
    "rejects invalid context windows before submission: %s",
    (contextWindow) => {
      expect(issuePaths({ contextWindow })).toContain("contextWindow");
    },
  );

  it.each(["", "0", "1.5", "16001", "not-a-number"])(
    "requires bounded integer embedding dimensions: %s",
    (embeddingDimensions) => {
      expect(
        issuePaths({
          capabilities: ["embedding"],
          embeddingDimensions,
        }),
      ).toContain("embeddingDimensions");
    },
  );

  it.each(["inputCostMicrosPerMillion", "outputCostMicrosPerMillion"])(
    "rejects invalid %s values before submission",
    (field) => {
      for (const value of ["-1", "1.5", "2147483648", "not-a-number"]) {
        expect(issuePaths({ [field]: value })).toContain(field);
      }
    },
  );

  it("accepts optional blanks and all numeric boundaries", () => {
    expect(modelFormSchema.safeParse(validModel).success).toBe(true);
    expect(
      modelFormSchema.safeParse({
        ...validModel,
        contextWindow: "1",
        capabilities: ["embedding"],
        embeddingDimensions: "1",
        inputCostMicrosPerMillion: "0",
        outputCostMicrosPerMillion: "0",
      }).success,
    ).toBe(true);
    expect(
      modelFormSchema.safeParse({
        ...validModel,
        contextWindow: "2147483647",
        capabilities: ["embedding"],
        embeddingDimensions: "16000",
        inputCostMicrosPerMillion: "2147483647",
        outputCostMicrosPerMillion: "2147483647",
      }).success,
    ).toBe(true);
  });

  it("ignores a stale hidden embedding value when embedding is not selected", () => {
    expect(
      modelFormSchema.safeParse({
        ...validModel,
        embeddingDimensions: "16001",
      }).success,
    ).toBe(true);
  });
});

describe("optionalInt", () => {
  it("preserves blank as null and converts a validated integer", () => {
    expect(optionalInt("  ")).toBeNull();
    expect(optionalInt("2147483647")).toBe(2_147_483_647);
  });

  it.each(["-1", "1.5", "2147483648", "not-a-number"])(
    "rejects an unvalidated integer value: %s",
    (value) => {
      expect(() => optionalInt(value)).toThrow("valid PostgreSQL integer");
    },
  );
});

describe("modelFormSchema max output tokens", () => {
  it.each(["-1", "1.5", "2147483648", "not-a-number"])(
    "rejects invalid max output tokens before submission: %s",
    (maxOutputTokens) => {
      expect(issuePaths({ maxOutputTokens })).toContain("maxOutputTokens");
    },
  );

  it("accepts blank and boundary max output tokens", () => {
    for (const maxOutputTokens of ["", "1", "2147483647"]) {
      expect(issuePaths({ maxOutputTokens })).not.toContain("maxOutputTokens");
    }
  });
});

describe("connectionFormSchema endpoints", () => {
  const validConnection = {
    name: "C",
    providerType: "openai" as const,
    endpoint: "",
    credential: "",
    requestTimeoutMs: 30_000,
    enabled: true,
  };
  const endpointIssues = (providerType: ProviderType, endpoint: string) => {
    const result = connectionFormSchema.safeParse({
      ...validConnection,
      providerType,
      endpoint,
    });
    return result.success
      ? []
      : result.error.issues.map((issue) => issue.path[0]);
  };

  it("requires an endpoint only for providers with an editable endpoint", () => {
    for (const providerType of [
      "openai_compatible",
      "lmstudio",
      "ollama",
    ] as const) {
      expect(endpointIssues(providerType, "")).toContain("endpoint");
      expect(endpointIssues(providerType, "http://127.0.0.1:1")).toEqual([]);
    }
    for (const providerType of ["openai", "anthropic"] as const) {
      expect(endpointIssues(providerType, "")).toEqual([]);
    }
  });

  it("leaves the create-mode credential rule to the dialog", () => {
    expect(
      connectionFormSchema.safeParse({ ...validConnection, credential: "" })
        .success,
    ).toBe(true);
  });

  it("accepts request timeouts up to two minutes for slow local providers", () => {
    const accepts = (requestTimeoutMs: number) =>
      connectionFormSchema.safeParse({ ...validConnection, requestTimeoutMs })
        .success;

    expect(accepts(120_000)).toBe(true);
    expect(accepts(120_001)).toBe(false);
  });
});

describe("provider helpers", () => {
  it("knows which providers edit their endpoint and need a key", () => {
    expect(providerTypes.map(providerHasEditableEndpoint)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(providerTypes.map(providerRequiresCredential)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(fixedEndpointFor("openai")).toBe("https://api.openai.com/v1");
    expect(fixedEndpointFor("anthropic")).toBe("https://api.anthropic.com/v1");
    expect(fixedEndpointFor("openrouter")).toBe("https://openrouter.ai/api/v1");
    expect(fixedEndpointFor("lmstudio")).toBeNull();
    expect(PROVIDER_LABELS.openrouter).toBe("OpenRouter");
    expect(PROVIDER_LABELS.lmstudio).toBe("LM Studio");
    expect(PROVIDER_LABELS.ollama).toBe("Ollama");
  });

  it("replaces only blank or prefilled endpoints when the provider changes", () => {
    const lmstudio = PROVIDER_DEFAULT_ENDPOINTS.lmstudio;
    const ollama = PROVIDER_DEFAULT_ENDPOINTS.ollama;
    expect(endpointAfterProviderChange("", "lmstudio")).toBe(lmstudio);
    expect(endpointAfterProviderChange("", "ollama")).toBe(ollama);
    expect(endpointAfterProviderChange("", "openai_compatible")).toBe("");
    expect(endpointAfterProviderChange("", "openrouter")).toBe("");
    expect(endpointAfterProviderChange(lmstudio, "ollama")).toBe(ollama);
    expect(endpointAfterProviderChange(ollama, "openai_compatible")).toBe("");
    expect(endpointAfterProviderChange(`${lmstudio} `, "openai")).toBe("");
    expect(endpointAfterProviderChange("http://gpu:8000/v1", "ollama")).toBe(
      "http://gpu:8000/v1",
    );
  });
});

describe("OpenRouter model form", () => {
  it("accepts automatic routing and a selected upstream provider", () => {
    expect(modelFormSchema.parse(validModel)).toMatchObject({
      upstreamProvider: "",
    });
    expect(
      modelFormSchema.parse({ ...validModel, upstreamProvider: "together" }),
    ).toMatchObject({ upstreamProvider: "together" });
  });
});

it.each(["contextWindow", "maxOutputTokens"])("rejects zero %s", (field) => {
  expect(issuePaths({ [field]: "0" })).toContain(field);
});

describe("knowledge dimension copy", () => {
  it("lists the indexed sizes and flags exact search for other supported sizes", () => {
    const base =
      "Knowledge embeddings support 1–4,000; indexed sizes: 256, 384, 512, 768, 1,024, 1,536, 2,048, 2,560, 3,072, 4,000.";
    expect(knowledgeDimensionHint("1024")).toBe(base);
    expect(knowledgeDimensionHint("")).toBe(base);
    expect(knowledgeDimensionHint("5000")).toBe(base);
    expect(knowledgeDimensionHint("12.5")).toBe(base);
    expect(knowledgeDimensionHint("1000")).toBe(
      `${base} This size uses exact search, which is fine for small projects.`,
    );
  });

  it("detects identity changes of an embedding model", () => {
    const saved = {
      providerModelId: "qwen",
      embeddingDimensions: 1536,
      embeddingDimensionMode: "matryoshka",
      upstreamProvider: null,
    };
    expect(changesEmbeddingIdentity(saved, { ...saved })).toBe(false);
    expect(
      changesEmbeddingIdentity(saved, { ...saved, embeddingDimensions: 1024 }),
    ).toBe(true);
    expect(
      changesEmbeddingIdentity(saved, {
        ...saved,
        upstreamProvider: "together",
      }),
    ).toBe(true);
  });

  it("describes a re-embed", () => {
    expect(reembedMessage(1)).toBe(
      "Re-embeds the knowledge index of 1 project. The graph is kept; semantic search shows keyword results until each project finishes.",
    );
  });
});

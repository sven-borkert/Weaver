import { describe, expect, it } from "vitest";

import {
  defaultVectorSpaceKey,
  effectiveVectorSpaceKey,
  knowledgeExtractionFingerprint,
  knowledgeIdentityField,
  knowledgeIndexFingerprint,
} from "./identity";

const ollamaEmbedding = {
  providerType: "ollama",
  endpoint: "http://ollama.test:11434",
  providerModelId: "qwen3-embedding:4b",
  upstreamProvider: null,
};

describe("knowledge identity digests", () => {
  it("escapes backslashes before separators", () => {
    expect(knowledgeIdentityField("a|b\\c")).toBe("a\\|b\\\\c");
    expect(knowledgeIdentityField(null)).toBe("");
    expect(knowledgeIdentityField(undefined)).toBe("");
  });

  it("pins the canonical digests shared with the SQL functions", () => {
    const key = defaultVectorSpaceKey(ollamaEmbedding);
    expect(key).toBe(
      "5dd0439ab9b0eb40863ab076a8bcec011106b67bef53498d8d52325146cd6849",
    );
    expect(
      knowledgeIndexFingerprint(
        {
          vectorSpaceKey: key,
          embeddingDimensions: 1536,
          embeddingDimensionMode: "matryoshka",
        },
        1,
      ),
    ).toBe("76f0ba41e69a7685d442f8df90e29a340446a3e101cd4ccd91471d54707728f7");
    expect(knowledgeIndexFingerprint(null, 1)).toBe(
      "bbf8748c74553f22cb890bb5df0e80c6517ee32ee7f4531103de64d21d4043ac",
    );
    expect(
      knowledgeExtractionFingerprint(
        {
          providerType: "openai_compatible",
          endpoint: "https://models.example/v1",
          providerModelId: "extract",
          upstreamProvider: null,
        },
        "prompt-v2",
      ),
    ).toBe("b7df416b6457cf9cac0fcf72aef5ca17688628c942c88bcafb472011e2ae4379");
    expect(
      defaultVectorSpaceKey({
        providerType: "openrouter",
        endpoint: "https://openrouter.ai/api/v1",
        providerModelId: "a|b\\c",
        upstreamProvider: "prov|x",
      }),
    ).toBe("a0ee649cd3cd86271b12ebfa15ccc0ff28991d5d2425a5713f40f38da7d8e80a");
  });

  it("lets a verified key override the provider identity", () => {
    const verifiedKey = defaultVectorSpaceKey(ollamaEmbedding);
    expect(
      effectiveVectorSpaceKey({
        providerType: "openrouter",
        endpoint: "https://openrouter.ai/api/v1",
        providerModelId: "qwen/qwen3-embedding-4b",
        vectorSpaceKey: verifiedKey,
      }),
    ).toBe(verifiedKey);
    expect(effectiveVectorSpaceKey(ollamaEmbedding)).toBe(verifiedKey);
  });

  it("treats a missing upstream provider like an empty one", () => {
    const { upstreamProvider: _omitted, ...withoutUpstream } = ollamaEmbedding;
    expect(defaultVectorSpaceKey(withoutUpstream)).toBe(
      defaultVectorSpaceKey(ollamaEmbedding),
    );
  });
});

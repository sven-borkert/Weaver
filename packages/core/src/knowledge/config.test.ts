import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  type KnowledgeRoutingIdentity,
  knowledgeConfigFingerprint,
  parseKnowledgeConfig,
} from "./config";
import { defaultVectorSpaceKey, knowledgeIndexFingerprint } from "./identity";

describe("knowledge configuration", () => {
  it("parses jobs-only defaults", () => {
    expect(parseKnowledgeConfig({})).toEqual({
      jobsEnabled: true,
      ingestionTmpTtlMinutes: 60,
      workerConcurrency: 2,
      reconcileCron: "*/15 * * * *",
      assistantReconcileCron: "* * * * *",
      taskTickCron: "* * * * *",
    });
  });

  it("keeps assistant recovery on a tighter cron than knowledge reconciliation", () => {
    const config = parseKnowledgeConfig({
      WEAVER_KNOWLEDGE_RECONCILE_CRON: "0 3 * * *",
      WEAVER_ASSISTANT_RECONCILE_CRON: "*/2 * * * *",
    });
    expect(config).toMatchObject({
      reconcileCron: "0 3 * * *",
      assistantReconcileCron: "*/2 * * * *",
    });
  });

  it("validates ingestion cleanup and recovery TTL", () => {
    for (const value of ["0", "10081", "1.5", "bad"])
      expect(() =>
        parseKnowledgeConfig({ WEAVER_INGESTION_TMP_TTL_MINUTES: value }),
      ).toThrow();
    for (const value of [1, 60, 10080])
      expect(
        parseKnowledgeConfig({
          WEAVER_INGESTION_TMP_TTL_MINUTES: String(value),
        }).ingestionTmpTtlMinutes,
      ).toBe(value);
  });

  it("caps worker concurrency for a provable lease", () => {
    expect(() =>
      parseKnowledgeConfig({ WEAVER_JOB_WORKER_CONCURRENCY: "9" }),
    ).toThrow();
    expect(
      parseKnowledgeConfig({ WEAVER_JOB_WORKER_CONCURRENCY: "8" }),
    ).toMatchObject({ workerConcurrency: 8 });
  });

  it("treats blank values as unset", () => {
    expect(
      parseKnowledgeConfig({
        WEAVER_JOBS_ENABLED: "",
        WEAVER_JOB_WORKER_CONCURRENCY: "",
        WEAVER_KNOWLEDGE_RECONCILE_CRON: "",
        WEAVER_ASSISTANT_RECONCILE_CRON: "",
      }),
    ).toEqual({
      jobsEnabled: true,
      ingestionTmpTtlMinutes: 60,
      workerConcurrency: 2,
      reconcileCron: "*/15 * * * *",
      assistantReconcileCron: "* * * * *",
      taskTickCron: "* * * * *",
    });
  });

  it("returns jobs-only defaults under SKIP_ENV_VALIDATION", () => {
    expect(
      parseKnowledgeConfig({
        SKIP_ENV_VALIDATION: "1",
        WEAVER_JOB_WORKER_CONCURRENCY: "not-a-number",
      }),
    ).toEqual({
      jobsEnabled: true,
      ingestionTmpTtlMinutes: 60,
      workerConcurrency: 2,
      reconcileCron: "*/15 * * * *",
      assistantReconcileCron: "* * * * *",
      taskTickCron: "* * * * *",
    });
    expect(
      parseKnowledgeConfig({
        SKIP_ENV_VALIDATION: "1",
        WEAVER_JOBS_ENABLED: "false",
      }).jobsEnabled,
    ).toBe(false);
  });

  it("fingerprints only the vector space and extraction schema", () => {
    const first = {
      extraction: {
        providerType: "openai_compatible",
        endpoint: "https://models.example/v1",
        providerModelId: "extract",
      },
      embedding: {
        providerType: "openai_compatible",
        endpoint: "https://models.example/v1",
        providerModelId: "embed",
        embeddingDimensions: 1536,
        embeddingDimensionMode: "native" as const,
      },
    };
    const fingerprint = knowledgeConfigFingerprint(first);

    for (const extraction of [
      { ...first.extraction, providerModelId: "extract-v2" },
      { ...first.extraction, endpoint: "https://other.example/v1" },
      { ...first.extraction, upstreamProvider: "anthropic" },
    ]) {
      expect(knowledgeConfigFingerprint({ ...first, extraction })).toBe(
        fingerprint,
      );
    }
    for (const embedding of [
      { ...first.embedding, providerModelId: "embed-v2" },
      { ...first.embedding, endpoint: "https://other.example/v1" },
      { ...first.embedding, upstreamProvider: "nebius" },
      { ...first.embedding, embeddingDimensions: 3072 },
      { ...first.embedding, embeddingDimensionMode: "matryoshka" as const },
    ]) {
      expect(knowledgeConfigFingerprint({ ...first, embedding })).not.toBe(
        fingerprint,
      );
    }
    expect(
      knowledgeConfigFingerprint({
        ...first,
        embedding: {
          ...first.embedding,
          providerType: "openrouter",
          endpoint: "https://openrouter.ai/api/v1",
          providerModelId: "embed-elsewhere",
          vectorSpaceKey: defaultVectorSpaceKey(first.embedding),
        },
      }),
    ).toBe(fingerprint);
    expect(
      knowledgeConfigFingerprint(
        first,
        KNOWLEDGE_EXTRACTION_SCHEMA_VERSION + 1,
      ),
    ).not.toBe(fingerprint);
    expect(knowledgeConfigFingerprint(null)).toBe(
      knowledgeIndexFingerprint(null, KNOWLEDGE_EXTRACTION_SCHEMA_VERSION),
    );
    expect(knowledgeConfigFingerprint(null)).not.toBe(fingerprint);
  });

  it("accepts the public routing identity shape", () => {
    const routing: KnowledgeRoutingIdentity = {
      extraction: {
        providerType: "openai_compatible",
        endpoint: "https://models.example/v1",
        providerModelId: "extract",
      },
      embedding: {
        providerType: "openai_compatible",
        endpoint: "https://models.example/v1",
        providerModelId: "embed",
        embeddingDimensions: 1536,
        embeddingDimensionMode: "native",
      },
    };

    expect(knowledgeConfigFingerprint(routing)).toMatch(/^[a-f0-9]{64}$/);
  });
});

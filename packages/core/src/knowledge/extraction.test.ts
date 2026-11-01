import { describe, expect, it } from "vitest";

import {
  extractionResponseSchema,
  normalizeKnowledgeName,
  normalizeRelationType,
} from "./extraction";

const entity = (key: string) => ({
  key,
  name: `Entity ${key}`,
  type: "Service",
  aliases: [key],
  description: null,
  mentionText: `Entity ${key}`,
  confidence: 0.9,
});

const relation = (sourceKey = "source", targetKey = "target") => ({
  sourceKey,
  targetKey,
  type: "depends on",
  description: null,
  confidence: 0.8,
  validFrom: "2026-08-29T12:00:00Z",
  validTo: null,
});

describe("extractionResponseSchema", () => {
  it("accepts the documented boundaries and known local endpoints", () => {
    const response = {
      entities: Array.from({ length: 50 }, (_, index) => ({
        ...entity(`entity-${index}`),
        name: "n".repeat(200),
        type: "t".repeat(200),
        aliases: Array.from(
          { length: 20 },
          (_, aliasIndex) => `alias-${aliasIndex}`,
        ),
      })),
      relations: Array.from({ length: 100 }, () => relation()),
    };
    response.entities[0] = { ...entity("source"), aliases: [] };
    response.entities[1] = { ...entity("target"), aliases: [] };

    expect(extractionResponseSchema.safeParse(response).success).toBe(true);
  });

  it("rejects values beyond bounded extraction limits", () => {
    expect(
      extractionResponseSchema.safeParse({
        entities: Array.from({ length: 51 }, (_, index) =>
          entity(`entity-${index}`),
        ),
        relations: [],
      }).success,
    ).toBe(false);
    expect(
      extractionResponseSchema.safeParse({
        entities: [entity("source"), entity("target")],
        relations: Array.from({ length: 101 }, () => relation()),
      }).success,
    ).toBe(false);
    expect(
      extractionResponseSchema.safeParse({
        entities: [{ ...entity("source"), aliases: Array(21).fill("alias") }],
        relations: [],
      }).success,
    ).toBe(false);
    expect(
      extractionResponseSchema.safeParse({
        entities: [{ ...entity("source"), name: "n".repeat(201) }],
        relations: [],
      }).success,
    ).toBe(false);
    expect(
      extractionResponseSchema.safeParse({
        entities: [{ ...entity("source"), type: "t".repeat(201) }],
        relations: [],
      }).success,
    ).toBe(false);
  });

  it("rejects invalid confidences, timestamps, and relation endpoints", () => {
    expect(
      extractionResponseSchema.safeParse({
        entities: [{ ...entity("source"), confidence: 1.01 }],
        relations: [],
      }).success,
    ).toBe(false);
    expect(
      extractionResponseSchema.safeParse({
        entities: [entity("source")],
        relations: [
          { ...relation("source", "missing"), validFrom: "not-a-date" },
        ],
      }).success,
    ).toBe(false);
    expect(
      extractionResponseSchema.safeParse({
        entities: [entity("source")],
        relations: [relation("source", "missing")],
      }).success,
    ).toBe(false);
  });
});

describe("knowledge normalization", () => {
  it("normalizes names and relation types for identity matching", () => {
    expect(normalizeKnowledgeName("  ＡＣＭＥ\t Service  ")).toBe(
      "acme service",
    );
    expect(normalizeRelationType("  Depends\t On  ")).toBe("depends_on");
  });
});

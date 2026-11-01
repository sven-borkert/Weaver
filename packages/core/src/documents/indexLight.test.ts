import { describe, expect, it } from "vitest";
import {
  documentIndexLights,
  indexLightsDescription,
  type IndexStateRow,
} from "./indexLight";

const SHA = "a".repeat(40);
const base: IndexStateRow = {
  headCommitSha: SHA,
  keywordStatus: null,
  keywordTargetSha: null,
  keywordIndexedSha: null,
  keywordFailureSummary: null,
  generationStatus: null,
  generationTargetSha: null,
  generationFingerprint: null,
  semanticIndexedSha: null,
  graphIndexedSha: null,
  generationFailureSummary: null,
};
const generation = { configFingerprint: "fp-1" };

describe("documentIndexLights", () => {
  it("is pending everywhere for a fresh document with a generation", () => {
    expect(documentIndexLights(base, generation)).toEqual({
      keyword: "pending",
      semantic: "pending",
      graph: "pending",
      summary: null,
    });
  });

  it("marks semantic and graph unavailable without a generation", () => {
    const lights = documentIndexLights(base, null);
    expect(lights.semantic).toBe("unavailable");
    expect(lights.graph).toBe("unavailable");
  });

  it("is ready when every SHA matches the head and the fingerprint matches", () => {
    const row: IndexStateRow = {
      ...base,
      keywordStatus: "ready",
      keywordTargetSha: SHA,
      keywordIndexedSha: SHA,
      generationStatus: "ready",
      generationTargetSha: SHA,
      generationFingerprint: "fp-1",
      semanticIndexedSha: SHA,
      graphIndexedSha: SHA,
    };
    expect(documentIndexLights(row, generation)).toEqual({
      keyword: "ready",
      semantic: "ready",
      graph: "ready",
      summary: null,
    });
  });

  it("is pending again when the head moved past the indexed SHA", () => {
    const row: IndexStateRow = {
      ...base,
      headCommitSha: "b".repeat(40),
      keywordStatus: "ready",
      keywordTargetSha: SHA,
      keywordIndexedSha: SHA,
      generationStatus: "ready",
      generationTargetSha: SHA,
      generationFingerprint: "fp-1",
      semanticIndexedSha: SHA,
      graphIndexedSha: SHA,
    };
    const lights = documentIndexLights(row, generation);
    expect([lights.keyword, lights.semantic, lights.graph]).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("reports a keyword failure with its summary", () => {
    const row: IndexStateRow = {
      ...base,
      keywordStatus: "failed",
      keywordTargetSha: SHA,
      keywordFailureSummary: "Document exceeds keyword indexing limits",
    };
    expect(documentIndexLights(row, generation)).toMatchObject({
      keyword: "failed",
      summary: "Document exceeds keyword indexing limits",
    });
  });

  it("a keyword failure recorded for an older revision is pending, not failed", () => {
    const row: IndexStateRow = {
      ...base,
      keywordStatus: "failed",
      keywordTargetSha: "b".repeat(40),
      keywordFailureSummary: "Document exceeds keyword indexing limits",
    };
    expect(documentIndexLights(row, generation)).toMatchObject({
      keyword: "pending",
      summary: null,
    });
  });

  it("reports a keyword blocked_configuration failure that is current", () => {
    const row: IndexStateRow = {
      ...base,
      keywordStatus: "blocked_configuration",
      keywordTargetSha: SHA,
      keywordFailureSummary: "Keyword indexing is not configured",
    };
    expect(documentIndexLights(row, generation)).toMatchObject({
      keyword: "failed",
      summary: "Keyword indexing is not configured",
    });
  });

  it("keeps semantic green when only extraction failed", () => {
    const row: IndexStateRow = {
      ...base,
      keywordStatus: "ready",
      keywordTargetSha: SHA,
      keywordIndexedSha: SHA,
      generationStatus: "failed",
      generationTargetSha: SHA,
      generationFingerprint: "fp-1",
      semanticIndexedSha: SHA,
      graphIndexedSha: null,
      generationFailureSummary: "Provider unavailable",
    };
    expect(documentIndexLights(row, generation)).toEqual({
      keyword: "ready",
      semantic: "ready",
      graph: "failed",
      summary: "Provider unavailable",
    });
  });

  it("treats a stale fingerprint as pending, not ready", () => {
    const row: IndexStateRow = {
      ...base,
      generationStatus: "ready",
      generationTargetSha: SHA,
      generationFingerprint: "fp-0",
      semanticIndexedSha: SHA,
      graphIndexedSha: SHA,
    };
    const lights = documentIndexLights(row, generation);
    expect(lights.semantic).toBe("pending");
    expect(lights.graph).toBe("pending");
  });

  it("shows a configuration-blocked document as pending while a rebuild covers it", () => {
    const row = {
      headCommitSha: "a",
      keywordStatus: "ready",
      keywordTargetSha: "a",
      keywordIndexedSha: "a",
      keywordFailureSummary: null,
      generationStatus: "blocked_configuration",
      generationTargetSha: "a",
      generationFingerprint: "old",
      semanticIndexedSha: null,
      graphIndexedSha: null,
      generationFailureSummary: "AI configuration is unavailable",
    };
    expect(
      documentIndexLights(
        row,
        { configFingerprint: "old" },
        { coveredByBuild: true },
      ),
    ).toMatchObject({ semantic: "pending", graph: "pending", summary: null });
    expect(
      documentIndexLights(row, { configFingerprint: "old" }),
    ).toMatchObject({
      semantic: "failed",
      graph: "failed",
      summary: "AI configuration is unavailable",
    });
  });

  it("describes the lights for assistive technology", () => {
    expect(
      indexLightsDescription({
        keyword: "ready",
        semantic: "pending",
        graph: "unavailable",
        summary: null,
      }),
    ).toBe("Index: keyword ready, semantic pending, graph not configured");
  });
});

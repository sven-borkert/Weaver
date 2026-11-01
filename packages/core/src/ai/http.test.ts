import { describe, expect, it, vi } from "vitest";

import { extractionResponseSchema } from "@weaver/core/knowledge/extraction";

import {
  EXTRACTION_SYSTEM_MESSAGE,
  type ExtractionAttempt,
  extractWithCorrection,
  parseExtractionJson,
  validationError,
  withUsage,
} from "./http";
import {
  AiProviderError,
  type AiUsageSample,
  type ExtractionCorrection,
} from "./types";

describe("EXTRACTION_SYSTEM_MESSAGE", () => {
  it("names every field of the extraction schema so any provider can produce it", () => {
    const entityFields = Object.keys(
      extractionResponseSchema.shape.entities.element.shape,
    );
    const relationFields = Object.keys(
      extractionResponseSchema.shape.relations.element.shape,
    );
    expect(entityFields.length).toBeGreaterThan(0);
    expect(relationFields.length).toBeGreaterThan(0);
    for (const field of [
      "entities",
      "relations",
      ...entityFields,
      ...relationFields,
    ]) {
      expect(EXTRACTION_SYSTEM_MESSAGE).toContain(`"${field}"`);
    }
  });

  it("shows the empty result so a model with nothing to extract still satisfies the schema", () => {
    const empty = '{"entities":[],"relations":[]}';
    expect(EXTRACTION_SYSTEM_MESSAGE).toContain(empty);
    expect(parseExtractionJson(empty)).toEqual({ entities: [], relations: [] });
  });
});

describe("parseExtractionJson", () => {
  it("reports why non-JSON content was rejected without quoting it", () => {
    let caught: unknown;
    try {
      parseExtractionJson('Sure! Here is the extraction:\n{"entities":[]}');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AiProviderError);
    const error = caught as AiProviderError;
    expect(error.kind).toBe("validation");
    expect(error.message).toBe("AI provider returned invalid extraction");
    expect(error.details).toEqual({
      stage: "json",
      contentLength: 45,
      fenced: false,
      leadingCharacter: "S",
      trailingCharacter: "}",
    });
    expect(JSON.stringify(error.details)).not.toContain("Sure");
  });

  it("lists the schema issues by path so a failure can be diagnosed later", () => {
    const content = JSON.stringify({
      entities: [
        {
          key: "e1",
          name: "Weaver",
          type: "product",
          aliases: [],
          description: null,
          mentionText: "Weaver",
          confidence: "high",
          extra: true,
        },
      ],
      relations: [
        {
          sourceKey: "e1",
          targetKey: "e2",
          type: "uses",
          description: null,
          confidence: 0.5,
          validFrom: "2026-06-22",
          validTo: null,
        },
      ],
    });
    let caught: unknown;
    try {
      parseExtractionJson(content);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AiProviderError);
    const details = (caught as AiProviderError).details;
    expect(details).toMatchObject({
      stage: "schema",
      entityCount: 1,
      relationCount: 1,
      issueCount: 3,
    });
    expect(details?.issues).toEqual([
      expect.stringMatching(/^entities\.0\.confidence: invalid_type/),
      expect.stringMatching(/^entities\.0: unrecognized_keys/),
      expect.stringMatching(/^relations\.0\.validFrom: invalid_format/),
    ]);
  });

  it("caps the listed issues", () => {
    const entities = Array.from({ length: 30 }, (_, index) => ({
      key: `e${index}`,
      name: "",
      type: "concept",
      aliases: [],
      description: null,
      mentionText: "x",
      confidence: 1,
    }));
    let caught: unknown;
    try {
      parseExtractionJson(JSON.stringify({ entities, relations: [] }));
    } catch (error) {
      caught = error;
    }
    const details = (caught as AiProviderError).details;
    expect(details?.issueCount).toBe(30);
    expect(details?.issues).toHaveLength(20);
  });

  it("keeps details when usage is attached", () => {
    const error = validationError("bad", undefined, { stage: "json" });
    const wrapped = withUsage(error, {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
      totalTokens: 2,
      durationMs: 1,
    }) as AiProviderError;
    expect(wrapped.details).toEqual({ stage: "json" });
    expect(wrapped.usage?.totalTokens).toBe(2);
  });
});

describe("extractWithCorrection", () => {
  const valid = {
    entities: [
      {
        key: "e1",
        name: "Weaver",
        type: "product",
        aliases: [],
        description: null,
        mentionText: "Weaver",
        confidence: 0.9,
      },
    ],
    relations: [],
  };
  const misspelled = JSON.stringify({
    entities: [{ ...valid.entities[0], aliases: undefined, alaises: [] }],
    relations: [],
  });
  const attempts = () =>
    vi.fn<
      (correction: ExtractionCorrection | null) => Promise<ExtractionAttempt>
    >();
  const usage = (tokens: number, durationMs: number): AiUsageSample => ({
    inputTokens: tokens,
    outputTokens: tokens,
    cachedTokens: null,
    totalTokens: tokens * 2,
    durationMs,
  });

  it("returns a valid first response without a correction turn", async () => {
    const attempt = attempts().mockResolvedValue({
      content: JSON.stringify(valid),
      usage: usage(3, 5),
    });

    const result = await extractWithCorrection(attempt);

    expect(result).toEqual({ data: valid, usage: usage(3, 5) });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith(null);
  });

  it("shows the model its validation failure once and accepts the corrected response", async () => {
    const attempt = attempts()
      .mockResolvedValueOnce({ content: misspelled, usage: usage(3, 5) })
      .mockResolvedValueOnce({
        content: JSON.stringify(valid),
        usage: usage(4, 7),
      });

    const result = await extractWithCorrection(attempt);

    expect(result.data).toEqual(valid);
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 7,
      cachedTokens: null,
      totalTokens: 14,
      durationMs: 12,
    });
    expect(result.correction).toMatchObject({
      stage: "schema",
    });
    expect(result.correction?.issues.join("\n")).toContain("alaises");
    expect(attempt).toHaveBeenCalledTimes(2);
    const correction = attempt.mock.calls[1]?.[0];
    expect(correction?.previousContent).toBe(misspelled);
    expect(correction?.message).toContain("entities.0: unrecognized_keys");
    expect(correction?.message).toContain("alaises");
  });

  it("asks for valid JSON when the first response did not parse", async () => {
    const attempt = attempts()
      .mockResolvedValueOnce({ content: "Sure! {", usage: usage(1, 1) })
      .mockResolvedValueOnce({
        content: JSON.stringify(valid),
        usage: usage(1, 1),
      });

    const result = await extractWithCorrection(attempt);

    expect(result.data).toEqual(valid);
    expect(attempt.mock.calls[1]?.[0]?.message).toMatch(/not valid JSON/i);
  });

  it("corrects a relation whose validTo precedes validFrom", async () => {
    const entities = [valid.entities[0], { ...valid.entities[0], key: "e2" }];
    const relation = {
      sourceKey: "e1",
      targetKey: "e2",
      type: "uses",
      description: null,
      confidence: 0.5,
      validFrom: "2026-02-01T00:00:00Z",
      validTo: "2026-01-01T00:00:00Z",
    };
    const fixed = { entities, relations: [{ ...relation, validTo: null }] };
    const attempt = attempts()
      .mockResolvedValueOnce({
        content: JSON.stringify({ entities, relations: [relation] }),
        usage: usage(1, 1),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(fixed),
        usage: usage(1, 1),
      });

    const result = await extractWithCorrection(attempt);

    expect(result.data).toEqual(fixed);
    expect(attempt.mock.calls[1]?.[0]?.message).toContain(
      "relations.0.validTo",
    );
  });

  it("fails permanently with both calls' usage when the correction is rejected too", async () => {
    const attempt = attempts()
      .mockResolvedValueOnce({
        content: misspelled,
        usage: usage(3, 5),
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: "{}",
        usage: usage(4, 7),
        finishReason: "stop",
      });

    const error = (await extractWithCorrection(attempt).catch(
      (reason: unknown) => reason,
    )) as AiProviderError;

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ kind: "validation", retryable: false });
    expect(error.usage).toMatchObject({ totalTokens: 14, durationMs: 12 });
    expect(error.details).toMatchObject({
      stage: "schema",
      finishReason: "stop",
      correction: "rejected",
      initialStage: "schema",
    });
    expect(JSON.stringify(error.details?.initialIssues)).toContain("alaises");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("keeps the original failure and its usage when the correction call fails", async () => {
    const attempt = attempts()
      .mockResolvedValueOnce({ content: misspelled, usage: usage(3, 5) })
      .mockRejectedValueOnce(
        new AiProviderError("AI provider request timed out", {
          kind: "provider",
          retryable: true,
        }),
      );

    const error = (await extractWithCorrection(attempt).catch(
      (reason: unknown) => reason,
    )) as AiProviderError;

    expect(error).toMatchObject({ kind: "validation", retryable: false });
    expect(error.usage).toEqual(usage(3, 5));
    expect(error.details).toMatchObject({
      stage: "schema",
      correction: "failed",
    });
  });

  it("keeps the first call's usage when cancelled during the correction", async () => {
    const controller = new AbortController();
    const attempt = attempts()
      .mockResolvedValueOnce({ content: misspelled, usage: usage(3, 5) })
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      });

    const error = (await extractWithCorrection(
      attempt,
      controller.signal,
    ).catch((reason: unknown) => reason)) as AiProviderError;

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.usage).toEqual(usage(3, 5));
  });

  it("adds a completed but unparseable correction's usage when cancelled during it", async () => {
    const controller = new AbortController();
    const attempt = attempts()
      .mockResolvedValueOnce({ content: misspelled, usage: usage(3, 5) })
      .mockImplementationOnce(async () => {
        controller.abort();
        throw validationError(
          "AI provider returned invalid response",
          usage(2, 4),
          {
            stage: "envelope",
          },
        );
      });

    const error = (await extractWithCorrection(
      attempt,
      controller.signal,
    ).catch((reason: unknown) => reason)) as AiProviderError;

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.usage).toEqual(usage(5, 9));
    expect(error.details).toMatchObject({ stage: "schema" });
  });

  it("does not re-ask after a truncated response", async () => {
    const attempt = attempts().mockResolvedValue({
      content: '{"entities":[',
      usage: usage(3, 5),
      finishReason: "length",
    });

    const error = (await extractWithCorrection(attempt).catch(
      (reason: unknown) => reason,
    )) as AiProviderError;

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(error.details).toMatchObject({
      stage: "json",
      finishReason: "length",
    });
    expect(error.usage).toEqual(usage(3, 5));
  });
});

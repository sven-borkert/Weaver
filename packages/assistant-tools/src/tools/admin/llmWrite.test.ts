import { describe, expect, it } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS } from "../../contract";
import {
  boundedConnectionOutput,
  boundedConnectionTestOutput,
  boundedImportOutput,
} from "./llmWrite";

describe("LLM admin write output bounds", () => {
  it("trims nested model previews while preserving a successful connection result", () => {
    const connection = {
      id: "connection-id",
      name: "Large connection",
      models: Array.from({ length: 100 }, (_unused, index) => ({
        id: `model-${index}`,
        displayName: `Model ${index} ${"x".repeat(500)}`,
      })),
    };
    const output = boundedConnectionOutput(connection);

    expect(output.connection).toMatchObject({
      id: "connection-id",
      name: "Large connection",
      modelsTruncated: true,
    });
    expect(output.connection.models.length).toBeGreaterThan(0);
    expect(output.connection.models.length).toBeLessThan(
      connection.models.length,
    );
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CHARS,
    );
  });

  it("reports an intact model preview truthfully", () => {
    const output = boundedConnectionOutput({
      id: "connection-id",
      models: [{ id: "model-id" }],
    });

    expect(output.connection.models).toHaveLength(1);
    expect(output.connection.modelsTruncated).toBe(false);
  });

  it("budgets the complete connection-test envelope with escaped model ids", () => {
    const output = boundedConnectionTestOutput({
      outcome: "success",
      durationMs: 12,
      summary: "Listed 500 model(s)",
      models: Array.from({ length: 500 }, (_, index) => ({
        providerModelId: `${index}-${'\\"'.repeat(180)}`,
        displayName: `Model ${index}`,
        contextWindow: null,
        maxOutputTokens: null,
        embeddingDimensions: null,
        capabilities: ["chat" as const],
        source: "inferred" as const,
      })),
    });

    expect(output.outcome).toBe("success");
    expect(output.summary).toBe("Listed 500 model(s)");
    expect(output.models.length).toBeGreaterThan(0);
    expect(output.models.length).toBeLessThan(500);
    expect(output.truncated).toBe(true);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CHARS,
    );
  });

  it("preserves import counts while bounding skipped rows", () => {
    const output = boundedImportOutput({
      created: 317,
      updated: 41,
      skipped: Array.from({ length: 142 }, (_, index) => ({
        providerModelId: `${index}-${'\\"'.repeat(180)}`,
        reason: `Rejected ${'\\"'.repeat(180)}`,
      })),
    });

    expect(output).toMatchObject({
      created: 317,
      updated: 41,
      truncated: true,
    });
    expect(output.skipped.length).toBeGreaterThan(0);
    expect(output.skipped.length).toBeLessThan(142);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CHARS,
    );
  });
});

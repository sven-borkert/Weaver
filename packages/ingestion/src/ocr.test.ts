import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { LlmModelSnapshot } from "@weaver/core/services/llmRoutes";
import { createOcrClient, OCR_PROMPT } from "./ocr";
import { createNativeParser } from "./native";
import { pdfFixture } from "./fixtures";

const snapshot: LlmModelSnapshot = {
  connectionId: "c1",
  connectionName: "Provider",
  providerType: "openai_compatible",
  endpoint: "https://ai.test/v1",
  requestTimeoutMs: 1000,
  enabled: true,
  modelId: "m1",
  providerModelId: "vision-model",
  displayName: "Vision",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  embeddingDimensions: null,
  embeddingDimensionMode: "native",
  upstreamProvider: null,
  reasoningMode: "provider_default",
  capabilities: ["chat", "vision"],
  inputCostMicrosPerMillion: 100,
  outputCostMicrosPerMillion: 200,
  currency: "USD",
};

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textModel(
  text: string,
  calls: unknown[] = [],
  finishReason: "stop" | "length" = "stop",
) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: finishReason, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

const input = {
  png: new Uint8Array([1, 2, 3]),
  projectId: "p1",
  fileId: "f1",
  jobId: "j1",
  page: 2,
};

describe("createOcrClient", () => {
  it("accepts a completed blank page so a mixed PDF can retain its other pages", async () => {
    const client = createOcrClient({
      db: {} as never,
      ring: null,
      recordUsage: vi.fn(async () => undefined),
    });
    await expect(
      client.transcribe(
        { snapshot, model: textModel("") },
        input,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ markdown: "" });
  });

  it("keeps readable PDF content when another page completes OCR with no text", async () => {
    const ocr = createOcrClient({
      db: {} as never,
      ring: null,
      resolveRoute: async () => snapshot,
      modelFactory: () => textModel(""),
      recordUsage: vi.fn(async () => undefined),
    });
    const parser = createNativeParser({ ocr, maxOcrPages: 2 });
    await expect(
      parser.parse(
        {
          fileId: "f1",
          projectId: "p1",
          jobId: "j1",
          fileName: "mixed.pdf",
          mimeType: "application/pdf",
          bytes: pdfFixture(["Readable content", null]),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      markdown: "Readable content",
      pageCount: 2,
      ocrPages: 1,
    });
  });

  it("rejects truncated transcription and retains actual usage", async () => {
    const recordUsage = vi.fn(async () => undefined);
    const client = createOcrClient({
      db: {} as never,
      ring: null,
      recordUsage,
    });
    expect(
      await client.transcribe(
        { snapshot, model: textModel("Partial sentence", [], "length") },
        input,
        new AbortController().signal,
      ),
    ).toMatchObject({
      failureKind: "provider",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest matchers return any.
      message: expect.stringContaining("incomplete"),
    });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: "validation_failure",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest matchers return any.
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
      }),
    );
  });

  it("preserves successful transcription when accounting fails", async () => {
    const recordUsage = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const client = createOcrClient({
      db: {} as never,
      ring: null,
      recordUsage,
    });
    await expect(
      client.transcribe(
        { snapshot, model: textModel("Complete transcription") },
        input,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ markdown: "Complete transcription" });
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, 8192],
    [4096, 4096],
    [100_000, 8192],
  ])(
    "caps output tokens when the model limit is %s",
    async (limit, expected) => {
      const seen: unknown[] = [];
      const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
          seen.push(options.maxOutputTokens);
          return {
            content: [{ type: "text", text: "page" }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          };
        },
      });
      const client = createOcrClient({
        db: {} as never,
        ring: null,
        recordUsage: vi.fn(async () => undefined),
      });
      await client.transcribe(
        { snapshot: { ...snapshot, maxOutputTokens: limit }, model },
        input,
        new AbortController().signal,
      );
      expect(seen).toEqual([expected]);
    },
  );

  it("blocks when no route or a non-vision model is routed", async () => {
    const missing = createOcrClient({
      db: {} as never,
      ring: null,
      resolveRoute: async () => null,
    });
    expect(await missing.resolve()).toMatchObject({
      failureKind: "configuration",
      message: /Import parsing route/,
    });
    const textOnly = createOcrClient({
      db: {} as never,
      ring: null,
      resolveRoute: async () => ({ ...snapshot, capabilities: ["chat"] }),
    });
    expect(await textOnly.resolve()).toMatchObject({
      failureKind: "configuration",
      message: /Vision capability/,
    });
  });

  it("sends the image as a file part, trims fences, and records usage", async () => {
    const calls: unknown[] = [];
    const recordUsage = vi.fn(async () => undefined);
    const client = createOcrClient({
      db: {} as never,
      ring: null,
      resolveRoute: async () => snapshot,
      modelFactory: () => textModel("```markdown\n# Scan\n\nBody\n```", calls),
      recordUsage,
    });
    const route = await client.resolve();
    if ("failureKind" in route) throw new Error(route.message);
    expect(
      await client.transcribe(route, input, new AbortController().signal),
    ).toEqual({ markdown: "# Scan\n\nBody" });
    expect(JSON.stringify(calls[0])).toContain(OCR_PROMPT.slice(0, 20));
    expect(JSON.stringify(calls[0])).toContain('"mediaType":"image/png"');
    expect(recordUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: "p1",
        operation: "ingestion.ocr",
        jobId: "j1",
        connectionId: "c1",
        provider: "openai_compatible",
        model: "vision-model",
        outcome: "success",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest types objectContaining as `=> any`
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
        pricing: {
          inputCostMicrosPerMillion: 100,
          outputCostMicrosPerMillion: 200,
        },
        currency: "USD",
      }),
    );
  });

  it("turns provider errors into a provider failure with a usage row", async () => {
    const recordUsage = vi.fn(async () => undefined);
    const client = createOcrClient({
      db: {} as never,
      ring: null,
      resolveRoute: async () => snapshot,
      modelFactory: () =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw new APICallError({
              message: "HTTP 400",
              url: "https://ai.test",
              requestBodyValues: {},
              statusCode: 400,
              isRetryable: false,
            });
          },
        }),
      recordUsage,
    });
    const route = await client.resolve();
    if ("failureKind" in route) throw new Error(route.message);
    expect(
      await client.transcribe(route, input, new AbortController().signal),
    ).toEqual({
      failureKind: "provider",
      message: "provider request failed",
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "provider_failure" }),
    );
  });

  it("rethrows cancellation", async () => {
    const controller = new AbortController();
    const client = createOcrClient({
      db: {} as never,
      ring: null,
      resolveRoute: async () => snapshot,
      modelFactory: () =>
        new MockLanguageModelV4({
          doGenerate: async ({ abortSignal }) => {
            controller.abort();
            throw abortSignal?.reason ?? new Error("aborted");
          },
        }),
      recordUsage: vi.fn(async () => undefined),
    });
    const route = await client.resolve();
    if ("failureKind" in route) throw new Error(route.message);
    await expect(
      client.transcribe(route, input, controller.signal),
    ).rejects.toBeDefined();
  });
});

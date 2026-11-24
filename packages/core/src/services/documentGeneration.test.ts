import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { createProviderAdapter } from "../ai/adapters";
import { MAX_AI_PROVIDER_REQUEST_BYTES } from "../ai/http";
import { createAdapterForSnapshot } from "../ai/registry";
import {
  formatDocumentAssistantReply,
  type DocumentAssistantContext,
  type DocumentAssistantTurn,
} from "../documents/assistantReply";
import { generateDocumentContent } from "./documentGeneration";
import { resolveLlmRoute, type LlmModelSnapshot } from "./llmRoutes";
import type { ProjectActor } from "./projectAccess";

vi.mock("./documents", () => ({ assertEditableMarkdownDocument: vi.fn() }));
vi.mock("./assistantConversations", () => ({ assertAssistantUse: vi.fn() }));
vi.mock("./aiUsageBestEffort", () => ({ recordAiUsageSafely: vi.fn() }));
vi.mock("./llmRoutes", () => ({ resolveLlmRoute: vi.fn() }));
vi.mock("../ai/registry", () => ({
  createAdapterForSnapshot: vi.fn(),
  createDbCredentialSource: vi.fn(),
}));

const route = {
  connectionId: "connection",
  providerType: "openrouter",
  endpoint: "https://openrouter.example/api/v1",
  requestTimeoutMs: 30_000,
  providerModelId: "vendor/assistant-model",
  upstreamProvider: "vendor",
  contextWindow: null,
  maxOutputTokens: null,
  reasoningMode: "provider_default",
} as unknown as LlmModelSnapshot;

/** Request bodies as the provider receives them, after the adapter's own size check. */
const bodies: string[] = [];

const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
  bodies.push(init?.body as string);
  return Response.json({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Done." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
});

function generate(
  context: DocumentAssistantContext,
  instruction: string,
  history: DocumentAssistantTurn[] = [],
) {
  return generateDocumentContent(
    {} as PrismaClient,
    {
      projectId: "project",
      documentId: "document",
      instruction,
      context,
      history,
    },
    {} as ProjectActor,
    { ring: null, fetchImpl },
  );
}

function sentPrompt(): string {
  const body = JSON.parse(bodies.at(-1)!) as {
    messages: Array<{ role: string; content: string }>;
  };
  return body.messages.find((message) => message.role === "user")!.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  bodies.length = 0;
  vi.mocked(resolveLlmRoute).mockResolvedValue(route);
  vi.mocked(createAdapterForSnapshot).mockImplementation(
    (snapshot, _credentials, fetcher) =>
      createProviderAdapter(
        snapshot.providerType,
        {
          baseUrl: snapshot.endpoint,
          requestTimeoutMs: snapshot.requestTimeoutMs,
          upstreamProvider: snapshot.upstreamProvider,
          resolveCredential: async () => "test-key",
        },
        fetcher,
      ),
  );
});

describe("generateDocumentContent request size", () => {
  it("trims the page around a Japanese selection so the first ask fits the provider cap", async () => {
    // 44,000 characters of Japanese page text with 5,000 selected: 133,649
    // request bytes before the page was fitted to the cap.
    const page = "日本語の文書です。".repeat(5_000).slice(0, 44_000);
    const context = {
      before: page.slice(0, 19_500),
      selection: page.slice(19_500, 24_500),
      after: page.slice(24_500),
    };
    await expect(
      generate(context, "この部分を要約してください。"),
    ).resolves.toEqual({ reply: "Done.", markdown: null, action: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(bodies[0]!)).toBeLessThanOrEqual(
      MAX_AI_PROVIDER_REQUEST_BYTES,
    );
    const prompt = sentPrompt();
    expect(prompt).toContain(`<selection>\n${context.selection}\n</selection>`);
    expect(prompt).toContain(
      "<request>\nこの部分を要約してください。\n</request>",
    );
    expect(prompt).not.toContain(context.before);
    // The text closest to the selection stays.
    expect(prompt).toContain(
      `${context.before.slice(-1_000)}\n</document_before>`,
    );
    expect(prompt).toContain(
      `<document_after>\n${context.after.slice(0, 1_000)}`,
    );
  });

  it("drops the oldest turns while a long English selection is rewritten again and again", async () => {
    const sentence = "The committee reviewed the proposal in detail. ";
    const selection = sentence.repeat(300).slice(0, 14_000);
    const context = {
      before: "Introduction. ".repeat(1_000).slice(0, 15_000),
      selection,
      after: "Conclusion. ".repeat(1_250),
    };
    const history: DocumentAssistantTurn[] = [];
    for (let request = 1; request <= 7; request += 1) {
      const instruction = `Rewrite the selection more formally, version ${request}.`;
      await generate(context, instruction, [...history]);
      expect(Buffer.byteLength(bodies.at(-1)!)).toBeLessThanOrEqual(
        MAX_AI_PROVIDER_REQUEST_BYTES,
      );
      history.push(
        { role: "user", text: instruction },
        {
          role: "assistant",
          text: formatDocumentAssistantReply({
            reply: `Version ${request}.`,
            markdown: selection.replaceAll("reviewed", `examined (${request})`),
            action: "replace",
          }),
        },
      );
    }
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    const prompt = sentPrompt();
    // The selection, the page around it and the newest turn survive; the oldest turn goes first.
    expect(prompt).toContain(`<selection>\n${selection}\n</selection>`);
    expect(prompt).toContain(context.before);
    expect(prompt).toContain(context.after);
    expect(prompt).toContain("version 6.");
    expect(prompt).not.toContain("version 1.");
  });

  it("never cuts the page text inside a surrogate pair", async () => {
    // Shifting the emoji by one unit at a time puts one variant's cut inside a pair.
    for (let shift = 0; shift < 4; shift += 1) {
      const text = `${"x".repeat(shift)}${"😀".repeat(9_990)}`;
      bodies.length = 0;
      await generate(
        { before: text, selection: "語".repeat(20_000), after: text },
        "Summarize.",
      );
      expect(Buffer.byteLength(bodies[0]!)).toBeLessThanOrEqual(
        MAX_AI_PROVIDER_REQUEST_BYTES,
      );
      // JSON.stringify escapes only an unpaired surrogate.
      expect(bodies[0]).not.toMatch(/\\ud[89a-f]/);
    }
  });

  it("refuses a selection that cannot fit with an error the dialog can name", async () => {
    // A control character is JSON-encoded as six bytes, so these outgrow the
    // cap even once the page text and the history are gone.
    await expect(
      generate(
        { before: "Page", selection: "\u0001".repeat(20_000), after: "" },
        "\u0002".repeat(4_000),
        [{ role: "user", text: "Earlier question" }],
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "selection" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

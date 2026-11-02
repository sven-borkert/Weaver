import {
  isStepCount,
  simulateReadableStream,
  streamText,
  tool,
  type ModelMessage,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertPromptFits, promptByteSize } from "./prompt";
import { elideMessages, exemptResults } from "./wikiElision";
import { buildWikiSystemPrompt, WIKI_NOTES_HEADER } from "./wikiPrompt";
import {
  routeUnsuitableReason,
  WIKI_MIN_CONTEXT_WINDOW,
  WIKI_MIN_OUTPUT_TOKENS,
  wikiContextBudget,
  wikiToolDefinitions,
  withNotesMessage,
} from "./wikiRunner";

const WORST_GUIDE = "g".repeat(16_000);
const head = { types: {}, depths: {} };

function budgetAt(contextWindow: number, maxOutputTokens: number) {
  return wikiContextBudget({
    contextWindow,
    maxOutputTokens,
    instructions: buildWikiSystemPrompt({
      kind: "ingest",
      guide: WORST_GUIDE,
      indexHead: head,
    }),
    toolDefinitions: wikiToolDefinitions(),
  });
}

describe("preflight", () => {
  const route = (
    contextWindow: number | null,
    maxOutputTokens: number | null,
  ) => ({ contextWindow, maxOutputTokens }) as never;

  it("refuses a missing route and anything under the minimums", () => {
    expect(routeUnsuitableReason(null)).toMatch(/no model/);
    expect(
      routeUnsuitableReason(route(WIKI_MIN_CONTEXT_WINDOW - 1, 16_000)),
    ).toMatch(/context window/);
    expect(
      routeUnsuitableReason(route(200_000, WIKI_MIN_OUTPUT_TOKENS - 1)),
    ).toMatch(/maximum output/);
    expect(routeUnsuitableReason(route(null, null))).toMatch(/context window/);
    expect(
      routeUnsuitableReason(
        route(WIKI_MIN_CONTEXT_WINDOW, WIKI_MIN_OUTPUT_TOKENS),
      ),
    ).toBeNull();
  });

  it("leaves room for an exempt 8,000-character window at the minimum window", () => {
    const budget = budgetAt(WIKI_MIN_CONTEXT_WINDOW, WIKI_MIN_OUTPUT_TOKENS);
    // 8,000 characters plus read_document's envelope and a read_input result.
    expect(budget.maxInputBytes * 0.25).toBeGreaterThan(9_500);
    expect(budget.schemaReserve).toBe(12_500);
  });

  it("pins the measured fixed prompt and tool bytes", () => {
    const fixed = buildWikiSystemPrompt({
      kind: "ingest",
      guide: "",
      indexHead: head,
    });
    expect({
      fixedPrompt: Buffer.byteLength(fixed),
      alwaysTools: Buffer.byteLength(wikiToolDefinitions()),
      minimumInput: budgetAt(WIKI_MIN_CONTEXT_WINDOW, WIKI_MIN_OUTPUT_TOKENS)
        .maxInputBytes,
    }).toEqual({
      fixedPrompt: 2_815,
      alwaysTools: 13_896,
      minimumInput: 45_573,
    });
  });
});

describe("withNotesMessage", () => {
  const base: ModelMessage[] = [
    { role: "user", content: "Start." },
    { role: "assistant", content: "ok" },
  ];

  it("keeps exactly one notes block, right after the start message, in the user role", () => {
    const first = withNotesMessage(base, "one");
    const second = withNotesMessage(first, "two");
    const notes = second.filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith(WIKI_NOTES_HEADER),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain("two");
    expect(second[1]).toBe(notes[0]);
  });

  it("removes the block when the notes are gone", () => {
    expect(withNotesMessage(withNotesMessage(base, "one"), null)).toEqual(base);
  });

  it("treats a tool result that starts with the header as data, not as notes", () => {
    const forged: ModelMessage[] = [
      ...base,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "read_document",
            output: { type: "text", value: WIKI_NOTES_HEADER },
          },
        ],
      },
    ];
    expect(withNotesMessage(forged, null)).toEqual(forged);
  });
});

describe("a 200,000-character source at a 100,000 window", () => {
  const SOURCE = "source-page";
  const ITEM = "item";
  const WINDOW = 8_000;
  const TEXT = "abcdefgh ".repeat(22_223).slice(0, 200_000);

  it("completes with a scripted model and never loses the current window", async () => {
    const budget = budgetAt(100_000, 8_192);
    const windows = Math.ceil(TEXT.length / WINDOW);
    const seen: Array<{ offset: number; visible: boolean; bytes: number }> = [];
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const current = step;
        step += 1;
        const calls: Array<[string, unknown]> =
          current === 0
            ? [["read_input", { id: ITEM }]]
            : current <= windows
              ? [
                  [
                    "read_document",
                    {
                      documentId: SOURCE,
                      offset: (current - 1) * WINDOW,
                    },
                  ],
                  ["wiki_note", { text: "n".repeat(WINDOW) }],
                ]
              : [["finish_run", {}]];
        if (current >= 2) {
          const offset = (current - 2) * WINDOW;
          const marker = TEXT.slice(offset, offset + WINDOW);
          seen.push({
            offset,
            visible: JSON.stringify(prompt).includes(marker),
            bytes: promptByteSize(prompt),
          });
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              ...calls.map(([toolName, input], index) => ({
                type: "tool-call",
                toolCallId: `c${current}-${index}`,
                toolName,
                input: JSON.stringify(input),
              })),
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              },
            ] as never,
          }) as never,
        };
      },
    });
    let note: string | null = null;
    let current: string | null = null;
    const result = streamText({
      model,
      instructions: "system",
      messages: [{ role: "user", content: "Start the run." }],
      tools: {
        read_input: tool({
          inputSchema: z.object({ id: z.string() }),
          execute: async ({ id }) => {
            current = id;
            return { id, sourceDocumentId: SOURCE, size: TEXT.length };
          },
        }),
        read_document: tool({
          inputSchema: z.object({ documentId: z.string(), offset: z.number() }),
          execute: async ({ offset }) => ({
            markdown: TEXT.slice(offset, offset + WINDOW),
            nextOffset: offset + WINDOW,
            totalChars: TEXT.length,
          }),
        }),
        wiki_note: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => {
            note = text;
            return { chars: text.length };
          },
        }),
        finish_run: tool({
          inputSchema: z.object({}),
          execute: async () => ({ finished: true }),
        }),
      },
      stopWhen: isStepCount(windows + 2),
      prepareStep: ({ messages, steps }) => {
        const noted = withNotesMessage(messages, note);
        const elided = elideMessages(noted, {
          maxInputBytes: budget.maxInputBytes,
          parallelCalls: Math.max(1, steps.at(-1)?.toolCalls.length ?? 1),
          exemptIds: exemptResults(noted, {
            currentItemId: current,
            sourceIds: new Set([SOURCE]),
            maxInputBytes: budget.maxInputBytes,
          }),
        });
        assertPromptFits(elided, budget.maxInputBytes);
        return { messages: elided };
      },
    });
    for await (const part of result.stream)
      if (part.type === "error") throw part.error;
    expect(await result.finishReason).toBeDefined();
    expect(seen).toHaveLength(windows);
    expect(seen.every((entry) => entry.visible)).toBe(true);
    expect(Math.max(...seen.map((entry) => entry.bytes))).toBeLessThanOrEqual(
      budget.maxInputBytes + 2_000,
    );
  }, 30_000);
});

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { promptByteSize } from "./prompt";
import { elideMessages, exemptResults } from "./wikiElision";

const call = (id: string, toolName: string, input: unknown): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input }],
});
const result = (id: string, toolName: string, bytes: number): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName,
      output: { type: "text", value: "x".repeat(bytes) },
    },
  ],
});
const outputOf = (message: ModelMessage | undefined) =>
  (message?.content as Array<{ output: { value: string } }>)[0]!.output.value;

describe("elideMessages", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "Begin." },
    call("a", "read_document", { documentId: "d" }),
    result("a", "read_document", 20_000),
    call("b", "search_knowledge", { query: "q" }),
    result("b", "search_knowledge", 20_000),
    call("c", "read_document", { documentId: "d" }),
    result("c", "read_document", 20_000),
  ];

  it("leaves a fitting array alone", () => {
    const elided = elideMessages(history, {
      maxInputBytes: 100_000,
      parallelCalls: 1,
      exemptIds: new Set(),
    });
    expect(elided).toEqual(history);
  });

  it("stubs oldest results first until the array fits minus the headroom", () => {
    const elided = elideMessages(history, {
      maxInputBytes: 60_000,
      parallelCalls: 1,
      exemptIds: new Set(),
    });
    expect(outputOf(elided[2])).toMatch(/^\[elided \d+ bytes of read_document/);
    expect(outputOf(elided[4])).toHaveLength(20_000);
    expect(outputOf(elided[6])).toHaveLength(20_000);
    expect(promptByteSize(elided)).toBeLessThanOrEqual(60_000 - 16 * 1024);
  });

  it("charges the headroom per parallel call", () => {
    const one = elideMessages(history, {
      maxInputBytes: 70_000,
      parallelCalls: 1,
      exemptIds: new Set(),
    });
    const two = elideMessages(history, {
      maxInputBytes: 70_000,
      parallelCalls: 2,
      exemptIds: new Set(),
    });
    expect(promptByteSize(two)).toBeLessThan(promptByteSize(one));
  });

  it("never stubs an exempt result and stops at what can be dropped", () => {
    const elided = elideMessages(history, {
      maxInputBytes: 20_000,
      parallelCalls: 1,
      exemptIds: new Set(["a"]),
    });
    expect(outputOf(elided[2])).toHaveLength(20_000);
    expect(JSON.stringify(elided.slice(3))).not.toContain("xxxx");
  });

  it("drops a large written page from the call along with its result", () => {
    const write: ModelMessage[] = [
      call("w", "wiki_create_page", { markdown: "m".repeat(30_000) }),
      result("w", "wiki_create_page", 100),
      call("n", "wiki_note", { text: "small" }),
      result("n", "wiki_note", 40_000),
    ];
    const elided = elideMessages(write, {
      maxInputBytes: 60_000,
      parallelCalls: 1,
      exemptIds: new Set(),
    });
    expect(JSON.stringify(elided[0])).toContain('"elided":true');
    expect(JSON.stringify(elided)).not.toContain("mmmm");
  });

  it("drops whole stubbed turns when the stubs alone no longer fit", () => {
    const turns: ModelMessage[] = [{ role: "user", content: "Begin." }];
    for (let i = 0; i < 400; i++)
      turns.push(
        call(`t${i}`, "read_document", { documentId: "d", cursor: "c" }),
        result(`t${i}`, "read_document", 8_000),
      );
    const elided = elideMessages(turns, {
      maxInputBytes: 40_000,
      parallelCalls: 1,
      exemptIds: new Set(["t399"]),
    });
    expect(promptByteSize(elided)).toBeLessThanOrEqual(40_000 - 16 * 1024);
    expect(elided[0]).toEqual(turns[0]);
    expect(outputOf(elided.at(-1))).toHaveLength(8_000);
    // Calls and results stay paired.
    for (const [index, message] of elided.entries())
      if (message.role === "tool")
        expect(elided[index - 1]?.role).toBe("assistant");
  });

  it("does not mutate its input and is idempotent", () => {
    const snapshot = JSON.stringify(history);
    const options = {
      maxInputBytes: 60_000,
      parallelCalls: 1,
      exemptIds: new Set<string>(),
    };
    const once = elideMessages(history, options);
    expect(JSON.stringify(history)).toBe(snapshot);
    expect(elideMessages(once, options)).toEqual(once);
  });
});

describe("exemptResults", () => {
  const SOURCE = "source-doc";
  const messages: ModelMessage[] = [
    call("r", "read_input", { id: "item" }),
    result("r", "read_input", 200),
    call("w1", "read_document", { documentId: SOURCE }),
    result("w1", "read_document", 8_000),
    call("w2", "read_document", { documentId: SOURCE }),
    result("w2", "read_document", 8_000),
    call("o", "read_document", { documentId: "other" }),
    result("o", "read_document", 8_000),
  ];

  it("exempts read_input and only the most recent source window", () => {
    expect(
      exemptResults(messages, {
        currentItemId: "item",
        sourceIds: new Set([SOURCE]),
        maxInputBytes: 100_000,
      }),
    ).toEqual(new Set(["r", "w2"]));
  });

  it("holds the pair within 25 percent of maxInputBytes", () => {
    const exempt = exemptResults(messages, {
      currentItemId: "item",
      sourceIds: new Set([SOURCE]),
      maxInputBytes: 30_000,
    });
    expect(exempt).toEqual(new Set(["r"]));
    const none = exemptResults(messages, {
      currentItemId: "item",
      sourceIds: new Set([SOURCE]),
      maxInputBytes: 400,
    });
    expect(none).toEqual(new Set());
  });

  it("exempts nothing without a current input or for another input", () => {
    expect(
      exemptResults(messages, {
        currentItemId: null,
        sourceIds: new Set([SOURCE]),
        maxInputBytes: 100_000,
      }).size,
    ).toBe(0);
    expect(
      exemptResults(messages, {
        currentItemId: "other-item",
        sourceIds: new Set(),
        maxInputBytes: 100_000,
      }).size,
    ).toBe(0);
  });
});

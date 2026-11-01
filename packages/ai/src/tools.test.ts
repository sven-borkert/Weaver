import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type ToolContext } from "@weaver/assistant-tools/contract";
import type { AssistantEvent } from "@weaver/core/assistant/events";
import type { SourceLocator } from "@weaver/core/assistant/citations";
import { CoreError } from "@weaver/core/errors";
import { toAiToolSet, type ToolCollector } from "./tools";

const ctx = {} as ToolContext;

const locator: SourceLocator = {
  kind: "document",
  projectId: "p",
  documentId: "d",
  commitSha: "abcdef1",
  headingPath: [],
  excerpt: null,
};

const echo = defineTool({
  name: "echo",
  kind: "read",
  capability: "content:read",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  async execute(input) {
    return { output: { text: input.text }, citations: [locator] };
  },
});

const dated = defineTool({
  name: "dated",
  kind: "read",
  capability: "content:read",
  description: "returns a Date the way Prisma rows do",
  inputSchema: z.object({}),
  async execute() {
    return {
      output: {
        documents: [
          { id: "d", lastEditedAt: new Date("2026-09-01T17:17:29.000Z") },
        ],
      },
    };
  },
});

const boom = defineTool({
  name: "boom",
  kind: "read",
  capability: "content:read",
  description: "boom",
  inputSchema: z.object({}),
  async execute() {
    throw new CoreError("FORBIDDEN", "SCOPE_VIOLATION", {
      reason: "SCOPE_VIOLATION",
    });
  },
});

const boomWithReason = defineTool({
  name: "boom_with_reason",
  kind: "read",
  capability: "content:read",
  description: "boom with an allowlisted reason",
  inputSchema: z.object({}),
  async execute() {
    throw new CoreError("BAD_REQUEST", "bad cursor", {
      reason: "INVALID_CURSOR",
    });
  },
});

const boomWithoutReason = defineTool({
  name: "boom_without_reason",
  kind: "read",
  capability: "content:read",
  description: "boom with a non-allowlisted reason",
  inputSchema: z.object({}),
  async execute() {
    throw new CoreError("BAD_REQUEST", "x", { reason: "SOMETHING_ELSE" });
  },
});

const propose = defineTool({
  name: "propose_x",
  kind: "propose",
  capability: "content:propose",
  description: "p",
  inputSchema: z.object({}),
  async execute() {
    return {
      output: {
        proposalId: "pr1",
        kind: "document.edit",
        status: "pending",
        summary: "s",
        expiresAt: "x",
      },
    };
  },
});

const huge = defineTool({
  name: "huge",
  kind: "read",
  capability: "content:read",
  description: "huge",
  inputSchema: z.object({}),
  async execute() {
    return { output: { blob: "x".repeat(20_000) } };
  },
});

const hugeQuotes = defineTool({
  name: "huge_quotes",
  kind: "read",
  capability: "content:read",
  description: "huge_quotes",
  inputSchema: z.object({}),
  async execute() {
    return { output: { blob: '"\\\n'.repeat(6_000) } };
  },
});

const hugeCjk = defineTool({
  name: "huge_cjk",
  kind: "read",
  capability: "content:read",
  description: "huge_cjk",
  inputSchema: z.object({}),
  async execute() {
    // 16,000 characters but 48,000 UTF-8 bytes: within the old character cap.
    return { output: { blob: "漢".repeat(15_900) } };
  },
});

const busy = defineTool({
  name: "busy",
  kind: "read",
  capability: "content:read",
  description: "busy",
  inputSchema: z.object({}),
  async execute() {
    throw new CoreError("TOO_MANY_REQUESTS", "reader queue full");
  },
});

const seenSignals: (AbortSignal | undefined)[] = [];
let executedProposals = 0;

const spy = defineTool({
  name: "spy",
  kind: "read",
  capability: "content:read",
  description: "spy",
  inputSchema: z.object({}),
  async execute(_input, context) {
    seenSignals.push(context.signal);
    return { output: { ok: true } };
  },
});

/** Aborts mid-flight, then fails: the abort must win over the model-facing error. */
const abortsThenThrows = defineTool({
  name: "aborts",
  kind: "read",
  capability: "content:read",
  description: "aborts",
  inputSchema: z.object({}),
  async execute(_input, context) {
    (context as { controller?: AbortController }).controller?.abort();
    throw new CoreError("FORBIDDEN", "SCOPE_VIOLATION", {
      reason: "SCOPE_VIOLATION",
    });
  },
});

const countedPropose = defineTool({
  name: "propose_counted",
  kind: "propose",
  capability: "content:propose",
  description: "p",
  inputSchema: z.object({}),
  async execute() {
    executedProposals += 1;
    return {
      output: {
        proposalId: "pr2",
        kind: "document.edit",
        status: "pending",
        summary: "s",
        expiresAt: "x",
      },
    };
  },
});

function harness(contracts = [echo, boom, propose, huge, spy]) {
  const events: AssistantEvent[] = [];
  const collector: ToolCollector = { citations: [], proposals: [] };
  const tools = toAiToolSet(contracts, {
    context: async () => ctx,
    onEvent: async (event) => {
      events.push(event);
    },
    collector,
  });
  return { events, collector, tools };
}

const options = { toolCallId: "t1", messages: [], context: {} };

describe("toAiToolSet", () => {
  it("exposes every contract by name with its description", () => {
    const { tools } = harness();
    expect(Object.keys(tools)).toEqual([
      "echo",
      "boom",
      "propose_x",
      "huge",
      "spy",
    ]);
    expect(tools.echo!.description).toBe("echo");
  });

  it("emits call/result events, returns the output, and collects citations", async () => {
    const { events, collector, tools } = harness();
    const result: unknown = await tools.echo!.execute!({ text: "hi" }, options);
    expect(result).toEqual({ text: "hi" });
    expect(events.map((e) => e.type)).toEqual(["tool.call", "tool.result"]);
    expect(events[0]).toMatchObject({
      type: "tool.call",
      toolName: "echo",
      input: { text: "hi" },
    });
    expect(collector.citations).toEqual([locator]);
  });

  it("returns model-facing errors instead of throwing", async () => {
    const { events, tools } = harness();
    const result: unknown = await tools.boom!.execute!({}, options);
    expect(result).toEqual({
      error: {
        code: "SCOPE_VIOLATION",
        message: "resource is outside the conversation scope",
      },
    });
    expect(events[1]).toMatchObject({ type: "tool.result", ok: false });
  });

  it("forwards an allowlisted structured reason to the model (spec §9)", async () => {
    const { tools } = harness([boomWithReason]);
    const result: unknown = await tools.boom_with_reason!.execute!({}, options);
    expect(result).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "bad cursor",
        reason: "INVALID_CURSOR",
      },
    });
  });

  it("omits reason for an error whose reason is not allowlisted", async () => {
    const { tools } = harness([boomWithoutReason]);
    const result: unknown = await tools.boom_without_reason!.execute!(
      {},
      options,
    );
    expect(result).toEqual({ error: { code: "BAD_REQUEST", message: "x" } });
  });

  it("records proposals and emits proposal.created", async () => {
    const { events, collector, tools } = harness();
    await tools.propose_x!.execute!({}, options);
    expect(collector.proposals).toEqual([
      { proposalId: "pr1", kind: "document.edit", summary: "s" },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "tool.call",
      "proposal.created",
      "tool.result",
    ]);
  });

  it("clamps oversized tool output before it reaches the model", async () => {
    const { events, tools } = harness();
    const result = (await tools.huge!.execute!({}, options)) as {
      truncated: boolean;
      partialJson: string;
    };
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(16_000);
    expect(result.partialJson.length).toBeGreaterThan(15_000);
    const summary = events.find((e) => e.type === "tool.result");
    expect(summary && "summary" in summary && summary.summary.length).toBe(200);
  });

  it("clamps by UTF-8 bytes, so a CJK page the model would be charged 48 KB for is cut", async () => {
    const { tools } = harness([hugeCjk]);
    const result = (await tools.huge_cjk!.execute!({}, options)) as {
      truncated: boolean;
      partialJson: string;
    };
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      16_000,
    );
  });

  it("forwards a busy reader as TOO_MANY_REQUESTS so the model can retry", async () => {
    const { tools } = harness([busy]);
    expect(await tools.busy!.execute!({}, options)).toEqual({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "too many file reads are in progress; try again shortly",
      },
    });
  });

  it("bounds the fallback's own serialization when the payload is escape-dense", async () => {
    const { tools } = harness([hugeQuotes]);
    const result = (await tools.huge_quotes!.execute!({}, options)) as {
      truncated: boolean;
      partialJson: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.partialJson.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(16_000);
  });

  it("bounds the persisted tool.call input payload", async () => {
    const { events, tools } = harness([echo]);
    await tools.echo!.execute!({ text: "y".repeat(5_000) }, options);
    const call = events[0]!;
    expect(
      JSON.stringify("input" in call ? call.input : null).length,
    ).toBeLessThanOrEqual(2_000);
  });

  it("forwards the abort signal to the contract and rethrows aborts", async () => {
    seenSignals.length = 0;
    const controller = new AbortController();
    const { tools } = harness();
    await tools.spy!.execute!(
      {},
      { ...options, abortSignal: controller.signal },
    );
    expect(seenSignals[0]).toBe(controller.signal);

    const aborting = new AbortController();
    const failing = toAiToolSet([abortsThenThrows], {
      context: async () => ({ ...ctx, controller: aborting }) as ToolContext,
      onEvent: async () => undefined,
      collector: { citations: [], proposals: [] },
    });
    await expect(
      failing.aborts!.execute!(
        {},
        { ...options, abortSignal: aborting.signal },
      ),
    ).rejects.toBeInstanceOf(CoreError);
  });

  it("never runs a propose contract once the tool.call emit loses the run", async () => {
    executedProposals = 0;
    const events: AssistantEvent[] = [];
    const controller = new AbortController();
    const collector: ToolCollector = { citations: [], proposals: [] };
    const tools = toAiToolSet([countedPropose], {
      context: async () => ctx,
      // What runner.emit does when the run turned `cancelling` or the attempt
      // lost its lease: it aborts the controller and returns.
      onEvent: async (event) => {
        events.push(event);
        controller.abort(new Error("run cancelled"));
      },
      collector,
    });

    await expect(
      tools.propose_counted!.execute!(
        {},
        { ...options, abortSignal: controller.signal },
      ),
    ).rejects.toThrow("run cancelled");
    expect(executedProposals).toBe(0);
    expect(collector.proposals).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["tool.call"]);
  });

  it("never runs a read contract once the tool.call emit loses the run", async () => {
    seenSignals.length = 0;
    const controller = new AbortController();
    const tools = toAiToolSet([spy], {
      context: async () => ctx,
      onEvent: async () => controller.abort(new Error("run cancelled")),
      collector: { citations: [], proposals: [] },
    });
    await expect(
      tools.spy!.execute!({}, { ...options, abortSignal: controller.signal }),
    ).rejects.toThrow("run cancelled");
    expect(seenSignals).toEqual([]);
  });

  it("maps a failing tool.call emit through the tool error vocabulary", async () => {
    let emits = 0;
    const tools = toAiToolSet([echo], {
      context: async () => ctx,
      onEvent: async () => {
        emits += 1;
        if (emits === 1) throw new Error("postgres is down: password=hunter2");
      },
      collector: { citations: [], proposals: [] },
    });
    const result: unknown = await tools.echo!.execute!({ text: "hi" }, options);
    expect(result).toEqual({
      error: { code: "INTERNAL", message: "tool failed" },
    });
  });
});

describe("tool output is JSON-safe", () => {
  it("hands the model a JSON value, never a Date", async () => {
    const { tools } = harness([dated]);
    // The SDK stores this as the tool result's `output.value` and validates the
    // whole message array against ModelMessage[] on the NEXT step, where
    // JSONValue rejects a Date: the run dies with AI_InvalidPromptError.
    const result = (await tools.dated!.execute!({}, options)) as {
      documents: Array<{ lastEditedAt: unknown }>;
    };
    expect(result.documents[0]!.lastEditedAt).toBe("2026-09-01T17:17:29.000Z");
  });
});

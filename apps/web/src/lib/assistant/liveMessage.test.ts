import { describe, expect, it } from "vitest";
import {
  emptyLiveMessage,
  reduceLiveMessage,
  type LiveMessage,
} from "./liveMessage";
import type { RunStreamEvent } from "./runEvents";

const ev = (
  sequence: number,
  event: RunStreamEvent["event"],
): RunStreamEvent => ({ sequence, event });
const run = (events: RunStreamEvent[]): LiveMessage =>
  events.reduce(reduceLiveMessage, emptyLiveMessage());

describe("reduceLiveMessage", () => {
  it("accumulates text deltas in order", () => {
    const state = run([
      ev(1, { type: "run.started", attempt: 1 }),
      ev(2, { type: "text.delta", text: "Hel" }),
      ev(3, { type: "text.delta", text: "lo" }),
    ]);
    expect(state.text).toBe("Hello");
    expect(state.lastSequence).toBe(3);
  });

  it("resets text and marks retrying on a second attempt", () => {
    const state = run([
      ev(1, { type: "run.started", attempt: 1 }),
      ev(2, { type: "text.delta", text: "partial" }),
      ev(3, {
        type: "run.failed",
        code: "PROVIDER_UNAVAILABLE",
        message: "x",
        retrying: true,
      }),
      ev(4, { type: "run.started", attempt: 2 }),
    ]);
    expect(state.text).toBe("");
    expect(state.attempt).toBe(2);
    expect(state.retrying).toBe(false);
    expect(state.failure).toBeNull();
  });

  it("pairs tool calls with results by id and keeps unmatched calls pending", () => {
    const state = run([
      ev(1, {
        type: "tool.call",
        toolCallId: "a",
        toolName: "read_document",
        input: { documentId: "d" },
      }),
      ev(2, {
        type: "tool.call",
        toolCallId: "b",
        toolName: "search_knowledge",
        input: {},
      }),
      ev(3, {
        type: "tool.result",
        toolCallId: "a",
        toolName: "read_document",
        ok: true,
        summary: "12 kB",
      }),
    ]);
    expect(state.tools).toEqual([
      {
        toolCallId: "a",
        toolName: "read_document",
        input: { documentId: "d" },
        ok: true,
        summary: "12 kB",
      },
      {
        toolCallId: "b",
        toolName: "search_knowledge",
        input: {},
        ok: null,
        summary: null,
      },
    ]);
  });

  it("collects citations and proposals and records the terminal event", () => {
    const citation = {
      id: "c",
      kind: "document" as const,
      projectId: "p",
      resourceId: "d",
      commitSha: "s",
      label: "Doc",
      excerpt: null,
    };
    const state = run([
      ev(1, { type: "citation", citation }),
      ev(2, {
        type: "proposal.created",
        proposalId: "pr",
        kind: "document.edit",
        summary: "Edit",
      }),
      ev(3, { type: "run.completed", messageId: "m" }),
    ]);
    expect(state.citations).toEqual([citation]);
    expect(state.proposals).toEqual([
      { proposalId: "pr", kind: "document.edit", summary: "Edit" },
    ]);
    expect(state.terminal).toBe("completed");
  });

  it("keeps a non-retrying failure as the terminal state", () => {
    const state = run([
      ev(1, {
        type: "run.failed",
        code: "RATE_LIMITED",
        message: "busy",
        retrying: false,
      }),
    ]);
    expect(state.terminal).toBe("failed");
    expect(state.failure).toEqual({ code: "RATE_LIMITED", message: "busy" });
    expect(state.retrying).toBe(false);
  });

  it("ignores an event at or below the last sequence", () => {
    const state = run([
      ev(2, { type: "text.delta", text: "a" }),
      ev(2, { type: "text.delta", text: "a" }),
      ev(1, { type: "text.delta", text: "z" }),
    ]);
    expect(state.text).toBe("a");
  });
});
it("renders persisted external approval and call state without arguments", () => {
  const prepared = run([
    ev(1, {
      type: "external.call.status",
      toolCallId: "sdk",
      toolName: "read_counter",
      callId: "call",
      status: "prepared",
      error: null,
    }),
    ev(2, {
      type: "external.approval.required",
      callId: "call",
      approvalId: "approval",
    }),
  ]);
  expect(prepared.tools[0]).toMatchObject({
    callId: "call",
    approvalId: "approval",
    externalStatus: "pending",
    input: null,
  });
  const decided = reduceLiveMessage(
    prepared,
    ev(3, {
      type: "external.approval.decided",
      callId: "call",
      approvalId: "approval",
      status: "denied",
    }),
  );
  expect(decided.tools[0]).toMatchObject({
    externalStatus: "denied",
    ok: false,
  });
  const completed = reduceLiveMessage(
    prepared,
    ev(3, {
      type: "external.call.status",
      toolCallId: "sdk",
      toolName: "read_counter",
      callId: "call",
      status: "completed",
      error: null,
    }),
  );
  expect(completed.tools[0]).toMatchObject({
    externalStatus: "completed",
    ok: true,
  });
});

it("merges external activity into its tool call and preserves unknown outcome", () => {
  const state = run([
    ev(1, {
      type: "tool.call",
      toolCallId: "t",
      toolName: "remote",
      input: {},
    }),
    ev(2, {
      type: "external.call.status",
      toolCallId: "t",
      toolName: "remote",
      callId: "c",
      status: "prepared",
      error: null,
    }),
    ev(3, { type: "external.approval.required", callId: "c", approvalId: "a" }),
    ev(4, {
      type: "external.call.status",
      toolCallId: "t",
      toolName: "remote",
      callId: "c",
      status: "unknown",
      error: { code: "UNKNOWN", message: "Outcome unknown" },
    }),
  ]);
  expect(state.tools).toHaveLength(1);
  expect(state.tools[0]).toMatchObject({
    approvalId: "a",
    externalStatus: "unknown",
    ok: false,
    summary: "Outcome unknown",
  });
});

it("retains immutable external identity, running admission and bounded result summary", () => {
  const running = run([
    ev(1, {
      type: "external.call.status",
      toolCallId: "sdk",
      callId: "call",
      toolName: "same",
      connectionId: "connection",
      connectionName: "Service",
      status: "dispatched",
      error: null,
    }),
  ]);
  expect(running.tools[0]).toMatchObject({
    connectionId: "connection",
    connectionName: "Service",
    externalStatus: "dispatched",
    ok: null,
    input: null,
  });
  const completed = reduceLiveMessage(
    running,
    ev(2, {
      type: "external.call.status",
      toolCallId: "sdk",
      callId: "call",
      toolName: "same",
      connectionId: "connection",
      connectionName: "Service",
      status: "completed",
      summary: "Received 42 bytes of external data.",
      error: null,
    }),
  );
  expect(completed.tools[0]).toMatchObject({
    ok: true,
    summary: "Received 42 bytes of external data.",
    connectionName: "Service",
  });
});

import { describe, expect, it } from "vitest";
import { replayStepsByRun, type ReplayEventRow } from "./replay";

const row = (
  type: string,
  payload: unknown = null,
  textLength: number | null = null,
  runId = "r1",
): ReplayEventRow => ({ runId, type, payload, textLength });

describe("replayStepsByRun", () => {
  it("orders text stretches and tool calls and records outcomes", () => {
    const steps = replayStepsByRun([
      row("run.started"),
      row("text.delta", null, 5),
      row("text.delta", null, 3),
      row("tool.call", {
        toolCallId: "a",
        toolName: "read_document",
        input: { id: 1 },
      }),
      row("tool.result", {
        toolCallId: "a",
        toolName: "read_document",
        ok: true,
      }),
      row("text.delta", null, 4),
      row("external.call.status", {
        toolCallId: "b",
        toolName: "counter",
        status: "prepared",
      }),
      row("external.call.status", {
        toolCallId: "b",
        toolName: "counter",
        status: "failed",
      }),
    ]).get("r1");
    expect(steps).toEqual([
      { kind: "text", length: 8 },
      {
        kind: "tool",
        toolCallId: "a",
        toolName: "read_document",
        input: { id: 1 },
        ok: true,
      },
      { kind: "text", length: 4 },
      {
        kind: "tool",
        toolCallId: "b",
        toolName: "counter",
        input: {},
        ok: false,
      },
    ]);
  });
  it("starts over on a retried attempt and drops runs without tool calls", () => {
    const byRun = replayStepsByRun([
      row("run.started"),
      row("text.delta", null, 9),
      row("tool.call", { toolCallId: "a", toolName: "x", input: {} }),
      row("run.started"),
      row("text.delta", null, 2),
      row("text.delta", null, 7, "r2"),
      row(
        "tool.call",
        { toolCallId: "c", toolName: "y", input: {} },
        null,
        "r2",
      ),
    ]);
    expect(byRun.has("r1")).toBe(false);
    expect(byRun.get("r2")).toHaveLength(2);
  });
});

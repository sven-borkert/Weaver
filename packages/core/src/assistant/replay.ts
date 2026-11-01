/** One earlier assistant turn as it actually ran: text stretches (by code-point length) and tool calls, in order. */
export type ReplayStep =
  | { kind: "text"; length: number }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: unknown;
      ok: boolean | null;
    };

export type ReplayEventRow = {
  runId: string;
  type: string;
  payload: unknown;
  textLength: number | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Rows must be ordered by run and sequence. Runs without a tool call are left out: plain text replays the same. */
export function replayStepsByRun(
  rows: readonly ReplayEventRow[],
): Map<string, ReplayStep[]> {
  const byRun = new Map<string, ReplayStep[]>();
  for (const row of rows) {
    // A retried attempt starts the reply over.
    if (row.type === "run.started" || !byRun.has(row.runId))
      byRun.set(row.runId, []);
    const steps = byRun.get(row.runId)!;
    const payload = record(row.payload);
    const toolCallId =
      typeof payload.toolCallId === "string" ? payload.toolCallId : null;
    const toolName =
      typeof payload.toolName === "string" ? payload.toolName : "";
    const tool = toolCallId
      ? steps.find(
          (step): step is Extract<ReplayStep, { kind: "tool" }> =>
            step.kind === "tool" && step.toolCallId === toolCallId,
        )
      : undefined;
    if (row.type === "text.delta") {
      const last = steps.at(-1);
      const length = Number(row.textLength ?? 0);
      if (last?.kind === "text") last.length += length;
      else steps.push({ kind: "text", length });
    } else if (row.type === "tool.call" && toolCallId && !tool) {
      steps.push({
        kind: "tool",
        toolCallId,
        toolName,
        input: payload.input,
        ok: null,
      });
    } else if (row.type === "tool.result" && tool) {
      tool.ok = payload.ok === true;
    } else if (row.type === "external.call.status" && toolCallId) {
      // External arguments are never stored, so the call replays without them.
      const call =
        tool ??
        (steps[
          steps.push({
            kind: "tool",
            toolCallId,
            toolName,
            input: {},
            ok: null,
          }) - 1
        ] as Extract<ReplayStep, { kind: "tool" }>);
      if (payload.status === "completed") call.ok = true;
      else if (
        payload.status === "failed" ||
        payload.status === "unknown" ||
        payload.status === "denied"
      )
        call.ok = false;
    }
  }
  for (const [runId, steps] of byRun)
    if (!steps.some((step) => step.kind === "tool")) byRun.delete(runId);
  return byRun;
}

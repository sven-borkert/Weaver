export type RunPhase =
  | "queued"
  | "waiting"
  | "thinking"
  | "streaming"
  | "cancelling"
  | "failed"
  | "cancelled"
  | "completed";

const WAITING_AFTER_MS = 10_000;

const FAILURE_COPY: Record<string, { retrying: string; terminal: string }> = {
  PROVIDER_UNAVAILABLE: {
    retrying: "The model didn't respond. Retrying…",
    terminal: "The model didn't respond. Try again.",
  },
  RATE_LIMITED: {
    retrying: "The model is busy. Retrying…",
    terminal: "The model is busy. Try again shortly.",
  },
  WORKER_LOST: {
    retrying: "The run was interrupted and is being retried.",
    terminal: "The run was interrupted and could not be retried.",
  },
  CONTENT_CHANGE_APPLIED: {
    retrying: "A change was approved. Review its result before trying again.",
    terminal:
      "The run stopped after a change was approved. Review its result before trying again.",
  },
};
const FALLBACK_FAILURE = "The assistant couldn't finish this answer.";

export function failureCopy(code: string, retrying: boolean): string {
  const copy = FAILURE_COPY[code];
  if (!copy) return retrying ? "Retrying…" : FALLBACK_FAILURE;
  return retrying ? copy.retrying : copy.terminal;
}

export function runStateCopy(input: {
  status:
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  hasText: boolean;
  queuedForMs: number;
  errorCode: string | null;
  retrying: boolean;
}): { phase: RunPhase; label: string | null } {
  if (input.retrying && input.errorCode)
    return { phase: "thinking", label: failureCopy(input.errorCode, true) };
  switch (input.status) {
    case "queued":
      return input.queuedForMs > WAITING_AFTER_MS
        ? { phase: "waiting", label: "Waiting for a worker…" }
        : { phase: "queued", label: "Queued" };
    case "running":
      return input.hasText
        ? { phase: "streaming", label: null }
        : { phase: "thinking", label: "Thinking" };
    case "cancelling":
      return { phase: "cancelling", label: "Cancelling…" };
    case "failed":
      return {
        phase: "failed",
        label: failureCopy(input.errorCode ?? "", false),
      };
    case "cancelled":
      return { phase: "cancelled", label: "Cancelled" };
    case "completed":
      return { phase: "completed", label: null };
  }
}

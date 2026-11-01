import { captureError } from "@weaver/core/diagnostics/writer";
import { withReference } from "@weaver/core/diagnostics/reference";
export type RunEventPage = {
  events: Array<{ sequence: number; type: string; payload: unknown }>;
  status:
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  nextAfter: number;
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_POLL_MS = 1_000;
const MAX_STREAM_MS = 15 * 60 * 1_000;
// Mirrors the replay page size of assistantRuns.listRunEvents: a page this
// full means more history is already waiting, so drain it without a poll wait.
const EVENT_PAGE_SIZE = 500;

export function formatSseEvent(event: {
  sequence: number;
  type: string;
  payload: unknown;
}): string {
  // Persisted types come from a literal union, but a newline in the event name
  // would forge SSE fields, so never interpolate one unchecked.
  const type = event.type.replace(/[\r\n]+/g, " ");
  return `id: ${event.sequence}\nevent: ${type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Reader demand bounds replay buffering to one page and one queued frame. */
export function createRunEventStream(input: {
  fetchPage: (after: number) => Promise<RunEventPage>;
  after: number;
  runId?: string;
  pollMs?: number;
  maxStreamMs?: number;
  signal?: AbortSignal;
  onClose?: () => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const stop = new AbortController();
  let after = input.after;
  let pending: RunEventPage | undefined;
  let eventIndex = 0;
  let pollBeforeFetch = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    input.onClose?.();
    pending = undefined;
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", close);
    try {
      controller.close();
    } catch {
      // Reader cancellation already closed the stream.
    }
  };
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (input.signal?.aborted) {
        close();
        return;
      }
      input.signal?.addEventListener("abort", close, { once: true });
      deadline = setTimeout(close, input.maxStreamMs ?? MAX_STREAM_MS);
    },
    async pull() {
      const send = (chunk: string) => {
        if (!stop.signal.aborted) controller.enqueue(encoder.encode(chunk));
      };
      try {
        for (;;) {
          if (stop.signal.aborted) return;
          if (!pending) {
            if (pollBeforeFetch) await wait(pollMs, stop.signal);
            if (stop.signal.aborted) return;
            const page = await input.fetchPage(after);
            if (stop.signal.aborted) return;
            pending = page;
            after = pending.nextAfter;
            eventIndex = 0;
          }
          const event = pending.events[eventIndex++];
          if (event) {
            send(formatSseEvent(event));
            return;
          }
          if (
            pending.events.length < EVENT_PAGE_SIZE &&
            TERMINAL.has(pending.status)
          ) {
            send(
              `event: end\ndata: ${JSON.stringify({ status: pending.status })}\n\n`,
            );
            close();
            return;
          }
          pollBeforeFetch = pending.events.length < EVENT_PAGE_SIZE;
          const empty = pending.events.length === 0;
          pending = undefined;
          if (empty) {
            send(": keep-alive\n\n");
            return;
          }
        }
      } catch (error) {
        const reference = captureError({
          event: "assistant.stream.failed",
          message: "assistant event stream failed",
          error,
          runId: input.runId,
        });
        send(
          `event: stream.error\ndata: ${JSON.stringify({
            message: withReference("stream failed", reference),
          })}\n\n`,
        );
        console.error(
          `assistant event stream failed (ref ${reference ?? "none"})`,
        );
        close();
      }
    },
    cancel: close,
  });
}

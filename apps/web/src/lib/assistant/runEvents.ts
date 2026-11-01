import {
  assistantEventSchema,
  type AssistantEvent,
} from "@weaver/core/assistant/events";
import { withBasePath } from "~/lib/basePath";

export type RunStreamEvent = { sequence: number; event: AssistantEvent };
export type RunStreamEnd = { status: "completed" | "failed" | "cancelled" };

/** The subset of EventSource the subscription uses; tests pass a fake. */
export type EventSourceLike = {
  addEventListener(
    type: string,
    listener: (event: { data: string; lastEventId?: string }) => void,
  ): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
};

const EVENT_TYPES = assistantEventSchema.options.map(
  (option) => option.shape.type.value,
);

export function runEventsUrl(runId: string, after: number): string {
  return withBasePath(
    `/api/assistant/runs/${encodeURIComponent(runId)}/events${after < 0 ? "" : `?after=${after}`}`,
  );
}

/**
 * Subscribes to a run's SSE stream. The browser retries transport drops on
 * its own and resends `Last-Event-ID`; we also track the cursor so a
 * replayed frame is dropped rather than rendered twice.
 */
export function createRunEventSubscription(input: {
  runId: string;
  after: number;
  EventSourceImpl: new (url: string) => EventSourceLike;
  onEvent(event: RunStreamEvent): void;
  onEnd(end: RunStreamEnd): void;
  onUnavailable(): void;
  onServerError(): void;
  onTransportError?(): void;
}): { close(): void; cursor(): number } {
  let cursor = input.after;
  const source = new input.EventSourceImpl(
    runEventsUrl(input.runId, input.after),
  );
  let closed = false;
  const close = () => {
    closed = true;
    source.close();
  };
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (raw) => {
      if (closed) return;
      const sequence = Number(raw.lastEventId);
      if (!Number.isInteger(sequence) || sequence <= cursor) return;
      let payload: unknown;
      try {
        payload = JSON.parse(raw.data);
      } catch {
        return;
      }
      const parsed = assistantEventSchema.safeParse({
        type,
        ...(payload as object),
      });
      if (!parsed.success) return;
      cursor = sequence;
      input.onEvent({ sequence, event: parsed.data });
    });
  }
  source.addEventListener("end", (raw) => {
    if (closed) return;
    close();
    try {
      const { status } = JSON.parse(raw.data) as RunStreamEnd;
      if (!["completed", "failed", "cancelled"].includes(status)) {
        input.onServerError();
        return;
      }
      input.onEnd({ status });
    } catch {
      input.onServerError();
    }
  });
  source.addEventListener("stream.error", () => {
    if (closed) return;
    close();
    input.onServerError();
  });
  source.onerror = () => {
    if (!closed) input.onTransportError?.();
  };
  return { close, cursor: () => cursor };
}

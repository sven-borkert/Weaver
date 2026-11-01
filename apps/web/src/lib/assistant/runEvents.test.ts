import { describe, expect, it, vi } from "vitest";
import {
  createRunEventSubscription,
  runEventsUrl,
  type EventSourceLike,
  type RunStreamEvent,
} from "./runEvents";

type Listener = (event: { data: string; lastEventId?: string }) => void;

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, payload: unknown, id?: number) {
    for (const l of this.listeners.get(type) ?? [])
      l({
        data: JSON.stringify(payload),
        lastEventId: id === undefined ? "" : String(id),
      });
  }
}

function subscribe(after = -1) {
  const onEvent = vi.fn<(e: RunStreamEvent) => void>();
  const onEnd = vi.fn();
  const onUnavailable = vi.fn();
  const onServerError = vi.fn();
  const sub = createRunEventSubscription({
    runId: "run-1",
    after,
    EventSourceImpl: FakeEventSource,
    onEvent,
    onEnd,
    onUnavailable,
    onServerError,
  });
  return {
    sub,
    onEvent,
    onEnd,
    onUnavailable,
    onServerError,
    source: FakeEventSource.instances.at(-1)!,
  };
}

describe("runEventsUrl", () => {
  it("builds a base-path aware URL with the cursor", () => {
    expect(runEventsUrl("run-1", 4)).toMatch(
      /\/api\/assistant\/runs\/run-1\/events\?after=4$/,
    );
  });
});

describe("createRunEventSubscription", () => {
  it("delivers typed events and advances the cursor", () => {
    const { sub, onEvent, source } = subscribe();
    source.emit("text.delta", { text: "hi" }, 3);
    expect(onEvent).toHaveBeenCalledWith({
      sequence: 3,
      event: { type: "text.delta", text: "hi" },
    });
    expect(sub.cursor()).toBe(3);
  });

  it("drops an event it has already seen (a transport retry replayed it)", () => {
    const { onEvent, source } = subscribe(2);
    source.emit("text.delta", { text: "old" }, 2);
    source.emit("text.delta", { text: "new" }, 3);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0].sequence).toBe(3);
  });

  it("closes on end and reports the terminal status", () => {
    const { onEnd, source } = subscribe();
    source.emit("end", { status: "completed" });
    expect(onEnd).toHaveBeenCalledWith({ status: "completed" });
    expect(source.closed).toBe(true);
  });

  it("treats stream.error as terminal and a transport error as retryable", () => {
    const { onServerError, onUnavailable, source } = subscribe();
    source.onerror?.({});
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(source.closed).toBe(false);
    source.emit("stream.error", { message: "stream failed" });
    expect(onServerError).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it("ignores malformed payloads instead of throwing", () => {
    const { onEvent, source } = subscribe();
    for (const l of source.listeners.get("text.delta") ?? [])
      l({ data: "{not json", lastEventId: "1" });
    source.emit("text.delta", { text: 42 }, 2);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("close() closes the source", () => {
    const { sub, source } = subscribe();
    sub.close();
    expect(source.closed).toBe(true);
  });
});

it("does not dispatch late data after its subscription has been closed", () => {
  const { sub, source, onEvent } = subscribe();
  sub.close();
  source.emit("text.delta", { text: "late" }, 1);
  expect(onEvent).not.toHaveBeenCalled();
});

it("reports transport errors to the run probe and ignores late terminal frames after close", () => {
  const onTransportError = vi.fn();
  const onEnd = vi.fn();
  const onServerError = vi.fn();
  const sub = createRunEventSubscription({
    runId: "r",
    after: -1,
    EventSourceImpl: FakeEventSource,
    onEvent: vi.fn(),
    onEnd,
    onUnavailable: vi.fn(),
    onServerError,
    onTransportError,
  });
  const source = FakeEventSource.instances.at(-1)!;
  source.onerror?.({});
  expect(onTransportError).toHaveBeenCalledOnce();
  sub.close();
  source.emit("end", { status: "completed" });
  source.emit("stream.error", {});
  expect(onEnd).not.toHaveBeenCalled();
  expect(onServerError).not.toHaveBeenCalled();
});

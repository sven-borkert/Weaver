import { describe, expect, it, vi } from "vitest";
import {
  createRunEventStream,
  formatSseEvent,
  type RunEventPage,
} from "./eventStream";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += decoder.decode(value);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const running = (nextAfter: number): RunEventPage => ({
  events: [],
  status: "running",
  nextAfter,
});

describe("formatSseEvent", () => {
  it("emits id/event/data lines with a blank terminator", () => {
    expect(
      formatSseEvent({
        sequence: 3,
        type: "text.delta",
        payload: { text: "hi\nthere" },
      }),
    ).toBe('id: 3\nevent: text.delta\ndata: {"text":"hi\\nthere"}\n\n');
  });

  it("cannot be used to forge extra SSE fields through the event name", () => {
    expect(
      formatSseEvent({
        sequence: 1,
        type: "text.delta\nevent: end\ndata: {}",
        payload: {},
      }),
    ).toBe("id: 1\nevent: text.delta event: end data: {}\ndata: {}\n\n");
  });
});

describe("createRunEventStream", () => {
  it("replays from the cursor, polls until terminal, then sends end", async () => {
    const pages = [
      {
        events: [
          { sequence: 0, type: "run.queued", payload: {} },
          { sequence: 1, type: "run.started", payload: { attempt: 1 } },
        ],
        status: "running" as const,
        nextAfter: 1,
      },
      { events: [], status: "running" as const, nextAfter: 1 },
      {
        events: [
          { sequence: 2, type: "run.completed", payload: { messageId: "m" } },
        ],
        status: "completed" as const,
        nextAfter: 2,
      },
    ];
    let call = 0;
    const text = await readAll(
      createRunEventStream({
        fetchPage: async () => pages[Math.min(call++, pages.length - 1)]!,
        after: -1,
        pollMs: 1,
      }),
    );
    expect(text.split("\n\n").filter(Boolean)).toEqual([
      "id: 0\nevent: run.queued\ndata: {}",
      'id: 1\nevent: run.started\ndata: {"attempt":1}',
      ": keep-alive",
      'id: 2\nevent: run.completed\ndata: {"messageId":"m"}',
      'event: end\ndata: {"status":"completed"}',
    ]);
  });

  it("resumes from the requested cursor and reports failed and cancelled runs", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const seen: number[] = [];
      const text = await readAll(
        createRunEventStream({
          fetchPage: async (after) => {
            seen.push(after);
            return { events: [], status, nextAfter: after };
          },
          after: 7,
          pollMs: 1,
        }),
      );
      expect(seen).toEqual([7]);
      expect(text).toBe(`event: end\ndata: {"status":"${status}"}\n\n`);
    }
  });

  it("drains a full replay page without waiting for the poll interval", async () => {
    const backlog = Array.from({ length: 500 }, (_, index) => ({
      sequence: index,
      type: "text.delta",
      payload: { text: "x" },
    }));
    const cursors: number[] = [];
    const startedAt = Date.now();
    const text = await readAll(
      createRunEventStream({
        fetchPage: async (after) => {
          cursors.push(after);
          return after < 0
            ? { events: backlog, status: "running" as const, nextAfter: 499 }
            : {
                events: [{ sequence: 500, type: "run.completed", payload: {} }],
                status: "completed" as const,
                nextAfter: 500,
              };
        },
        after: -1,
        pollMs: 60_000,
      }),
    );
    expect(cursors).toEqual([-1, 499]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(text.split("\n\n").filter(Boolean)).toHaveLength(502);
  });

  it("stops polling once the request is aborted and never emits end", async () => {
    const controller = new AbortController();
    let calls = 0;
    const text = await readAll(
      createRunEventStream({
        fetchPage: async () => {
          calls += 1;
          if (calls === 2) controller.abort();
          return running(-1);
        },
        after: -1,
        pollMs: 5,
        signal: controller.signal,
      }),
    );
    const callsAtClose = calls;
    await delay(50);
    expect(calls).toBe(callsAtClose);
    expect(calls).toBe(2);
    expect(text).not.toContain("event: end");
  });

  it("does not start polling when the request is already aborted", async () => {
    let calls = 0;
    const text = await readAll(
      createRunEventStream({
        fetchPage: async () => {
          calls += 1;
          return running(-1);
        },
        after: -1,
        pollMs: 5,
        signal: AbortSignal.abort(),
      }),
    );
    expect(calls).toBe(0);
    expect(text).toBe("");
  });

  it("stops polling when the client disconnects mid-stream", async () => {
    let calls = 0;
    const stream = createRunEventStream({
      fetchPage: async () => {
        calls += 1;
        return running(-1);
      },
      after: -1,
      pollMs: 5,
    });
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      ": keep-alive\n\n",
    );
    await reader.cancel();
    const callsAtCancel = calls;
    await delay(60);
    expect(calls).toBe(callsAtCancel);
  });

  it("reports a fetch failure as a stream.error event without leaking the cause", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const text = await readAll(
        createRunEventStream({
          fetchPage: async () => {
            throw new Error("connect ECONNREFUSED secret-token@db:5432");
          },
          after: -1,
          pollMs: 1,
        }),
      );
      expect(text).toBe(
        'event: stream.error\ndata: {"message":"stream failed"}\n\n',
      );
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("reports a server-side failure as stream.error, not the transport error name", async () => {
    const stream = createRunEventStream({
      fetchPage: () => Promise.reject(new Error("db down")),
      after: -1,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = await readAll(stream);
      expect(out).toBe(
        'event: stream.error\ndata: {"message":"stream failed"}\n\n',
      );
      expect(out).not.toContain("event: error\n");
    } finally {
      spy.mockRestore();
    }
  });
});

it("bounds full replay pages while the consumer stalls and cancels without another fetch", async () => {
  const fetchPage = vi.fn(async (after: number): Promise<RunEventPage> => ({
    events: Array.from({ length: 500 }, (_, i) => ({
      sequence: after + i + 1,
      type: "text.delta",
      payload: { text: "x".repeat(1000) },
    })),
    status: "running",
    nextAfter: after + 500,
  }));
  const stream = createRunEventStream({ fetchPage, after: -1 });
  const reader = stream.getReader();
  await reader.read();
  await delay(20);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await reader.cancel();
  await delay(20);
  expect(fetchPage).toHaveBeenCalledTimes(1);
});
it("expires a stalled replay without requiring reader demand", async () => {
  const fetchPage = vi.fn(async (): Promise<RunEventPage> => ({
    events: [{ sequence: 0, type: "text.delta", payload: { text: "x" } }],
    status: "running",
    nextAfter: 0,
  }));
  const stream = createRunEventStream({
    fetchPage,
    after: -1,
    maxStreamMs: 10,
  });
  await delay(30);
  const reader = stream.getReader();
  await reader.read();
  expect((await reader.read()).done).toBe(true);
  expect(fetchPage).toHaveBeenCalledTimes(1);
});

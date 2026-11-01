import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  invalidateDiagnosticsSettingsCache,
  peekDiagnosticsSettings,
  primeDiagnosticsSettingsCache,
} from "@weaver/core/services/diagnosticsSettings";
import { DEFAULT_DIAGNOSTICS_SETTINGS } from "./settings";
import { withDiagnosticContext } from "./context";
import {
  captureError,
  diagnosticWriterStats,
  emitDiagnostic,
  flushDiagnostics,
  reserveDiagnosticEvent,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  trackDiagnosticTask,
  waitForDiagnosticWriterReady,
  type DiagnosticEmitInput,
} from "./writer";

type Row = Prisma.DiagnosticEventCreateManyInput;

function fakeDb() {
  const createMany = vi.fn(async (args: { data: Row[] }) => ({
    count: args.data.length,
  }));
  const findUnique = vi.fn(
    async (_args?: unknown): Promise<{ value: Prisma.JsonValue } | null> =>
      null,
  );
  return {
    createMany,
    findUnique,
    db: {
      diagnosticEvent: { createMany },
      systemSetting: { findUnique },
    } as unknown as PrismaClient,
  };
}

function enable(level: "errors" | "standard" | "verbose" = "standard") {
  primeDiagnosticsSettingsCache({ ...DEFAULT_DIAGNOSTICS_SETTINGS, level });
}

function deferred<T = { count: number }>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await stopDiagnosticWriter();
  invalidateDiagnosticsSettingsCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("diagnostic writer", () => {
  it("persists immutable body provenance that event overrides cannot narrow", async () => {
    const { db, createMany } = fakeDb();
    const projectA = "10000000-0000-4000-8000-000000000001";
    const projectB = "10000000-0000-4000-8000-000000000002";
    const ids = [projectA];
    enable("verbose");
    startDiagnosticWriter({ db, runtime: "worker" });
    withDiagnosticContext({ bodyProjectIds: ids }, () => {
      emitDiagnostic({
        event: "ai.request",
        message: "mixed history",
        bodyProjectIds: [projectB],
        requestBody: '{"text":"private request"}',
        responseBody: '{"text":"private response"}',
      });
      ids.splice(0);
    });
    await flushDiagnostics();
    const row = createMany.mock.calls.flatMap(([args]) => args.data)[0]!;
    expect(row.bodyProjectIds).toEqual([projectA, projectB]);
    expect(row.requestBody).toContain("private request");
    expect(row.responseBody).toContain("private response");
  });

  it("strips both bodies for unknown lineage or suppressed context despite overrides", async () => {
    const { db, createMany } = fakeDb();
    enable("verbose");
    startDiagnosticWriter({ db, runtime: "worker" });
    for (const context of [
      { runId: "10000000-0000-4000-8000-000000000001" },
      { bodyProjectIds: null },
      { suppressProviderBodies: true },
    ]) {
      withDiagnosticContext(context, () =>
        emitDiagnostic({
          event: "ai.request",
          message: "unknown history",
          suppressProviderBodies: false,
          requestBody: '{"text":"private"}',
          responseBody: '{"text":"private"}',
        }),
      );
    }
    await flushDiagnostics();
    const rows = createMany.mock.calls.flatMap(([args]) => args.data);
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row).toMatchObject({
        hasRequestBody: false,
        hasResponseBody: false,
        requestBody: null,
        responseBody: null,
      });
  });

  it("persists only warnings and errors at the errors level", async () => {
    const { db, createMany } = fakeDb();
    enable("errors");
    startDiagnosticWriter({ db, runtime: "worker" });
    emitDiagnostic({ event: "job.started", message: "info dropped" });
    emitDiagnostic({
      event: "job.failed",
      severity: "warn",
      message: "warn kept",
    });
    emitDiagnostic({
      event: "job.failed",
      severity: "error",
      message: "error kept",
    });
    emitDiagnostic({
      event: "trpc.mutation",
      severity: "error",
      verbose: true,
      message: "verbose dropped",
    });
    await flushDiagnostics();
    const rows = createMany.mock.calls.flatMap(([args]) => args.data);
    expect(rows.map((row) => row.message)).toEqual(["warn kept", "error kept"]);
  });
  it("returns the queued event id, honours a reserved id, and returns null when nothing is written", async () => {
    const { db, createMany } = fakeDb();
    expect(
      emitDiagnostic({
        event: "job.failed",
        severity: "error",
        message: "before start",
      }),
    ).toBeNull();
    expect(reserveDiagnosticEvent("error")).toBeNull();
    enable("errors");
    startDiagnosticWriter({ db, runtime: "worker" });
    expect(
      emitDiagnostic({ event: "job.started", message: "dropped info" }),
    ).toBeNull();
    expect(reserveDiagnosticEvent("info")).toBeNull();
    const reserved = reserveDiagnosticEvent("error");
    expect(reserved).not.toBeNull();
    expect(reserved!.id.startsWith(reserved!.reference)).toBe(true);
    const id = emitDiagnostic({
      id: reserved!.id,
      event: "job.failed",
      severity: "error",
      message: "kept",
    });
    expect(id).toBe(reserved!.id);
    const fresh = emitDiagnostic({
      event: "job.failed",
      severity: "error",
      message: "fresh",
    });
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      emitDiagnostic({
        id: "junk",
        event: "job.failed",
        severity: "error",
        message: "junk id",
      }),
    ).toMatch(/^[0-9a-f-]{36}$/);
    await flushDiagnostics();
    const rows = createMany.mock.calls.flatMap(([args]) => args.data);
    expect(rows.map((row) => row.id)).toEqual([
      reserved!.id,
      fresh,
      expect.any(String),
    ]);
  });

  it("captures an error summary and returns its reference", async () => {
    const { db, createMany } = fakeDb();
    enable("errors");
    startDiagnosticWriter({ db, runtime: "worker" });
    const reference = captureError({
      event: "runtime.error",
      message: "pool failed",
      error: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
      details: { source: "pg-boss" },
    });
    expect(reference).toMatch(/^[0-9a-f]{8}$/);
    await flushDiagnostics();
    const [row] = createMany.mock.calls.flatMap(([args]) => args.data);
    expect(row!.id!.startsWith(reference!)).toBe(true);
    expect(row).toMatchObject({
      severity: "error",
      outcome: "error",
      category: "runtime",
      details: {
        source: "pg-boss",
        error: { name: "Error", code: "ECONNREFUSED" },
      },
    });
  });

  it("keeps malformed correlation identifiers from poisoning an insert batch", async () => {
    const { db, createMany } = fakeDb();
    enable();
    startDiagnosticWriter({ db, runtime: "web" });
    emitDiagnostic({
      event: "job.started",
      message: "started",
      projectId: "invalid",
      requestId: "x".repeat(100),
      credentialId: "k".repeat(300),
    });
    await flushDiagnostics();
    const row = createMany.mock.calls[0]![0].data[0]!;
    expect(row.projectId).toBeNull();
    expect(row.requestId).toHaveLength(64);
    expect(row.credentialId).toHaveLength(200);
  });
  it.each(["standard", "verbose"] as const)(
    "redacts short and multiline Bearer tokens and message fields at %s",
    async (level) => {
      const { db, createMany } = fakeDb();
      enable(level);
      startDiagnosticWriter({ db, runtime: "web" });
      emitDiagnostic({
        event: "ai.request",
        message: "Bearer abc123",
        details: {
          messageContent: "TEST_ONLY_PRIVATE",
          messageText: "TEST_ONLY_PRIVATE",
          messageBody: "TEST_ONLY_PRIVATE",
          diagnostic: "request failed: Bearer abc123",
          error: new Error("Bearer\nTEST_ONLY_SECRET"),
          errorMessage: "basic model unavailable",
          messageId: "m1",
        },
        requestBody: JSON.stringify({
          diagnostic: "request failed: Bearer abc123",
          messageContent: "allowed body content",
        }),
        responseBody: JSON.stringify({
          diagnostic: "Bearer\nTEST_ONLY_SECRET",
        }),
      });
      await flushDiagnostics();
      const row = createMany.mock.calls[0]![0].data[0]!;
      expect(row.message).toBe("[redacted]");
      expect(row.details).toEqual({
        messageContent: "[redacted]",
        messageText: "[redacted]",
        messageBody: "[redacted]",
        diagnostic: "[redacted]",
        error: "[redacted]",
        errorMessage: "basic model unavailable",
        messageId: "m1",
      });
      if (level === "verbose") {
        expect(JSON.parse(row.requestBody!)).toEqual({
          diagnostic: "[redacted]",
          messageContent: "allowed body content",
        });
        expect(JSON.parse(row.responseBody!)).toEqual({
          diagnostic: "[redacted]",
        });
      } else {
        expect(row.requestBody).toBeNull();
        expect(row.responseBody).toBeNull();
      }
      expect(JSON.stringify(row)).not.toContain("TEST_ONLY_");
      expect(JSON.stringify(row)).not.toContain("abc123");
    },
  );

  it("redacts embedded schemes and role/source content at the writer boundary", async () => {
    const { db, createMany } = fakeDb();
    enable("verbose");
    startDiagnosticWriter({ db, runtime: "web" });
    emitDiagnostic({
      event: "ai.request",
      message: "Bearer TEST_ONLY_SECRET was rejected",
      details: {
        user_content: "TEST_ONLY_PRIVATE",
        assistantText: "TEST_ONLY_PRIVATE",
        rawPrompt: "TEST_ONLY_PRIVATE",
        error: new Error("request failed using Bearer TEST_ONLY_SECRET"),
        context: { requestId: "r1" },
        count: 1,
      },
      requestBody: JSON.stringify({
        note: "request failed: Basic dXNlcjpwYXNz (401)",
        rawPrompt: "allowed body prompt",
      }),
    });
    await flushDiagnostics();
    const row = createMany.mock.calls[0]![0].data[0]!;
    expect(JSON.stringify(row)).not.toContain("TEST_ONLY_");
    expect(JSON.stringify(row)).not.toContain("dXNlcjpwYXNz");
    expect(row.details).toMatchObject({
      context: { requestId: "r1" },
      count: 1,
    });
    expect(JSON.parse(row.requestBody!)).toEqual({
      note: "[redacted]",
      rawPrompt: "allowed body prompt",
    });
  });

  it("redacts separator bypasses and private history while preserving safe writer metadata", async () => {
    const { db, createMany } = fakeDb();
    enable("verbose");
    startDiagnosticWriter({ db, runtime: "web" });
    emitDiagnostic({
      event: "ai.request",
      message: "inputTokens: 45; credentialId: c1; basic model unavailable",
      details: {
        conversation_history: [{ user: "TEST_ONLY_PRIVATE" }],
        "api  key": "TEST_ONLY_SECRET",
        api__key: "TEST_ONLY_SECRET",
        context: { requestId: "r1" },
        errorMessage: "basic model unavailable",
      },
      requestBody: JSON.stringify({
        api__key: "TEST_ONLY_SECRET",
        messages: [{ content: "allowed body" }],
      }),
    });
    emitDiagnostic({
      event: "job.failed",
      message: "api__key=TEST_ONLY_SECRET",
    });
    await flushDiagnostics();
    const rows = createMany.mock.calls[0]![0].data;
    expect(JSON.stringify(rows)).not.toContain("TEST_ONLY_");
    expect(rows[0]).toMatchObject({
      message: "inputTokens: 45; credentialId: c1; basic model unavailable",
      details: {
        context: { requestId: "r1" },
        errorMessage: "basic model unavailable",
      },
    });
    expect(JSON.parse(rows[0]!.requestBody!)).toEqual({
      api__key: "[redacted]",
      messages: [{ content: "allowed body" }],
    });
  });

  it.each(["standard", "verbose"] as const)(
    "redacts credentials and private content outside provider bodies at %s",
    async (level) => {
      const { db, createMany } = fakeDb();
      enable(level);
      startDiagnosticWriter({ db, runtime: "web" });
      emitDiagnostic({
        event: "ai.request",
        message: "Authorization: Bearer TEST_ONLY_SENTINEL",
        details: {
          messages: [{ content: "TEST_ONLY_CONVERSATION" }],
          prompt: "TEST_ONLY_PROMPT",
          error: new Error("password=TEST_ONLY_PASSWORD"),
          model: "test-model",
          tool: "search_documents",
          count: 3,
          path: "/docs/guide.md",
        },
        requestBody: JSON.stringify({
          messages: [{ content: "permitted provider conversation" }],
          prompt: "permitted provider prompt",
          password: "TEST_ONLY_BODY_PASSWORD",
        }),
      });
      await flushDiagnostics();
      const row = createMany.mock.calls[0]![0].data[0]!;
      expect(JSON.stringify(row)).not.toContain("TEST_ONLY_");
      expect(row.details).toMatchObject({
        model: "test-model",
        tool: "search_documents",
        count: 3,
        path: "/docs/guide.md",
      });
      if (level === "verbose") {
        expect(JSON.parse(row.requestBody!)).toEqual({
          messages: [{ content: "permitted provider conversation" }],
          prompt: "permitted provider prompt",
          password: "[redacted]",
        });
      } else {
        expect(row.requestBody).toBeNull();
      }
    },
  );

  it("does nothing before start and while disabled", async () => {
    expect(() =>
      emitDiagnostic({ event: "job.started", message: "ignored" }),
    ).not.toThrow();
    const { db, createMany } = fakeDb();
    primeDiagnosticsSettingsCache({
      ...DEFAULT_DIAGNOSTICS_SETTINGS,
      level: "off",
    });
    startDiagnosticWriter({ db, runtime: "worker" });
    emitDiagnostic({ event: "job.started", message: "off" });
    await flushDiagnostics();
    expect(createMany).not.toHaveBeenCalled();
    expect(diagnosticWriterStats()).toMatchObject({
      queued: 0,
      written: 0,
      dropped: 0,
    });
  });

  it("persists the first event after cold-start settings readiness", async () => {
    const { db, createMany, findUnique } = fakeDb();
    findUnique.mockResolvedValueOnce({
      value: { ...DEFAULT_DIAGNOSTICS_SETTINGS, level: "standard" },
    });
    startDiagnosticWriter({
      db,
      runtime: "web",
      flushIntervalMs: 60_000,
    });

    await waitForDiagnosticWriterReady();
    emitDiagnostic({
      event: "runtime.started",
      message: "web runtime started",
    });
    await flushDiagnostics();

    expect(createMany.mock.calls.flatMap(([args]) => args.data)).toMatchObject([
      {
        runtime: "web",
        event: "runtime.started",
        message: "web runtime started",
      },
    ]);
  });

  it("resolves cold-start readiness when the settings read fails", async () => {
    const { db, createMany, findUnique } = fakeDb();
    findUnique.mockRejectedValueOnce(new Error("settings unavailable"));
    startDiagnosticWriter({
      db,
      runtime: "worker",
      flushIntervalMs: 60_000,
    });

    await expect(waitForDiagnosticWriterReady()).resolves.toBeUndefined();
    emitDiagnostic({ event: "runtime.started", message: "worker started" });
    await flushDiagnostics();

    expect(createMany).not.toHaveBeenCalled();
    expect(diagnosticWriterStats()).toMatchObject({
      started: true,
      runtime: "worker",
      dropped: 0,
    });
  });

  it.each(["resolve", "reject"] as const)(
    "bounds runtime admission and contains a late settings %s across writer restart",
    async (settlement) => {
      vi.useFakeTimers();
      const previous = fakeDb();
      const pendingSettings = deferred<{
        value: Prisma.JsonValue;
      } | null>();
      previous.findUnique.mockReturnValueOnce(pendingSettings.promise);
      startDiagnosticWriter({
        db: previous.db,
        runtime: "worker",
        flushIntervalMs: 60_000,
      });

      let admitted = false;
      const admission = waitForDiagnosticWriterReady().then(() => {
        admitted = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(admitted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(admitted).toBe(true);
      await admission;
      expect(vi.getTimerCount()).toBe(1);

      await stopDiagnosticWriter();
      const replacement = fakeDb();
      replacement.findUnique.mockResolvedValueOnce({
        value: { ...DEFAULT_DIAGNOSTICS_SETTINGS, level: "standard" },
      });
      startDiagnosticWriter({
        db: replacement.db,
        runtime: "web",
        flushIntervalMs: 60_000,
      });
      const replacementReadiness = waitForDiagnosticWriterReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(replacement.findUnique).toHaveBeenCalledOnce();
      await replacementReadiness;
      emitDiagnostic({
        event: "runtime.started",
        message: "replacement web runtime started",
      });
      await flushDiagnostics();

      if (settlement === "resolve") {
        pendingSettings.resolve({
          value: { ...DEFAULT_DIAGNOSTICS_SETTINGS, level: "verbose" },
        });
      } else {
        pendingSettings.reject(new Error("late settings failure"));
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(peekDiagnosticsSettings()?.value.level).toBe("standard");
      expect(
        replacement.createMany.mock.calls.flatMap(([args]) => args.data),
      ).toMatchObject([
        {
          runtime: "web",
          event: "runtime.started",
          message: "replacement web runtime started",
        },
      ]);
    },
  );

  it("writes bounded standard metadata with explicit UTC time and merged ids", async () => {
    const { db, createMany } = fakeDb();
    enable();
    startDiagnosticWriter({
      db,
      runtime: "mcp",
      now: () => new Date("2026-09-04T12:00:00.000Z"),
    });
    withDiagnosticContext(
      {
        requestId: "r1",
        userId: "11111111-1111-4111-8111-111111111111",
        jobId: "j1",
      },
      () => {
        emitDiagnostic({
          event: "ai.request",
          message: "m".repeat(600),
          userId: undefined,
          jobId: "j2",
          connectionId: "22222222-2222-4222-8222-222222222222",
          statusCode: 503,
          durationMs: 12,
          outcome: "error",
          details: { api_key: "secret", host: "h" },
          requestBody: '{"model":"m"}',
          responseBody: "err",
        });
        emitDiagnostic({
          event: "trpc.mutation",
          message: "verbose only",
          verbose: true,
        });
      },
    );
    await flushDiagnostics();
    const rows = createMany.mock.calls.flatMap(([args]) => args.data);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runtime: "mcp",
      severity: "info",
      verbose: false,
      category: "ai",
      event: "ai.request",
      requestId: "r1",
      userId: "11111111-1111-4111-8111-111111111111",
      jobId: "j2",
      connectionId: "22222222-2222-4222-8222-222222222222",
      statusCode: 503,
      durationMs: 12,
      outcome: "error",
      details: { api_key: "[redacted]", host: "h" },
      hasRequestBody: false,
      hasResponseBody: false,
      requestBody: null,
      responseBody: null,
      createdAt: new Date("2026-09-04T12:00:00.000Z"),
    });
    expect(rows[0]!.message).toHaveLength(500);
    expect(diagnosticWriterStats()).toMatchObject({
      written: 1,
      dropped: 0,
      queued: 0,
      flushes: 1,
    });
  });

  it("retains sanitized bodies and verbose-only events at verbose level", async () => {
    const { db, createMany } = fakeDb();
    enable("verbose");
    startDiagnosticWriter({ db, runtime: "worker" });
    emitDiagnostic({
      event: "ai.request",
      message: "ok",
      requestBody: '{"model":"m","api_key":"s"}',
      responseBody: JSON.stringify(
        Array.from({ length: 30 }, () => "x".repeat(2000)),
      ),
      details: { big: Array.from({ length: 30 }, () => "x".repeat(2000)) },
    });
    emitDiagnostic({ event: "trpc.mutation", message: "kept", verbose: true });
    emitDiagnostic({
      event: "ai.request",
      message: "malformed",
      responseBody: "token=secret",
    });
    await flushDiagnostics();
    const rows = createMany.mock.calls.flatMap(([args]) => args.data);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      verbose: true,
      hasRequestBody: true,
      hasResponseBody: true,
      requestBody: '{"model":"m","api_key":"[redacted]"}',
    });
    expect(rows[0]!.responseBody).toHaveLength(32_768);
    expect(JSON.stringify(rows[0]!.details).length).toBeLessThanOrEqual(8192);
    expect(rows[1]).toMatchObject({ event: "trpc.mutation", verbose: true });
    expect(rows[2]!.responseBody).toBe("[redacted body]");
  });

  it("starts only once and flushes periodically without duplicate timers", async () => {
    vi.useFakeTimers();
    const first = fakeDb();
    const second = fakeDb();
    enable();
    startDiagnosticWriter({
      db: first.db,
      runtime: "web",
      flushIntervalMs: 1000,
    });
    startDiagnosticWriter({
      db: second.db,
      runtime: "mcp",
      flushIntervalMs: 1,
    });
    emitDiagnostic({ event: "job.started", message: "first" });
    await vi.advanceTimersByTimeAsync(999);
    expect(first.createMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.createMany.mock.calls[0]![0].data[0]).toMatchObject({
      runtime: "web",
      message: "first",
    });
    expect(second.createMany).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await stopDiagnosticWriter();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes full batches in the background and drains arrivals during an insert", async () => {
    const { db, createMany } = fakeDb();
    const pending = deferred();
    createMany.mockImplementationOnce(() => pending.promise);
    enable();
    startDiagnosticWriter({ db, runtime: "web", batchSize: 2 });
    emitDiagnostic({ event: "job.started", message: "a" });
    emitDiagnostic({ event: "job.started", message: "b" });
    expect(createMany).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(createMany).toHaveBeenCalledTimes(1);
    emitDiagnostic({ event: "job.started", message: "c" });
    const draining = flushDiagnostics();
    pending.resolve({ count: 2 });
    await draining;
    expect(
      createMany.mock.calls.map(([args]) =>
        args.data.map((row) => row.message),
      ),
    ).toEqual([["a", "b"], ["c"]]);
    expect(diagnosticWriterStats()).toMatchObject({
      queued: 0,
      written: 3,
      dropped: 0,
    });
  });

  it("flushes queued rows while overlapping tracked captures remain pending", async () => {
    const { db, createMany } = fakeDb();
    enable();
    startDiagnosticWriter({ db, runtime: "web" });
    let resolveFirst!: (input: DiagnosticEmitInput | null) => void;
    let resolveSecond!: (input: DiagnosticEmitInput | null) => void;
    trackDiagnosticTask(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    trackDiagnosticTask(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
    emitDiagnostic({ event: "job.started", message: "unrelated ready row" });
    const flushing = flushDiagnostics();

    try {
      await Promise.resolve();
      expect(
        createMany.mock.calls.flatMap(([args]) => args.data),
      ).toMatchObject([{ message: "unrelated ready row" }]);
    } finally {
      resolveFirst(null);
      resolveSecond(null);
      await flushing;
    }
  });

  it("drops the oldest queued rows under pressure while an insert is pending", async () => {
    const { db, createMany } = fakeDb();
    const pending = deferred();
    createMany.mockImplementationOnce(() => pending.promise);
    enable();
    startDiagnosticWriter({ db, runtime: "web", batchSize: 1, maxQueue: 2 });
    emitDiagnostic({ event: "job.started", message: "in-flight" });
    await Promise.resolve();
    for (const message of ["old", "middle", "new"])
      emitDiagnostic({ event: "job.started", message });
    expect(diagnosticWriterStats()).toMatchObject({ queued: 2, dropped: 1 });
    pending.resolve({ count: 1 });
    await flushDiagnostics();
    expect(
      createMany.mock.calls.flatMap(([args]) =>
        args.data.map((row) => row.message),
      ),
    ).toEqual(["in-flight", "middle", "new"]);
    expect(diagnosticWriterStats()).toMatchObject({ written: 3, dropped: 1 });
  });

  it("counts failed inserts and logs only error names at most once per minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, createMany } = fakeDb();
    createMany.mockRejectedValue(new TypeError("password=secret"));
    enable();
    startDiagnosticWriter({ db, runtime: "worker", flushIntervalMs: 120000 });
    for (let i = 0; i < 2; i++) {
      emitDiagnostic({ event: "job.failed", message: "failed" });
      await flushDiagnostics();
    }
    expect(diagnosticWriterStats()).toMatchObject({
      written: 0,
      dropped: 2,
      lastError: "TypeError",
    });
    expect(log.mock.calls).toEqual([
      ["diagnostic writer insert failed: TypeError"],
    ]);
    vi.setSystemTime(60000);
    enable();
    emitDiagnostic({ event: "job.failed", message: "again" });
    await flushDiagnostics();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never throws for hostile inputs and continues writing healthy events", async () => {
    const { db, createMany } = fakeDb();
    enable("verbose");
    startDiagnosticWriter({ db, runtime: "worker" });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("secret");
        },
        get() {
          throw new Error("secret");
        },
      },
    );
    expect(() => emitDiagnostic(hostile as DiagnosticEmitInput)).not.toThrow();
    expect(() =>
      emitDiagnostic({
        event: "job.started",
        message: null,
      } as unknown as DiagnosticEmitInput),
    ).not.toThrow();
    expect(() =>
      emitDiagnostic({
        event: "job.started",
        message: "healthy",
        details: hostile,
      }),
    ).not.toThrow();
    await flushDiagnostics();
    expect(createMany.mock.calls.flatMap(([args]) => args.data)).toEqual([
      expect.objectContaining({
        message: "healthy",
        details: "[unavailable]",
      }),
    ]);
    expect(diagnosticWriterStats()).toMatchObject({ dropped: 2, written: 1 });
  });

  it("keeps a timed-out shutdown from draining a replacement writer", async () => {
    vi.useFakeTimers();
    const previous = fakeDb();
    const pendingInsert = deferred();
    previous.createMany.mockImplementationOnce(() => pendingInsert.promise);
    enable();
    startDiagnosticWriter({
      db: previous.db,
      runtime: "worker",
      batchSize: 1,
    });
    emitDiagnostic({ event: "job.started", message: "previous in-flight" });
    await Promise.resolve();
    emitDiagnostic({ event: "job.started", message: "previous queued" });
    const stopping = stopDiagnosticWriter();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(diagnosticWriterStats()).toMatchObject({
      started: false,
      dropped: 2,
      written: 0,
    });

    const replacement = fakeDb();
    startDiagnosticWriter({ db: replacement.db, runtime: "web" });
    let resolveCapture!: (input: DiagnosticEmitInput | null) => void;
    trackDiagnosticTask(
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    );
    emitDiagnostic({ event: "job.started", message: "replacement queued" });

    try {
      pendingInsert.resolve({ count: 1 });
      await vi.advanceTimersByTimeAsync(0);
      const afterLateInsert = diagnosticWriterStats();
      let flushed = false;
      const flushing = flushDiagnostics().then(() => {
        flushed = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(afterLateInsert).toMatchObject({
        started: true,
        runtime: "web",
        queued: 1,
        written: 0,
        dropped: 0,
        flushes: 0,
      });
      expect(flushed).toBe(true);
      await flushing;
    } finally {
      resolveCapture({ event: "ai.request", message: "replacement capture" });
      await stopDiagnosticWriter();
    }

    expect(previous.createMany).toHaveBeenCalledTimes(1);
    expect(
      replacement.createMany.mock.calls.flatMap(([args]) =>
        args.data.map((row) => row.message),
      ),
    ).toEqual(["replacement queued", "replacement capture"]);
    expect(diagnosticWriterStats()).toMatchObject({
      started: false,
      written: 2,
      dropped: 0,
    });
  });

  it("bounds shutdown, accounts for pending rows, and contains late insert rejection", async () => {
    vi.useFakeTimers();
    const { db, createMany } = fakeDb();
    const pending = deferred();
    createMany.mockImplementationOnce(() => pending.promise);
    enable();
    startDiagnosticWriter({ db, runtime: "worker", batchSize: 1 });
    emitDiagnostic({ event: "job.started", message: "in-flight" });
    await Promise.resolve();
    emitDiagnostic({ event: "job.started", message: "queued" });
    const stopping = stopDiagnosticWriter();
    emitDiagnostic({ event: "job.started", message: "after stop" });
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(diagnosticWriterStats()).toMatchObject({
      started: false,
      queued: 0,
      dropped: 2,
      written: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    const fresh = fakeDb();
    startDiagnosticWriter({ db: fresh.db, runtime: "web" });
    pending.reject(new Error("password=secret"));
    await Promise.resolve();
    await Promise.resolve();
    emitDiagnostic({ event: "job.started", message: "fresh" });
    await flushDiagnostics();
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(fresh.createMany.mock.calls[0]![0].data[0]!.message).toBe("fresh");
    expect(diagnosticWriterStats()).toMatchObject({ written: 1, dropped: 0 });
  });
});

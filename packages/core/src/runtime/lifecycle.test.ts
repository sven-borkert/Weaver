import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeLifecycle, type RuntimeProcessEvent } from "./lifecycle";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(
  overrides: Partial<Parameters<typeof createRuntimeLifecycle>[0]> = {},
) {
  const handlers = new Map<RuntimeProcessEvent, (...args: unknown[]) => void>();
  const closeHealth = vi.fn().mockResolvedValue(undefined);
  const dependencies: Parameters<typeof createRuntimeLifecycle>[0] = {
    on: vi.fn(
      (event: RuntimeProcessEvent, handler: (...args: unknown[]) => void) =>
        handlers.set(event, handler),
    ),
    startHealth: vi.fn().mockResolvedValue({ close: closeHealth }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    exit: vi.fn(),
    logFatal: vi.fn(),
    shutdownTimeoutMs: 1_000,
    ...overrides,
  };
  return {
    lifecycle: createRuntimeLifecycle(dependencies),
    dependencies,
    handlers,
    closeHealth,
  };
}

describe("runtime lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("installs shutdown protection before asynchronous startup", async () => {
    const order: string[] = [];
    const { lifecycle } = setup({
      on: vi.fn((event) => order.push(`handler:${event}`)),
      startHealth: vi.fn(async () => {
        order.push("start:health");
        return { close: () => Promise.resolve() };
      }),
    });

    await lifecycle.run();

    expect(order.slice(0, 4)).toEqual([
      "handler:SIGINT",
      "handler:SIGTERM",
      "handler:uncaughtException",
      "handler:unhandledRejection",
    ]);
    expect(order[4]).toBe("start:health");
  });

  it("routes startup failure through cleanup with sanitized logging", async () => {
    const rejectedValue = { secret: "provider-payload" };
    const { lifecycle, dependencies, closeHealth } = setup({
      start: vi.fn().mockRejectedValue(rejectedValue),
    });

    await lifecycle.run();

    expect(dependencies.stop).toHaveBeenCalledOnce();
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(dependencies.disconnectDb).toHaveBeenCalledOnce();
    expect(dependencies.logFatal).toHaveBeenCalledWith(
      "startup-failure",
      { name: "UnknownError" },
      { name: "UnknownError", message: "[object Object]" },
    );
    expect(dependencies.logFatal).not.toHaveBeenCalledWith(rejectedValue);
    expect(
      JSON.stringify(vi.mocked(dependencies.logFatal).mock.calls),
    ).not.toContain("provider-payload");
    expect(dependencies.exit).toHaveBeenCalledWith(1);
  });

  it("cleans up when signaled during worker startup", async () => {
    const startGate = deferred();
    const { lifecycle, dependencies, handlers, closeHealth } = setup({
      start: vi.fn().mockReturnValue(startGate.promise),
    });

    const running = lifecycle.run();
    await vi.waitFor(() => {
      expect(dependencies.start).toHaveBeenCalledOnce();
    });
    handlers.get("SIGTERM")?.();
    startGate.resolve();
    await running;

    expect(dependencies.stop).toHaveBeenCalledOnce();
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(dependencies.disconnectDb).toHaveBeenCalledOnce();
    expect(dependencies.exit).toHaveBeenCalledWith(0);
  });

  it("exposes readiness to the health server only after workers start", async () => {
    const startGate = deferred();
    let probe: (() => boolean) | undefined;
    const { lifecycle, handlers } = setup({
      startHealth: vi.fn(async (isReady: () => boolean) => {
        probe = isReady;
        return { close: vi.fn().mockResolvedValue(undefined) };
      }),
      start: vi.fn().mockReturnValue(startGate.promise),
    });

    const running = lifecycle.run();
    await vi.waitFor(() => {
      expect(probe).toBeDefined();
    });
    expect(probe!()).toBe(false);

    startGate.resolve();
    await vi.waitFor(() => {
      expect(probe!()).toBe(true);
    });
    handlers.get("SIGTERM")?.();
    await running;
  });

  it("upgrades a pending graceful shutdown when a fatal event arrives", async () => {
    const stopGate = deferred();
    const { lifecycle, dependencies, handlers } = setup({
      stop: vi.fn().mockReturnValue(stopGate.promise),
    });
    await lifecycle.run();

    handlers.get("SIGINT")?.();
    handlers.get("unhandledRejection")?.({ secret: "source-content" });
    stopGate.resolve();
    await vi.waitFor(() => {
      expect(dependencies.exit).toHaveBeenCalledOnce();
    });

    expect(dependencies.stop).toHaveBeenCalledOnce();
    expect(dependencies.disconnectDb).toHaveBeenCalledOnce();
    expect(dependencies.exit).toHaveBeenCalledWith(1);
    expect(dependencies.logFatal).toHaveBeenCalledWith(
      "unhandled-rejection",
      { name: "UnknownError" },
      { name: "UnknownError", message: "[object Object]" },
    );
    expect(
      JSON.stringify(vi.mocked(dependencies.logFatal).mock.calls),
    ).not.toContain("source-content");
  });

  it("keeps the database connected until the worker drain completes", async () => {
    const stopGate = deferred();
    const { lifecycle, dependencies, handlers, closeHealth } = setup({
      stop: vi.fn().mockReturnValue(stopGate.promise),
    });
    await lifecycle.run();

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(dependencies.stop).toHaveBeenCalledOnce();
      expect(closeHealth).toHaveBeenCalledOnce();
    });
    expect(dependencies.disconnectDb).not.toHaveBeenCalled();

    stopGate.resolve();
    await vi.waitFor(() => {
      expect(dependencies.disconnectDb).toHaveBeenCalledOnce();
    });
  });

  it("exits 1 and logs a sanitized shutdown failure when stop rejects", async () => {
    const { lifecycle, dependencies, handlers, closeHealth } = setup({
      stop: vi.fn().mockRejectedValue({ secret: "drain-payload" }),
    });
    await lifecycle.run();

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(dependencies.exit).toHaveBeenCalledOnce();
    });

    expect(closeHealth).toHaveBeenCalledOnce();
    expect(dependencies.disconnectDb).toHaveBeenCalledOnce();
    expect(dependencies.logFatal).toHaveBeenCalledExactlyOnceWith(
      "shutdown-failure",
      { name: "UnknownError" },
      { name: "UnknownError", message: "[object Object]" },
    );
    expect(
      JSON.stringify(vi.mocked(dependencies.logFatal).mock.calls),
    ).not.toContain("drain-payload");
    expect(dependencies.exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 and logs a shutdown failure when the database disconnect rejects", async () => {
    const error = Object.assign(new Error("disconnect failed"), {
      code: "ECONNRESET",
    });
    const { lifecycle, dependencies, handlers, closeHealth } = setup({
      disconnectDb: vi.fn().mockRejectedValue(error),
    });
    await lifecycle.run();

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(dependencies.exit).toHaveBeenCalledOnce();
    });

    expect(dependencies.stop).toHaveBeenCalledOnce();
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(dependencies.logFatal).toHaveBeenCalledExactlyOnceWith(
      "shutdown-failure",
      { name: "Error", code: "ECONNRESET" },
      expect.objectContaining({ name: "Error", code: "ECONNRESET" }),
    );
    expect(dependencies.exit).toHaveBeenCalledWith(1);
  });

  it("reports the stop failure first when several cleanup steps reject", async () => {
    const { lifecycle, dependencies, handlers } = setup({
      stop: vi.fn().mockRejectedValue(new TypeError("stop failed")),
      disconnectDb: vi.fn().mockRejectedValue(new RangeError("disconnect")),
    });
    await lifecycle.run();

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(dependencies.exit).toHaveBeenCalledOnce();
    });

    expect(dependencies.logFatal).toHaveBeenCalledExactlyOnceWith(
      "shutdown-failure",
      { name: "TypeError" },
      expect.objectContaining({ name: "TypeError" }),
    );
  });

  it("exits 0 without a fatal log after a clean shutdown", async () => {
    const { lifecycle, dependencies, handlers, closeHealth } = setup();
    await lifecycle.run();

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(dependencies.exit).toHaveBeenCalledOnce();
    });

    expect(dependencies.stop).toHaveBeenCalledOnce();
    expect(closeHealth).toHaveBeenCalledOnce();
    expect(dependencies.disconnectDb).toHaveBeenCalledOnce();
    expect(dependencies.logFatal).not.toHaveBeenCalled();
    expect(dependencies.exit).toHaveBeenCalledWith(0);
  });

  it("forces a failed exit when shutdown outlives its deadline", async () => {
    vi.useFakeTimers();
    const { lifecycle, dependencies, handlers } = setup({
      start: vi.fn().mockReturnValue(new Promise<void>(() => undefined)),
    });

    void lifecycle.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.start).toHaveBeenCalledOnce();
    handlers.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(dependencies.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(dependencies.logFatal).toHaveBeenCalledWith("shutdown-timeout");
    expect(dependencies.exit).toHaveBeenCalledOnce();
    expect(dependencies.exit).toHaveBeenCalledWith(1);
  });

  it("disarms the shutdown watchdog once cleanup completes", async () => {
    vi.useFakeTimers();
    const { lifecycle, dependencies, handlers } = setup();
    await lifecycle.run();

    handlers.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(dependencies.exit).toHaveBeenCalledOnce();
    expect(dependencies.logFatal).not.toHaveBeenCalled();
  });
});

it("keeps the fatal cause closed and hands out only a bounded error summary", async () => {
  const error = Object.assign(new Error("Bearer provider-secret-value"), {
    code: "EADDRINUSE",
  });
  const { lifecycle, dependencies } = setup({
    start: vi.fn().mockRejectedValue(error),
  });
  await lifecycle.run();
  expect(dependencies.logFatal).toHaveBeenCalledWith(
    "startup-failure",
    { name: "Error", code: "EADDRINUSE" },
    expect.objectContaining({
      name: "Error",
      code: "EADDRINUSE",
      // summarizeError is the redaction boundary for the summary argument.
      message: "[redacted]",
    }),
  );
});

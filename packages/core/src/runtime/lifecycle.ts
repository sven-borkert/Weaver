import { summarizeError, type ErrorSummary } from "../diagnostics/errorSummary";
export type RuntimeProcessEvent =
  "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection";

type RuntimeFatalEvent =
  | "startup-failure"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "shutdown-timeout"
  | "shutdown-failure";

type RuntimeHealth = { close: () => Promise<void> };

export type RuntimeLifecycleDependencies = {
  on: (
    event: RuntimeProcessEvent,
    handler: (...args: unknown[]) => void,
  ) => void;
  startHealth: (isReady: () => boolean) => Promise<RuntimeHealth>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  disconnectDb: () => Promise<void>;
  exit: (code: 0 | 1) => void;
  logFatal: (
    event: RuntimeFatalEvent,
    cause?: { name: string; code?: string },
    error?: ErrorSummary,
  ) => void;
  shutdownTimeoutMs: number;
};

export function createRuntimeLifecycle(
  dependencies: RuntimeLifecycleDependencies,
) {
  let handlersInstalled = false;
  let health: RuntimeHealth | null = null;
  let ready = false;
  let startupPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let exitCode: 0 | 1 = 0;
  let exited = false;

  function exitOnce() {
    if (exited) return;
    exited = true;
    dependencies.exit(exitCode);
  }

  function logFatalCause(event: RuntimeFatalEvent, error: unknown) {
    const name =
      error instanceof Error &&
      [
        "Error",
        "TypeError",
        "RangeError",
        "SyntaxError",
        "AggregateError",
        "CoreError",
        "EncryptionKeyUnavailableError",
        "PrismaClientKnownRequestError",
        "PrismaClientInitializationError",
        "ZodError",
      ].includes(error.name)
        ? error.name
        : "UnknownError";
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^(?:E[A-Z0-9_]{2,40}|P[0-9]{4}|BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|PRECONDITION_FAILED|INTERNAL_SERVER_ERROR)$/.test(
        error.code,
      )
        ? error.code
        : undefined;
    dependencies.logFatal(
      event,
      { name, ...(code ? { code } : {}) },
      summarizeError(error),
    );
  }

  function installHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;
    dependencies.on("SIGINT", () => void shutdown(0));
    dependencies.on("SIGTERM", () => void shutdown(0));
    dependencies.on(
      "uncaughtException",
      (error) => void shutdown(1, "uncaught-exception", error),
    );
    dependencies.on(
      "unhandledRejection",
      (error) => void shutdown(1, "unhandled-rejection", error),
    );
  }

  function shutdown(
    requestedExitCode: 0 | 1,
    fatalEvent?: RuntimeFatalEvent,
    error?: unknown,
  ): Promise<void> {
    if (requestedExitCode === 1) exitCode = 1;
    if (fatalEvent) logFatalCause(fatalEvent, error);
    if (shutdownPromise) return shutdownPromise;

    // A hung startup or drain must not keep the process alive until SIGKILL.
    const watchdog = setTimeout(() => {
      exitCode = 1;
      dependencies.logFatal("shutdown-timeout");
      exitOnce();
    }, dependencies.shutdownTimeoutMs);

    const cleanup = (async () => {
      ready = false;
      if (startupPromise) await startupPromise.catch(() => undefined);
      const results: PromiseSettledResult<void>[] = await Promise.allSettled([
        dependencies.stop(),
        health?.close() ?? Promise.resolve(),
      ]);
      try {
        await dependencies.disconnectDb();
        results.push({ status: "fulfilled", value: undefined });
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        exitCode = 1;
        logFatalCause("shutdown-failure", failed.reason);
      }
    })();
    const sharedShutdown = cleanup.finally(() => {
      clearTimeout(watchdog);
      exitOnce();
    });
    shutdownPromise = sharedShutdown;
    return sharedShutdown;
  }

  async function run(): Promise<void> {
    installHandlers();
    const startup = (async () => {
      health = await dependencies.startHealth(() => ready);
      if (shutdownPromise) return;
      await dependencies.start();
      ready = true;
    })();
    startupPromise = startup;
    try {
      await startup;
    } catch (error) {
      await shutdown(1, "startup-failure", error);
      return;
    }
    if (shutdownPromise) await shutdownPromise;
  }

  return { run, shutdown };
}

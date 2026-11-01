import { randomUUID } from "node:crypto";
import type {
  DiagnosticSeverity,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import {
  getDiagnosticsSettings,
  peekDiagnosticsSettings,
  supersedeDiagnosticsSettingsRefresh,
} from "@weaver/core/services/diagnosticsSettings";
import {
  currentDiagnosticContext,
  mergeDiagnosticContexts,
  providerBodiesSuppressed,
  type DiagnosticContext,
} from "./context";
import {
  DIAGNOSTIC_CATEGORY_OF,
  type DiagnosticEventName,
  type DiagnosticOutcome,
} from "./events";
import {
  MAX_MESSAGE_CHARS,
  sanitizeBody,
  sanitizeDetails,
  sanitizeText,
} from "./sanitize";
import type { DiagnosticLevel } from "./settings";
import { summarizeError } from "./errorSummary";
import { diagnosticReference } from "./reference";
import { processSingleton } from "./processState";

export type DiagnosticRuntimeName = "web" | "worker" | "mcp";
export type DiagnosticEmitInput = DiagnosticContext & {
  id?: string;
  event: DiagnosticEventName;
  message: string;
  severity?: DiagnosticSeverity;
  verbose?: boolean;
  details?: unknown;
  durationMs?: number | null;
  statusCode?: number | null;
  outcome?: DiagnosticOutcome | null;
  requestBody?: string | null;
  responseBody?: string | null;
};

export type DiagnosticWriterStats = {
  started: boolean;
  runtime: DiagnosticRuntimeName | null;
  queued: number;
  written: number;
  dropped: number;
  flushes: number;
  lastError: string | null;
};

type Row = Prisma.DiagnosticEventCreateManyInput;
type WriterState = {
  db: PrismaClient;
  runtime: DiagnosticRuntimeName;
  now: () => Date;
  batchSize: number;
  maxQueue: number;
  queue: Row[];
  pendingTasks: Set<Promise<void>>;
  taskCancellations: Map<Promise<void>, () => void>;
  inFlight: number;
  timer: ReturnType<typeof setInterval> | null;
  ready: Promise<void>;
  cancelReady: () => void;
  flushing: Promise<void> | null;
  stopping: Promise<void> | null;
  closed: boolean;
  stats: DiagnosticWriterStats;
  lastErrorLoggedAt: number;
  lastReportAt: number;
  reporting: Promise<void> | null;
};

const CONSOLE_ERROR_INTERVAL_MS = 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const INITIAL_SETTINGS_WAIT_MS = DEFAULT_FLUSH_INTERVAL_MS;
const STOP_TIMEOUT_MS = 5_000;
const shared = processSingleton<{
  state: WriterState | null;
  lastStats: DiagnosticWriterStats;
}>("writer", () => ({
  state: null,
  lastStats: {
    started: false,
    runtime: null,
    queued: 0,
    written: 0,
    dropped: 0,
    flushes: 0,
    lastError: null,
  },
}));

export function startDiagnosticWriter(options: {
  db: PrismaClient;
  runtime: DiagnosticRuntimeName;
  flushIntervalMs?: number;
  batchSize?: number;
  maxQueue?: number;
  now?: () => Date;
}): void {
  if (shared.state) return;
  const readiness = boundedSettingsRead(options.db);
  const current: WriterState = {
    db: options.db,
    runtime: options.runtime,
    now: options.now ?? (() => new Date()),
    batchSize: options.batchSize ?? 100,
    maxQueue: options.maxQueue ?? 5_000,
    queue: [],
    pendingTasks: new Set(),
    taskCancellations: new Map(),
    inFlight: 0,
    timer: null,
    ready: readiness.promise,
    cancelReady: readiness.cancel,
    flushing: null,
    stopping: null,
    closed: false,
    stats: {
      started: true,
      runtime: options.runtime,
      queued: 0,
      written: 0,
      dropped: 0,
      flushes: 0,
      lastError: null,
    },
    lastErrorLoggedAt: -Infinity,
    lastReportAt: 0,
    reporting: null,
  };
  shared.state = current;
  current.timer = setInterval(() => {
    const settings = peekDiagnosticsSettings();
    if (!settings || settings.stale) void refreshSettings(current.db);
    void flushDiagnostics();
    if (Date.now() - current.lastReportAt >= 15_000)
      void reportWriterStats(current);
  }, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  current.timer.unref?.();
}

function reportWriterStats(
  current: WriterState,
  stopped = false,
): Promise<void> {
  if (current.reporting && !stopped) return current.reporting;
  current.lastReportAt = Date.now();
  const key = `diagnostics.writer.${current.runtime}`;
  const value = {
    ...current.stats,
    queued: current.queue.length,
    started: !stopped,
    reportedAt: new Date().toISOString(),
  };
  const report = Promise.resolve()
    .then(async () => {
      await current.db.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    })
    .catch(() => undefined)
    .finally(() => {
      if (current.reporting === report) current.reporting = null;
    });
  current.reporting = report;
  return report;
}

function refreshSettings(db: PrismaClient): Promise<void> {
  return Promise.resolve()
    .then(() => getDiagnosticsSettings(db))
    .then(() => undefined)
    .catch(() => undefined);
}

function boundedSettingsRead(db: PrismaClient): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve();
  };
  void refreshSettings(db).then(settle, settle);
  const timeout = setTimeout(settle, INITIAL_SETTINGS_WAIT_MS);
  timeout.unref?.();
  return { promise, cancel: settle };
}

/** Resolves after the active writer's failure-isolated initial settings read. */
export function waitForDiagnosticWriterReady(): Promise<void> {
  return shared.state?.ready ?? Promise.resolve();
}

function pickString(value: unknown, maximum = 64): string | null {
  return typeof value === "string" && value !== ""
    ? sanitizeText(value, maximum)
    : null;
}

function pickUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null;
}

function levelAccepts(
  level: DiagnosticLevel,
  severity: DiagnosticSeverity,
  verbose: boolean,
): boolean {
  if (level === "off") return false;
  if (verbose && level !== "verbose") return false;
  if (level === "errors" && severity !== "error" && severity !== "warn")
    return false;
  return true;
}

function emitDiagnosticInto(
  current: WriterState,
  input: DiagnosticEmitInput,
): string | null {
  try {
    const peeked = peekDiagnosticsSettings();
    if (!peeked || peeked.stale) void refreshSettings(current.db);
    const level = peeked?.value.level ?? "off";
    const severity = input.severity ?? "info";
    if (!levelAccepts(level, severity, input.verbose === true)) return null;
    if (typeof input.message !== "string") {
      current.stats.dropped += 1;
      return null;
    }
    const context = mergeDiagnosticContexts(currentDiagnosticContext(), input);
    const captureBodies =
      level === "verbose" && !providerBodiesSuppressed(context);
    const requestBody = captureBodies ? sanitizeBody(input.requestBody) : null;
    const responseBody = captureBodies
      ? sanitizeBody(input.responseBody)
      : null;
    const id = pickUuid(input.id) ?? randomUUID();
    const row: Row = {
      id,
      createdAt: current.now(),
      runtime: current.runtime,
      severity,
      verbose:
        input.verbose === true || requestBody !== null || responseBody !== null,
      category: DIAGNOSTIC_CATEGORY_OF[input.event],
      event: input.event,
      message: sanitizeText(input.message, MAX_MESSAGE_CHARS),
      requestId: pickString(context.requestId),
      jobId: pickString(context.jobId),
      runId: pickUuid(context.runId),
      userId: pickUuid(context.userId),
      credentialId: pickString(context.credentialId, 200),
      projectId: pickUuid(context.projectId),
      generationId: pickUuid(context.generationId),
      documentId: pickUuid(context.documentId),
      connectionId: pickUuid(context.connectionId),
      durationMs: input.durationMs ?? null,
      statusCode: input.statusCode ?? null,
      outcome: input.outcome ?? null,
      details: sanitizeDetails(input.details),
      hasRequestBody: requestBody !== null,
      hasResponseBody: responseBody !== null,
      bodyProjectIds: context.bodyProjectIds
        ? [...context.bodyProjectIds]
        : undefined,
      requestBody,
      responseBody,
    };
    current.queue.push(row);
    while (current.queue.length > current.maxQueue) {
      current.queue.shift();
      current.stats.dropped += 1;
    }
    if (current.queue.length >= current.batchSize) void flushDiagnostics();
    return id;
  } catch {
    current.stats.dropped += 1;
    return null;
  }
}

export function emitDiagnostic(input: DiagnosticEmitInput): string | null {
  const current = shared.state;
  if (!current || current.stopping || current.closed) return null;
  return emitDiagnosticInto(current, input);
}

/**
 * Hands out an event id before a transaction so a stored failure summary can
 * carry its reference and the after-commit event can reuse the same id.
 */
export function reserveDiagnosticEvent(
  severity: DiagnosticSeverity = "error",
): { id: string; reference: string } | null {
  const current = shared.state;
  if (!current || current.stopping || current.closed) return null;
  const level = peekDiagnosticsSettings()?.value.level ?? "off";
  if (!levelAccepts(level, severity, false)) return null;
  const id = randomUUID();
  const reference = diagnosticReference(id);
  return reference ? { id, reference } : null;
}

export type CaptureErrorInput = Omit<DiagnosticEmitInput, "details"> & {
  error: unknown;
  details?: Record<string, unknown>;
};

/** Emits one failure event with `details.error` and returns its reference; never throws. */
export function captureError(input: CaptureErrorInput): string | null {
  try {
    const { error, details, ...rest } = input;
    return diagnosticReference(
      emitDiagnostic({
        ...rest,
        severity: rest.severity ?? "error",
        outcome: rest.outcome ?? "error",
        details: { ...(details ?? {}), error: summarizeError(error) },
      }),
    );
  } catch {
    return null;
  }
}

export function trackDiagnosticTask(
  task: Promise<DiagnosticEmitInput | null>,
  cancel?: () => void,
): void {
  const current = shared.state;
  if (!current || current.stopping || current.closed) {
    try {
      cancel?.();
    } catch {
      /* Capture cleanup is failure-isolated. */
    }
    void task.catch(() => undefined);
    return;
  }
  const tracked = task
    .then((input) => {
      if (input && shared.state === current && !current.closed) {
        emitDiagnosticInto(current, input);
      }
    })
    .catch(() => undefined);
  current.pendingTasks.add(tracked);
  if (cancel) current.taskCancellations.set(tracked, cancel);
  void tracked.then(() => {
    current.pendingTasks.delete(tracked);
    current.taskCancellations.delete(tracked);
  });
}

function recordInsertError(current: WriterState, error: unknown): void {
  let name = "unknown";
  try {
    if (error instanceof Error)
      name =
        typeof error.name === "string" &&
        /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(error.name)
          ? error.name
          : "Error";
  } catch {
    /* Hostile errors must not break the drain. */
  }
  current.stats.lastError = name;
  const now = Date.now();
  if (now - current.lastErrorLoggedAt >= CONSOLE_ERROR_INTERVAL_MS) {
    current.lastErrorLoggedAt = now;
    try {
      console.error(`diagnostic writer insert failed: ${name}`);
    } catch {
      /* Logging is best effort. */
    }
  }
}

export function flushDiagnostics(drainPending = false): Promise<void> {
  const current = shared.state;
  if (!current || current.closed) return Promise.resolve();
  if (current.flushing) {
    return drainPending
      ? current.flushing.then(() => {
          if (shared.state === current && !current.closed)
            return flushDiagnostics(true);
        })
      : current.flushing;
  }
  if (
    current.queue.length === 0 &&
    (!drainPending || current.pendingTasks.size === 0)
  )
    return Promise.resolve();
  current.flushing = Promise.resolve().then(async () => {
    try {
      while (!current.closed) {
        if (current.queue.length > 0) {
          const batch = current.queue.splice(0, current.batchSize);
          current.inFlight = batch.length;
          try {
            await current.db.diagnosticEvent.createMany({ data: batch });
            if (!current.closed) {
              current.stats.written += batch.length;
              current.stats.flushes += 1;
            }
          } catch (error) {
            if (!current.closed) {
              current.stats.dropped += batch.length;
              recordInsertError(current, error);
            }
          } finally {
            current.inFlight = 0;
          }
          continue;
        }
        if (!drainPending || current.pendingTasks.size === 0) break;
        await Promise.all([...current.pendingTasks]);
      }
    } finally {
      current.flushing = null;
    }
  });
  return current.flushing;
}

export function stopDiagnosticWriter(): Promise<void> {
  const current = shared.state;
  if (!current) return Promise.resolve();
  if (current.stopping) return current.stopping;
  current.cancelReady();
  for (const cancel of current.taskCancellations.values()) {
    try {
      cancel();
    } catch {
      /* Capture cleanup is failure-isolated. */
    }
  }
  current.taskCancellations.clear();
  if (current.timer) clearInterval(current.timer);
  const drain = flushDiagnostics(true);
  current.stopping = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drain.then(() => reportWriterStats(current, true)),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, STOP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      current.closed = true;
      // An outstanding insert has an unknown outcome after the drain deadline.
      current.stats.dropped += current.queue.length + current.inFlight;
      current.queue.length = 0;
      shared.lastStats = {
        ...current.stats,
        started: false,
        runtime: null,
        queued: 0,
      };
      supersedeDiagnosticsSettingsRefresh();
      shared.state = null;
    }
  })();
  return current.stopping;
}

export function diagnosticWriterStats(): DiagnosticWriterStats {
  const current = shared.state;
  return current
    ? { ...current.stats, queued: current.queue.length }
    : { ...shared.lastStats };
}

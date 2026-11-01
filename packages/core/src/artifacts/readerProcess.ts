/** Every artifact reader runs here, in a short-lived child process: the byte
 *  bounds inside @weaver/artifact-readers bound bytes read, not the heap a
 *  parsed document takes, so an in-process read could take the whole worker
 *  down with it. */
import { fork } from "node:child_process";
import type { ArtifactReadErrorCode } from "@weaver/artifact-readers/errors";
import { monitorProcessMemory } from "../process/memoryMonitor";
import {
  isArtifactReadErrorCode,
  isReaderOperation,
  MAX_READER_RESULT_BYTES,
  READER_OPERATIONS,
  type ReaderOperation,
} from "./readerOperations";

export type ReaderRequest = {
  dataDir: string;
  projectId: string;
  contentDigest: string;
  maxBytes: number;
  operation: ReaderOperation;
  input: unknown;
};

/** Why the reader never produced an answer. `timeout`/`memory` are the file's
 *  fault; `crashed`/`not_started` are the server's. `memory` covers both the
 *  RSS watchdog and a child that aborted itself (V8's heap-limit fatal ends in
 *  SIGABRT); `crashed` keeps every other signal death. */
export type ReaderUnavailableCause =
  "timeout" | "memory" | "crashed" | "not_started";

export type ReaderFailure =
  | { code: ArtifactReadErrorCode; message: string }
  | { code: "busy"; message: string }
  | {
      code: "unavailable";
      cause: ReaderUnavailableCause;
      message: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    };

export type ReaderResult =
  { ok: true; value: unknown } | { ok: false; failure: ReaderFailure };

const MAX_CONCURRENT_READERS = 2;
const MAX_WAITING_READS = 8;
const MAX_HEAP_MB = 512;
const MAX_RESIDENT_BYTES = 1024 * 1024 * 1024;
const MAX_FAILURE_MESSAGE_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 120_000;

/** One fixed message per cause: a caller learns what happened, never how. */
const UNAVAILABLE_MESSAGE: Record<ReaderUnavailableCause, string> = {
  timeout: "reading the file took too long",
  memory: "reading the file needed too much memory",
  crashed: "reading the file failed",
  not_started: "the file reader could not be started",
};
const TOO_BUSY = "too many file reads are in progress; try again";

const unavailable = (
  cause: ReaderUnavailableCause,
  exit?: { exitCode: number | null; signal: NodeJS.Signals | null },
): ReaderResult => ({
  ok: false,
  failure: {
    code: "unavailable",
    cause,
    message: UNAVAILABLE_MESSAGE[cause],
    ...(exit ?? {}),
  },
});

/** Queue saturation is a distinct, caller-actionable code: unlike every
 *  other "unavailable" case, a caller can usefully retry immediately. */
const busy = (): ReaderResult => ({
  ok: false,
  failure: { code: "busy", message: TOO_BUSY },
});

/** @internal The child is the process that parses hostile files, so nothing it
 *  sends back is trusted. `null` means "not a result message". */
export function parseChildMessage(raw: unknown): ReaderResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const message = raw as {
    kind?: unknown;
    ok?: unknown;
    json?: unknown;
    failure?: unknown;
  };
  if (message.kind !== "result") return null;
  if (message.ok === true) {
    // Bytes, not code units: the cap is only checked once the whole message
    // has been received, so an honest child enforces it before sending.
    if (
      typeof message.json !== "string" ||
      Buffer.byteLength(message.json) > MAX_READER_RESULT_BYTES
    )
      return unavailable("crashed");
    try {
      return { ok: true, value: JSON.parse(message.json) as unknown };
    } catch {
      return unavailable("crashed");
    }
  }
  if (typeof message.failure !== "object" || message.failure === null)
    return unavailable("crashed");
  const { code, message: text } = message.failure as {
    code?: unknown;
    message?: unknown;
  };
  if (
    typeof code !== "string" ||
    !isArtifactReadErrorCode(code) ||
    typeof text !== "string"
  )
    return unavailable("crashed");
  return {
    ok: false,
    failure: { code, message: text.slice(0, MAX_FAILURE_MESSAGE_CHARS) },
  };
}

type SlotOutcome = "granted" | "timeout" | "busy";

let active = 0;
const waiting: Array<() => void> = [];

/** @internal Test hook: reader children currently holding a slot. */
export function activeReaderCount(): number {
  return active;
}

/** The deadline covers the wait, so a queued read cannot sit behind a 120 s
 *  PDF and only then start its own clock. */
function acquireSlot(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SlotOutcome> {
  if (active < MAX_CONCURRENT_READERS) {
    active += 1;
    return Promise.resolve("granted");
  }
  if (waiting.length >= MAX_WAITING_READS) return Promise.resolve("busy");
  return new Promise<SlotOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      leave();
      resolve("timeout");
    }, timeoutMs);
    const stopWaiting = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const grant = () => {
      stopWaiting();
      active += 1;
      resolve("granted");
    };
    const leave = () => {
      const index = waiting.indexOf(grant);
      if (index >= 0) waiting.splice(index, 1);
      stopWaiting();
    };
    function onAbort() {
      leave();
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(grant);
  });
}

function releaseSlot(): void {
  active -= 1;
  waiting.shift()?.();
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Artifact read cancelled", "AbortError");
}

function spawnReader(
  request: ReaderRequest,
  timeoutMs: number,
  options: { signal?: AbortSignal },
): Promise<ReaderResult> {
  return new Promise<ReaderResult>((resolve, reject) => {
    const child = fork(new URL("./readerChild.ts", import.meta.url), [], {
      execArgv: [
        `--max-old-space-size=${MAX_HEAP_MB}`,
        "--import",
        import.meta.resolve("tsx"),
      ],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: process.env.NODE_ENV,
        TZ: "UTC",
      },
    });
    let outcome: ReaderResult | undefined;
    let cancelled = false;
    let startFailed = false;
    const deadline = setTimeout(() => {
      outcome ??= unavailable("timeout");
      child.kill("SIGKILL");
    }, timeoutMs);
    const stopMemory = monitorProcessMemory(child, MAX_RESIDENT_BYTES, () => {
      outcome ??= unavailable("memory");
      child.kill("SIGKILL");
    });
    const abort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("message", (raw: unknown) => {
      if (outcome) return;
      const parsed = parseChildMessage(raw);
      if (!parsed) return;
      outcome = parsed;
      child.kill("SIGKILL");
    });
    child.on("error", () => {
      startFailed = true;
      child.kill("SIGKILL");
    });
    // The exit status is only known here, so an operational failure is built
    // at close rather than when it was detected.
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadline);
      stopMemory();
      options.signal?.removeEventListener("abort", abort);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      if (cancelled || options.signal?.aborted)
        reject(abortError(options.signal));
      else
        resolve(
          outcome ??
            unavailable(
              startFailed
                ? "not_started"
                : exitCode === null && signal === "SIGABRT"
                  ? "memory"
                  : "crashed",
              { exitCode, signal },
            ),
        );
    });
    if (child.connected)
      child.send({ kind: "read", request }, (error) => {
        if (error) child.kill("SIGKILL");
      });
    if (options.signal?.aborted) abort();
  });
}

export async function runArtifactReader(
  request: ReaderRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReaderResult> {
  if (!isReaderOperation(request.operation))
    throw new Error("unknown reader operation");
  options.signal?.throwIfAborted();
  const timeoutMs =
    options.timeoutMs ??
    (READER_OPERATIONS[request.operation].some((format) => format === "pdf")
      ? PDF_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  // A deadline spent waiting for a slot says the server is busy, not that the
  // file took too long: the child never ran, and retrying may well work.
  const slot = await acquireSlot(options.signal, timeoutMs);
  if (slot !== "granted") return busy();
  try {
    options.signal?.throwIfAborted();
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return busy();
    return await spawnReader(request, remaining, options);
  } finally {
    releaseSlot();
  }
}

import { currentDiagnosticContext, providerBodiesSuppressed } from "./context";
import { redactSecrets } from "../security/redactSecrets";
import { peekDiagnosticsSettings } from "@weaver/core/services/diagnosticsSettings";
import { MAX_BODY_CHARS, parseProviderBody } from "./sanitize";
import { summarizeError } from "./errorSummary";
import { trackDiagnosticTask, type DiagnosticEmitInput } from "./writer";

export type DiagnosticFetchMeta = {
  connectionId?: string;
  providerType?: string;
  requestTimeoutMs?: number;
};

const MAX_CAPTURE_CHARS = MAX_BODY_CHARS * 2;
const REQUEST_CAPTURE_TIMEOUT_MS = 25;
const RESPONSE_CAPTURE_TIMEOUT_MS = 120_000;

type CapturedBody = {
  text: string | null;
  bytes: number | null;
  complete: boolean | null;
};

type CappedRead = {
  text: string;
  complete: boolean;
  bytes: number;
};

type ResponseInspection = {
  ok: boolean | null;
  status: number | null;
};

const UNAVAILABLE_BODY: CapturedBody = {
  text: null,
  bytes: null,
  complete: null,
};

function scrubCapturedText(text: string, secrets: readonly string[]): string {
  const scrub = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return "[depth]";
    if (typeof value === "string") return redactSecrets(value, secrets);
    if (Array.isArray(value))
      return value.map((item) => scrub(item, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redactSecrets(key, secrets),
          scrub(item, depth + 1),
        ]),
      );
    return value;
  };
  try {
    return JSON.stringify(scrub(parseProviderBody(text)));
  } catch {
    return redactSecrets(text, secrets);
  }
}

function hrefOf(input: string | URL | Request): string {
  try {
    return typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  } catch {
    return "";
  }
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  try {
    return (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
  } catch {
    return "GET";
  }
}

function modelOf(body: string | null): string | null {
  if (!body || body.length > 262_144) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { model?: unknown }).model === "string"
      ? (parsed as { model: string }).model
      : null;
  } catch {
    return null;
  }
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const capped = text.slice(0, maxChars);
  const finalCode = capped.charCodeAt(capped.length - 1);
  return finalCode >= 0xd800 && finalCode <= 0xdbff
    ? capped.slice(0, -1)
    : capped;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Diagnostic capture is best effort.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A pending read may retain the lock until cancellation resolves.
  }
}

async function readCappedResult(
  response: Response,
  maxChars: number,
  onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
  onProgress?: (value: CappedRead) => void,
): Promise<CappedRead> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", complete: true, bytes: 0 };
  onReader?.(reader);
  if (maxChars <= 0) {
    cancelReader(reader);
    releaseReader(reader);
    return { text: "", complete: false, bytes: 0 };
  }

  const decoder = new TextDecoder();
  let text = "";
  let complete = false;
  let bytes = 0;
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) {
        text = capText(`${text}${decoder.decode()}`, maxChars);
        complete = true;
        break;
      }
      bytes += value.byteLength;
      const decoded = `${text}${decoder.decode(value, { stream: true })}`;
      text = capText(decoded, maxChars);
      onProgress?.({ text, complete: false, bytes });
      if (decoded.length > maxChars) break;
    }
  } finally {
    cancelReader(reader);
    releaseReader(reader);
  }
  return { text, complete, bytes };
}

/** Reads at most `maxChars` characters from a response body, then cancels the stream. */
export async function readCapped(
  response: Response,
  maxChars: number,
): Promise<string> {
  return (await readCappedResult(response, maxChars)).text;
}

function fromText(text: string): CapturedBody {
  return {
    text: capText(text, MAX_CAPTURE_CHARS),
    bytes: Buffer.byteLength(text, "utf8"),
    complete: text.length <= MAX_CAPTURE_CHARS,
  };
}

function fromBytes(bytes: Uint8Array): CapturedBody {
  try {
    const complete = bytes.byteLength <= MAX_CAPTURE_CHARS;
    return {
      text: new TextDecoder().decode(bytes.subarray(0, MAX_CAPTURE_CHARS)),
      bytes: bytes.byteLength,
      complete,
    };
  } catch {
    return {
      text: null,
      bytes: bytes.byteLength,
      complete: bytes.byteLength <= MAX_CAPTURE_CHARS,
    };
  }
}

function initBody(input?: RequestInit): CapturedBody | undefined {
  if (input?.body === undefined || input.body === null) return undefined;
  const body = input.body;
  if (typeof body === "string") return fromText(body);
  if (body instanceof URLSearchParams) return fromText(body.toString());
  if (body instanceof ArrayBuffer) return fromBytes(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return fromBytes(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  return UNAVAILABLE_BODY;
}

function captureCappedBody(
  response: Response,
  maxChars: number,
  timeoutMs = REQUEST_CAPTURE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CapturedBody> {
  let partial: CappedRead = { text: "", complete: false, bytes: 0 };
  let abortCapture: (() => void) | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const finish = (
    resolve: (value: CapturedBody) => void,
    value: CapturedBody,
  ) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (abortCapture) signal?.removeEventListener("abort", abortCapture);
    resolve(value);
  };

  return new Promise((resolve) => {
    const read = readCappedResult(
      response,
      maxChars,
      (value) => {
        reader = value;
      },
      (value) => {
        partial = value;
      },
    );
    abortCapture = () => {
      if (reader) cancelReader(reader);
      finish(resolve, {
        text: partial.text || null,
        bytes: null,
        complete: false,
      });
    };
    timer = setTimeout(abortCapture, timeoutMs);
    signal?.addEventListener("abort", abortCapture, { once: true });
    if (signal?.aborted) abortCapture();
    timer.unref?.();
    void read.then(
      ({ text, complete, bytes }) =>
        finish(resolve, {
          text,
          bytes: complete ? bytes : null,
          complete,
        }),
      () => finish(resolve, UNAVAILABLE_BODY),
    );
  });
}

function captureRequestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<CapturedBody> {
  const initialized = initBody(init);
  if (initialized) return Promise.resolve(initialized);
  if (!(input instanceof Request)) return Promise.resolve(UNAVAILABLE_BODY);
  try {
    return captureCappedBody(
      input.clone() as unknown as Response,
      MAX_CAPTURE_CHARS,
    );
  } catch {
    return Promise.resolve(UNAVAILABLE_BODY);
  }
}

function captureResponseBody(
  response: Response,
  maxChars: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CapturedBody> {
  try {
    return captureCappedBody(response.clone(), maxChars, timeoutMs, signal);
  } catch {
    return Promise.resolve(UNAVAILABLE_BODY);
  }
}

function contentLengthOf(response: Response): number | null {
  try {
    const value = response.headers.get("content-length");
    if (!value || !/^\d+$/.test(value)) return null;
    const bytes = Number(value);
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function inspectResponse(response: Response): ResponseInspection {
  let ok: boolean | null = null;
  let status: number | null = null;
  try {
    ok = response.ok;
  } catch {
    // Diagnostics must not trust provider response accessors.
  }
  try {
    status = response.status;
  } catch {
    // Diagnostics must not trust provider response accessors.
  }
  return { ok, status };
}

async function recordFetchFailure(
  requestCapture: Promise<CapturedBody>,
  base: Omit<Record<string, unknown>, "model" | "requestBytes">,
  meta: DiagnosticFetchMeta,
  method: string,
  path: string,
  started: number,
  error: unknown,
  suppressBodies: boolean,
): Promise<DiagnosticEmitInput | null> {
  try {
    const request = await requestCapture;
    const name = error instanceof Error ? error.name : "";
    const classification =
      name === "AbortError"
        ? "abort_error"
        : name === "TimeoutError"
          ? "timeout_error"
          : "transport_error";
    // A suppressed provider may put private content in its error; only the
    // closed classification survives.
    const summary = suppressBodies ? null : summarizeError(error);
    const code = summary ? (summary.code ?? summary.cause?.code ?? null) : null;
    return {
      event: "ai.request",
      severity: "error",
      message: `${method} ${path} failed: ${classification}${code ? ` (${code})` : ""}`,
      connectionId: meta.connectionId,
      durationMs: Date.now() - started,
      outcome:
        name === "AbortError"
          ? "cancelled"
          : name === "TimeoutError"
            ? "timeout"
            : "error",
      details: {
        ...base,
        model: request.complete ? modelOf(request.text) : null,
        requestBytes: request.bytes,
        requestBodyComplete: request.complete,
        classification,
        ...(summary ? { error: summary } : {}),
      },
      requestBody: request.text,
    };
  } catch {
    return null;
  }
}

async function recordFetchResponse(
  requestCapture: Promise<CapturedBody>,
  response: Response,
  responseCapture: Promise<CapturedBody>,
  inspection: ResponseInspection,
  verbose: boolean,
  base: Omit<Record<string, unknown>, "model" | "requestBytes">,
  meta: DiagnosticFetchMeta,
  method: string,
  path: string,
  started: number,
): Promise<DiagnosticEmitInput | null> {
  try {
    const request = await requestCapture;
    const capturedResponse = await responseCapture;
    return {
      event: "ai.request",
      severity: inspection.ok === false ? "error" : "info",
      message: `${method} ${path} → ${inspection.status ?? "?"}`,
      connectionId: meta.connectionId,
      statusCode: inspection.status,
      durationMs: Date.now() - started,
      outcome: inspection.ok === null ? null : inspection.ok ? "ok" : "error",
      details: {
        ...base,
        model: request.complete ? modelOf(request.text) : null,
        requestBytes: request.bytes,
        requestBodyComplete: request.complete,
        responseBytes: contentLengthOf(response) ?? capturedResponse.bytes,
        responseBodyComplete: capturedResponse.complete,
        error: inspection.ok === false ? "http_error" : null,
      },
      requestBody: request.text,
      responseBody: verbose ? capturedResponse.text : null,
    };
  } catch {
    return null;
  }
}

/** Wraps a provider fetch so every call becomes one `ai.request` event; never alters the result. */
export function diagnosticFetch(
  fetchImpl: typeof fetch,
  meta: DiagnosticFetchMeta = {},
): typeof fetch {
  return async (input, init) => {
    const suppressBodies = providerBodiesSuppressed(currentDiagnosticContext());
    const level = peekDiagnosticsSettings()?.value.level ?? "off";
    if (level === "off") return fetchImpl(input, init);
    const captureController = new AbortController();
    const fetchSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const captureSignal = fetchSignal
      ? AbortSignal.any([captureController.signal, fetchSignal])
      : captureController.signal;
    const started = Date.now();
    const href = hrefOf(input);
    const method = methodOf(input, init);
    let host = "";
    let path = href;
    try {
      const url = new URL(href);
      host = url.host;
      path = url.pathname;
    } catch {
      path = href.split(/[?#]/, 1)[0] ?? "";
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const knownSecrets = [
      headers.get("authorization")?.replace(/^[^ ]+\s+/, ""),
      headers.get("x-api-key"),
      headers.get("x-goog-api-key"),
    ].filter((value): value is string => Boolean(value));
    const scrubCapture = (body: CapturedBody): CapturedBody => ({
      ...body,
      text:
        body.text === null ? null : scrubCapturedText(body.text, knownSecrets),
    });
    const requestCapture = suppressBodies
      ? Promise.resolve(UNAVAILABLE_BODY)
      : captureRequestBody(input, init).then(scrubCapture);
    path = redactSecrets(path, knownSecrets);
    const base = {
      providerType: meta.providerType ?? null,
      method,
      host: redactSecrets(host, knownSecrets),
      path: redactSecrets(path, knownSecrets),
    };

    try {
      const response = await fetchImpl(input, init);
      const inspection = inspectResponse(response);
      const verbose = level === "verbose" && !suppressBodies;
      const responseCapture = verbose
        ? captureResponseBody(
            response,
            MAX_CAPTURE_CHARS,
            meta.requestTimeoutMs ?? RESPONSE_CAPTURE_TIMEOUT_MS,
            captureSignal,
          ).then(scrubCapture)
        : Promise.resolve(UNAVAILABLE_BODY);
      trackDiagnosticTask(
        recordFetchResponse(
          requestCapture,
          response,
          responseCapture,
          inspection,
          verbose,
          base,
          meta,
          method,
          path,
          started,
        ),
        () => captureController.abort(),
      );
      return response;
    } catch (error) {
      trackDiagnosticTask(
        recordFetchFailure(
          requestCapture,
          base,
          meta,
          method,
          path,
          started,
          error,
          suppressBodies,
        ),
      );
      throw error;
    }
  };
}

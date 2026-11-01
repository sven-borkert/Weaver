type TrpcLoggerOperation = {
  direction: "up" | "down";
  path?: string;
  result?: unknown;
};

type TrpcLoggerEnv = {
  NODE_ENV?: string;
  NEXT_PUBLIC_TRPC_LOGGER?: string;
};

// TRPC error codes that always have user-facing handling (toast / inline
// form error). These shouldn't pollute the dev console — they're not bugs,
// they're expected business outcomes. Bypass with NEXT_PUBLIC_TRPC_LOGGER
// when debugging.
const USER_HANDLED_TRPC_ERROR_CODES = new Set([
  "PARSE_ERROR",
  "PAYMENT_REQUIRED",
  "PRECONDITION_REQUIRED",
  "METHOD_NOT_SUPPORTED",
  "UNPROCESSABLE_CONTENT",
  "UNSUPPORTED_MEDIA_TYPE",
  "CLIENT_CLOSED_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "TIMEOUT",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
]);

export function shouldEnableTrpcLogger(
  op: TrpcLoggerOperation,
  env: TrpcLoggerEnv = process.env,
) {
  if (
    op.path &&
    /^(?:account|user|apiKey|projectApiKey|oidc|llm|llmConnection|externalMcp|externalMcpConnection|projectGitRemote)(?:\.|$)/.test(
      op.path,
    )
  )
    return false;

  if (op.direction === "down" && op.result instanceof Error) {
    if (isTransientTrpcTransportError(op.result)) return false;
    if (
      env.NEXT_PUBLIC_TRPC_LOGGER !== "true" &&
      isUserHandledTrpcError(op.result)
    ) {
      return false;
    }
    return true;
  }

  return env.NEXT_PUBLIC_TRPC_LOGGER === "true";
}

/**
 * Detects TRPCClientError instances whose server-side code is something the
 * UI already handles (CONFLICT / PRECONDITION_FAILED / NOT_FOUND / etc.).
 * Looks at both the top-level error and any nested `data.code` (tRPC's
 * standard envelope) along the cause chain.
 */
export function isUserHandledTrpcError(error: unknown) {
  const chain = errorChain(error);
  for (const item of chain) {
    if (isObject(item)) {
      const data = isObject(item.data) ? item.data : undefined;
      const meta = isObject(item.meta) ? item.meta : undefined;
      const response =
        meta && isObject(meta.response) ? meta.response : undefined;
      const status = data?.httpStatus ?? response?.status;
      if (typeof status === "number" && status >= 400 && status < 500)
        return true;
    }
    const direct = readStringProperty(item, "code");
    if (direct && USER_HANDLED_TRPC_ERROR_CODES.has(direct)) return true;
    if (isObject(item) && "data" in item) {
      const data = (item as { data?: unknown }).data;
      const nested = readStringProperty(data, "code");
      if (nested && USER_HANDLED_TRPC_ERROR_CODES.has(nested)) return true;
    }
  }
  return false;
}

export function isTransientTrpcTransportError(error: unknown) {
  const chain = errorChain(error);
  return chain.some((item) => {
    const name = readStringProperty(item, "name");
    const message = readStringProperty(item, "message");
    return (
      name === "AbortError" ||
      /\babort(ed|error)?\b/i.test(message ?? "") ||
      message === "network error" ||
      message === "Failed to fetch" ||
      message === "Load failed"
    );
  });
}

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  let current: unknown = error;

  while (isObject(current) && !chain.includes(current)) {
    chain.push(current);
    current = "cause" in current ? current.cause : undefined;
  }

  return chain;
}

function readStringProperty(value: unknown, key: string) {
  if (!isObject(value) || !(key in value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function logTrpcOperation(op: TrpcLoggerOperation): void {
  console.debug("tRPC", {
    path: op.path,
    direction: op.direction,
    status:
      op.direction === "up"
        ? "request"
        : op.result instanceof Error
          ? "error"
          : "response",
    input: "[redacted]",
    result: "[redacted]",
  });
}

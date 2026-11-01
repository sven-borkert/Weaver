import { redactSecrets } from "@weaver/core/security/redactSecrets";
export { redactSecrets } from "@weaver/core/security/redactSecrets";
import { APICallError, RetryError } from "ai";
import { isCoreError } from "@weaver/core/errors";
import { describeNetworkFailure } from "@weaver/core/diagnostics/networkFailure";

export class RunCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelledError";
  }
}
export class RunTimeoutError extends Error {
  constructor() {
    super("run timed out");
    this.name = "RunTimeoutError";
  }
}

export type RunFailure = { code: string; message: string; retryable: boolean };

/** Error summaries are persisted verbatim (AssistantRun.errorMessage, the run.failed payload). */
const MAX_FAILURE_MESSAGE_CHARS = 300;

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, MAX_FAILURE_MESSAGE_CHARS);
}

/**
 * Spec §17 retryability: permission, scope, validation, and conflict failures never retry;
 * provider rate limits and transient provider failures do. Anything unrecognised defaults to
 * a non-retryable INTERNAL with a fixed message, so an unknown error can neither cause a retry
 * storm nor leak internals into the persisted summary.
 */
export function classifyRunError(error: unknown): RunFailure {
  // The SDK wraps an exhausted internal retry loop; classify what actually failed.
  for (let depth = 0; depth < 3; depth += 1) {
    if (!RetryError.isInstance(error) || error.lastError === undefined) break;
    error = error.lastError;
  }
  if (error instanceof RunCancelledError)
    return { code: "CANCELLED", message: "cancelled", retryable: false };
  if (error instanceof RunTimeoutError)
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: "run timed out",
      retryable: false,
    };
  if (
    error instanceof Error &&
    "code" in error &&
    ["P1001", "P1008", "P1017"].includes(String(error.code))
  )
    return {
      code: "INTERNAL",
      message: "Temporary database connection failure",
      retryable: true,
    };
  const network = describeNetworkFailure(error);
  if (network)
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: `Could not reach the LLM provider: ${network.text} [${network.code}]`,
      retryable: network.retryable,
    };
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;
    if (status === 429)
      return {
        code: "RATE_LIMITED",
        message: "provider rate limit exceeded",
        retryable: true,
      };
    if (status === 401 || status === 403)
      return {
        code: "PROVIDER_UNAVAILABLE",
        message: "provider rejected the connection credential",
        retryable: false,
      };
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: "provider request failed",
      retryable: error.isRetryable || status === 408 || status >= 500,
    };
  }
  if (
    isCoreError(error) &&
    error.details?.reason === "PROVIDER_CONNECTION_CHANGED"
  )
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: "Provider connection changed; retrying with current routing",
      retryable: true,
    };
  if (isCoreError(error))
    return { code: error.code, message: describe(error), retryable: false };
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      message:
        error.name === "TimeoutError"
          ? "provider request timed out"
          : "provider request interrupted",
      retryable: true,
    };
  }
  return {
    code: "INTERNAL",
    message: "assistant run failed",
    retryable: false,
  };
}

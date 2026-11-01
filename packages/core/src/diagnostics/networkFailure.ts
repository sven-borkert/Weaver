export type NetworkFailure = { code: string; text: string; retryable: boolean };

const EXACT: Record<string, { text: string; retryable: boolean }> = {
  OUTBOUND_NOT_ALLOWED: {
    text: "endpoint not allowed by the outbound policy (WEAVER_OUTBOUND_ALLOWED_ORIGINS)",
    retryable: false,
  },
  ECONNREFUSED: { text: "connection refused", retryable: true },
  ENOTFOUND: { text: "host not found", retryable: false },
  EAI_AGAIN: { text: "host not found", retryable: false },
  EHOSTUNREACH: { text: "host unreachable", retryable: true },
  ENETUNREACH: { text: "host unreachable", retryable: true },
  EHOSTDOWN: { text: "host unreachable", retryable: true },
  ETIMEDOUT: { text: "connection timed out", retryable: true },
  UND_ERR_CONNECT_TIMEOUT: { text: "connection timed out", retryable: true },
  UND_ERR_HEADERS_TIMEOUT: { text: "connection timed out", retryable: true },
  ECONNRESET: { text: "connection reset", retryable: true },
  EPIPE: { text: "connection reset", retryable: true },
  UND_ERR_SOCKET: { text: "connection reset", retryable: true },
  DEPTH_ZERO_SELF_SIGNED_CERT: {
    text: "TLS certificate rejected",
    retryable: false,
  },
  SELF_SIGNED_CERT_IN_CHAIN: {
    text: "TLS certificate rejected",
    retryable: false,
  },
};
const TLS_PREFIX = /^(?:CERT_|ERR_TLS_|UNABLE_TO_)/;
const FETCH_FAILED = /^(?:fetch failed|failed to fetch)$/i;

function codeOf(error: Error): string | null {
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 && code.length <= 40
      ? code
      : null;
  } catch {
    return null;
  }
}

/** Human cause for a transport-level failure anywhere in the cause chain; null when not a network failure. */
export function describeNetworkFailure(error: unknown): NetworkFailure | null {
  let fetchFailed = false;
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    let message = "";
    try {
      message = current.message;
    } catch {
      /* hostile accessor */
    }
    if (current.name === "TypeError" && FETCH_FAILED.test(message))
      fetchFailed = true;
    const code = codeOf(current);
    if (code) {
      if (Object.hasOwn(EXACT, code)) return { code, ...EXACT[code]! };
      if (TLS_PREFIX.test(code))
        return { code, text: "TLS certificate rejected", retryable: false };
      if (fetchFailed) return { code, text: "network error", retryable: true };
    }
    current =
      current instanceof AggregateError && current.errors.length > 0
        ? current.errors[0]
        : current.cause;
  }
  return fetchFailed
    ? { code: "FETCH_FAILED", text: "network error", retryable: true }
    : null;
}

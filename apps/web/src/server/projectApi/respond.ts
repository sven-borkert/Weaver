import { CoreError } from "@weaver/core/errors";
export function projectApiHeaders(requestId: string, revision?: string) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
  });
  if (revision) headers.set("ETag", `"${revision}"`);
  return headers;
}
export function projectApiErrorResponse(
  error: unknown,
  requestId: string,
): Response {
  const statuses = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PRECONDITION_FAILED: 412,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
  };
  const coreCode =
    error instanceof CoreError ? error.code : "INTERNAL_SERVER_ERROR";
  const reason = error instanceof CoreError ? error.details?.reason : undefined;
  const code =
    typeof reason === "string" &&
    ["CURSOR_STALE", "IDEMPOTENCY_KEY_REUSED"].includes(reason)
      ? reason
      : coreCode;
  const override =
    error instanceof CoreError ? error.details?.status : undefined;
  const status =
    typeof override === "number" &&
    [400, 401, 409, 412, 413, 415, 428].includes(override)
      ? override
      : statuses[coreCode];
  const headers = projectApiHeaders(requestId);
  if (status === 401) headers.set("WWW-Authenticate", "Bearer");
  if (status === 429) {
    const retry =
      error instanceof CoreError ? error.details?.retryAfterSeconds : undefined;
    headers.set("Retry-After", String(typeof retry === "number" ? retry : 60));
  }
  const messages: Record<number, string> = {
    400: "Invalid request",
    401: "A valid project API key is required",
    403: "Permission required",
    404: "Resource unavailable",
    409: "Request conflicts with current state",
    412: "Resource revision changed",
    413: "Request body too large",
    415: "JSON content type required",
    428: "If-Match is required",
    429: "Rate limit exceeded",
    500: "Request could not be completed",
  };
  return Response.json(
    { error: { code, message: messages[status], requestId } },
    { status, headers },
  );
}

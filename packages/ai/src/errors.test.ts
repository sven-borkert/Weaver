import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { CoreError } from "@weaver/core/errors";
import {
  classifyRunError,
  redactSecrets,
  RunCancelledError,
  RunTimeoutError,
} from "./errors";

function apiError(statusCode: number, isRetryable = statusCode >= 500) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://ai.test",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

describe("classifyRunError", () => {
  it.each(["P1001", "P1008", "P1017"])(
    "retries transient database failure %s without exposing details",
    (code) => {
      expect(
        classifyRunError(
          Object.assign(new Error("private database host"), { code }),
        ),
      ).toEqual({
        code: "INTERNAL",
        message: "Temporary database connection failure",
        retryable: true,
      });
    },
  );
  it("retries a changed provider destination", () => {
    expect(
      classifyRunError(
        new CoreError(
          "PRECONDITION_FAILED",
          "Provider connection changed; resolve routing again",
          { reason: "PROVIDER_CONNECTION_CHANGED" },
        ),
      ),
    ).toMatchObject({ retryable: true, code: "PROVIDER_UNAVAILABLE" });
  });
  it("maps cancellation, timeouts, provider statuses, core errors, and unknowns", () => {
    expect(classifyRunError(new RunCancelledError())).toEqual({
      code: "CANCELLED",
      message: "cancelled",
      retryable: false,
    });
    expect(classifyRunError(new RunTimeoutError())).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: false,
    });
    expect(classifyRunError(apiError(429, true))).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(classifyRunError(apiError(503))).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(classifyRunError(apiError(401, false))).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: false,
    });
    expect(classifyRunError(new CoreError("FORBIDDEN"))).toMatchObject({
      code: "FORBIDDEN",
      retryable: false,
    });
    expect(classifyRunError(new Error("x"))).toMatchObject({
      code: "INTERNAL",
      retryable: false,
    });
  });

  it("never retries permission, scope, validation, or conflict failures (spec §17)", () => {
    for (const code of [
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "PRECONDITION_FAILED",
    ] as const) {
      expect(classifyRunError(new CoreError(code))).toMatchObject({
        code,
        retryable: false,
      });
    }
    expect(classifyRunError(apiError(400, false)).retryable).toBe(false);
    expect(classifyRunError(apiError(403, false)).retryable).toBe(false);
    expect(classifyRunError(apiError(422, false)).retryable).toBe(false);
  });

  it("retries transient provider failures", () => {
    expect(classifyRunError(apiError(408, false)).retryable).toBe(true);
    expect(classifyRunError(apiError(500, false)).retryable).toBe(true);
    expect(classifyRunError(apiError(502, false)).retryable).toBe(true);
    // A provider that flags a non-5xx status as retryable is honoured.
    expect(classifyRunError(apiError(409, true)).retryable).toBe(true);
    const timeout = new Error("provider request timed out");
    timeout.name = "TimeoutError";
    expect(classifyRunError(timeout)).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("classifies the underlying failure when the SDK exhausts its own retries", () => {
    const rateLimited = apiError(429, true);
    const wrapped = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(500), rateLimited],
    });
    expect(classifyRunError(wrapped)).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(
      classifyRunError(
        new RetryError({
          message: "Failed",
          reason: "maxRetriesExceeded",
          errors: [apiError(401, false)],
        }),
      ),
    ).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
  });

  it("produces messages that are safe to truncate to 300 chars and carry no credential", () => {
    const leaky = apiError(400, false);
    Object.defineProperty(leaky, "message", {
      value: `401 {"error":{"message":"Incorrect API key provided: sk-proj-AbCdEf123456. Sent header 'Authorization: Bearer sk-proj-AbCdEf123456'."}} ${"padding ".repeat(80)}`,
    });
    const failure = classifyRunError(leaky);
    expect(failure.message.length).toBeLessThanOrEqual(300);
    expect(failure.message).not.toContain("sk-proj-AbCdEf123456");
    expect(classifyRunError(apiError(401, false)).message).toBe(
      "provider rejected the connection credential",
    );
  });

  it.each([400, 429, 503])(
    "never retains provider prose or opaque credentials for HTTP %s",
    (statusCode) => {
      const error = new APICallError({
        message:
          "Provider quoted PRIVATE_PROMPT and opaque-credential-EXAMPLE_ONLY",
        url: "https://ai.test",
        requestBodyValues: {},
        statusCode,
      });
      const failure = classifyRunError(error);
      expect(failure.message).not.toContain("PRIVATE_PROMPT");
      expect(failure.message).not.toContain("opaque-credential");
    },
  );

  it("hides internal detail behind a fixed message for unknown errors", () => {
    expect(classifyRunError(new Error("x-api-key: sk-secret blew up"))).toEqual(
      {
        code: "INTERNAL",
        message: "assistant run failed",
        retryable: false,
      },
    );
    expect(classifyRunError("sk-secret")).toEqual({
      code: "INTERNAL",
      message: "assistant run failed",
      retryable: false,
    });
  });
});

describe("redactSecrets", () => {
  it("masks bearer tokens and sk- keys", () => {
    expect(redactSecrets("Authorization: Bearer abc.def key sk-12345 ok")).toBe(
      "Authorization: Bearer [redacted] key [redacted] ok",
    );
  });

  it("masks realistic provider error bodies and header echoes", () => {
    expect(
      redactSecrets(
        '{"error":{"message":"Incorrect API key provided: sk-proj-9aB_cD-1234. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error"}}',
      ),
    ).not.toContain("sk-proj-9aB_cD-1234");
    expect(redactSecrets('{"x-api-key":"abc123def456"}')).toBe(
      '{"x-api-key":"[redacted]"}',
    );
    expect(redactSecrets("x-api-key: abc123def456")).toBe(
      "x-api-key: [redacted]",
    );
    expect(redactSecrets("authorization=Basic dXNlcjpwYXNz")).toBe(
      "authorization=[redacted]",
    );
    expect(redactSecrets('"api_key": "abc123def456"')).toBe(
      '"api_key": "[redacted]"',
    );
    expect(redactSecrets("?key=AIzaSyA1234567890abcdefg")).toBe(
      "?key=[redacted]",
    );
    expect(redactSecrets("token gsk_abcdef1234567890")).toBe(
      "token [redacted]",
    );
    expect(redactSecrets("sk-ant-api03-AbCd_1234-xyz")).toBe("[redacted]");
  });

  it("is idempotent and leaves ordinary prose alone", () => {
    const once = redactSecrets("Authorization: Bearer abc.def");
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets("The document could not be found in project p1")).toBe(
      "The document could not be found in project p1",
    );
  });
});

it("names the network cause of a transport failure and retries only transient ones", () => {
  const refused = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
  expect(classifyRunError(refused)).toEqual({
    code: "PROVIDER_UNAVAILABLE",
    message:
      "Could not reach the LLM provider: connection refused [ECONNREFUSED]",
    retryable: true,
  });
  const wrapped = new APICallError({
    message: "Cannot connect to API: getaddrinfo ENOTFOUND litellm.internal",
    url: "https://litellm.internal",
    requestBodyValues: {},
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND litellm.internal"), {
      code: "ENOTFOUND",
    }),
    isRetryable: true,
  });
  expect(classifyRunError(wrapped)).toEqual({
    code: "PROVIDER_UNAVAILABLE",
    message: "Could not reach the LLM provider: host not found [ENOTFOUND]",
    retryable: false,
  });
  const policy = Object.assign(new Error("outbound endpoint is not allowed"), {
    code: "OUTBOUND_NOT_ALLOWED",
  });
  expect(classifyRunError(policy)).toEqual({
    code: "PROVIDER_UNAVAILABLE",
    message:
      "Could not reach the LLM provider: endpoint not allowed by the outbound policy (WEAVER_OUTBOUND_ALLOWED_ORIGINS) [OUTBOUND_NOT_ALLOWED]",
    retryable: false,
  });
});

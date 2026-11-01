import { describe, expect, it } from "vitest";
import { describeNetworkFailure } from "./networkFailure";

function fetchFailed(cause: unknown) {
  return new TypeError("fetch failed", { cause });
}
function coded(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

describe("describeNetworkFailure", () => {
  it.each([
    ["ECONNREFUSED", "connection refused", true],
    ["ENOTFOUND", "host not found", false],
    ["EAI_AGAIN", "host not found", false],
    ["EHOSTUNREACH", "host unreachable", true],
    ["ENETUNREACH", "host unreachable", true],
    ["ETIMEDOUT", "connection timed out", true],
    ["UND_ERR_CONNECT_TIMEOUT", "connection timed out", true],
    ["ECONNRESET", "connection reset", true],
    ["UND_ERR_SOCKET", "connection reset", true],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS certificate rejected", false],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS certificate rejected", false],
    ["CERT_HAS_EXPIRED", "TLS certificate rejected", false],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "TLS certificate rejected", false],
  ])("maps %s through a fetch failure cause", (code, text, retryable) => {
    expect(describeNetworkFailure(fetchFailed(coded(code)))).toEqual({
      code,
      text,
      retryable,
    });
  });

  it("names the outbound policy setting without the origin", () => {
    expect(describeNetworkFailure(coded("OUTBOUND_NOT_ALLOWED"))).toEqual({
      code: "OUTBOUND_NOT_ALLOWED",
      text: "endpoint not allowed by the outbound policy (WEAVER_OUTBOUND_ALLOWED_ORIGINS)",
      retryable: false,
    });
  });

  it("reports an unknown code on a fetch failure as a retryable network error", () => {
    expect(describeNetworkFailure(fetchFailed(coded("EWEIRD")))).toEqual({
      code: "EWEIRD",
      text: "network error",
      retryable: true,
    });
    expect(describeNetworkFailure(fetchFailed(new Error("no code")))).toEqual({
      code: "FETCH_FAILED",
      text: "network error",
      retryable: true,
    });
  });

  it("walks an aggregate cause and stops on cycles", () => {
    const aggregate = new AggregateError([coded("ECONNREFUSED")], "all failed");
    expect(describeNetworkFailure(fetchFailed(aggregate))?.code).toBe(
      "ECONNREFUSED",
    );
    const loop = new Error("loop");
    (loop as { cause?: unknown }).cause = loop;
    expect(describeNetworkFailure(loop)).toBeNull();
  });

  it("returns null for errors that are not network failures", () => {
    expect(describeNetworkFailure(new Error("validation"))).toBeNull();
    expect(describeNetworkFailure(coded("P1001"))).toBeNull();
    expect(describeNetworkFailure(coded("constructor"))).toBeNull();
    expect(describeNetworkFailure("string")).toBeNull();
  });
});

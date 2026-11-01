import { beforeEach, describe, expect, it, vi } from "vitest";
const emitDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@weaver/core/diagnostics/writer", () => ({ emitDiagnostic }));
import { POST } from "./route";

beforeEach(() => emitDiagnostic.mockClear());

describe("CSP reporting", () => {
  it.each([
    {
      "csp-report": {
        "effective-directive": "script-src-elem",
        "document-uri": "https://host/private?token=secret",
      },
    },
    [
      {
        type: "csp-violation",
        body: { effectiveDirective: "script-src-elem", sample: "secret" },
      },
    ],
  ])(
    "records the directive without document URLs or script samples",
    async (body) => {
      const response = await POST(
        new Request("http://localhost/api/csp-report", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(204);
      expect(emitDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { source: "csp", directive: "script-src-elem" },
        }),
      );
      expect(JSON.stringify(emitDiagnostic.mock.calls)).not.toContain("secret");
    },
  );
  it("rejects oversized and unrecognized reports without logging", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost/api/csp-report", {
            method: "POST",
            body: "x".repeat(8193),
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await POST(
          new Request("http://localhost/api/csp-report", {
            method: "POST",
            body: JSON.stringify({
              "csp-report": { "effective-directive": "secret" },
            }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(emitDiagnostic).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
vi.mock("~/env", () => ({ env: { WEAVER_AUTH_TRUST_PROXY: true } }));
vi.mock("@weaver/core/diagnostics/writer", () => ({ emitDiagnostic: vi.fn() }));
import { POST } from "./route";

describe("CSP report admission", () => {
  it("keeps one reporting source from exhausting another's bucket", async () => {
    const request = (address: string) =>
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "x-real-ip": address },
        body: JSON.stringify({
          "csp-report": { "effective-directive": "script-src" },
        }),
      });
    for (let i = 0; i < 60; i++)
      expect((await POST(request("192.0.2.1"))).status).toBe(204);
    expect((await POST(request("192.0.2.1"))).status).toBe(429);
    expect((await POST(request("192.0.2.2"))).status).toBe(204);
  });
});

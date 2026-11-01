import { describe, expect, it } from "vitest";

import { withAuthRequestBasePath } from "./requestBasePath";

describe("withAuthRequestBasePath", () => {
  it("leaves requests unchanged when no base path is configured", () => {
    const request = new Request("http://localhost:3000/api/auth/ok");

    expect(withAuthRequestBasePath(request, undefined).url).toBe(request.url);
  });

  it("prepends a missing normalized base path", () => {
    const request = new Request("http://localhost:3000/api/auth/ok");

    expect(withAuthRequestBasePath(request, "knowledge/").url).toBe(
      "http://localhost:3000/knowledge/api/auth/ok",
    );
  });

  it("does not prepend an already-prefixed request", () => {
    const request = new Request("http://localhost:3000/knowledge/api/auth/ok");

    expect(withAuthRequestBasePath(request, "/knowledge").url).toBe(
      request.url,
    );
  });

  it("preserves POST method, headers, and body while prefixing", async () => {
    const request = new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "r1" },
      body: JSON.stringify({ code: "abc" }),
    });

    const rewritten = withAuthRequestBasePath(request, "/knowledge");

    expect(rewritten.url).toBe(
      "http://localhost:3000/knowledge/api/auth/oauth2/token",
    );
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get("content-type")).toBe("application/json");
    expect(rewritten.headers.get("x-request-id")).toBe("r1");
    await expect(rewritten.json()).resolves.toEqual({ code: "abc" });
  });
});

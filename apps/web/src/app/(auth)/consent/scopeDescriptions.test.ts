import { describe, expect, it } from "vitest";
import { describeScope, parseRequestedScopes } from "./scopeDescriptions";

describe("consent scope descriptions", () => {
  it("flags content:write as a write grant and describes every known scope", () => {
    expect(describeScope("content:write").write).toBe(true);
    for (const scope of [
      "mcp:use",
      "content:read",
      "content:propose",
      "external:use",
      "offline_access",
    ]) {
      expect(describeScope(scope).write).toBe(false);
      expect(describeScope(scope).title).not.toBe(scope);
    }
  });
  it("falls back for unknown scopes and de-duplicates the request", () => {
    expect(describeScope("openid").title).toBe("openid");
    expect(parseRequestedScopes("a b  a")).toEqual(["a", "b"]);
    expect(parseRequestedScopes(undefined)).toEqual([]);
  });

  it("flags external:manage as a write grant", () => {
    expect(describeScope("external:manage").write).toBe(true);
    expect(describeScope("external:manage").title).toBe(
      "Manage your MCP connections",
    );
  });
});

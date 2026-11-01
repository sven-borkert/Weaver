import { describe, expect, it } from "vitest";
import { safeLoginCallbackUrl } from "./callbackUrl";

describe("safeLoginCallbackUrl", () => {
  it("keeps same-origin absolute paths including query and hash", () => {
    expect(safeLoginCallbackUrl("/apps/APP-100/nodes?tab=all#node-1")).toBe(
      "/apps/APP-100/nodes?tab=all#node-1",
    );
  });

  it("accepts and normalizes same-app callbacks that include the deployment base path", () => {
    expect(
      safeLoginCallbackUrl(
        "/knowledge/apps/APP-100/nodes?tab=all#node-1",
        "/knowledge",
      ),
    ).toBe("/apps/APP-100/nodes?tab=all#node-1");
  });

  it("falls back when the callback is missing or empty", () => {
    expect(safeLoginCallbackUrl(null)).toBe("/");
    expect(safeLoginCallbackUrl(undefined)).toBe("/");
    expect(safeLoginCallbackUrl("")).toBe("/");
  });

  it("rejects absolute, protocol-relative, and script callbacks", () => {
    for (const value of [
      "https://evil.example/apps",
      "http://evil.example/apps",
      "//evil.example/apps",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      expect(safeLoginCallbackUrl(value)).toBe("/");
    }
  });

  it("rejects non-path callbacks and backslash-smuggling attempts", () => {
    expect(safeLoginCallbackUrl("apps/APP-100")).toBe("/");
    expect(safeLoginCallbackUrl("/\\evil.example/apps")).toBe("/");
  });
});

it("rejects protocol-relative callbacks after stripping the base path", () => {
  expect(safeLoginCallbackUrl("/knowledge//evil.com", "/knowledge")).toBe("/");
});

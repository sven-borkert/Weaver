import { describe, expect, it } from "vitest";

import {
  normalizeBasePath,
  publicUrlWithBasePath,
  stripBasePath,
  withBasePath,
} from "./basePath";

describe("base path helpers", () => {
  it.each(["?utm=x", "#section", "?x=1#section"])(
    "handles base-root suffix %s",
    (suffix) => {
      expect(stripBasePath(`/weaver${suffix}`, "/weaver")).toBe(`/${suffix}`);
      expect(withBasePath(`/weaver${suffix}`, "/weaver")).toBe(
        `/weaver${suffix}`,
      );
    },
  );

  it("normalizes optional deployment base paths", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/other-app/")).toBe("/other-app");
    expect(normalizeBasePath("other-app")).toBe("/other-app");
  });

  it("prefixes absolute app paths and leaves absolute URLs unchanged", () => {
    expect(withBasePath("/api/trpc", "/other-app")).toBe("/other-app/api/trpc");
    expect(withBasePath("/apps", "")).toBe("/apps");
    expect(withBasePath("https://example.test/apps", "/other-app")).toBe(
      "https://example.test/apps",
    );
  });

  it("builds public URLs from an origin and deployment base path", () => {
    expect(
      publicUrlWithBasePath("https://host.test:8443", "/api/mcp", "/other-app"),
    ).toBe("https://host.test:8443/other-app/api/mcp");
    expect(
      publicUrlWithBasePath(
        "https://host.test:8443/other-app",
        "/api/mcp",
        "/other-app",
      ),
    ).toBe("https://host.test:8443/other-app/api/mcp");
  });

  it("strips the configured base path from same-app paths", () => {
    expect(stripBasePath("/other-app/apps/APP-100", "/other-app")).toBe(
      "/apps/APP-100",
    );
    expect(stripBasePath("/other-app", "/other-app")).toBe("/");
    expect(stripBasePath("/apps", "/other-app")).toBe("/apps");
  });
});

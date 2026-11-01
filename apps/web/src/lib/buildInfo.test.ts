import { afterEach, describe, expect, it } from "vitest";

import { formatAppVersion, getClientBuildInfo } from "./buildInfo";

const KEYS = [
  "NEXT_PUBLIC_APP_VERSION",
  "NEXT_PUBLIC_BUILD_TIME",
  "NEXT_PUBLIC_COMMIT_SHA",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("formatAppVersion", () => {
  it("prefixes a bare semver and keeps an existing prefix", () => {
    expect(formatAppVersion("0.1.92")).toBe("v0.1.92");
    expect(formatAppVersion(" v0.1.92 ")).toBe("v0.1.92");
  });
});

describe("getClientBuildInfo", () => {
  it("reads the inlined build metadata", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "0.1.92";
    process.env.NEXT_PUBLIC_BUILD_TIME = "2026-09-17T08:30:00.000Z";
    process.env.NEXT_PUBLIC_COMMIT_SHA = "0123456789abcdef";

    expect(getClientBuildInfo()).toEqual({
      version: "v0.1.92",
      buildTime: "2026-09-17T08:30:00.000Z",
      commitSha: "0123456789abcdef",
    });
  });

  it("treats blank and missing values as absent", () => {
    process.env.NEXT_PUBLIC_BUILD_TIME = "   ";

    expect(getClientBuildInfo()).toEqual({
      version: null,
      buildTime: null,
      commitSha: null,
    });
  });
});

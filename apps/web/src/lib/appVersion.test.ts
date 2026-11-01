import packageJson from "../../../../package.json";
import { describe, expect, it } from "vitest";

import { APP_VERSION, formatAppVersion, getAppVersionInfo } from "./appVersion";

describe("app version helpers", () => {
  it("formats package versions with the UI/API v prefix", () => {
    expect(formatAppVersion("0.1.0")).toBe("v0.1.0");
    expect(formatAppVersion("v0.1.0")).toBe("v0.1.0");
    expect(APP_VERSION).toBe(`v${packageJson.version}`);
  });

  it("returns deployment build metadata from environment variables", () => {
    expect(
      getAppVersionInfo({
        NEXT_PUBLIC_BUILD_TIME: "2026-06-19T10:11:12.000Z",
        VERCEL_GIT_COMMIT_SHA: "abcdef1234567890",
      }),
    ).toEqual({
      version: `v${packageJson.version}`,
      buildTime: "2026-06-19T10:11:12.000Z",
      commitSha: "abcdef1234567890",
    });
  });

  it("prefers explicit app build metadata over platform defaults", () => {
    expect(
      getAppVersionInfo({
        APP_BUILD_TIME: "2026-06-19T12:00:00.000Z",
        NEXT_PUBLIC_BUILD_TIME: "2026-06-19T10:11:12.000Z",
        APP_COMMIT_SHA: "1234567",
        VERCEL_GIT_COMMIT_SHA: "abcdef1234567890",
      }),
    ).toEqual({
      version: `v${packageJson.version}`,
      buildTime: "2026-06-19T12:00:00.000Z",
      commitSha: "1234567",
    });
  });
});

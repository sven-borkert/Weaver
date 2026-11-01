import { describe, expect, it, vi } from "vitest";
import {
  classifyGitVersion,
  createGitRuntimeCheck,
  GIT_FAILURE_CACHE_MS,
  MIN_GIT_VERSION,
  parseGitVersion,
} from "./gitVersion";

it.each([
  ["git version 2.34.1\n", [2, 34, 1]],
  ["git version 2.39.3 (Apple Git-145)", [2, 39, 3]],
  ["git version 2.45.2.windows.1", [2, 45, 2]],
  ["git version 3.0", [3, 0, 0]],
])("parses %j", (output, expected) => {
  expect(parseGitVersion(output)).toEqual(expected);
});

it("rejects output that is not a Git version", () => {
  expect(parseGitVersion("command not found")).toBeNull();
  expect(classifyGitVersion("")).toEqual({ status: "missing" });
});

it.each([
  ["git version 2.34.1", "unsupported"],
  ["git version 2.35.9", "unsupported"],
  ["git version 1.99.0", "unsupported"],
  ["git version 2.36.0", "ok"],
  ["git version 2.36", "ok"],
  ["git version 2.51.0", "ok"],
  ["git version 3.0.0", "ok"],
])("classifies %j as %s", (output, status) => {
  const result = classifyGitVersion(output);
  expect(result.status).toBe(status);
  if (result.status === "unsupported") {
    expect(result.minimum).toBe(MIN_GIT_VERSION);
  }
});

describe("checkGitRuntime caching", () => {
  it("re-checks a missing Git only after the failure cache expires", async () => {
    let time = 0;
    const exec = vi.fn(async (): Promise<string> => {
      throw new Error("ENOENT");
    });
    const check = createGitRuntimeCheck({ exec, now: () => time });
    expect(await check()).toEqual({ status: "missing" });
    expect(await check()).toEqual({ status: "missing" });
    expect(exec).toHaveBeenCalledTimes(1);
    time = GIT_FAILURE_CACHE_MS;
    expect(await check()).toEqual({ status: "missing" });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("caches a passing result for the life of the process", async () => {
    let time = 0;
    const exec = vi.fn(async () => "git version 2.51.0\n");
    const check = createGitRuntimeCheck({ exec, now: () => time });
    expect(await check()).toEqual({ status: "ok", version: "2.51.0" });
    time = GIT_FAILURE_CACHE_MS * 10;
    expect(await check()).toEqual({ status: "ok", version: "2.51.0" });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createPdfRuntimeCheck, PDF_FAILURE_CACHE_MS } from "./runtime";

describe("checkPdfRuntime", () => {
  it("caches a failed probe for the failure window", async () => {
    let time = 0;
    const probe = vi.fn(async () => {
      throw new Error("Executable doesn't exist");
    });
    const check = createPdfRuntimeCheck({ probe, now: () => time });
    expect(await check()).toEqual({
      status: "missing",
      reason: "Executable doesn't exist",
    });
    expect(await check()).toEqual({
      status: "missing",
      reason: "Executable doesn't exist",
    });
    expect(probe).toHaveBeenCalledTimes(1);
    time = PDF_FAILURE_CACHE_MS;
    await check();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("caches a passing probe for the process", async () => {
    let time = 0;
    const probe = vi.fn(async () => undefined);
    const check = createPdfRuntimeCheck({ probe, now: () => time });
    expect(await check()).toEqual({ status: "ok" });
    time = PDF_FAILURE_CACHE_MS * 10;
    expect(await check()).toEqual({ status: "ok" });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

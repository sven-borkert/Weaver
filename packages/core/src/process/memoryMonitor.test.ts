import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { monitorProcessMemory, residentBytesFromPs } from "./memoryMonitor";

it("kills an over-budget child even while its event loop is blocked", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "globalThis.bytes = Buffer.alloc(64 * 1024 * 1024, 1); process.stdout.write('ready'); while (true) {}",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const closed = once(child, "close");
  const failsafe = setTimeout(() => child.kill("SIGKILL"), 4000);
  let limited = false;
  let stop: (() => void) | undefined;
  try {
    await once(child.stdout, "data");
    stop = monitorProcessMemory(child, 32 * 1024 * 1024, () => {
      limited = true;
      child.kill("SIGKILL");
    });
    expect(await closed).toEqual([null, "SIGKILL"]);
    expect(limited).toBe(true);
  } finally {
    clearTimeout(failsafe);
    stop?.();
    child.kill("SIGKILL");
    await closed;
  }
});

// An exited child that Node has not reaped yet is a zombie: `ps` prints RSS 0
// with a Z state, which must never count as "unmeasurable, kill it".
it("does not treat an unreaped zombie as an over-budget child", async () => {
  const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
  const closed = once(child, "close");
  const block = (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* keep the loop busy so the exit is not reaped */
    }
  };
  block(300);
  expect(child.exitCode).toBeNull();
  let limited = false;
  // The first sample is taken synchronously here; blocking again lets it
  // observe the zombie before the loop reaps it.
  const stop = monitorProcessMemory(child, 1, () => {
    limited = true;
  });
  block(300);
  try {
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(limited).toBe(false);
  } finally {
    stop();
  }
});

it("reads a ps line as bytes and a zombie as zero", () => {
  expect(residentBytesFromPs("  1234 S+\n")).toBe(1234 * 1024);
  expect(residentBytesFromPs("     0 Z   \n")).toBe(0);
  expect(residentBytesFromPs("     0 ZN\n")).toBe(0);
  expect(() => residentBytesFromPs("     0 S\n")).toThrow(/unavailable/);
  expect(() => residentBytesFromPs("\n")).toThrow(/unavailable/);
  expect(() => residentBytesFromPs("abc R\n")).toThrow(/unavailable/);
});

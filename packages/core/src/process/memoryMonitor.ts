import { execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

/** @internal exported for memoryMonitor.test.ts. Resident bytes from one
 *  `ps -o rss=,stat=` line; 0 for a zombie (exited, not yet reaped), which
 *  holds no memory and must not read as unmeasurable. */
export function residentBytesFromPs(stdout: string): number {
  const [rss, stat] = stdout.trim().split(/\s+/);
  if (stat?.includes("Z")) return 0;
  const kib = Number(rss);
  if (!rss || !Number.isFinite(kib) || kib <= 0)
    throw new Error("Child process memory is unavailable");
  return kib * 1024;
}

async function residentBytes(pid: number): Promise<number> {
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    if (/^State:\s+Z/m.test(status)) return 0;
    const kib = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
    if (!kib) throw new Error("Child process memory is unavailable");
    return Number(kib) * 1024;
  }
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-o", "rss=,stat=", "-p", String(pid)],
      { timeout: 1000, maxBuffer: 1024 },
      (error, stdout) => {
        const unavailable = (cause: unknown) =>
          cause instanceof Error
            ? cause
            : new Error("Child process memory is unavailable");
        if (error) return reject(unavailable(error));
        try {
          resolve(residentBytesFromPs(stdout));
        } catch (cause) {
          reject(unavailable(cause));
        }
      },
    );
  });
}

export function monitorProcessMemory(
  child: ChildProcess,
  maxBytes: number,
  onLimit: () => void,
): () => void {
  let stopped = false;
  let pending = false;
  const sample = async () => {
    if (
      stopped ||
      pending ||
      !child.pid ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    pending = true;
    try {
      if ((await residentBytes(child.pid)) > maxBytes && !stopped) onLimit();
    } catch {
      if (!stopped && child.exitCode === null && child.signalCode === null)
        onLimit();
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => {
    void sample();
  }, 250);
  timer.unref();
  void sample();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

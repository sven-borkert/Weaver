import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NOTEBOOK_TIMEOUT_MS } from "@weaver/core/artifacts/notebookSchema";
import { monitorProcessMemory } from "@weaver/core/process/memoryMonitor";

const DEFAULT_EXECUTABLE = fileURLToPath(
  new URL(
    "../../native/onenote-reader/target/release/weaver-onenote-reader",
    import.meta.url,
  ),
);
const MAX_RESIDENT_BYTES = 1024 * 1024 * 1024;

export function createNotebookParser(
  options: { executable?: string; timeoutMs?: number } = {},
) {
  return async (input: {
    sourcePath: string;
    outputDir: string;
    signal: AbortSignal;
  }): Promise<void> => {
    input.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        options.executable ?? DEFAULT_EXECUTABLE,
        ["--source", input.sourcePath, "--output", input.outputDir],
        {
          stdio: "ignore",
          detached: process.platform !== "win32",
          env: { PATH: process.env.PATH, TZ: "UTC" },
        },
      );
      let failure: Error | undefined;
      let stopMemory: (() => void) | undefined;
      const kill = () => {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const abort = () => {
        failure = new DOMException(
          "Notebook preparation cancelled",
          "AbortError",
        );
        kill();
      };
      const timer = setTimeout(() => {
        failure ??= new Error("Reading the notebook took too long.");
        kill();
      }, options.timeoutMs ?? NOTEBOOK_TIMEOUT_MS);
      child.once("spawn", () => {
        stopMemory = monitorProcessMemory(child, MAX_RESIDENT_BYTES, () => {
          failure ??= new Error("Reading the notebook needed too much memory.");
          kill();
        });
      });
      child.once("error", () => {
        failure ??= new Error(
          "The OneNote reader is not installed on this worker.",
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        stopMemory?.();
        input.signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error("The OneNote reader could not read this file."));
        else resolve();
      });
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
  };
}

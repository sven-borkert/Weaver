import { spawn } from "node:child_process";

export type GitRemoteCommand = {
  executable: "git" | "ssh-keygen";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
};
export type GitRemoteCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  stopped?: "TIMEOUT" | "CANCELLED" | "PUSH_FAILED";
};

export function runGitRemoteCommand(
  command: GitRemoteCommand,
): Promise<GitRemoteCommandResult> {
  if (command.signal?.aborted)
    return Promise.resolve({
      code: -1,
      stdout: "",
      stderr: "",
      stopped: "CANCELLED",
    });
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped: GitRemoteCommandResult["stopped"];
    const stop = (reason: NonNullable<typeof stopped>) => {
      stopped ??= reason;
      // Kill Git and its SSH child before removing the private key.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => stop("TIMEOUT"), command.timeoutMs);
    const abort = () => stop("CANCELLED");
    command.signal?.addEventListener("abort", abort, { once: true });
    if (command.signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 65_536) {
        stdout = stdout.slice(0, 65_536);
        stop("PUSH_FAILED");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 65_536) {
        stderr = stderr.slice(0, 65_536);
        stop("PUSH_FAILED");
      }
    });
    child.on("error", () => {
      stopped ??= "PUSH_FAILED";
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", abort);
      resolve({ code: code ?? -1, stdout, stderr, stopped });
    });
  });
}

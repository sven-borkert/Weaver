import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runGitRemoteCommand } from "./remoteCommand";

it.each(["TIMEOUT", "CANCELLED"] as const)(
  "kills the command process group on %s",
  async (reason) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "weaver-remote-command-"),
    );
    const controller = new AbortController();
    const timer =
      reason === "CANCELLED"
        ? setTimeout(() => controller.abort(), 50)
        : undefined;
    try {
      const result = await runGitRemoteCommand({
        executable: "git",
        args: ["-c", "alias.wait=!sleep 30", "wait"],
        cwd: directory,
        env: {
          PATH: "/usr/bin:/bin",
          NODE_ENV: "test",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        signal: controller.signal,
        timeoutMs: reason === "TIMEOUT" ? 50 : 2000,
      });
      expect(result.stopped).toBe(reason);
      expect(result.code).not.toBe(0);
    } finally {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  },
  3000,
);

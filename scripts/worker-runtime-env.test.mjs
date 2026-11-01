import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Turbo forwards the Playwright web origin and port", () => {
  const result = spawnSync(
    "pnpm",
    ["exec", "turbo", "run", "dev", "--filter=@weaver/web", "--dry=json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AUTH_URL: "http://127.0.0.1:4321",
        PORT: "4321",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const dryRun = JSON.parse(result.stdout);
  const webDev = dryRun.tasks.find((task) => task.taskId === "@weaver/web#dev");
  assert.ok(webDev, "web dev task missing from Turbo dry run");
  assert.ok(
    webDev.environmentVariables.configured.some((value) =>
      value.startsWith("AUTH_URL="),
    ),
  );
  assert.ok(
    webDev.environmentVariables.configured.some((value) =>
      value.startsWith("PORT="),
    ),
  );
});

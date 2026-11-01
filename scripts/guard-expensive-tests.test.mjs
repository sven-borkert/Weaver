import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function decision(command) {
  const result = spawnSync(
    process.execPath,
    ["scripts/guard-expensive-tests.mjs", "--mode=gate"],
    {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision
    : null;
}

for (const command of [
  "pnpm test:integration",
  "RUN_FULL_TESTS=0 pnpm test:integration",
  "pnpm test:integration # RUN_FULL_TESTS=1",
  "echo RUN_FULL_TESTS=1; pnpm test:integration",
  "pnpm test:integration; RUN_FULL_TESTS=1 pnpm e2e",
  "pnpm e2e",
  "pnpm run -w e2e",
  "pnpm run --workspace-root e2e",
  "timeout 900 pnpm e2e",
  "time pnpm e2e",
  "nohup pnpm e2e",
  "nice -n 10 pnpm e2e",
  "node node_modules/.bin/playwright test",
  "env RUN_FULL_TESTS=0 pnpm exec playwright test",
  "pnpm exec vitest run -c apps/web/vitest.integration.config.ts",
  'sh -c "pnpm test:integration"',
  'echo "$(pnpm test:integration)"',
  "RUN_FULL_TESTS=1 env -u RUN_FULL_TESTS pnpm e2e",
  "cat <<'EOF'\npnpm e2e\nEOF\npnpm test:integration",
  "cat <<EOF\n$(pnpm e2e)\nEOF",
])
  test(`gates executable: ${command}`, () =>
    assert.equal(decision(command), "deny"));

for (const command of [
  "RUN_FULL_TESTS=1 pnpm test:integration",
  "RUN_FULL_TESTS='1' pnpm e2e",
  "env RUN_FULL_TESTS=1 pnpm exec playwright test",
  "cat apps/web/vitest.integration.config.ts",
  "rg playwright docs/setup.md",
  "echo 'pnpm test:integration RUN_FULL_TESTS=0'",
  "pnpm test:integration apps/web/tests/integration/auth.spec.ts",
  "pnpm test:integration:documents",
  "pnpm exec playwright install chromium",
  "echo '$(pnpm e2e)'",
  "python3 - <<'PY'\ns = 'pnpm test:integration'\nPY",
  'RUN_FULL_TESTS=1 sh -c "pnpm e2e"',
])
  test(`permits consented or cheap: ${command}`, () =>
    assert.equal(decision(command), null));

for (const command of [
  "> /tmp/result.log pnpm e2e",
  "2>/tmp/error.log pnpm test:integration",
  "pnpm test:integration > apps/web/tests/integration/output.spec.ts",
  "pnpm test:integration --exclude apps/web/tests/integration/auth.spec.ts",
  "pnpm test:integration --exclude=apps/web/tests/integration/auth.spec.ts",
  "pnpm test:integration -t apps/web/tests/integration/auth.spec.ts",
  "pnpm exec vitest run -c apps/web/vitest.integration.config.ts --outputFile apps/web/tests/integration/output.spec.ts",
])
  test(`gates redirects and non-filter spec arguments: ${command}`, () =>
    assert.equal(decision(command), "deny"));

for (const command of [
  "RUN_FULL_TESTS=1 > /tmp/result.log pnpm e2e",
  "pnpm test:integration apps/web/tests/integration/auth.spec.ts > /tmp/result.log",
  "pnpm test:integration --run apps/web/tests/integration/auth.spec.ts",
  "cat > /tmp/result.log <<'EOF'\npnpm e2e\nEOF",
])
  test(`permits valid redirected or focused command: ${command}`, () =>
    assert.equal(decision(command), null));

for (const command of [
  "command env RUN_FULL_TESTS=0 pnpm e2e",
  "RUN_FULL_TESTS=1 command env -u RUN_FULL_TESTS pnpm e2e",
  "pnpm test:integration apps/web/tests/integration/*.spec.ts",
])
  test(`gates wrapped or broad execution: ${command}`, () =>
    assert.equal(decision(command), "deny"));
for (const command of [
  "command env RUN_FULL_TESTS=1 pnpm e2e",
  "command -- pnpm test:integration apps/web/tests/integration/auth.spec.ts",
])
  test(`permits wrapped authorized or focused execution: ${command}`, () =>
    assert.equal(decision(command), null));

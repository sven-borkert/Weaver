import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve("scripts/require-env.mjs");
const PRINT_ENV = [
  process.execPath,
  "-e",
  "process.stdout.write(JSON.stringify({ db: process.env.DATABASE_URL, dir: process.env.WEAVER_DATA_DIR, extra: process.env.REQUIRE_ENV_EXTRA }))",
];
const TEST_DB_URL =
  "postgresql://weaver:secret@127.0.0.1:5432/weaver_test?schema=public";

function writeEnvFile(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "require-env-"));
  const file = path.join(dir, ".env.test");
  writeFileSync(file, contents);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(args, { shell = {}, command = PRINT_ENV } = {}) {
  const env = { ...process.env, ...shell };
  delete env.DATABASE_URL;
  delete env.WEAVER_DATA_DIR;
  Object.assign(env, shell);
  return spawnSync(process.execPath, [SCRIPT, ...args, "--", ...command], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

test("fails when the env file is missing", () => {
  const result = run(["./.env.does-not-exist", "weaver_test", "./data-test"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env\.does-not-exist/);
  assert.match(result.stderr, /missing/i);
});

test("runs the command with the file's variables when the pair matches", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="${TEST_DB_URL}"\nWEAVER_DATA_DIR="./data-test"\nREQUIRE_ENV_EXTRA="from-file"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      db: TEST_DB_URL,
      dir: "./data-test",
      extra: "from-file",
    });
  } finally {
    cleanup();
  }
});

test("rejects a file whose DATABASE_URL names another database", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="postgresql://weaver:secret@127.0.0.1:5432/weaver?schema=public"\nWEAVER_DATA_DIR="./data-test"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"weaver"/);
    assert.match(result.stderr, /"weaver_test"/);
    assert.doesNotMatch(result.stderr, /secret/);
  } finally {
    cleanup();
  }
});

test("rejects a file whose WEAVER_DATA_DIR is not the paired directory", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="${TEST_DB_URL}"\nWEAVER_DATA_DIR="./data"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WEAVER_DATA_DIR/);
    assert.match(result.stderr, /data-test/);
  } finally {
    cleanup();
  }
});

test("rejects a shell DATABASE_URL that differs from the file", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="${TEST_DB_URL}"\nWEAVER_DATA_DIR="./data-test"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"], {
      shell: {
        DATABASE_URL:
          "postgresql://weaver:secret@127.0.0.1:5432/weaver?schema=public",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shell/i);
    assert.match(result.stderr, /DATABASE_URL/);
  } finally {
    cleanup();
  }
});

test("accepts a shell DATABASE_URL identical to the file", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="${TEST_DB_URL}"\nWEAVER_DATA_DIR="./data-test"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"], {
      shell: { DATABASE_URL: TEST_DB_URL },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanup();
  }
});

test("keeps dotenv-cli precedence for unguarded keys (shell wins)", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="${TEST_DB_URL}"\nWEAVER_DATA_DIR="./data-test"\nREQUIRE_ENV_EXTRA="from-file"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"], {
      shell: { REQUIRE_ENV_EXTRA: "from-shell" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).extra, "from-shell");
  } finally {
    cleanup();
  }
});

test("propagates the command's exit code", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="${TEST_DB_URL}"\nWEAVER_DATA_DIR="./data-test"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"], {
      command: [process.execPath, "-e", "process.exit(3)"],
    });
    assert.equal(result.status, 3);
  } finally {
    cleanup();
  }
});

test("rejects malformed usage", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "./.env.test"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage/i);
});

test("refuses a remote test database even when its name matches", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="postgresql://weaver:secret@remote.example/weaver_test"\nWEAVER_DATA_DIR="./data-test"\n`,
  );
  try {
    const result = run([file, "weaver_test", "./data-test"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /local/);
    assert.doesNotMatch(result.stderr, /secret/);
  } finally {
    cleanup();
  }
});

test("refuses query-string overrides of a local test host", () => {
  const { file, cleanup } = writeEnvFile(
    `DATABASE_URL="${TEST_DB_URL}&host=remote.example"\nWEAVER_DATA_DIR="./data-test"\n`,
  );
  try {
    assert.equal(run([file, "weaver_test", "./data-test"]).status, 1);
  } finally {
    cleanup();
  }
});

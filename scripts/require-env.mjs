#!/usr/bin/env node
// Guards the root db:*/test/e2e scripts: the env file must exist and name the
// expected database/data-dir pair (CLAUDE.md "Three databases").
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const GUARDED_KEYS = ["DATABASE_URL", "WEAVER_DATA_DIR"];
const USAGE =
  "usage: node scripts/require-env.mjs <env-file> <database-name> <data-dir> -- <command...>";

function fail(message) {
  process.stderr.write(`require-env: ${message}\n`);
  process.exit(1);
}

function databaseName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

const [envFile, expectedDb, expectedDataDir, separator, ...command] =
  process.argv.slice(2);
if (
  !envFile ||
  !expectedDb ||
  !expectedDataDir ||
  separator !== "--" ||
  command.length === 0
) {
  fail(USAGE);
}

const root = process.cwd();
const file = path.resolve(root, envFile);
if (!existsSync(file)) {
  fail(
    `${envFile} is missing; create it from .env.example pointing at database "${expectedDb}" and WEAVER_DATA_DIR=${expectedDataDir} (see docs/setup.md).`,
  );
}

const fileEnv = parse(readFileSync(file, "utf8"));
for (const key of GUARDED_KEYS) {
  if (!fileEnv[key]) fail(`${envFile} does not set ${key}.`);
  const shellValue = process.env[key];
  if (shellValue !== undefined && shellValue !== fileEnv[key]) {
    fail(
      `${key} is set in the shell and differs from ${envFile}; unset it so the file decides which database/data directory is used.`,
    );
  }
}

const actualDb = databaseName(fileEnv.DATABASE_URL);
if (actualDb !== expectedDb) {
  fail(
    `${envFile} DATABASE_URL targets database "${actualDb ?? "<unparseable>"}", expected "${expectedDb}".`,
  );
}

if (
  ["weaver_test", "weaver_e2e"].includes(expectedDb) &&
  !["localhost", "127.0.0.1", "[::1]", "postgres"].includes(
    new URL(fileEnv.DATABASE_URL).hostname,
  )
) {
  fail(
    "Destructive test commands require a local database host (localhost, loopback or postgres).",
  );
}

if (["weaver_test", "weaver_e2e"].includes(expectedDb)) {
  const url = new URL(fileEnv.DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.searchParams.has("host") ||
    url.searchParams.has("hostaddr")
  ) {
    fail(
      "Test database connections must use a canonical local PostgreSQL URL without host overrides.",
    );
  }
}

const actualDataDir = path.resolve(root, fileEnv.WEAVER_DATA_DIR);
const wantedDataDir = path.resolve(root, expectedDataDir);
if (actualDataDir !== wantedDataDir) {
  fail(
    `${envFile} WEAVER_DATA_DIR resolves to ${actualDataDir}, expected ${wantedDataDir} (${expectedDataDir}).`,
  );
}

// Same precedence as dotenv-cli: values already in the shell win.
const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  env: { ...fileEnv, ...process.env },
});
if (result.error) fail(result.error.message);
process.exit(result.status ?? 1);

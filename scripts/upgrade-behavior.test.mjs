import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const APP_REPOS = ["tools", "web", "worker", "mcp"].map(
  (r) => `registry.example/weaver/${r}`,
);

function runUpgrade(t, overrides = {}, ref = "main", webEnv = "") {
  const dir = mkdtempSync(join(tmpdir(), "weaver-upgrade-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "web.env"),
    "WEAVER_PUBLIC_HOST=weaver.example\nWEAVER_BASE_PATH=/weaver\nWEAVER_GITLAB_API=https://gitlab.example/api/v4\nWEAVER_GITLAB_PROJECT=group%2Fweaver\n" +
      webEnv,
  );
  writeFileSync(join(dir, "gitlab-token"), "TEST_ONLY_TOKEN");
  const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, name + " " + args.join(" ") + "\\n");
const expected = "a".repeat(40);
if (name === "curl") {
  const url = args.find(a => a.startsWith("https://"));
  if (args.includes("-o")) fs.writeFileSync(args[args.indexOf("-o") + 1], "stub deploy file");
  else if (url.includes("/repository/commits/")) console.log(JSON.stringify({ id: expected }));
  else console.log(JSON.stringify({ commitSha: process.env.STALE === "1" ? "b".repeat(40) : expected }));
} else if (name === "docker") {
  if (args.includes("pull") && process.env.PULL_FAIL === "1") process.exit(1);
  if (args.includes("ps")) for (let i = 0; i < 3; i++) console.log(JSON.stringify({ State: "running", Health: process.env.UNHEALTHY === "1" ? "unhealthy" : "healthy" }));
  if (args.includes("config")) {
    for (const r of ["tools", "web", "worker", "worker", "mcp"]) console.log("registry.example/weaver/" + r + ":aaaaaaaa");
    console.log("pgvector/pgvector:0.8.6-pg17-trixie");
  }
  if (args[0] === "image" && args[1] === "ls") for (const tag of ["aaaaaaaa", "cccccccc", "dddddddd", "latest", "<none>"]) console.log(tag);
  if (args[0] === "image" && args[1] === "rm" && args[2] === process.env.IN_USE) process.exit(1);
} else if (name === "jq") {
  const raw = fs.readFileSync(0, "utf8").trim();
  const values = raw ? raw.split("\\n").map(line => JSON.parse(line)) : [];
  if (args.includes("-se")) process.exit(values.length === 3 && values.every(v => v.State === "running" && v.Health === "healthy") ? 0 : 1);
  const value = values[0];
  if (!value) process.exit(1);
  console.log(args.at(-1) === ".id" ? value.id : value.commitSha || "");
}
`;
  for (const name of [
    "curl",
    "docker",
    "jq",
    "install",
    "systemctl",
    "flock",
    "sleep",
  ]) {
    writeFileSync(join(dir, name), stub);
    chmodSync(join(dir, name), 0o755);
  }
  const result = spawnSync("sh", [resolve("deploy/weaver-upgrade"), ref], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      WEAVER_DEPLOY_ROOT: dir,
      CALL_LOG: log,
      ...overrides,
    },
    encoding: "utf8",
  });
  return { ...result, calls: readFileSync(log, "utf8") };
}

test("an upgrade aborts before install or reload when the exact image pull fails", (t) => {
  const result = runUpgrade(t, { PULL_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /^install |^systemctl /m);
  assert.doesNotMatch(result.calls, /ignore-pull-failures/);
});

test("an old revision cannot pass the upgrade health check", (t) => {
  const result = runUpgrade(t, { STALE: "1" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /image prune/);
});

test("a crash-looping worker cannot pass the upgrade health check", (t) => {
  const result = runUpgrade(t, { UNHEALTHY: "1" });
  assert.notEqual(result.status, 0);
});

test("matching revision and ready workers complete an upgrade", (t) => {
  const result = runUpgrade(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /upgraded to a{40}/);
  assert.match(result.calls, /raw\?ref=a{40}/);
});

test("a successful upgrade keeps the new and previous image sets and removes older ones", (t) => {
  const result = runUpgrade(t, {}, "main", "WEAVER_IMAGE_TAG=cccccccc\n");
  assert.equal(result.status, 0, result.stderr);
  const removed = result.calls
    .split("\n")
    .filter((line) => line.startsWith("docker image rm "))
    .map((line) => line.slice("docker image rm ".length))
    .sort();
  assert.deepEqual(
    removed,
    APP_REPOS.flatMap((repo) => [`${repo}:dddddddd`, `${repo}:latest`]).sort(),
  );
  assert.match(result.calls, /^docker image prune -f$/m);
});

test("an image that cannot be removed does not fail a finished upgrade", (t) => {
  const result = runUpgrade(
    t,
    { IN_USE: "registry.example/weaver/web:latest" },
    "main",
    "WEAVER_IMAGE_TAG=cccccccc\n",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /upgraded to a{40}/);
  assert.match(result.stderr, /registry\.example\/weaver\/web:latest/);
});

test("rollback refs are refused before changing deployment state", (t) => {
  const result = runUpgrade(t, {}, "v0.1.100");
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, "");
});

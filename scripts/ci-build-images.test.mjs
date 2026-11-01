import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Runs the CI build script against a stub `docker` that records every call.
function runBuild(env, expectedStatus = 0) {
  const dir = mkdtempSync(join(tmpdir(), "weaver-ci-"));
  const log = join(dir, "calls.log");
  const stub = join(dir, "docker");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1" = manifest ]; then echo "no such manifest" >&2; exit 1; fi\n`,
  );
  chmodSync(stub, 0o755);
  const result = spawnSync("sh", ["deploy/ci/build-images.sh"], {
    env: {
      PATH: process.env.PATH,
      CI_COMMIT_BRANCH: "main",
      CI_DEFAULT_BRANCH: "main",
      CI_COMMIT_TAG: "",
      IMAGE: "registry.test/weaver",
      COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      SHORT_SHA: "01234567",
      BUILD_TIME: "2026-09-22T10:00:00Z",
      BASE_PATH: "/weaver",
      DOCKER: stub,
      ...env,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, expectedStatus, result.stderr);
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

const builds = (calls) => calls.filter((c) => c.startsWith("build "));
const pushes = (calls) => calls.filter((c) => c.startsWith("push "));

test("builds the seven images in order with registry cache and build args", () => {
  const calls = runBuild({ PUSH_TAGS: "" });
  const order = builds(calls).map((c) => c.match(/-t (\S+)/)[1]);
  assert.deepEqual(order, [
    "registry.test/weaver/onenote-reader-build:01234567",
    "registry.test/weaver/tools:01234567",
    "registry.test/weaver/web:01234567",
    "registry.test/weaver/worker-build:01234567",
    "registry.test/weaver/worker:01234567",
    "registry.test/weaver/mcp-build:01234567",
    "registry.test/weaver/mcp:01234567",
  ]);
  const web = builds(calls)[2];
  assert.match(web, /--target runtime/);
  assert.match(web, /--cache-from registry\.test\/weaver\/tools:latest/);
  assert.match(web, /--cache-from registry\.test\/weaver\/web:latest/);
  assert.match(web, /--build-arg BUILDKIT_INLINE_CACHE=1/);
  assert.match(web, /--build-arg NEXT_PUBLIC_BASE_PATH=\/weaver/);
  assert.match(
    web,
    /--build-arg APP_COMMIT_SHA=0123456789abcdef0123456789abcdef01234567/,
  );
  assert.match(web, /--build-arg APP_BUILD_TIME=2026-09-22T10:00:00Z/);
  assert.match(
    web,
    /--label org\.opencontainers\.image\.revision=0123456789abcdef0123456789abcdef01234567/,
  );
  assert.ok(
    builds(calls).every((c) => c.includes("--provenance=false")),
    "provenance attestations would publish the Git remote of the build",
  );
  assert.match(builds(calls)[0], /--target notebook-build/);
  assert.match(builds(calls)[3], /--target build/);
  const worker = builds(calls)[4];
  assert.match(worker, /--target runtime/);
  assert.match(
    worker,
    /--cache-from registry\.test\/weaver\/onenote-reader-build:latest/,
  );
  assert.match(
    worker,
    /--cache-from registry\.test\/weaver\/worker-build:latest/,
  );
  assert.match(builds(calls)[5], /--target build/);
  const mcp = builds(calls)[6];
  assert.match(mcp, /--target runtime/);
  assert.match(mcp, /--cache-from registry\.test\/weaver\/mcp-build:latest/);
});

test("smoke-tests every runtime image before any push", () => {
  const calls = runBuild({ PUSH_TAGS: "latest" });
  const firstPush = calls.findIndex((c) => c.startsWith("push "));
  const runs = calls
    .map((c, i) => [c, i])
    .filter(([c]) => c.startsWith("run "));
  assert.equal(runs.length, 4, "tools, web, worker, mcp are each smoke-tested");
  assert.ok(
    runs.every(([, i]) => i < firstPush),
    "smoke tests precede pushes",
  );
  assert.ok(
    runs.every(([c]) => /for p in .*\.claude.*CLAUDE\.md.*docs/.test(c)),
    "every published image is checked for agent instructions and internal docs",
  );
  assert.ok(runs.some(([c]) => c.includes("weaver-onenote-reader")));
  assert.ok(runs.some(([c]) => c.includes("apps/web/server.js")));
  const toolsRun = runs.find(([c]) => c.includes("prisma --version"));
  assert.ok(toolsRun, "tools image is smoke-tested");
  assert.match(
    toolsRun[0],
    /DATABASE_URL=/,
    "tools smoke test needs a placeholder DATABASE_URL: the Prisma config resolves it at load time",
  );
});

test("pushes nothing without PUSH_TAGS, every requested tag for app images, and latest only for cache images", () => {
  assert.deepEqual(pushes(runBuild({ PUSH_TAGS: "" })), []);
  const calls = runBuild({ PUSH_TAGS: "latest 0.1.117", PUSH_CACHE: "1" });
  const pushed = pushes(calls)
    .map((c) => c.slice("push ".length))
    .sort();
  const expected = [];
  for (const image of ["tools", "web", "worker", "mcp"]) {
    for (const tag of ["01234567", "latest", "0.1.117"])
      expected.push(`registry.test/weaver/${image}:${tag}`);
  }
  for (const image of ["onenote-reader-build", "worker-build", "mcp-build"]) {
    expected.push(`registry.test/weaver/${image}:latest`);
  }
  assert.deepEqual(pushed, expected.sort());
  assert.ok(
    calls.some(
      (c) =>
        c ===
        "tag registry.test/weaver/web:01234567 registry.test/weaver/web:0.1.117",
    ),
  );
  assert.ok(
    calls.some(
      (c) =>
        c ===
        "tag registry.test/weaver/onenote-reader-build:01234567 registry.test/weaver/onenote-reader-build:latest",
    ),
    "cache images are tagged :latest from the short-sha build",
  );
});

test("tag pipelines leave the default branch build caches alone", () => {
  const calls = runBuild({ PUSH_TAGS: "v0.1.119" });
  assert.ok(pushes(calls).every((call) => !call.endsWith(":latest")));
});

test("web smoke executes the version guard", () => {
  const calls = runBuild({ PUSH_TAGS: "" });
  assert.ok(
    calls.some((call) =>
      call.includes("node --import ./apps/web/server-lifecycle.mjs"),
    ),
  );
});

test("web smoke launches Chromium through the traced playwright-core", () => {
  const calls = runBuild({ PUSH_TAGS: "" });
  const web = calls.find(
    (call) => call.startsWith("run ") && call.includes("apps/web/server.js"),
  );
  assert.ok(web, "web image is smoke-tested");
  assert.match(web, /apps\/web\/\.next\/node_modules\/playwright-core-\*/);
  assert.match(web, /chromium\.launch\(/);
  assert.match(web, /WEAVER_CHROMIUM_PATH/);
});

test("web smoke finds the Mermaid bundle where the PDF export reads it", () => {
  const calls = runBuild({ PUSH_TAGS: "" });
  const web = calls.find(
    (call) => call.startsWith("run ") && call.includes("apps/web/server.js"),
  );
  assert.match(
    web,
    /test -s apps\/web\/node_modules\/mermaid\/dist\/mermaid\.min\.js/,
  );
  const render = readFileSync(
    "apps/web/src/server/documents/pdf/render.ts",
    "utf8",
  );
  assert.match(render, /"node_modules\/mermaid\/dist\/mermaid\.min\.js"/);
  assert.doesNotMatch(
    render,
    /createRequire|require\.resolve|import\.meta\.resolve/,
    "the bundler compiles require.resolve() to a module id, not a path",
  );
});

test("tag and non-default branch pipelines cannot publish floating aliases", () => {
  assert.deepEqual(
    runBuild({ CI_COMMIT_TAG: "latest", PUSH_TAGS: "latest" }, 1),
    [],
  );
  assert.deepEqual(
    runBuild({ CI_COMMIT_BRANCH: "feature", PUSH_TAGS: "latest" }, 1),
    [],
  );
  assert.deepEqual(
    runBuild({ CI_COMMIT_TAG: "v1", PUSH_TAGS: "v1", PUSH_CACHE: "1" }, 1),
    [],
  );
});

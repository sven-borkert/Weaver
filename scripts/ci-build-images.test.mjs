import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Runs the CI build script against a stub `docker` that records every call.
function runBuild(env, expectedStatus = 0) {
  const dir = mkdtempSync(join(tmpdir(), "weaver-ci-"));
  try {
    const log = join(dir, "calls.log");
    const stub = join(dir, "docker");
    const git = join(dir, "git");
    const local = join(dir, "local");
    const registry = join(dir, "registry");
    mkdirSync(local);
    mkdirSync(registry);
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const args = process.argv.slice(2);
const [command, subcommand, operation] = args;
const local = ${JSON.stringify(local)};
const registry = process.env.TEST_REGISTRY;
const leaf = (ref) => ref.split("/").at(-1);
const load = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
const option = (name) => args[args.indexOf(name) + 1];
const fail = (message) => { console.error(message); process.exit(1); };
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
function lookup(ref) {
  const [name, digest] = leaf(ref).split("@");
  if (digest) {
    for (const key of readdirSync(registry)) {
      if (!key.startsWith(name + ":")) continue;
      const image = load(join(registry, key));
      if (image.digest === digest) return image;
    }
    return undefined;
  }
  const path = join(registry, name);
  return existsSync(path) ? load(path) : undefined;
}
function publish(ref, image) {
  if (leaf(ref) === process.env.TEST_FAILED_PUSH) fail("simulated push failed: " + ref);
  save(join(registry, leaf(ref)), image);
}
if (command === "build") {
  if (process.env.TEST_FAIL_BUILD === "1") fail("local build unavailable");
  const ref = leaf(option("-t"));
  const name = ref.split(":")[0];
  const manifest = ref.includes(":weaver-ci-release-") ? readFileSync(join(args.at(-1), "release"), "utf8").trim() : undefined;
  const image = {
    commit: process.env.COMMIT_SHA,
    basePath: process.env.BASE_PATH,
    buildId: manifest ? undefined : process.env.TEST_BUILD_ID,
    manifest,
  };
  image.digest = "sha256:" + createHash("sha256").update(name + JSON.stringify(image)).digest("hex");
  save(join(local, ref), image);
} else if (command === "buildx" && subcommand === "imagetools" && operation === "inspect") {
  const ref = args.at(-1);
  if (leaf(ref) === process.env.TEST_FAILED_INSPECT) fail("ERROR: config was not found at the registry");
  const image = lookup(ref);
  if (!image) fail("ERROR: " + ref + ": not found");
  const template = option("--format");
  if (template.includes(".Manifest.Digest")) console.log(image.digest);
  else if (template.includes("org.weaver.release.digests")) console.log(image.commit + "|" + image.basePath + "|" + image.manifest);
  else if (template.includes("org.weaver.base-path")) console.log(image.commit + "|" + image.basePath);
  else fail("unsupported inspect template: " + template);
} else if (command === "buildx" && subcommand === "imagetools" && operation === "create") {
  const source = lookup(args.at(-1));
  if (!source) fail("missing alias source");
  publish(option("--tag"), source);
} else if (command === "tag") {
  save(join(local, leaf(args[2])), load(join(local, leaf(args[1]))));
} else if (command === "push") {
  const ref = args.at(-1);
  publish(ref, load(join(local, leaf(ref))));
} else if (command !== "run") {
  fail("unsupported docker command: " + args.join(" "));
}
`,
    );
    chmodSync(stub, 0o755);
    writeFileSync(
      git,
      '#!/bin/sh\n[ "$1 $2 $3 $4" = "ls-remote --exit-code origin refs/heads/main" ] || exit 1\nprintf "%s\\trefs/heads/main\\n" "${TEST_BRANCH_TIP:-$COMMIT_SHA}"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["deploy/ci/build-images.sh"], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CI_COMMIT_BRANCH: "main",
        CI_DEFAULT_BRANCH: "main",
        CI_COMMIT_TAG: "",
        IMAGE: "registry.test/weaver",
        COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
        SHORT_SHA: "01234567",
        BUILD_TIME: "2026-09-22T10:00:00Z",
        BASE_PATH: "/weaver",
        DOCKER: stub,
        TEST_REGISTRY: registry,
        TEST_BUILD_ID: "default",
        ...env,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const builds = (calls) => calls.filter((c) => c.startsWith("build "));
const pushes = (calls) =>
  calls.flatMap((call) => {
    const target = call.startsWith("push ")
      ? call.slice("push ".length)
      : /^buildx imagetools create --prefer-index=false --tag (\S+)/.exec(
          call,
        )?.[1];
    return target && !target.includes(":weaver-ci-") ? [`push ${target}`] : [];
  });

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
    calls.some((c) =>
      /^buildx imagetools create --prefer-index=false --tag registry\.test\/weaver\/web:0\.1\.117 registry\.test\/weaver\/web@sha256:[0-9a-f]{64}$/.test(
        c,
      ),
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

const runtimeImages = ["tools", "web", "worker", "mcp"];
const commit = "0123456789abcdef0123456789abcdef01234567";
const stageTag = `weaver-ci-stage-${commit}`;
const manifestTag = `weaver-ci-release-${commit}`;
const readImage = (registry, name, tag) =>
  JSON.parse(readFileSync(join(registry, `${name}:${tag}`), "utf8"));

function withRegistry(run) {
  const registry = mkdtempSync(join(tmpdir(), "weaver-release-"));
  try {
    run(registry, { TEST_REGISTRY: registry, PUSH_TAGS: "latest 0.1.117" });
  } finally {
    rmSync(registry, { recursive: true, force: true });
  }
}

test("an interrupted staging publishes no aliases and retains staged images for the next attempt", () => {
  withRegistry((registry, env) => {
    const failed = runBuild(
      {
        ...env,
        TEST_BUILD_ID: "first",
        TEST_FAILED_PUSH: `worker:${stageTag}`,
      },
      1,
    );
    assert.deepEqual(pushes(failed), []);
    assert.equal(existsSync(join(registry, `tools:${manifestTag}`)), false);
    runBuild({ ...env, TEST_BUILD_ID: "retry" });
    for (const name of runtimeImages) {
      const version = readImage(registry, name, "0.1.117");
      assert.equal(
        version.buildId,
        ["tools", "web"].includes(name) ? "first" : "retry",
      );
      assert.equal(version.digest, readImage(registry, name, stageTag).digest);
    }
  });
});

test("resumes an interrupted publish from the same complete digest manifest and updates latest last", () => {
  withRegistry((registry, env) => {
    runBuild(
      { ...env, TEST_BUILD_ID: "first", TEST_FAILED_PUSH: "web:01234567" },
      1,
    );
    assert.ok(existsSync(join(registry, "tools:0.1.117")));
    assert.equal(existsSync(join(registry, "tools:latest")), false);
    const originalManifest = readImage(registry, "tools", manifestTag);
    const originalDigests = runtimeImages.map(
      (name) => readImage(registry, name, stageTag).digest,
    );
    assert.equal(originalManifest.manifest, originalDigests.join(" "));

    const retry = runBuild({ ...env, TEST_FAIL_BUILD: "1" });
    assert.deepEqual(builds(retry), []);
    const publishing = pushes(retry);
    const firstLatest = publishing.findIndex((call) =>
      call.endsWith(":latest"),
    );
    assert.ok(firstLatest > 0);
    assert.ok(
      publishing.slice(firstLatest).every((call) => call.endsWith(":latest")),
    );
    assert.equal(
      publishing.some((call) => call.endsWith("/tools:0.1.117")),
      false,
    );
    assert.deepEqual(
      readImage(registry, "tools", manifestTag),
      originalManifest,
    );
    for (const [index, name] of runtimeImages.entries()) {
      const latest = readImage(registry, name, "latest");
      assert.equal(latest.buildId, "first");
      assert.equal(latest.digest, originalDigests[index]);
      assert.equal(latest.digest, readImage(registry, name, "0.1.117").digest);
      assert.equal(latest.digest, readImage(registry, name, "01234567").digest);
    }
  });
});

test("rejects an immutable alias with a different digest despite matching build labels", () => {
  withRegistry((registry, env) => {
    runBuild(
      { ...env, TEST_BUILD_ID: "first", TEST_FAILED_PUSH: "web:01234567" },
      1,
    );
    const alias = readImage(registry, "tools", "0.1.117");
    writeFileSync(
      join(registry, "tools:0.1.117"),
      JSON.stringify({ ...alias, digest: "sha256:" + "0".repeat(64) }),
    );
    assert.deepEqual(
      pushes(runBuild({ ...env, TEST_BUILD_ID: "retry" }, 1)),
      [],
    );
    assert.equal(
      readImage(registry, "tools", "0.1.117").digest,
      "sha256:" + "0".repeat(64),
    );
    assert.equal(existsSync(join(registry, "tools:latest")), false);
  });
});

test("does not republish latest when rerunning a completed older release", () => {
  withRegistry((registry, env) => {
    runBuild({ ...env, TEST_BUILD_ID: "first" });
    runBuild({
      ...env,
      COMMIT_SHA: "fedcba9876543210fedcba9876543210fedcba98",
      SHORT_SHA: "fedcba98",
      PUSH_TAGS: "latest 0.1.118",
      TEST_BUILD_ID: "newer",
    });
    assert.deepEqual(pushes(runBuild({ ...env, TEST_BUILD_ID: "retry" })), []);
    for (const name of runtimeImages)
      assert.equal(readImage(registry, name, "latest").buildId, "newer");
  });
});

test("an interrupted older release repairs immutable aliases without moving latest backward", () => {
  withRegistry((registry, env) => {
    const newer = "fedcba9876543210fedcba9876543210fedcba98";
    runBuild(
      { ...env, TEST_BUILD_ID: "first", TEST_FAILED_PUSH: "web:latest" },
      1,
    );
    runBuild({
      ...env,
      COMMIT_SHA: newer,
      SHORT_SHA: "fedcba98",
      PUSH_TAGS: "latest 0.1.118",
      TEST_BUILD_ID: "newer",
    });
    rmSync(join(registry, "web:0.1.117"));
    const calls = runBuild({ ...env, TEST_BRANCH_TIP: newer, PUSH_CACHE: "1" });
    assert.deepEqual(pushes(calls), ["push registry.test/weaver/web:0.1.117"]);
    assert.equal(readImage(registry, "web", "0.1.117").commit, commit);
    for (const name of runtimeImages)
      assert.equal(readImage(registry, name, "latest").commit, newer);
  });
});

test("fails closed on registry inspection failure even when the error contains not found", () => {
  withRegistry((registry, env) => {
    const calls = runBuild(
      { ...env, TEST_FAILED_INSPECT: `tools:${manifestTag}` },
      1,
    );
    assert.deepEqual(pushes(calls), []);
    assert.equal(readdirSync(registry).length, 0);
  });
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

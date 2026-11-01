import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const requireWeb = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const signalListeners = process.listenerCount("SIGTERM");
await import("../apps/web/server-lifecycle.mjs");
const NextServer = requireWeb("next/dist/server/next-server.js").default;
const hook = Symbol.for("weaver.web.cleanup");

test("production adapter preserves native signals and waits for Next after-work", async () => {
  assert.equal(process.listenerCount("SIGTERM"), signalListeners);
  const calls = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  globalThis[hook] = async () => {
    calls.push("weaver");
  };
  try {
    const closed = NextServer.prototype.close.call({
      cleanupListeners: {
        runAll: async () => {
          await pending;
          calls.push("next");
        },
      },
    });
    await Promise.resolve();
    assert.deepEqual(calls, []);
    release();
    await closed;
    assert.deepEqual(calls, ["next", "weaver"]);
  } finally {
    delete globalThis[hook];
  }
});

test("Next launcher still drains the HTTP server before its application close hook", () => {
  const source = readFileSync(
    requireWeb.resolve("next/dist/server/lib/start-server.js"),
    "utf8",
  );
  const cleanup = source.slice(source.indexOf("const cleanup ="));
  assert.match(
    cleanup,
    /await new Promise[\s\S]*?server\.close\([\s\S]*?await Promise\.all\([\s\S]*?nextServer\.close\(/,
  );
  const dockerfile = readFileSync("docker/web.Dockerfile", "utf8");
  assert.doesNotMatch(dockerfile, /NEXT_MANUAL_SIG_HANDLE/);
  assert.match(dockerfile, /"--import", "\.\/apps\/web\/server-lifecycle.mjs"/);
});

test("launchers select React mode before preloading Next and allow development cleanup", () => {
  const { scripts } = JSON.parse(readFileSync("apps/web/package.json", "utf8"));
  assert.match(scripts.start, /^NODE_ENV=production node --import/);
  assert.match(
    scripts.dev,
    /^NODE_ENV=development NEXT_EXIT_TIMEOUT_MS=25000 node --import/,
  );
});

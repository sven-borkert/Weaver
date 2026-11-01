import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const turbo = JSON.parse(
  readFileSync(new URL("../turbo.json", import.meta.url), "utf8"),
);

test("shared lint and compiler configuration invalidates every cached task", () => {
  for (const file of ["tsconfig.base.json", "eslint.config.js"]) {
    assert.ok(
      turbo.globalDependencies?.includes(file),
      `${file} must be a Turbo global dependency`,
    );
  }
});

test("the web build is keyed on the root package version", () => {
  assert.ok(
    turbo.tasks.build.inputs.includes("$TURBO_ROOT$/package.json"),
    "next.config.ts reads the version from the root package.json",
  );
  assert.ok(turbo.tasks.build.inputs.includes("$TURBO_DEFAULT$"));
});

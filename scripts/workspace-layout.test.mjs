import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

test("the repository exposes the Phase 4 workspace skeleton", () => {
  assert.equal(existsSync("apps/web/package.json"), true);
  assert.equal(existsSync("turbo.json"), true);
  assert.equal(existsSync("src"), false);
  const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
  assert.match(workspace, /packages:\s*[\s\S]*apps\/\*/);
  assert.match(workspace, /packages:\s*[\s\S]*packages\/\*/);
});

test("the MCP runtime and package are part of the workspace", () => {
  assert.equal(existsSync("apps/mcp-server/package.json"), true);
  assert.equal(existsSync("packages/mcp/package.json"), true);
  assert.equal(existsSync("docker/mcp.Dockerfile"), true);
  assert.equal(existsSync("packages/ingestion/package.json"), true);
});

test("every supported migration entry point uses the guarded deploy wrapper", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const database = JSON.parse(readFileSync("packages/db/package.json", "utf8"));
  assert.equal(
    database.scripts["migrate:deploy"],
    "tsx prisma/migrate-deploy.ts",
  );
  for (const name of ["db:migrate", "db:test:migrate", "db:e2e:migrate"]) {
    assert.match(root.scripts[name], /@weaver\/db migrate:deploy$/);
    assert.doesNotMatch(root.scripts[name], /prisma migrate deploy/);
  }
  assert.equal(existsSync("packages/db/prisma/migrate-deploy.ts"), true);
});

test("container dependency installs include every shared workspace manifest", () => {
  const manifests = readdirSync("packages")
    .map((name) => `packages/${name}/package.json`)
    .filter(existsSync);
  for (const name of ["web", "worker", "mcp"]) {
    const source = readFileSync(`docker/${name}.Dockerfile`, "utf8");
    for (const stage of source.split(/^FROM /m)) {
      if (!stage.includes("RUN pnpm install")) continue;
      const beforeInstall = stage.split("RUN pnpm install")[0];
      for (const manifest of manifests)
        assert.ok(
          beforeInstall.includes(`COPY ${manifest} ${manifest}`),
          `${name}: missing ${manifest} before dependency install`,
        );
    }
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const check = (shell, file) => {
  const result = spawnSync(shell, ["-n", file], { encoding: "utf8" });
  assert.equal(result.status, 0, `${shell} -n ${file}: ${result.stderr}`);
};

test("host scripts parse and never build on the host", () => {
  check("sh", "deploy/weaver-compose-up");
  check("sh", "deploy/weaver-upgrade");
  check("bash", "deploy/weaver-backup");
  check("sh", "deploy/ci/build-images.sh");
  const up = readFileSync("deploy/weaver-compose-up", "utf8");
  assert.doesNotMatch(
    up,
    /compose build|APP_BUILD_TIME|APP_COMMIT_SHA|REPO_DIR/,
  );
  assert.match(up, /compose pull/);
  assert.match(
    up,
    /COMPOSE_FILE_PATH:-\$WEAVER_DEPLOY_ROOT\/docker-compose\.yml/,
  );
  assert.match(
    readFileSync("deploy/weaver-backup", "utf8"),
    /COMPOSE_FILE_PATH:-\$WEAVER_DEPLOY_ROOT\/docker-compose\.yml/,
  );
});

test("the stack unit runs from the deploy root without a checkout", () => {
  const unit = readFileSync("deploy/weaver-docker.service", "utf8");
  assert.match(unit, /^WorkingDirectory=\/srv\/weaver$/m);
  assert.match(unit, /-f \/srv\/weaver\/docker-compose\.yml down/);
  assert.doesNotMatch(unit, /\/opt\/weaver/);
  assert.match(unit, /^TimeoutStartSec=900$/m);
});

test("weaver-upgrade fetches every deploy file for the requested ref", () => {
  const upgrade = readFileSync("deploy/weaver-upgrade", "utf8");
  for (const file of [
    "docker-compose.yml",
    "deploy/weaver-compose-up",
    "deploy/weaver-upgrade",
    "deploy/weaver-backup",
    "deploy/weaver-docker.service",
    "deploy/weaver-backup.service",
    "deploy/weaver-backup.timer",
  ]) {
    assert.ok(upgrade.includes(file), `weaver-upgrade must fetch ${file}`);
  }
  assert.match(upgrade, /repository\/files\//);
  assert.match(upgrade, /PRIVATE-TOKEN/);
  assert.match(upgrade, /gitlab-token/);
  assert.match(upgrade, /systemctl daemon-reload/);
  assert.match(upgrade, /systemctl reload-or-restart weaver-docker\.service/);
  assert.match(upgrade, /api\/health/);
  assert.match(
    upgrade,
    /image prune/,
    "old image sets must be pruned after a successful reload",
  );
  assert.match(
    upgrade,
    /seq 1 30/,
    "the final health check must retry while web is still starting",
  );
  assert.match(upgrade, /sleep 2/);
});

test("weaver-upgrade never puts the token on the curl command line", () => {
  const upgrade = readFileSync("deploy/weaver-upgrade", "utf8");
  assert.match(upgrade, /--header @/);
  assert.doesNotMatch(upgrade, /--header "PRIVATE-TOKEN: \$\(cat/);
});

test("reload stops application writers before migrations while retaining postgres", () => {
  const up = readFileSync("deploy/weaver-compose-up", "utf8");
  const stop = up.indexOf(
    "compose stop web agent-worker ingestion-worker mcp-server",
  );
  const migrate = up.indexOf(
    "compose up -d --no-deps --force-recreate migrations",
  );
  const wait = up.indexOf("compose wait migrations");
  const start = up.indexOf("compose up -d --no-deps --force-recreate web");
  assert.ok(stop > 0 && stop < migrate && migrate < wait && wait < start);
  assert.doesNotMatch(
    up,
    /compose (?:down|stop postgres)|--force-recreate postgres/,
  );
});

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("deploy/weaver-backup", "utf8");

function position(pattern, message) {
  const match = pattern.exec(script);
  assert.ok(match, message);
  return match.index;
}

// Assert only the decisions this test protects, not the script's spelling.
test("backup stops the application services before dumping the database", () => {
  assert.match(
    script,
    /^APP_SERVICES="web agent-worker ingestion-worker mcp-server"$/m,
    "every writer of the database and data tree must be quiesced",
  );
  assert.match(
    script,
    /compose ps --services --status running/,
    "running and restarting writers must be stopped and restarted",
  );
  const stop = position(
    /compose stop \$stopped_services/,
    "missing compose stop",
  );
  const dump = position(/exec -T postgres pg_dump/, "missing pg_dump");
  assert.ok(stop < dump, "services must stop before pg_dump runs");
});

test("backup never stops postgres", () => {
  const services = /^APP_SERVICES="([^"]*)"$/m.exec(script)?.[1] ?? "";
  assert.doesNotMatch(services, /postgres/);
  assert.doesNotMatch(script, /compose (?:stop|down|rm|kill)[^\n]*postgres/);
  assert.doesNotMatch(script, /compose down/);
});

test("backup restarts the stopped services on every exit path", () => {
  assert.match(script, /^trap cleanup EXIT$/m);
  const cleanup = /^cleanup\(\) \{\n([\s\S]*?)^\}/m.exec(script)?.[1] ?? "";
  assert.match(cleanup, /restart_services/, "the exit trap must restart");
  assert.match(
    script,
    /compose start \$stopped_services/,
    "restart uses start, which neither rebuilds nor runs migrations",
  );
  assert.doesNotMatch(script, /compose up/);
});

test("backup restarts the services before verifying and publishing", () => {
  const tar = position(/^tar -C .* -czf /m, "missing data archive");
  const restart = position(/^restart_services$/m, "missing main-path restart");
  const verify = position(/^gzip -t /m, "missing gzip verification");
  assert.ok(tar < restart, "services stay stopped while tar reads the tree");
  assert.ok(restart < verify, "verification must not extend the outage");
});

test("backup treats every nonzero tar status as fatal", () => {
  assert.doesNotMatch(script, /tar_status/);
  assert.doesNotMatch(script, /-gt 1/);
  assert.doesNotMatch(script, /^tar -C [^\n]*\|\|/m);
  assert.match(script, /^set -euo pipefail$/m);
});

test("backup checks every repository and the archive before publishing", () => {
  const fsck = position(
    /git -c safe\.directory='\*' -C "\$repo" fsck --connectivity-only --no-dangling/,
    "missing git fsck",
  );
  const list = position(
    /^tar -tzf "\$data_file\.tmp" >\/dev\/null$/m,
    "missing tar listing",
  );
  const publish = position(/^mv "\$data_file\.tmp"/m, "missing publish step");
  assert.ok(fsck < publish, "fsck must run before the backup is published");
  assert.ok(list < publish, "the archive must be listed before publishing");
  assert.match(script, /\[ -d "\$repo" \] \|\| continue/, "no-repos guard");
});

test("a repository failing fsck keeps older backups and fails the run", () => {
  const prune = position(/-mtime "\+\$RETENTION_DAYS" -print -delete/, "prune");
  const guard = position(
    /^if \[ "\$fsck_failed" -eq 0 \]; then$/m,
    "prune guard",
  );
  assert.ok(guard < prune, "pruning must be skipped after an fsck failure");
  assert.match(script, /if \[ "\$fsck_failed" -ne 0 \]; then\n  exit 1\nfi/);
});

test("backup unit allows for the service drain", () => {
  const unit = readFileSync("deploy/weaver-backup.service", "utf8");
  assert.match(unit, /^TimeoutStartSec=1200$/m);
});

for (const stubborn of [false, true])
  test(`backup handles restarting writers (stop fails: ${stubborn})`, () => {
    const root = mkdtempSync(join(tmpdir(), "weaver-backup-test-"));
    mkdirSync(join(root, "data"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/calls'
case "$*" in
  *" ps "*)
    if [ ! -f '${root}/stopped' ]; then
      case "$*" in *"--status restarting"*) echo agent-worker ;; esac
    elif [ '${stubborn}' = true ]; then echo agent-worker; fi ;;
  *" stop "*) touch '${root}/stopped' ;;
  *" pg_dump "*) echo 'SELECT 1;' ;;
esac
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["deploy/weaver-backup"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        WEAVER_DEPLOY_ROOT: root,
      },
    });
    const calls = readFileSync(join(root, "calls"), "utf8");
    if (stubborn) {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(calls, /pg_dump/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(calls, /stop agent-worker/);
      assert.ok(calls.indexOf("stop agent-worker") < calls.indexOf("pg_dump"));
      assert.match(calls, /start agent-worker/);
    }
  });

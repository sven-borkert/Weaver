import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openProjectRepo } from "@weaver/git-store";
import { execa, type ResultPromise } from "execa";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./_harness";
import { readEvents, waitForEvent } from "./fixtures/lock-events";

const CHILD_TIMEOUT_MS = 10_000;
const CLEANUP_GRACE_MS = 10_000;
const MAX_SEQUENTIAL_INTERNAL_DEADLINES = 2;
const OUTER_TEST_TIMEOUT_MS = 30_000;
const MIN_OUTER_TEST_TIMEOUT_MS =
  CHILD_TIMEOUT_MS * MAX_SEQUENTIAL_INTERNAL_DEADLINES + CLEANUP_GRACE_MS;

if (OUTER_TEST_TIMEOUT_MS < MIN_OUTER_TEST_TIMEOUT_MS) {
  throw new Error("outer test timeout cannot guarantee child cleanup");
}

const SAME_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const CRASH_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const fixture = fileURLToPath(
  new URL("./fixtures/git-lock-worker.ts", import.meta.url),
);
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

type WorkerMode = "crash" | "once" | "overlap" | "serial";

function startWorker(
  projectId: string,
  markerFile: string,
  workerId: string,
  mode: WorkerMode,
  holdMs = 0,
): ResultPromise {
  return execa(
    process.execPath,
    [
      "--import=tsx",
      fixture,
      projectId,
      markerFile,
      workerId,
      mode,
      String(holdMs),
    ],
    {
      cleanup: true,
      cwd: workspaceRoot,
      killSignal: "SIGKILL",
      timeout: CHILD_TIMEOUT_MS,
    },
  );
}

async function terminateWorkers(workers: ResultPromise[]): Promise<void> {
  await Promise.all(
    workers.map(async (worker) => {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
      }
      await worker.catch(() => undefined);
    }),
  );
}

async function waitForEventWhileRunning(
  markerFile: string,
  workerId: string,
  kind: string,
  worker: ResultPromise,
): Promise<void> {
  await Promise.race([
    waitForEvent(markerFile, workerId, kind, CHILD_TIMEOUT_MS),
    worker.then(
      () => {
        throw new Error(`worker exited before ${workerId}:${kind}`);
      },
      () => {
        throw new Error(`worker failed before ${workerId}:${kind}`);
      },
    ),
  ]);
}

describe("cross-process Git locking", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it(
    "serializes mixed-case UUID spellings against one repository truth",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "weaver-git-lock-"));
      const markerFile = path.join(dir, "events.log");
      const workers: ResultPromise[] = [];
      try {
        const one = startWorker(
          SAME_PROJECT_ID.toUpperCase(),
          markerFile,
          "one",
          "serial",
          150,
        );
        const two = startWorker(
          SAME_PROJECT_ID,
          markerFile,
          "two",
          "serial",
          150,
        );
        workers.push(one, two);
        await Promise.all([one, two]);

        const critical = (await readEvents(markerFile)).filter(
          (event) => event.kind === "start" || event.kind === "end",
        );
        expect(critical).toHaveLength(4);
        const firstWorker = critical[0]!.workerId;
        const secondWorker = critical[2]!.workerId;
        expect([firstWorker, secondWorker].sort()).toEqual(["one", "two"]);
        expect(
          critical.map((event) => `${event.workerId}:${event.kind}`),
        ).toEqual([
          `${firstWorker}:start`,
          `${firstWorker}:end`,
          `${secondWorker}:start`,
          `${secondWorker}:end`,
        ]);

        const repo = (await openProjectRepo(SAME_PROJECT_ID))!;
        expect((await repo.listTrackedFiles()).sort()).toEqual([
          "one.md",
          "two.md",
        ]);
      } finally {
        await terminateWorkers(workers);
        await rm(dir, { recursive: true, force: true });
      }
    },
    OUTER_TEST_TIMEOUT_MS,
  );

  it(
    "allows different projects to overlap",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "weaver-git-lock-"));
      const markerFile = path.join(dir, "events.log");
      const workers: ResultPromise[] = [];
      try {
        const alpha = startWorker(
          FIRST_PROJECT_ID,
          markerFile,
          "alpha",
          "overlap",
          100,
        );
        const beta = startWorker(
          SECOND_PROJECT_ID,
          markerFile,
          "beta",
          "overlap",
          100,
        );
        workers.push(alpha, beta);
        await Promise.all([alpha, beta]);

        const critical = (await readEvents(markerFile)).filter(
          (event) => event.kind === "start" || event.kind === "end",
        );
        expect(critical).toHaveLength(4);
        expect(critical.map((event) => event.kind)).toEqual([
          "start",
          "start",
          "end",
          "end",
        ]);
        expect(
          critical
            .slice(0, 2)
            .map((event) => event.workerId)
            .sort(),
        ).toEqual(["alpha", "beta"]);
        expect(
          critical
            .slice(2)
            .map((event) => event.workerId)
            .sort(),
        ).toEqual(["alpha", "beta"]);
      } finally {
        await terminateWorkers(workers);
        await rm(dir, { recursive: true, force: true });
      }
    },
    OUTER_TEST_TIMEOUT_MS,
  );

  it(
    "releases a project lock when the holder is killed",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "weaver-git-lock-"));
      const markerFile = path.join(dir, "events.log");
      const workers: ResultPromise[] = [];
      try {
        const crash = startWorker(
          CRASH_PROJECT_ID,
          markerFile,
          "crash",
          "crash",
        );
        workers.push(crash);
        await waitForEventWhileRunning(markerFile, "crash", "locked", crash);
        expect(crash.kill("SIGKILL")).toBe(true);
        await expect(crash).rejects.toMatchObject({ signal: "SIGKILL" });

        const successor = startWorker(
          CRASH_PROJECT_ID,
          markerFile,
          "successor",
          "once",
        );
        workers.push(successor);
        await successor;

        const events = await readEvents(markerFile);
        expect(
          events.map((event) => `${event.workerId}:${event.kind}`),
        ).toEqual(["crash:locked", "successor:start", "successor:end"]);
        const repo = (await openProjectRepo(CRASH_PROJECT_ID))!;
        expect(await repo.listTrackedFiles()).toEqual(["successor.md"]);
      } finally {
        await terminateWorkers(workers);
        await rm(dir, { recursive: true, force: true });
      }
    },
    OUTER_TEST_TIMEOUT_MS,
  );
});

it("fences publication after the advisory-lock backend is terminated", async () => {
  const { withProjectRepo } = await import("@weaver/git-store");
  const { projectRepoLockKey } =
    await import("@weaver/git-store/advisory-lock");
  const { getPrisma } = await import("./_harness");
  const projectId = "55555555-5555-4555-8555-555555555555";
  const author = {
    name: "Writer",
    email: "writer@example.test",
    userId: projectId,
  };
  let originalHead = "";
  let terminated: Array<{ terminated: boolean }> = [];
  await expect(
    withProjectRepo(projectId, async (repo) => {
      originalHead = await repo.resolveHead();
      await repo.writeFileAtomic("unpublished.md", "unpublished\n");
      const key = projectRepoLockKey(projectId);
      terminated = await getPrisma().$queryRaw<Array<{ terminated: boolean }>>`
      SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND classid = ((${key}::bigint >> 32) & 4294967295)::oid
        AND objid = (${key}::bigint & 4294967295)::oid`;
      await repo.commitAll("must not publish", author);
    }),
  ).rejects.toThrow(/terminat|abort/i);
  expect(terminated).toEqual([{ terminated: true }]);
  expect(await (await openProjectRepo(projectId))!.resolveHead()).toBe(
    originalHead,
  );
  await withProjectRepo(projectId, async (repo) => {
    expect(await repo.fileExistsInWorktree("unpublished.md")).toBe(false);
    await repo.writeFileAtomic("successor.md", "successor\n");
    await repo.commitAll("successor", author);
  });
});

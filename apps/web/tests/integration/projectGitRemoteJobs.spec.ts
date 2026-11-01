import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withProjectRepo,
  withExistingProjectRepoReader,
} from "@weaver/git-store";
import {
  GitRemoteError,
  type pushProjectToRemote,
} from "@weaver/git-store/remote";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import { FakeJobQueue } from "@weaver/core/jobs/queue";
import { encryptSecret, secretAad } from "@weaver/core/security/encryption";
import {
  discoverProjectGitRemotes,
  dispatchProjectGitRemote,
  notifyProjectContentChanged,
  pushProjectGitRemote,
  PROJECT_GIT_LEASE_MS,
  PROJECT_GIT_QUEUE_TTL_MS,
} from "@weaver/core/services/projectGitRemoteJobs";
import { setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  getPrisma,
  makeProject,
  resetDb,
  testEncryptionKeys,
} from "./_harness";

const initialTime = new Date("2026-09-09T10:00:00Z");
const pin = "example.test ssh-ed25519 AAAAtest";

async function fixture() {
  const project = await makeProject();
  const id = randomUUID();
  const encrypted = encryptSecret(
    testEncryptionKeys(),
    "synthetic-private-key",
    secretAad("project-git-remote", id),
  );
  await getPrisma().projectGitRemote.create({
    data: {
      id,
      projectId: project.id,
      remoteUrl: "git@example.test:repo.git",
      branch: "main",
      enabled: true,
      keyName: "test key",
      keyFingerprint: "SHA256:test",
      keyUploadedAt: initialTime,
      credentialCiphertext: new Uint8Array(encrypted.ciphertext),
      credentialNonce: new Uint8Array(encrypted.nonce),
      credentialTag: new Uint8Array(encrypted.tag),
      credentialKeyVersion: encrypted.keyVersion,
      nextAttemptAt: initialTime,
    },
  });
  return { projectId: project.id, id };
}

function row(id: string) {
  return getPrisma().projectGitRemote.findUniqueOrThrow({ where: { id } });
}

async function dispatch(now = initialTime) {
  const queue = new FakeJobQueue();
  await discoverProjectGitRemotes({ db: getPrisma(), queue, now });
  const job = queue.jobs.find((job) => job.name === "project.git-push");
  if (job?.name !== "project.git-push") throw new Error("Expected push job");
  return job.data;
}

function push(
  payload: Awaited<ReturnType<typeof dispatch>>,
  transport: typeof pushProjectToRemote,
  now = initialTime,
) {
  return pushProjectGitRemote({
    db: getPrisma(),
    payload,
    transport,
    now,
    ring: testEncryptionKeys(),
  });
}

function success(commitSha = "a".repeat(40)) {
  return vi
    .fn<typeof pushProjectToRemote>()
    .mockResolvedValue({ commitSha, knownHosts: pin });
}

async function commit(projectId: string, content: string) {
  return withProjectRepo(projectId, async (repo) => {
    await repo.writeFileAtomic("document.md", content);
    return repo.commitAll("Update document", {
      name: "Worker Test",
      userId: randomUUID(),
      email: "worker@example.test",
    });
  });
}

describe("project Git remote jobs", () => {
  beforeEach(async () => {
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("admits one publication and one push across duplicate ticks and deliveries", async () => {
    const remote = await fixture();
    const queue = new FakeJobQueue();
    const counts = await Promise.all(
      [1, 2].map(() =>
        discoverProjectGitRemotes({ db: getPrisma(), queue, now: initialTime }),
      ),
    );
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(1);
    const payload = queue.jobs[0];
    if (payload?.name !== "project.git-push") throw new Error("Missing job");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = vi.fn<typeof pushProjectToRemote>(async (input) => {
      expect(input.privateKey).toBe("synthetic-private-key");
      entered();
      await held;
      return { commitSha: "a".repeat(40), knownHosts: pin };
    });
    const active = push(payload.data, transport);
    await started;
    try {
      await push(payload.data, transport);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(
        await discoverProjectGitRemotes({
          db: getPrisma(),
          queue,
          now: initialTime,
        }),
      ).toBe(0);
      expect((await row(remote.id)).leaseToken).not.toBeNull();
    } finally {
      release();
      await active;
    }
    expect(await row(remote.id)).toMatchObject({
      lastPushedSha: "a".repeat(40),
      lastPushedAt: initialTime,
      failureCount: 0,
      leaseToken: null,
      queueToken: null,
    });
  });

  it("persists capped retries and retries the latest real committed HEAD", async () => {
    const remote = await fixture();
    const first = await commit(remote.projectId, "first");
    let now = initialTime;
    const failing = vi
      .fn<typeof pushProjectToRemote>()
      .mockRejectedValue(new Error("secret raw stderr"));
    for (const minutes of [1, 5, 15, 60, 60]) {
      const payload = await dispatch(now);
      await push(payload, failing, now);
      const current = await row(remote.id);
      expect(current.lastErrorCode).toBe("PUSH_FAILED");
      expect(current.nextAttemptAt.getTime() - now.getTime()).toBe(
        minutes * 60_000,
      );
      const queue = new FakeJobQueue();
      expect(
        await discoverProjectGitRemotes({ db: getPrisma(), queue, now }),
      ).toBe(0);
      now = current.nextAttemptAt;
    }
    const latest = await commit(remote.projectId, "latest");
    expect(latest).not.toBe(first);
    const localTransport = vi.fn<typeof pushProjectToRemote>(async (input) => {
      const commitSha = await withExistingProjectRepoReader(
        input.projectId,
        (repo) => repo.resolveHead(),
      );
      if (!commitSha) throw new Error("Missing repository");
      return {
        commitSha,
        knownHosts: pin,
        skipped: commitSha === input.lastPushedSha,
      };
    });
    await push(await dispatch(now), localTransport, now);
    expect(await row(remote.id)).toMatchObject({
      lastPushedSha: latest,
      lastErrorCode: null,
      failureCount: 0,
    });
    const successfulAt = (await row(remote.id)).lastPushedAt;
    now = (await row(remote.id)).nextAttemptAt;
    await push(await dispatch(now), localTransport, now);
    expect(localTransport.mock.calls[1]?.[0].lastPushedSha).toBe(latest);
    expect((await row(remote.id)).lastPushedAt).toEqual(successfulAt);
  });

  it("picks up a commit created while an earlier immutable snapshot is pushing", async () => {
    const remote = await fixture();
    const first = await commit(remote.projectId, "before push");
    let latest = "";
    const snapshotTransport = vi.fn<typeof pushProjectToRemote>(
      async (input) => {
        const commitSha = await withExistingProjectRepoReader(
          input.projectId,
          (repo) => repo.resolveHead(),
        );
        if (!commitSha) throw new Error("Missing repository");
        latest = await commit(remote.projectId, "during push");
        return { commitSha, knownHosts: pin };
      },
    );
    await push(await dispatch(), snapshotTransport);
    expect((await row(remote.id)).lastPushedSha).toBe(first);
    expect(latest).not.toBe(first);
    const now = (await row(remote.id)).nextAttemptAt;
    const nextTransport = success(latest);
    await push(await dispatch(now), nextTransport, now);
    expect(nextTransport.mock.calls[0]?.[0].lastPushedSha).toBe(first);
    expect((await row(remote.id)).lastPushedSha).toBe(latest);
  });

  it("key deletion pauses discovery and invalidates an already queued delivery", async () => {
    const remote = await fixture();
    const payload = await dispatch();
    await getPrisma().projectGitRemote.update({
      where: { id: remote.id },
      data: {
        enabled: false,
        revision: { increment: 1 },
        queueToken: null,
        queuedAt: null,
        keyName: null,
        keyFingerprint: null,
        keyUploadedAt: null,
        credentialCiphertext: null,
        credentialNonce: null,
        credentialTag: null,
        credentialKeyVersion: null,
      },
    });
    const transport = success();
    await push(payload, transport);
    expect(transport).not.toHaveBeenCalled();
    expect(
      await discoverProjectGitRemotes({
        db: getPrisma(),
        queue: new FakeJobQueue(),
        now: initialTime,
      }),
    ).toBe(0);
  });

  it.each([false, true])(
    "fences stale completion after a configuration change (failure: %s)",
    async (fails) => {
      const remote = await fixture();
      const payload = await dispatch();
      const transport = vi.fn<typeof pushProjectToRemote>(async () => {
        await getPrisma().projectGitRemote.update({
          where: { id: remote.id },
          data: {
            revision: { increment: 1 },
            branch: "replacement",
            queueToken: null,
            queuedAt: null,
            lastPushedSha: null,
            lastPushedAt: null,
            nextAttemptAt: initialTime,
          },
        });
        expect(
          await discoverProjectGitRemotes({
            db: getPrisma(),
            queue: new FakeJobQueue(),
            now: initialTime,
          }),
        ).toBe(0);
        if (fails) throw new Error("old failed remote");
        return { commitSha: "a".repeat(40), knownHosts: pin };
      });
      await push(payload, transport);
      expect(await row(remote.id)).toMatchObject({
        revision: 2,
        lastPushedSha: null,
        lastErrorCode: null,
        knownHosts: null,
        failureCount: 0,
        leaseToken: null,
      });
      const next = await dispatch();
      const updated = success();
      await push(next, updated);
      expect(updated.mock.calls[0]?.[0].branch).toBe("replacement");
    },
  );

  it("rejects stale queued work and soft-deleted projects before admission", async () => {
    const remote = await fixture();
    const payload = await dispatch();
    await getPrisma().projectGitRemote.update({
      where: { id: remote.id },
      data: { queueToken: null, queuedAt: null, revision: { increment: 1 } },
    });
    const transport = success();
    await push(payload, transport);
    const next = await dispatch();
    await getPrisma().project.update({
      where: { id: remote.projectId },
      data: { deletedAt: initialTime },
    });
    await push(next, transport);
    expect(transport).not.toHaveBeenCalled();
    expect(
      await discoverProjectGitRemotes({
        db: getPrisma(),
        queue: new FakeJobQueue(),
        now: new Date(initialTime.getTime() + PROJECT_GIT_QUEUE_TTL_MS),
      }),
    ).toBe(0);
  });

  it("rechecks project deletion after an admission waits for a locked remote", async () => {
    const remote = await fixture();
    const payload = await dispatch();
    const db = getPrisma();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${remote.projectId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "ProjectGitRemote" WHERE id = ${remote.id}::uuid FOR UPDATE`;
        const [backend] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        ready(backend!.pid);
        await held;
        await tx.project.update({
          where: { id: remote.projectId },
          data: { deletedAt: initialTime },
        });
      },
      { timeout: 10_000 },
    );
    const pid = await locked;
    const transport = success();
    const pending = push(payload, transport);
    try {
      await vi.waitFor(
        async () => {
          const waiting = await db.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY(pg_blocking_pids(pid))) AS waiting`;
          expect(waiting[0]?.waiting).toBe(true);
        },
        { timeout: 2_000, interval: 10 },
      );
    } finally {
      release();
      await blocker;
      await pending;
    }
    expect(transport).not.toHaveBeenCalled();
    expect(await row(remote.id)).toMatchObject({
      leaseToken: null,
      lastAttemptAt: null,
      lastPushedSha: null,
    });
  });

  it("recovers lost publication and expired worker leases with new fenced tokens", async () => {
    const remote = await fixture();
    const lost = await dispatch();
    const later = new Date(initialTime.getTime() + PROJECT_GIT_QUEUE_TTL_MS);
    const recovered = await dispatch(later);
    expect(recovered.queueToken).not.toBe(lost.queueToken);
    const transport = success();
    await push(lost, transport, later);
    expect(transport).not.toHaveBeenCalled();
    await getPrisma().projectGitRemote.update({
      where: { id: remote.id },
      data: {
        queueToken: null,
        queuedAt: null,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(later.getTime() + PROJECT_GIT_LEASE_MS),
      },
    });
    expect(
      await discoverProjectGitRemotes({
        db: getPrisma(),
        queue: new FakeJobQueue(),
        now: later,
      }),
    ).toBe(0);
    const expired = new Date(later.getTime() + PROJECT_GIT_LEASE_MS);
    await push(await dispatch(expired), transport, expired);
    expect(transport).toHaveBeenCalledOnce();
    expect((await row(remote.id)).leaseToken).toBeNull();
  });

  it("records failed publication and unavailable encryption without exposing raw errors", async () => {
    const remote = await fixture();
    const queue = new FakeJobQueue();
    vi.spyOn(queue, "send").mockRejectedValue(new Error("database password"));
    expect(
      await discoverProjectGitRemotes({
        db: getPrisma(),
        queue,
        now: initialTime,
      }),
    ).toBe(0);
    expect(await row(remote.id)).toMatchObject({
      lastErrorCode: "QUEUE_UNAVAILABLE",
      failureCount: 1,
      queueToken: null,
    });
    const nextTime = (await row(remote.id)).nextAttemptAt;
    const payload = await dispatch(nextTime);
    const transport = success();
    await pushProjectGitRemote({
      db: getPrisma(),
      payload,
      ring: null,
      transport,
      now: nextTime,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(await row(remote.id)).toMatchObject({
      lastErrorCode: "KEY_UNAVAILABLE",
      failureCount: 2,
      leaseToken: null,
    });
  });

  it("records a failed push with its cause in the diagnostics log", async () => {
    const remote = await fixture();
    startDiagnosticWriter({
      db: getPrisma(),
      runtime: "worker",
      flushIntervalMs: 60_000,
    });
    await waitForDiagnosticWriterReady();
    try {
      await push(
        await dispatch(),
        vi
          .fn<typeof pushProjectToRemote>()
          .mockRejectedValue(
            new GitRemoteError(
              "NETWORK_ERROR",
              null,
              "SSH target is not allowed: git.internal:22",
            ),
          ),
      );
      await flushDiagnostics();
    } finally {
      await stopDiagnosticWriter();
    }
    expect(await row(remote.id)).toMatchObject({
      lastErrorCode: "NETWORK_ERROR",
      failureCount: 1,
    });
    const events = await getPrisma().diagnosticEvent.findMany({
      where: { event: "git.remote.push_failed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      severity: "error",
      projectId: remote.projectId,
      message: "Git push failed: NETWORK_ERROR",
    });
    expect(events[0]!.details).toMatchObject({
      code: "NETWORK_ERROR",
      cause: "SSH target is not allowed: git.internal:22",
    });
  });

  it("retains first-use host trust after failure and passes it to retries", async () => {
    const remote = await fixture();
    const error = new GitRemoteError("AUTHENTICATION_FAILED", pin);
    await push(
      await dispatch(),
      vi.fn<typeof pushProjectToRemote>().mockRejectedValue(error),
    );
    expect(await row(remote.id)).toMatchObject({
      knownHosts: pin,
      lastErrorCode: "AUTHENTICATION_FAILED",
    });
    const now = (await row(remote.id)).nextAttemptAt;
    const changed = vi
      .fn<typeof pushProjectToRemote>()
      .mockRejectedValue(new GitRemoteError("HOST_KEY_CHANGED"));
    await push(await dispatch(now), changed, now);
    expect(changed.mock.calls[0]?.[0].knownHosts).toBe(pin);
    expect(await row(remote.id)).toMatchObject({
      knownHosts: pin,
      lastErrorCode: "HOST_KEY_CHANGED",
    });
  });

  it("dispatches a push immediately for an eligible, unqueued remote and is a no-op while queued or leased", async () => {
    const { projectId, id } = await fixture();
    const queue = new FakeJobQueue();
    expect(
      await dispatchProjectGitRemote({
        db: getPrisma(),
        queue,
        projectId,
        now: initialTime,
      }),
    ).toBe(true);
    expect(
      queue.jobs.filter((job) => job.name === "project.git-push"),
    ).toHaveLength(1);
    expect((await row(id)).queueToken).not.toBeNull();
    expect(
      await dispatchProjectGitRemote({
        db: getPrisma(),
        queue,
        projectId,
        now: initialTime,
      }),
    ).toBe(false);
    expect(
      queue.jobs.filter((job) => job.name === "project.git-push"),
    ).toHaveLength(1);
  });

  it("notifyProjectContentChanged marks an idle remote due now and dispatches once", async () => {
    const { projectId, id } = await fixture();
    await getPrisma().projectGitRemote.update({
      where: { id },
      data: { nextAttemptAt: new Date(initialTime.getTime() + 3_600_000) },
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    try {
      await notifyProjectContentChanged(getPrisma(), projectId);
      expect(
        queue.jobs.filter((job) => job.name === "project.git-push"),
      ).toHaveLength(1);
      expect((await row(id)).nextAttemptAt.getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      await getPrisma().projectGitRemote.update({
        where: { id },
        data: { enabled: false, queueToken: null, queuedAt: null },
      });
      await notifyProjectContentChanged(getPrisma(), projectId);
      expect(
        queue.jobs.filter((job) => job.name === "project.git-push"),
      ).toHaveLength(1);
    } finally {
      setJobQueueForTests(null);
    }
  });

  it("notifyProjectContentChanged leaves a remote in backoff on its own schedule", async () => {
    const { projectId, id } = await fixture();
    const futureAttempt = new Date(initialTime.getTime() + 3_600_000);
    await getPrisma().projectGitRemote.update({
      where: { id },
      data: { failureCount: 2, nextAttemptAt: futureAttempt },
    });
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    try {
      await notifyProjectContentChanged(getPrisma(), projectId);
      expect(
        queue.jobs.filter((job) => job.name === "project.git-push"),
      ).toHaveLength(0);
      expect(await row(id)).toMatchObject({
        failureCount: 2,
        nextAttemptAt: futureAttempt,
        queueToken: null,
      });
    } finally {
      setJobQueueForTests(null);
    }
  });

  it("dispatchProjectGitRemote is a no-op without claiming when jobs are disabled and no queue is given", async () => {
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");
    const { projectId, id } = await fixture();
    expect(
      await dispatchProjectGitRemote({
        db: getPrisma(),
        projectId,
        now: initialTime,
      }),
    ).toBe(false);
    expect(await row(id)).toMatchObject({
      queueToken: null,
      failureCount: 0,
      lastErrorCode: null,
    });
  });
});

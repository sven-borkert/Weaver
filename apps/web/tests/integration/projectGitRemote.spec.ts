import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import {
  decryptProjectGitRemoteKey,
  assertProjectGitRemoteSecretsDecryptable,
  rotateProjectGitRemoteSecrets,
} from "@weaver/core/services/projectGitRemote";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  testEncryptionKeys,
} from "./_harness";

let privateKey: string;
beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "weaver-test-key-"));
  try {
    await promisify(execFile)("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      path.join(dir, "key"),
    ]);
    privateKey = await readFile(path.join(dir, "key"), "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  await resetDb();
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

async function fixture() {
  const owner = await makeUser("User", "remote-owner");
  const project = await makeProject("Remote project");
  await addMembership(project.id, owner.id, "Owner");
  const ring = testEncryptionKeys();
  const caller = callerFor(owner, { encryptionKeys: ring });
  return { db: getPrisma(), owner, project, ring, caller };
}

describe("project Git remote management", () => {
  it("stores one remote, uploads a write-only key, replaces and deletes it", async () => {
    const { db, project, caller } = await fixture();
    const projectId = project.id;
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    expect(await caller.projectGitRemote.get({ projectId })).toBeNull();
    const saved = await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "git@example.test:team/project.git",
      branch: "main",
      enabled: false,
    });
    expect(saved).toMatchObject({
      projectId,
      branch: "main",
      enabled: false,
      key: null,
      revision: 1,
    });
    const uploaded = await caller.projectGitRemote.uploadKey({
      projectId,
      expectedRevision: saved.revision,
      keyName: "deploy-key",
      privateKey,
    });
    expect(uploaded.key).toMatchObject({
      name: "deploy-key",
      fingerprint: expect.stringMatching(/^SHA256:/),
    });
    expect(JSON.stringify(uploaded)).not.toMatch(
      /PRIVATE KEY|credentialCiphertext|credentialNonce|credentialTag|privateKey/,
    );
    expect(
      JSON.stringify(
        await db.projectGitRemote.findUnique({ where: { projectId } }),
      ),
    ).not.toContain(privateKey);
    const enabled = await caller.projectGitRemote.save({
      projectId,
      expectedRevision: uploaded.revision,
      remoteUrl: saved.remoteUrl,
      branch: "main",
      enabled: true,
    });
    expect(enabled.enabled).toBe(true);
    const afterEnable = await db.projectGitRemote.findUniqueOrThrow({
      where: { projectId },
    });
    expect(afterEnable.queueToken).not.toBeNull();
    expect(queue.jobs.filter((job) => job.name === "project.git-push")).toEqual(
      [
        {
          name: "project.git-push",
          data: { projectId, queueToken: afterEnable.queueToken },
        },
      ],
    );
    const replaced = await caller.projectGitRemote.uploadKey({
      projectId,
      expectedRevision: enabled.revision,
      keyName: "replacement",
      privateKey,
    });
    expect(replaced).toMatchObject({
      enabled: true,
      key: { name: "replacement", fingerprint: uploaded.key!.fingerprint },
    });
    const afterReplace = await db.projectGitRemote.findUniqueOrThrow({
      where: { projectId },
    });
    expect(afterReplace.queueToken).not.toBeNull();
    expect(
      queue.jobs.filter((job) => job.name === "project.git-push"),
    ).toHaveLength(2);
    await expect(
      caller.projectGitRemote.deleteKey({
        projectId,
        expectedRevision: uploaded.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const removed = await caller.projectGitRemote.deleteKey({
      projectId,
      expectedRevision: replaced.revision,
    });
    expect(removed).toMatchObject({ key: null, enabled: false });
    expect(
      await db.projectGitRemote.findUnique({ where: { projectId } }),
    ).toMatchObject({
      credentialCiphertext: null,
      credentialNonce: null,
      credentialTag: null,
      credentialKeyVersion: null,
    });
    await caller.projectGitRemote.remove({
      projectId,
      expectedRevision: removed.revision,
    });
    expect(await caller.projectGitRemote.get({ projectId })).toBeNull();
  });

  it("rechecks Owner membership after waiting behind a membership mutation", async () => {
    const { db, owner, project, caller } = await fixture();
    const projectId = project.id;
    const saved = await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "git@example.test:repo.git",
      branch: "main",
      enabled: false,
    });
    const organization = await db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { organizationId: true },
    });
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
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))::text`;
        await tx.$queryRaw`SELECT id FROM "ProjectGitRemote" WHERE "projectId" = ${projectId}::uuid FOR UPDATE`;
        const [backend] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        ready(backend!.pid);
        await held;
        await tx.member.updateMany({
          where: {
            organizationId: organization.organizationId,
            userId: owner.id,
          },
          data: { role: "viewer" },
        });
      },
      { timeout: 10_000 },
    );
    const pid = await locked;
    const mutation = caller.projectGitRemote.save({
      projectId,
      expectedRevision: saved.revision,
      remoteUrl: saved.remoteUrl,
      branch: "must-not-save",
      enabled: false,
    });
    const result = mutation.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
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
    }
    expect((await result).error).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await db.projectGitRemote.findUnique({ where: { projectId } }),
    ).toMatchObject({ branch: "main", revision: saved.revision });
  });

  it("prevents remove and recreate from bypassing an admitted push lease", async () => {
    const { db, project, caller } = await fixture();
    const projectId = project.id;
    const saved = await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "git@example.test:repo.git",
      branch: "main",
      enabled: false,
    });
    const original = await db.projectGitRemote.update({
      where: { projectId },
      data: {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });
    await expect(
      caller.projectGitRemote.remove({
        projectId,
        expectedRevision: saved.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      caller.projectGitRemote.save({
        projectId,
        remoteUrl: "git@example.test:replacement.git",
        branch: "main",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await db.projectGitRemote.findUniqueOrThrow({ where: { projectId } }))
        .id,
    ).toBe(original.id);
    await db.projectGitRemote.update({
      where: { projectId },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
    await caller.projectGitRemote.remove({
      projectId,
      expectedRevision: saved.revision,
    });
    await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "git@example.test:replacement.git",
      branch: "main",
      enabled: false,
    });
    expect(
      (await db.projectGitRemote.findUniqueOrThrow({ where: { projectId } }))
        .id,
    ).not.toBe(original.id);
  });

  it("requires Owner membership for reads and every management action", async () => {
    const { project, caller } = await fixture();
    const projectId = project.id;
    const saved = await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "ssh://git@example.test:2222/team/project.git",
      branch: "backup/weaver",
      enabled: false,
    });
    for (const role of ["Viewer", "Editor", "Maintainer"] as const) {
      const user = await makeUser("User", `remote-${role}`);
      await addMembership(projectId, user.id, role);
      const other = callerFor(user);
      await expect(
        other.projectGitRemote.get({ projectId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        other.projectGitRemote.uploadKey({
          projectId,
          expectedRevision: saved.revision,
          keyName: "No",
          privateKey,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        other.projectGitRemote.save({
          projectId,
          expectedRevision: saved.revision,
          remoteUrl: saved.remoteUrl,
          branch: "main",
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        other.projectGitRemote.deleteKey({
          projectId,
          expectedRevision: saved.revision,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        other.projectGitRemote.remove({
          projectId,
          expectedRevision: saved.revision,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        other.projectGitRemote.pushNow({ projectId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const admin = callerFor(await makeUser("Admin", "remote-admin"));
    await expect(
      admin.projectGitRemote.get({ projectId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires a key before enabling and refuses unsafe targets or invalid keys", async () => {
    const { project, caller } = await fixture();
    const projectId = project.id;
    await expect(
      caller.projectGitRemote.save({
        projectId,
        remoteUrl: "git@example.test:repo.git",
        branch: "main",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      caller.projectGitRemote.save({
        projectId,
        remoteUrl: "ext::sh -c bad",
        branch: "main",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const saved = await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "git@example.test:repo.git",
      branch: "main",
      enabled: false,
    });
    await expect(
      caller.projectGitRemote.uploadKey({
        projectId,
        expectedRevision: saved.revision,
        keyName: "invalid",
        privateKey: "invalid private content",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await caller.projectGitRemote.get({ projectId }))?.key).toBeNull();
  });
  it("rotates encrypted keys without disclosure and refuses missing encryption material", async () => {
    const { db, owner, project, ring, caller } = await fixture();
    const projectId = project.id;
    const saved = await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "git@example.test:repo.git",
      branch: "main",
      enabled: false,
    });
    const noRing = callerFor(owner, { encryptionKeys: null });
    await expect(
      noRing.projectGitRemote.uploadKey({
        projectId,
        expectedRevision: saved.revision,
        keyName: "key",
        privateKey,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller.projectGitRemote.uploadKey({
      projectId,
      expectedRevision: saved.revision,
      keyName: "key",
      privateKey,
    });
    const row = await db.projectGitRemote.findUniqueOrThrow({
      where: { projectId },
    });
    expect(decryptProjectGitRemoteKey(row, ring)).toBe(privateKey);
    await expect(
      assertProjectGitRemoteSecretsDecryptable(db, null),
    ).rejects.toThrow("cannot be decrypted");
    const version = ring.activeVersion + 1;
    const nextRing = {
      activeVersion: version,
      keys: new Map([...ring.keys, [version, new Uint8Array(randomBytes(32))]]),
    };
    expect(await rotateProjectGitRemoteSecrets(db, nextRing)).toEqual({
      rotated: 1,
      skipped: 0,
    });
    const onlyNew = {
      activeVersion: version,
      keys: new Map([[version, nextRing.keys.get(version)!]]),
    };
    expect(
      decryptProjectGitRemoteKey(
        await db.projectGitRemote.findUniqueOrThrow({ where: { projectId } }),
        onlyNew,
      ),
    ).toBe(privateKey);
    await expect(
      assertProjectGitRemoteSecretsDecryptable(db, onlyNew),
    ).resolves.toBeUndefined();
    expect(await rotateProjectGitRemoteSecrets(db, onlyNew)).toEqual({
      rotated: 0,
      skipped: 1,
    });
  });

  it("queues a pull for an Owner with a key, enforces single-flight, and blocks during an active push lease", async () => {
    const { db, owner, project, caller } = await fixture();
    const projectId = project.id;
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    try {
      const saved = await caller.projectGitRemote.save({
        projectId,
        remoteUrl: "git@example.test:team/project.git",
        branch: "main",
        enabled: false,
      });
      await expect(
        caller.projectGitRemote.pull({ projectId }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      await caller.projectGitRemote.uploadKey({
        projectId,
        expectedRevision: saved.revision,
        keyName: "deploy-key",
        privateKey,
      });
      const pulled = await caller.projectGitRemote.pull({ projectId });
      expect(pulled.pullQueued).toBe(true);
      const afterPull = await db.projectGitRemote.findUniqueOrThrow({
        where: { projectId },
      });
      expect(afterPull.pullQueueToken).not.toBeNull();
      expect(
        queue.jobs.filter((job) => job.name === "project.git-pull"),
      ).toEqual([
        {
          name: "project.git-pull",
          data: { projectId, pullToken: afterPull.pullQueueToken },
        },
      ]);

      await expect(
        caller.projectGitRemote.pull({ projectId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // Isolate the push-lease conflict from the already-queued conflict.
      await db.projectGitRemote.update({
        where: { projectId },
        data: { pullQueueToken: null },
      });
      await db.projectGitRemote.update({
        where: { projectId },
        data: {
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 120_000),
        },
      });
      await expect(
        caller.projectGitRemote.pull({ projectId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await db.projectGitRemote.update({
        where: { projectId },
        data: { leaseToken: null, leaseExpiresAt: null },
      });

      for (const role of ["Viewer", "Editor", "Maintainer"] as const) {
        const user = await makeUser("User", `remote-pull-${role}`);
        await addMembership(projectId, user.id, role);
        const other = callerFor(user);
        await expect(
          other.projectGitRemote.pull({ projectId }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      const nonMember = callerFor(await makeUser("User", "remote-pull-none"));
      await expect(
        nonMember.projectGitRemote.pull({ projectId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const bearer = callerWithSecurity(
        owner,
        createApiKeySecurityContext({
          userId: owner.id,
          globalRole: owner.role,
          keyId: "key",
          permissions: { content: ["read", "write"], mcp: ["use"] },
          projectIds: [],
        }),
      );
      await expect(
        bearer.projectGitRemote.pull({ projectId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      setJobQueueForTests(null);
    }
  });

  it("clears a queued pull when the key is deleted or the target changes (C1/M5)", async () => {
    const { db, owner, project, caller } = await fixture();
    const projectId = project.id;
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const saved = await caller.projectGitRemote.save({
      projectId,
      remoteUrl: "git@example.test:team/project.git",
      branch: "main",
      enabled: false,
    });
    const withKey = await caller.projectGitRemote.uploadKey({
      projectId,
      expectedRevision: saved.revision,
      keyName: "deploy-key",
      privateKey,
    });
    await caller.projectGitRemote.pull({ projectId });

    const afterDelete = await caller.projectGitRemote.deleteKey({
      projectId,
      expectedRevision: withKey.revision,
    });
    expect(afterDelete.pullQueued).toBe(false);
    expect(
      (await db.projectGitRemote.findUniqueOrThrow({ where: { projectId } }))
        .pullQueueToken,
    ).toBeNull();

    // A new key, a new queued pull — saving a different branch invalidates it.
    const restored = await caller.projectGitRemote.uploadKey({
      projectId,
      expectedRevision: afterDelete.revision,
      keyName: "deploy-key",
      privateKey,
    });
    await caller.projectGitRemote.pull({ projectId });
    const afterSave = await caller.projectGitRemote.save({
      projectId,
      expectedRevision: restored.revision,
      remoteUrl: restored.remoteUrl,
      branch: "release",
      enabled: false,
    });
    expect(afterSave.pullQueued).toBe(false);
    const row = await db.projectGitRemote.findUniqueOrThrow({
      where: { projectId },
    });
    expect(row.pullQueueToken).toBeNull();
    expect(row.pullRequestedAt).toBeNull();
    // With the token cleared a fresh pull is admitted again, not CONFLICT.
    await expect(
      callerFor(owner, {
        encryptionKeys: testEncryptionKeys(),
      }).projectGitRemote.pull({ projectId }),
    ).resolves.toMatchObject({ pullQueued: true });
  });

  it("refuses bearer management even for a project owner", async () => {
    const { owner, project } = await fixture();
    const bearer = callerWithSecurity(
      owner,
      createApiKeySecurityContext({
        userId: owner.id,
        globalRole: owner.role,
        keyId: "key",
        permissions: { content: ["read", "write"], mcp: ["use"] },
        projectIds: [],
      }),
    );
    await expect(
      bearer.projectGitRemote.get({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      bearer.projectGitRemote.save({
        projectId: project.id,
        remoteUrl: "git@example.test:repo.git",
        branch: "main",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

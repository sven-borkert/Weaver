import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as taskServices from "@weaver/core/services/scheduledTasks";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@weaver/db/client";
import { MockLanguageModelV4 } from "ai/test";
import { encryptSecret, secretAad } from "@weaver/core/security/encryption";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { openProjectRepo, repoDir } from "@weaver/git-store";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  createDocument,
  deleteDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import { softDeleteProject } from "@weaver/core/services/projects";
import { createFolder } from "@weaver/core/services/folders";
import { projectChangesSince } from "@weaver/core/services/projectActivity";
import { assembleTaskContext } from "@weaver/core/scheduledTasks/context";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import {
  claimDueTasks,
  withTaskOutputLease,
  createTask,
  deleteTask,
  listOwnedTasks,
  listTaskRuns,
  expireAbandonedRuns,
  failTaskRun,
  getTask,
  leaseTaskRun,
  listProjectTasks,
  resumeTask,
  runTaskNow,
  succeedTaskRun,
  updateTask,
} from "@weaver/core/services/scheduledTasks";
import { executeScheduledTaskRun } from "@weaver/ai/taskRunner";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
} from "@weaver/core/diagnostics/writer";
import {
  invalidateDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import { createTable } from "@weaver/core/services/tables";
import {
  FakeJobQueue,
  setJobQueueForTests,
  type JobQueue,
} from "@weaver/core/jobs/queue";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
  testEncryptionKeys,
} from "./_harness";

function enriched(user: { id: string; role: "Admin" | "User"; email: string }) {
  return { ...securityContextFor(user), name: "Test", email: user.email };
}

/** An eligible, unqueued ProjectGitRemote row, so a content commit is expected
 * to dispatch an immediate `project.git-push` job (mirrors documents.spec.ts). */
async function addEligibleGitRemote(projectId: string) {
  const id = randomUUID();
  const encrypted = encryptSecret(
    testEncryptionKeys(),
    "synthetic-private-key",
    secretAad("project-git-remote", id),
  );
  await getPrisma().projectGitRemote.create({
    data: {
      id,
      projectId,
      remoteUrl: "git@example.test:repo.git",
      branch: "main",
      enabled: true,
      keyName: "test key",
      keyFingerprint: "SHA256:test",
      keyUploadedAt: new Date(),
      credentialCiphertext: new Uint8Array(encrypted.ciphertext),
      credentialNonce: new Uint8Array(encrypted.nonce),
      credentialTag: new Uint8Array(encrypted.tag),
      credentialKeyVersion: encrypted.keyVersion,
      nextAttemptAt: new Date(),
    },
  });
  return id;
}

describe("projectChangesSince", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists commits after a recorded head and maps paths to documents", async () => {
    const owner = await makeUser("User", "activity");
    const outsider = await makeUser("User", "activity-out");
    const project = await makeProject("Activity");
    await addMembership(project.id, owner.id, "Editor");
    const actor = enriched(owner);
    // Repositories are created lazily: a project without content is empty, not missing.
    expect(
      await projectChangesSince(getPrisma(), actor, {
        projectId: project.id,
        fromSha: null,
        sinceDate: new Date(0),
        limit: 200,
      }),
    ).toEqual({
      headSha: null,
      commits: [],
      truncated: false,
      fallback: "none",
    });
    // The access check still runs ahead of that branch.
    await expect(
      projectChangesSince(getPrisma(), enriched(outsider), {
        projectId: project.id,
        fromSha: null,
        sinceDate: new Date(0),
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const first = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Alpha",
        content: { kind: "markdown", contentJson: parseDocumentBody("one") },
      },
      actor,
    );
    const before = await projectChangesSince(getPrisma(), actor, {
      projectId: project.id,
      fromSha: null,
      sinceDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      limit: 200,
    });
    expect(before.headSha).toBe(first.headCommitSha);
    expect(
      before.commits.some((c) => c.documents.some((d) => d.id === first.id)),
    ).toBe(true);

    const second = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Beta",
        content: { kind: "markdown", contentJson: parseDocumentBody("two") },
      },
      actor,
    );
    const after = await projectChangesSince(getPrisma(), actor, {
      projectId: project.id,
      fromSha: first.headCommitSha,
      sinceDate: new Date(0),
      limit: 200,
    });
    expect(after.headSha).toBe(second.headCommitSha);
    expect(after.commits).toHaveLength(1);
    expect(after.commits[0]!.documents).toEqual([
      expect.objectContaining({ id: second.id, title: "Beta", status: "A" }),
    ]);
    expect(after.fallback).toBe("none");

    const table = await createTable(
      getPrisma(),
      { projectId: project.id, folderPath: [], title: "Budget" },
      actor,
    );
    const withTable = await projectChangesSince(getPrisma(), actor, {
      projectId: project.id,
      fromSha: second.headCommitSha,
      sinceDate: new Date(0),
      limit: 200,
    });
    expect(withTable.commits).toHaveLength(1);
    expect(withTable.commits[0]!.tables).toEqual([
      expect.objectContaining({ id: table.id, title: "Budget", status: "A" }),
    ]);
    expect(withTable.commits[0]!.documents).toEqual([]);

    // An unknown head falls back to the date window instead of failing.
    const fallback = await projectChangesSince(getPrisma(), actor, {
      projectId: project.id,
      fromSha: "0000000000000000000000000000000000000000",
      sinceDate: new Date(0),
      limit: 200,
    });
    expect(fallback.fallback).toBe("since_date");
    expect(fallback.commits.length).toBeGreaterThanOrEqual(2);

    await expect(
      projectChangesSince(getPrisma(), enriched(outsider), {
        projectId: project.id,
        fromSha: null,
        sinceDate: new Date(0),
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("attaches stored change summaries to commits", async () => {
    const owner = await makeUser("User", "activity-summary");
    const project = await makeProject("Activity summary");
    await addMembership(project.id, owner.id, "Editor");
    const actor = enriched(owner);
    const created = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        content: { kind: "markdown", contentJson: parseDocumentBody("steps") },
      },
      actor,
    );
    const now = new Date();
    await getPrisma().documentChangeSummary.create({
      data: {
        projectId: project.id,
        commitSha: created.headCommitSha,
        documentId: created.id,
        pathAtSha: created.path,
        baseCommitSha: created.headCommitSha,
        status: "ready",
        summary: "Add the runbook",
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
    });
    const changes = await projectChangesSince(getPrisma(), actor, {
      projectId: project.id,
      fromSha: null,
      sinceDate: new Date(0),
      limit: 10,
    });
    expect(
      changes.commits.find((commit) => commit.sha === created.headCommitSha)
        ?.changeSummary,
    ).toEqual({ status: "ready", summary: "Add the runbook" });
  });
});

describe("assembleTaskContext", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("diffs a changed document from its own previous revision and skips one created inside the window", async () => {
    const owner = await makeUser("User", "context");
    const project = await makeProject("Context");
    await addMembership(project.id, owner.id, "Editor");
    const actor = enriched(owner);
    const first = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("restart apache"),
        },
      },
      actor,
    );
    const head1 = (
      await projectChangesSince(getPrisma(), actor, {
        projectId: project.id,
        fromSha: null,
        sinceDate: new Date(0),
        limit: 10,
      })
    ).headSha;
    await saveDocument(
      getPrisma(),
      {
        projectId: project.id,
        documentId: first.id,
        baseCommitSha: first.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("restart nginx"),
        },
        changeSummary: "update",
      },
      actor,
    );
    // A second document makes the project head a commit that never touches
    // Runbook, so a project-head-based diff would resolve nothing for it.
    await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Other",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("unrelated"),
        },
      },
      actor,
    );
    const head2 = (
      await projectChangesSince(getPrisma(), actor, {
        projectId: project.id,
        fromSha: null,
        sinceDate: new Date(0),
        limit: 10,
      })
    ).headSha;
    const scope = await resolveScopeSnapshot(getPrisma(), actor, {
      kind: "project",
      projectId: project.id,
    });

    const incremental = await assembleTaskContext(getPrisma(), actor, {
      scope,
      excludeDocumentId: null,
      previousHeads: { [project.id]: head1! },
      inputBytes: 20_000,
      now: new Date(),
    });
    expect(incremental.digest).toContain("Runbook (modified)");
    expect(incremental.digest).toContain("Other (added)");
    expect(incremental.digest).toContain("+ restart nginx");
    expect(incremental.digest).toContain("- restart apache");
    // Other was created inside the window: it has no earlier revision to diff.
    expect(incremental.digest).not.toContain("### Diff: Other");
    expect(incremental.summary.commits).toBe(2);
    expect(incremental.summary.documents).toBe(2);
    expect(incremental.heads[project.id]).toBe(head2);

    // First run: both documents are created inside the window, so neither has
    // an earlier revision to diff against; their bodies carry the content.
    const firstRun = await assembleTaskContext(getPrisma(), actor, {
      scope,
      excludeDocumentId: null,
      previousHeads: null,
      inputBytes: 20_000,
      now: new Date(),
    });
    expect(firstRun.summary.fallback).toBe("none");
    // The three document commits plus the repository's empty root commit.
    expect(firstRun.summary.commits).toBe(4);
    expect(firstRun.digest).toContain("Runbook (added)");
    expect(firstRun.digest).toContain("Runbook (modified)");
    expect(firstRun.digest).toContain("Other (added)");
    expect(firstRun.digest).not.toContain("### Diff");
    expect(firstRun.content).toContain("## Document: Runbook");
    expect(firstRun.content).toContain("restart nginx");
    expect(firstRun.content).toContain("## Document: Other");
  });

  it("gives every project in a multi-project scope its own share of the content budget", async () => {
    const owner = await makeUser("User", "context-share");
    const one = await makeProject("Share One");
    const two = await makeProject("Share Two");
    await addMembership(one.id, owner.id, "Editor");
    await addMembership(two.id, owner.id, "Editor");
    const actor = enriched(owner);
    const body = "alpha ".repeat(500).trim();
    for (const title of ["Alpha-1", "Alpha-2"]) {
      await createDocument(
        getPrisma(),
        {
          projectId: one.id,
          folderPath: [],
          title,
          content: { kind: "markdown", contentJson: parseDocumentBody(body) },
        },
        actor,
      );
    }
    await createDocument(
      getPrisma(),
      {
        projectId: two.id,
        folderPath: [],
        title: "Beta-11",
        content: { kind: "markdown", contentJson: parseDocumentBody(body) },
      },
      actor,
    );
    const scope = await resolveScopeSnapshot(getPrisma(), actor, {
      kind: "projects",
      projectIds: [one.id, two.id],
    });

    // Positive control: a budget that fits everything keeps all three documents,
    // and the per-project summary attributes them.
    const roomy = await assembleTaskContext(getPrisma(), actor, {
      scope,
      excludeDocumentId: null,
      previousHeads: null,
      inputBytes: 60_000,
      now: new Date(),
    });
    expect(roomy.content).toContain("## Document: Alpha-1");
    expect(roomy.content).toContain("## Document: Alpha-2");
    expect(roomy.content).toContain("## Document: Beta-11");
    expect(roomy.summary.truncated).toBe(false);
    expect(roomy.summary.projects).toEqual([
      // Two document commits plus the repository's empty root commit.
      { projectId: one.id, documents: 2, tables: 0, commits: 3 },
      { projectId: two.id, documents: 1, tables: 0, commits: 2 },
    ]);

    const blocks = roomy.content.split("\n\n");
    expect(blocks).toHaveLength(3);
    const blockBytes = Math.max(
      ...blocks.map((block) => Buffer.byteLength(block, "utf8")),
    );
    const digestBytes = Buffer.byteLength(roomy.digest, "utf8");
    // Content room for exactly two documents: filling project by project would
    // spend all of it on project one and leave project two unrepresented.
    const tight = await assembleTaskContext(getPrisma(), actor, {
      scope,
      excludeDocumentId: null,
      previousHeads: null,
      inputBytes: digestBytes + 2 * blockBytes + 6,
      now: new Date(),
    });
    expect(tight.summary.projects).toEqual([
      { projectId: one.id, documents: 1, tables: 0, commits: 3 },
      { projectId: two.id, documents: 1, tables: 0, commits: 2 },
    ]);
    expect(tight.content).toContain("## Document: Beta-11");
    expect(tight.summary.documents).toBe(2);
    expect(tight.summary.truncated).toBe(true);
  });

  it("cuts a document that exceeds the content budget instead of dropping it", async () => {
    const owner = await makeUser("User", "context-partial");
    const project = await makeProject("Partial");
    await addMembership(project.id, owner.id, "Editor");
    const actor = enriched(owner);
    // About 30 KB: under the per-document source cap, far over the budget.
    const document = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Oversized",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("alpha ".repeat(5000).trim()),
        },
      },
      actor,
    );
    const scope = await resolveScopeSnapshot(getPrisma(), actor, {
      kind: "document",
      projectId: project.id,
      documentId: document.id,
    });
    const inputBytes = 6_000;
    const context = await assembleTaskContext(getPrisma(), actor, {
      scope,
      excludeDocumentId: null,
      previousHeads: null,
      inputBytes,
      now: new Date(),
    });
    expect(context.content).toContain("## Document: Oversized");
    expect(context.content).toContain("alpha alpha");
    expect(context.content).toContain("_[truncated]_");
    expect(
      Buffer.byteLength(context.digest, "utf8") +
        Buffer.byteLength(context.content, "utf8"),
    ).toBeLessThanOrEqual(inputBytes);
    expect(context.summary.documents).toBe(1);
    expect(context.summary.truncated).toBe(true);
  });

  it("reports a document cut at its source even when the budget is roomy", async () => {
    const owner = await makeUser("User", "context-source-cut");
    const project = await makeProject("Source Cut");
    await addMembership(project.id, owner.id, "Editor");
    const actor = enriched(owner);
    // About 42 KB: over the 32 KB per-document source cap.
    const document = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Long",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("alpha ".repeat(7000).trim()),
        },
      },
      actor,
    );
    const scope = await resolveScopeSnapshot(getPrisma(), actor, {
      kind: "document",
      projectId: project.id,
      documentId: document.id,
    });
    const context = await assembleTaskContext(getPrisma(), actor, {
      scope,
      excludeDocumentId: null,
      previousHeads: null,
      inputBytes: 200_000,
      now: new Date(),
    });
    expect(context.content).toContain("## Document: Long");
    expect(context.content).toContain("_[truncated]_");
    expect(Buffer.byteLength(context.content, "utf8")).toBeLessThan(33_000);
    expect(context.summary.documents).toBe(1);
    expect(context.summary.truncated).toBe(true);
  });
});

const SCHEDULE = { kind: "daily" as const, hour: 7, minute: 0 };

async function fixture(suffix: string) {
  const owner = await makeUser("User", `task-${suffix}`);
  const maintainer = await makeUser("User", `task-m-${suffix}`);
  const viewer = await makeUser("User", `task-v-${suffix}`);
  const outsider = await makeUser("User", `task-o-${suffix}`);
  const project = await makeProject(`Tasks ${suffix}`);
  await addMembership(project.id, owner.id, "Editor");
  await addMembership(project.id, maintainer.id, "Maintainer");
  await addMembership(project.id, viewer.id, "Viewer");
  return { owner, maintainer, viewer, outsider, project };
}

function definition(projectId: string) {
  return {
    name: "Daily digest",
    instruction: "Summarize what changed in this project since the last run.",
    scope: { kind: "project" as const, projectId },
    outputProjectId: projectId,
    outputFolderPath: [] as string[],
    schedule: SCHEDULE,
    timezone: "Europe/Berlin",
  };
}

async function seedTasks(ownerId: string, projectId: string, count: number) {
  await getPrisma().scheduledTask.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      ownerId,
      name: `Seeded ${i}`,
      instruction: "Summarize.",
      scopeRequest: { kind: "project", projectId },
      scopeSnapshot: {
        kind: "project",
        projectIds: [projectId],
        documentId: null,
        tableId: null,
        resolvedAt: new Date().toISOString(),
        truncated: false,
      },
      outputProjectId: projectId,
      outputFolderPath: [],
      schedule: SCHEDULE,
      timezone: "Europe/Berlin",
      cron: "0 7 * * *",
    })),
  });
}

/** A queue that accepts nothing, like a runtime with WEAVER_JOBS_ENABLED=false. */
const nullDispatchQueue: JobQueue = {
  send: async () => null,
  work: async () => undefined,
  schedule: async () => undefined,
  stop: async () => undefined,
};

describe("scheduled task policy", () => {
  it("pauses scheduled tasks atomically when their output project is deleted", async () => {
    const { owner, project } = await fixture("delete-lifecycle");
    const db = getPrisma();
    const task = await createTask(db, enriched(owner), definition(project.id));
    await db.member.updateMany({
      where: { userId: owner.id },
      data: { role: "owner" },
    });
    await softDeleteProject(db, project.id, enriched(owner));
    expect(
      await db.scheduledTask.findUnique({ where: { id: task.id } }),
    ).toMatchObject({ status: "paused", nextRunAt: null });
  });
  it("retains output identity after publication acknowledgement rolls back", async () => {
    const { owner, project } = await fixture("publication-ack");
    const db = getPrisma();
    const task = await createTask(db, enriched(owner), definition(project.id));
    const run = await db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        trigger: "manual",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    const failingDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "$transaction")
          return (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          ) =>
            target.$transaction(async (tx) => {
              await callback(tx);
              throw new Error("publication acknowledgement lost");
            });
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const output = await withTaskOutputLease(failingDb, run.id, () =>
      createDocument(
        db,
        {
          projectId: project.id,
          title: "Report",
          folderPath: [],
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("report"),
          },
        },
        enriched(owner),
      ),
    );
    expect(
      await db.scheduledTask.findUnique({ where: { id: task.id } }),
    ).toMatchObject({ outputDocumentId: output.id });
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      1,
    );
  });

  it("refuses publication after an expired lease and preserves admitted output identity", async () => {
    const { owner, project } = await fixture("publication-lease");
    const db = getPrisma();
    const task = await createTask(db, enriched(owner), definition(project.id));
    const run = await db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        trigger: "manual",
        status: "running",
        leaseExpiresAt: new Date(0),
      },
    });
    const publish = () =>
      createDocument(
        db,
        {
          projectId: project.id,
          title: "Report",
          folderPath: [],
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("report"),
          },
        },
        enriched(owner),
      );
    await expect(
      withTaskOutputLease(db, run.id, publish),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      0,
    );
    await db.scheduledTaskRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() + 60000) },
    });
    const output = await withTaskOutputLease(db, run.id, publish, {
      outputProjectId: project.id,
      projectHeads: {},
      contextSummary: {},
      inputTokens: null,
      outputTokens: null,
    });
    await failTaskRun(db, {
      runId: run.id,
      code: "ABANDONED",
      message: "late acknowledgement",
    });
    expect(
      await db.scheduledTaskRun.findUnique({ where: { id: run.id } }),
    ).toMatchObject({
      status: "running",
      outputCommitSha: output.headCommitSha,
    });
    expect(
      await db.scheduledTask.findUnique({ where: { id: task.id } }),
    ).toMatchObject({ outputDocumentId: output.id });
  });
  it("excludes inaccessible tasks from the owner's quota and never schedules deleted outputs", async () => {
    const { owner, project } = await fixture("dead-quota");
    const db = getPrisma();
    const task = await createTask(db, enriched(owner), definition(project.id));
    const row = await db.scheduledTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    for (let i = 1; i < 20; i++) {
      const { id: _id, ...data } = row;
      await db.scheduledTask.create({
        data: {
          ...data,
          scopeRequest: definition(project.id).scope,
          scopeSnapshot: task.scopeSnapshot,
          schedule: SCHEDULE,
          name: `Old ${i}`,
          nextRunAt: new Date(0),
        },
      });
    }
    await db.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });
    const next = await makeProject("New accessible output");
    await addMembership(next.id, owner.id, "Editor");
    await expect(
      createTask(db, enriched(owner), definition(next.id)),
    ).resolves.toMatchObject({ outputProjectId: next.id });
    expect(await claimDueTasks(db, new Date())).toEqual([]);
  });
  it.each(["membership", "deleted"])(
    "lets an owner remove inaccessible tasks after %s loss",
    async (kind) => {
      const { owner, project } = await fixture(`lost-${kind}`);
      const db = getPrisma();
      const task = await createTask(
        db,
        enriched(owner),
        definition(project.id),
      );
      if (kind === "deleted")
        await db.project.update({
          where: { id: project.id },
          data: { deletedAt: new Date() },
        });
      else await db.member.deleteMany({ where: { userId: owner.id } });
      expect(
        (await listOwnedTasks(db, enriched(owner))).some(
          (row) => row.id === task.id,
        ),
      ).toBe(true);
      await deleteTask(db, enriched(owner), task.id);
      expect(
        await db.scheduledTask.findUnique({ where: { id: task.id } }),
      ).toBeNull();
    },
  );
  it("redacts task inputs and run context from output viewers", async () => {
    const { owner, viewer, project } = await fixture("private-inputs");
    const db = getPrisma();
    const task = await createTask(db, enriched(owner), definition(project.id));
    await db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        trigger: "manual",
        contextSummary: { projects: [{ projectId: "private-source" }] },
        errorMessage: "private detail",
      },
    });
    const detail = await getTask(db, enriched(viewer), task.id);
    expect(detail.instruction).toBe("");
    expect(detail.scopeSnapshot.projectIds).toEqual([]);
    const history = await listTaskRuns(db, enriched(viewer), {
      taskId: task.id,
    });
    expect(history.runs[0]).toMatchObject({
      contextSummary: null,
      errorMessage: null,
    });
  });
  it("does not count abandoned leases toward automatic pausing", async () => {
    const { owner, project } = await fixture("abandoned-counter");
    const db = getPrisma();
    const task = await createTask(db, enriched(owner), definition(project.id));
    for (let i = 0; i < 5; i++) {
      const run = await db.scheduledTaskRun.create({
        data: {
          taskId: task.id,
          trigger: "manual",
          status: "running",
          leaseExpiresAt: new Date(0),
        },
      });
      await expireAbandonedRuns(db, new Date());
      expect(
        await db.scheduledTaskRun.findUnique({ where: { id: run.id } }),
      ).toMatchObject({ errorCode: "ABANDONED" });
    }
    expect(
      await db.scheduledTask.findUnique({ where: { id: task.id } }),
    ).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });

  it("keeps task details private to its owner while retaining Maintainer management", async () => {
    const { owner, maintainer, project } = await fixture("private-details");
    const created = await callerFor(owner).scheduledTask.create(
      definition(project.id),
    );
    const seen = await callerFor(maintainer).scheduledTask.get({
      taskId: created.id,
    });
    expect(seen).toMatchObject({
      canManage: true,
      canEditDefinition: false,
      instruction: "",
      externalInputs: [],
      scopeSnapshot: { projectIds: [] },
    });
    await getPrisma().scheduledTaskRun.create({
      data: {
        taskId: created.id,
        trigger: "manual",
        status: "failed",
        errorMessage: "private failure",
        contextSummary: { private: "context" },
      },
    });
    expect(
      (
        await callerFor(maintainer).scheduledTask.listRuns({
          taskId: created.id,
        })
      ).runs[0],
    ).toMatchObject({ errorMessage: null, contextSummary: null });
    expect(
      (await callerFor(owner).scheduledTask.listRuns({ taskId: created.id }))
        .runs[0],
    ).toMatchObject({
      errorMessage: "private failure",
      contextSummary: { private: "context" },
    });
    await expect(
      callerFor(maintainer).scheduledTask.pause({ taskId: created.id }),
    ).resolves.toMatchObject({
      status: "paused",
      instruction: "",
      scopeSnapshot: { projectIds: [] },
    });
  });
  it("does not admit manual or queued runs while a task is paused", async () => {
    const { owner, project } = await fixture("paused-admission");
    const created = await callerFor(owner).scheduledTask.create(
      definition(project.id),
    );
    const queued = await getPrisma().scheduledTaskRun.create({
      data: { taskId: created.id, trigger: "schedule" },
    });
    await callerFor(owner).scheduledTask.pause({ taskId: created.id });
    expect(
      await leaseTaskRun(getPrisma(), {
        runId: queued.id,
        workerId: "w",
        leaseMs: 60000,
      }),
    ).toBeNull();
    expect(
      await getPrisma().scheduledTaskRun.findUnique({
        where: { id: queued.id },
      }),
    ).toMatchObject({ status: "skipped", errorCode: "task_paused" });
    await expect(
      callerFor(owner).scheduledTask.runNow({ taskId: created.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("lets an Editor create a task, members see it, and only the owner or a Maintainer manage it", async () => {
    const { owner, maintainer, viewer, outsider, project } =
      await fixture("policy");
    const created = await callerFor(owner).scheduledTask.create(
      definition(project.id),
    );
    expect(created).toMatchObject({
      name: "Daily digest",
      status: "active",
      ownerId: owner.id,
      scheduleText: "Daily at 07:00, Europe/Berlin",
      canManage: true,
    });
    expect(created.nextRunAt).not.toBeNull();
    expect(created.scopeSnapshot.projectIds).toEqual([project.id]);

    const seenByViewer = await callerFor(viewer).scheduledTask.listForProject({
      projectId: project.id,
    });
    expect(seenByViewer.map((t) => t.id)).toEqual([created.id]);
    expect(seenByViewer[0]!.canManage).toBe(false);
    expect(
      (
        await callerFor(maintainer).scheduledTask.listForProject({
          projectId: project.id,
        })
      )[0]!.canManage,
    ).toBe(true);
    await expect(
      callerFor(outsider).scheduledTask.listForProject({
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(outsider).scheduledTask.get({ taskId: created.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Positive control before the denial: the Maintainer can pause.
    await expect(
      callerFor(maintainer).scheduledTask.pause({ taskId: created.id }),
    ).resolves.toMatchObject({
      status: "paused",
      pauseReason: "manual",
      nextRunAt: null,
    });
    await expect(
      callerFor(viewer).scheduledTask.resume({ taskId: created.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(owner).scheduledTask.resume({ taskId: created.id }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      callerFor(owner).scheduledTask.resume({ taskId: created.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(
      (await callerFor(owner).scheduledTask.listMine()).map((t) => t.id),
    ).toEqual([created.id]);
    await expect(
      callerFor(viewer).scheduledTask.create(definition(project.id)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(viewer).scheduledTask.delete({ taskId: created.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(maintainer).scheduledTask.delete({ taskId: created.id }),
    ).resolves.toBeUndefined();
    expect(await getPrisma().scheduledTask.count()).toBe(0);
  });

  it("validates the definition and enforces the limits", async () => {
    const { owner, project } = await fixture("limits");
    const caller = callerFor(owner);
    await expect(
      caller.scheduledTask.create({
        ...definition(project.id),
        timezone: "Mars/Olympus",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      // The direct caller skips the HTTP errorFormatter; the field pin rides
      // on the cause (see llm.spec.ts).
      cause: expect.objectContaining({ field: "timezone" }),
    });
    await expect(
      caller.scheduledTask.create({
        ...definition(project.id),
        outputFolderPath: ["nope"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (let i = 0; i < 20; i += 1) {
      await createTask(getPrisma(), securityContextFor(owner), {
        ...definition(project.id),
        name: `Task ${i}`,
      });
    }
    await expect(
      caller.scheduledTask.create({
        ...definition(project.id),
        name: "One too many",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("admits exactly one of two concurrent creates at the owner limit", async () => {
    const { owner, project } = await fixture("owner-race");
    await seedTasks(owner.id, project.id, 19);
    const results = await Promise.allSettled(
      ["Race A", "Race B"].map((name) =>
        createTask(getPrisma(), securityContextFor(owner), {
          ...definition(project.id),
          name,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await getPrisma().scheduledTask.count({ where: { ownerId: owner.id } }),
    ).toBe(20);
  });

  it("admits exactly one of two owners' concurrent creates at the project limit", async () => {
    const { owner, maintainer, viewer, project } =
      await fixture("project-race");
    await seedTasks(viewer.id, project.id, 49);
    const results = await Promise.allSettled(
      [owner, maintainer].map((user) =>
        createTask(getPrisma(), securityContextFor(user), {
          ...definition(project.id),
          name: `Race ${user.id}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await getPrisma().scheduledTask.count({
        where: { outputProjectId: project.id },
      }),
    ).toBe(50);
  });

  it("keeps a run's own output project after the task moves, and hides it from a reader without access", async () => {
    const db = getPrisma();
    const { owner, viewer, project } = await fixture("run-project");
    const target = await makeProject("Tasks run-project target");
    await addMembership(target.id, owner.id, "Editor");
    await addMembership(target.id, viewer.id, "Viewer");
    const actor = enriched(owner);
    const task = await createTask(db, actor, definition(project.id));
    const report = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Report",
        content: { kind: "markdown", contentJson: parseDocumentBody("first") },
      },
      actor,
    );
    const run = await db.scheduledTaskRun.create({
      data: { taskId: task.id, trigger: "schedule", status: "running" },
      select: { id: true },
    });
    await succeedTaskRun(db, {
      runId: run.id,
      outputDocumentId: report.id,
      outputCommitSha: report.headCommitSha,
      projectHeads: { [project.id]: report.headCommitSha },
      contextSummary: null,
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 5,
    });

    await updateTask(db, actor, {
      ...definition(project.id),
      taskId: task.id,
      outputProjectId: target.id,
    });
    const history = await listTaskRuns(db, actor, { taskId: task.id });
    expect(history.runs[0]).toMatchObject({
      outputDocumentId: report.id,
      outputProjectId: project.id,
      outputCommitSha: report.headCommitSha,
    });

    // The viewer still sees the task through its new project, but lost the old one.
    const { organizationId } = await db.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { organizationId: true },
    });
    await db.member.deleteMany({
      where: { userId: viewer.id, organizationId },
    });
    const limited = await listTaskRuns(db, enriched(viewer), {
      taskId: task.id,
    });
    expect(limited.runs[0]).toMatchObject({
      outputDocumentId: report.id,
      outputProjectId: null,
    });
  });

  it("lets an owner at the limit move a task, but not into a full project", async () => {
    const { owner, viewer, project } = await fixture("move");
    const target = await makeProject("Tasks move target");
    await addMembership(target.id, owner.id, "Editor");
    const full = await makeProject("Tasks move full");
    await addMembership(full.id, owner.id, "Editor");
    await seedTasks(owner.id, project.id, 20);
    await seedTasks(viewer.id, full.id, 50);
    const task = await getPrisma().scheduledTask.findFirstOrThrow({
      where: { ownerId: owner.id },
    });
    await expect(
      updateTask(getPrisma(), securityContextFor(owner), {
        ...definition(full.id),
        taskId: task.id,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      updateTask(getPrisma(), securityContextFor(owner), {
        ...definition(target.id),
        taskId: task.id,
      }),
    ).resolves.toMatchObject({ outputProjectId: target.id });
    expect(
      await getPrisma().scheduledTask.count({ where: { ownerId: owner.id } }),
    ).toBe(20);
  });

  it("run now queues exactly one run and dispatches it", async () => {
    const { owner, project } = await fixture("runnow");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const task = await callerFor(owner).scheduledTask.create(
      definition(project.id),
    );
    const { runId } = await callerFor(owner).scheduledTask.runNow({
      taskId: task.id,
    });
    expect(queue.jobs).toEqual([
      { name: "task.run", data: { runId, taskId: task.id } },
    ]);
    await expect(
      callerFor(owner).scheduledTask.runNow({ taskId: task.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const runs = await callerFor(owner).scheduledTask.listRuns({
      taskId: task.id,
    });
    expect(runs.runs).toEqual([
      expect.objectContaining({
        id: runId,
        status: "queued",
        trigger: "manual",
      }),
    ]);
  });

  it("refuses a run now it cannot dispatch and records no stuck run", async () => {
    const { owner, project } = await fixture("dispatch");
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const task = await callerFor(owner).scheduledTask.create(
      definition(project.id),
    );

    // Positive control: a working queue queues and dispatches one run.
    const dispatched = await callerFor(owner).scheduledTask.runNow({
      taskId: task.id,
    });
    expect(queue.jobs).toHaveLength(1);
    await getPrisma().scheduledTaskRun.delete({
      where: { id: dispatched.runId },
    });

    setJobQueueForTests(nullDispatchQueue);
    await expect(
      callerFor(owner).scheduledTask.runNow({ taskId: task.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      await getPrisma().scheduledTaskRun.count({ where: { taskId: task.id } }),
    ).toBe(0);

    // The refused run left nothing behind, so run now still works afterwards.
    const drained = new FakeJobQueue();
    setJobQueueForTests(drained);
    await expect(
      callerFor(owner).scheduledTask.runNow({ taskId: task.id }),
    ).resolves.toMatchObject({ runId: expect.any(String) });
    expect(drained.jobs).toHaveLength(1);
  });

  it("edits a task in place, clearing the output document only when the destination moves", async () => {
    const { owner, maintainer, project } = await fixture("update");
    const created = await callerFor(owner).scheduledTask.create(
      definition(project.id),
    );
    const living = "00000000-0000-0000-0000-0000000000aa";
    await getPrisma().scheduledTask.update({
      where: { id: created.id },
      data: { outputDocumentId: living },
    });
    const stored = async () =>
      getPrisma().scheduledTask.findUniqueOrThrow({
        where: { id: created.id },
      });

    // Positive control: a name-only edit keeps the living document and the slot.
    const renamed = await callerFor(owner).scheduledTask.update({
      ...definition(project.id),
      taskId: created.id,
      name: "Weekly digest",
    });
    expect(renamed.name).toBe("Weekly digest");
    expect(renamed.nextRunAt?.getTime()).toBe(created.nextRunAt?.getTime());
    expect((await stored()).outputDocumentId).toBe(living);

    await createFolder(
      getPrisma(),
      { projectId: project.id, parentPath: [], name: "Reports" },
      enriched(owner),
    );
    await callerFor(owner).scheduledTask.update({
      ...definition(project.id),
      taskId: created.id,
      name: "Weekly digest",
      outputFolderPath: ["reports"],
    });
    expect((await stored()).outputDocumentId).toBeNull();

    const rescheduled = await callerFor(owner).scheduledTask.update({
      ...definition(project.id),
      taskId: created.id,
      name: "Weekly digest",
      outputFolderPath: ["reports"],
      schedule: { kind: "hourly", minute: 30 },
    });
    expect(rescheduled.nextRunAt?.getTime()).not.toBe(
      created.nextRunAt?.getTime(),
    );

    await expect(
      callerFor(maintainer).scheduledTask.update({
        ...definition(project.id),
        taskId: created.id,
        name: "Maintained digest",
        outputFolderPath: ["reports"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A destination the editor cannot see at all is invisible, not refused.
    const stranger = await makeProject("Stranger update");
    await expect(
      callerFor(owner).scheduledTask.update({
        ...definition(project.id),
        taskId: created.id,
        outputProjectId: stranger.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const readOnly = await makeProject("Read-only update");
    await addMembership(readOnly.id, owner.id, "Viewer");
    await expect(
      callerFor(owner).scheduledTask.update({
        ...definition(project.id),
        taskId: created.id,
        outputProjectId: readOnly.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stored()).toMatchObject({ outputProjectId: project.id });
  });

  it("resolves the task maintaining an output document for any project member", async () => {
    const { owner, viewer, outsider, project } = await fixture("byoutput");
    const created = await callerFor(owner).scheduledTask.create(
      definition(project.id),
    );
    const output = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Daily digest",
        content: { kind: "markdown", contentJson: parseDocumentBody("report") },
      },
      enriched(owner),
    );
    const unrelated = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("restart nginx"),
        },
      },
      enriched(owner),
    );
    await getPrisma().scheduledTask.update({
      where: { id: created.id },
      data: { outputDocumentId: output.id },
    });

    await expect(
      callerFor(viewer).scheduledTask.byOutputDocument({
        projectId: project.id,
        documentId: output.id,
      }),
    ).resolves.toEqual({ id: created.id, name: created.name });
    await expect(
      callerFor(outsider).scheduledTask.byOutputDocument({
        projectId: project.id,
        documentId: output.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(viewer).scheduledTask.byOutputDocument({
        projectId: project.id,
        documentId: unrelated.id,
      }),
    ).resolves.toBeNull();
  });
});

describe("scheduled task claiming and run state", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });

  it("claims a due task exactly once under two concurrent ticks and advances nextRunAt", async () => {
    const { owner, project } = await fixture("claim");
    const task = await createTask(
      getPrisma(),
      securityContextFor(owner),
      definition(project.id),
    );
    const due = new Date(Date.now() - 60_000);
    await getPrisma().scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: due },
    });
    const now = new Date();
    const [a, b] = await Promise.all([
      claimDueTasks(getPrisma(), now),
      claimDueTasks(getPrisma(), now),
    ]);
    expect(a.length + b.length).toBe(1);
    const after = await getPrisma().scheduledTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(
      await getPrisma().scheduledTaskRun.count({
        where: { taskId: task.id, status: "queued" },
      }),
    ).toBe(1);
    // Nothing is due any more: a third tick claims nothing.
    expect(await claimDueTasks(getPrisma(), new Date())).toEqual([]);
    await getPrisma().scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: due },
    });
    expect(await claimDueTasks(getPrisma(), new Date())).toEqual([]);
    expect(
      await getPrisma().scheduledTaskRun.count({ where: { taskId: task.id } }),
    ).toBe(1);
  });

  it("leases a queued run once, skips an overlapping one, and expires an abandoned lease", async () => {
    const { owner, project } = await fixture("lease");
    const task = await createTask(
      getPrisma(),
      securityContextFor(owner),
      definition(project.id),
    );
    const { runId } = await runTaskNow(
      getPrisma(),
      securityContextFor(owner),
      task.id,
    );
    const leased = await leaseTaskRun(getPrisma(), {
      runId,
      workerId: "w1",
      leaseMs: 60_000,
    });
    expect(leased?.task.id).toBe(task.id);
    expect(leased?.owner.id).toBe(owner.id);
    expect(
      await leaseTaskRun(getPrisma(), {
        runId,
        workerId: "w2",
        leaseMs: 60_000,
      }),
    ).toBeNull();
    // The losing worker must not rewrite the lease the winner holds.
    expect(
      await getPrisma().scheduledTaskRun.findUniqueOrThrow({
        where: { id: runId },
      }),
    ).toMatchObject({ status: "running", errorCode: null });

    const overlapping = await getPrisma().scheduledTaskRun.create({
      data: { taskId: task.id, trigger: "schedule" },
      select: { id: true },
    });
    expect(
      await leaseTaskRun(getPrisma(), {
        runId: overlapping.id,
        workerId: "w2",
        leaseMs: 60_000,
      }),
    ).toBeNull();
    expect(
      await getPrisma().scheduledTaskRun.findUniqueOrThrow({
        where: { id: overlapping.id },
      }),
    ).toMatchObject({
      status: "skipped",
      errorCode: "overlap",
    });

    await getPrisma().scheduledTaskRun.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await expireAbandonedRuns(getPrisma(), new Date())).toBe(1);
    expect(
      await getPrisma().scheduledTaskRun.findUniqueOrThrow({
        where: { id: runId },
      }),
    ).toMatchObject({
      status: "failed",
      errorCode: "ABANDONED",
    });
    expect(
      (
        await getPrisma().scheduledTask.findUniqueOrThrow({
          where: { id: task.id },
        })
      ).consecutiveFailures,
    ).toBe(0);

    // The abandoned worker finishing late must not restamp the task, and must
    // learn it lost the race so it never reports the run as succeeded.
    const late = await succeedTaskRun(getPrisma(), {
      runId,
      outputDocumentId: "00000000-0000-0000-0000-000000000123",
      outputCommitSha: "late",
      projectHeads: {},
      contextSummary: {
        documents: 0,
        tables: 0,
        commits: 0,
        truncated: false,
        fallback: "none",
      },
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    });
    expect(late).toBe(false);
    expect(
      await getPrisma().scheduledTaskRun.findUniqueOrThrow({
        where: { id: runId },
      }),
    ).toMatchObject({ status: "failed", errorCode: "ABANDONED" });
    expect(
      await getPrisma().scheduledTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
    ).toMatchObject({
      lastRunStatus: "failed",
      consecutiveFailures: 0,
      outputDocumentId: null,
    });
  });

  it("pauses a task after five consecutive failures and resets on resume or success", async () => {
    const { owner, project } = await fixture("failing");
    const actor = securityContextFor(owner);
    const task = await createTask(getPrisma(), actor, definition(project.id));
    for (let i = 0; i < 5; i += 1) {
      const run = await getPrisma().scheduledTaskRun.create({
        data: { taskId: task.id, trigger: "schedule", status: "running" },
        select: { id: true },
      });
      const outcome = await failTaskRun(getPrisma(), {
        runId: run.id,
        code: "PROVIDER_ERROR",
        message: "boom",
      });
      expect(outcome.paused).toBe(i === 4);
    }
    expect(
      await getPrisma().scheduledTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
    ).toMatchObject({
      status: "paused",
      pauseReason: "failing",
      consecutiveFailures: 5,
      lastRunStatus: "failed",
    });
    await resumeTask(getPrisma(), actor, task.id);
    const run = await getPrisma().scheduledTaskRun.create({
      data: { taskId: task.id, trigger: "schedule", status: "running" },
      select: { id: true },
    });
    const succeeded = await succeedTaskRun(getPrisma(), {
      runId: run.id,
      outputDocumentId: "00000000-0000-0000-0000-000000000123",
      outputCommitSha: "abc",
      projectHeads: { [project.id]: "abc" },
      contextSummary: {
        documents: 0,
        tables: 0,
        commits: 0,
        truncated: false,
        fallback: "none",
      },
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 5,
    });
    expect(succeeded).toBe(true);
    expect(
      await getPrisma().scheduledTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
    ).toMatchObject({
      status: "active",
      consecutiveFailures: 0,
      lastRunStatus: "succeeded",
      outputDocumentId: "00000000-0000-0000-0000-000000000123",
    });
    expect(
      (await listProjectTasks(getPrisma(), actor, project.id))[0]!
        .lastRunStatus,
    ).toBe("succeeded");
  });

  it("never rewrites a run another worker just leased when two workers race", async () => {
    const { owner, project } = await fixture("race");
    const task = await createTask(
      getPrisma(),
      securityContextFor(owner),
      definition(project.id),
    );
    const { runId } = await runTaskNow(
      getPrisma(),
      securityContextFor(owner),
      task.id,
    );
    // Both read the run as queued before either takes the task lock; the
    // loser must not skip the run the winner is already executing.
    const [a, b] = await Promise.all([
      leaseTaskRun(getPrisma(), { runId, workerId: "wa", leaseMs: 60_000 }),
      leaseTaskRun(getPrisma(), { runId, workerId: "wb", leaseMs: 60_000 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(
      await getPrisma().scheduledTaskRun.findUniqueOrThrow({
        where: { id: runId },
      }),
    ).toMatchObject({ status: "running", errorCode: null });
  });
});

function reportModel(
  prompts: string[],
  text = "## Report\n\nNothing burned down.",
  onGenerate?: () => void,
  finishReason: "stop" | "length" = "stop",
) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      onGenerate?.();
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: finishReason, raw: undefined },
        usage: {
          inputTokens: {
            total: 12,
            noCache: 12,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      } as never;
    },
  });
}

function runnerDeps(model: MockLanguageModelV4) {
  return {
    db: getPrisma(),
    ring: testEncryptionKeys(),
    workerId: "test-worker",
    modelFactory: () => model,
    heartbeatMs: 100,
  };
}

/**
 * pg-boss frees a `task.run` singleton key once the job leaves the queue;
 * FakeJobQueue keeps every job it was ever sent, so a fresh queue stands in
 * for the drained one when the same task runs again.
 */
async function queueRun(
  actor: Parameters<typeof runTaskNow>[1],
  taskId: string,
) {
  setJobQueueForTests(new FakeJobQueue());
  return runTaskNow(getPrisma(), actor, taskId);
}

async function latestRun(taskId: string) {
  return getPrisma().scheduledTaskRun.findFirstOrThrow({
    where: { taskId },
    orderBy: { queuedAt: "desc" },
  });
}

describe("scheduled task runner", () => {
  it.each([false, true])(
    "retries a published report acknowledgement without provider failure (committed=%s)",
    async (committed) => {
      await seedTestLlmRouting({ jobs: true });
      const { owner, project } = await fixture(`report-ack-${committed}`);
      const db = getPrisma();
      const actor = securityContextFor(owner);
      const task = await createTask(db, actor, definition(project.id));
      const { runId } = await queueRun(actor, task.id);
      const original = taskServices.succeedTaskRun;
      vi.spyOn(taskServices, "succeedTaskRun").mockImplementationOnce(
        async (...args) => {
          if (committed) await original(...args);
          throw new Error("acknowledgement lost");
        },
      );
      const prompts: string[] = [];
      await executeScheduledTaskRun(runnerDeps(reportModel(prompts)), runId);
      expect(await latestRun(task.id)).toMatchObject({
        status: "succeeded",
        errorCode: null,
      });
      expect(
        (await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } }))
          .consecutiveFailures,
      ).toBe(0);
      expect(prompts).toHaveLength(1);
      expect(
        await db.document.count({ where: { projectId: project.id } }),
      ).toBe(1);
    },
  );

  it.each([true, false])(
    "recovers publication only from trusted Git after acknowledgement outages (trusted=%s)",
    async (trusted) => {
      await seedTestLlmRouting({ jobs: true });
      const { owner, project } = await fixture("report-git-receipt");
      const db = getPrisma();
      const actor = securityContextFor(owner);
      const task = await createTask(db, actor, definition(project.id));
      const { runId } = await queueRun(actor, task.id);
      const original = taskServices.withTaskOutputLease;
      const publication = vi
        .spyOn(taskServices, "withTaskOutputLease")
        .mockImplementation((client, id, write, receipt) => {
          const failed = new Proxy(client, {
            get(target, key, receiver) {
              if (key === "$transaction")
                return (
                  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
                ) =>
                  target.$transaction(async (tx) => {
                    await callback(tx);
                    throw new Error("publication transaction rolled back");
                  });
              if (key === "scheduledTaskRun")
                return new Proxy(target.scheduledTaskRun, {
                  get(model, prop, modelReceiver) {
                    if (prop === "updateMany")
                      return (args: Prisma.ScheduledTaskRunUpdateManyArgs) => {
                        if (args.data.outputCommitSha)
                          throw new Error("receipt unavailable");
                        return model.updateMany(args);
                      };
                    return Reflect.get(model, prop, modelReceiver) as unknown;
                  },
                });
              return Reflect.get(target, key, receiver) as unknown;
            },
          });
          return original(failed, id, write, receipt);
        });
      const acknowledgement = vi
        .spyOn(taskServices, "succeedTaskRun")
        .mockRejectedValue(new Error("acknowledgement unavailable"));
      const prompts: string[] = [];
      try {
        await executeScheduledTaskRun(runnerDeps(reportModel(prompts)), runId);
      } finally {
        publication.mockRestore();
        acknowledgement.mockRestore();
      }
      expect(await latestRun(task.id)).toMatchObject({
        status: "running",
        outputCommitSha: null,
        contextSummary: expect.any(Object),
      });
      const ledgerPath = path.join(
        repoDir(project.id),
        ".git",
        "weaver-trusted-commits",
      );
      const ledger = await readFile(ledgerPath, "utf8");
      if (!trusted) await writeFile(ledgerPath, "");
      await expireAbandonedRuns(db, new Date(Date.now() + 3600000));
      if (!trusted) {
        expect(await latestRun(task.id)).toMatchObject({
          status: "running",
          outputCommitSha: null,
        });
        await writeFile(ledgerPath, ledger);
        await expireAbandonedRuns(db, new Date(Date.now() + 3600000));
      }
      expect(await latestRun(task.id)).toMatchObject({
        status: "succeeded",
        outputCommitSha: expect.any(String),
        errorCode: null,
      });
      expect(prompts).toHaveLength(1);
    },
  );

  it("reconciles a published report after repeated acknowledgement failures", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project } = await fixture("report-ack-reconcile");
    const db = getPrisma();
    const actor = securityContextFor(owner);
    const task = await createTask(db, actor, definition(project.id));
    const { runId } = await queueRun(actor, task.id);
    const spy = vi
      .spyOn(taskServices, "succeedTaskRun")
      .mockRejectedValue(new Error("database temporarily unavailable"));
    const prompts: string[] = [];
    await executeScheduledTaskRun(runnerDeps(reportModel(prompts)), runId);
    spy.mockRestore();
    expect(await latestRun(task.id)).toMatchObject({
      status: "running",
      outputCommitSha: expect.any(String),
    });
    await expireAbandonedRuns(db, new Date(Date.now() + 3600000));
    expect(await latestRun(task.id)).toMatchObject({
      status: "succeeded",
      errorCode: null,
    });
    expect(
      (await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } }))
        .consecutiveFailures,
    ).toBe(0);
    expect(prompts).toHaveLength(1);
  });

  it("classifies permission loss inside the publication lease as OUTPUT_FORBIDDEN", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project } = await fixture("publication-access");
    const db = getPrisma();
    const task = await createTask(
      db,
      securityContextFor(owner),
      definition(project.id),
    );
    const { runId } = await runTaskNow(db, securityContextFor(owner), task.id);
    const original = taskServices.withTaskOutputLease;
    const gate = vi
      .spyOn(taskServices, "withTaskOutputLease")
      .mockImplementation((client, id, write) =>
        original(client, id, async () => {
          await db.member.updateMany({
            where: { userId: owner.id },
            data: { role: "viewer" },
          });
          return write();
        }),
      );
    try {
      await executeScheduledTaskRun(runnerDeps(reportModel([])), runId);
    } finally {
      gate.mockRestore();
    }
    expect(
      await db.scheduledTaskRun.findUnique({ where: { id: runId } }),
    ).toMatchObject({ status: "failed", errorCode: "OUTPUT_FORBIDDEN" });
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      0,
    );
  });

  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(async () => {
    await stopDiagnosticWriter();
    invalidateDiagnosticsSettingsCache();
  });

  it.each([false, true])(
    "never publishes after lease expiry while waiting for the project repository (swept=%s)",
    async (swept) => {
      await seedTestLlmRouting({ jobs: true });
      const { owner, project } = await fixture("publication-wait");
      const db = getPrisma();
      const task = await createTask(
        db,
        securityContextFor(owner),
        definition(project.id),
      );
      const { runId } = await runTaskNow(
        db,
        securityContextFor(owner),
        task.id,
      );
      let generated!: () => void;
      const ready = new Promise<void>((resolve) => {
        generated = resolve;
      });
      let execution: Promise<void> | undefined;
      await withProjectRepo(project.id, async () => {
        execution = executeScheduledTaskRun(
          {
            ...runnerDeps(reportModel([], undefined, generated)),
            heartbeatMs: 60_000,
          },
          runId,
        );
        await ready;
        await db.scheduledTaskRun.update({
          where: { id: runId },
          data: { leaseExpiresAt: new Date(0) },
        });
        if (swept) await expireAbandonedRuns(db, new Date());
      });
      await execution;
      expect(
        await db.document.count({ where: { projectId: project.id } }),
      ).toBe(0);
      expect(
        await db.scheduledTask.findUnique({ where: { id: task.id } }),
      ).toMatchObject({ outputDocumentId: null, consecutiveFailures: 0 });
      expect(
        await db.scheduledTaskRun.findUnique({ where: { id: runId } }),
      ).toMatchObject({ status: "failed", errorCode: "ABANDONED" });
    },
  );

  it("ends a failed run with a diagnostic reference and records the error summary", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project } = await fixture("runner-reference");
    const actor = securityContextFor(owner);
    const admin = await makeUser("Admin", "task-reference-admin");
    await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
      level: "errors",
    });
    startDiagnosticWriter({
      db: getPrisma(),
      runtime: "worker",
      flushIntervalMs: 60_000,
    });
    const task = await createTask(getPrisma(), actor, definition(project.id));
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw Object.assign(new Error("outbound endpoint is not allowed"), {
          code: "OUTBOUND_NOT_ALLOWED",
        });
      },
    });
    const queued = await queueRun(actor, task.id);
    await executeScheduledTaskRun(runnerDeps(model), queued.runId);

    const stored = await getPrisma().scheduledTaskRun.findUniqueOrThrow({
      where: { id: queued.runId },
      select: { status: true, errorCode: true, errorMessage: true },
    });
    expect(stored.status).toBe("failed");
    expect(stored.errorMessage).toMatch(/ \(ref [0-9a-f]{8}\)$/);
    const reference = /\(ref ([0-9a-f]{8})\)$/.exec(stored.errorMessage!)![1]!;
    await flushDiagnostics(true);
    const event = await getPrisma().diagnosticEvent.findFirstOrThrow({
      where: { event: "task.run.failed" },
    });
    expect(event.id.startsWith(reference)).toBe(true);
    expect(event.details).toMatchObject({
      reference,
      error: { name: expect.any(String) },
    });
  });

  it("rejects truncated reports without changing the output or successful baseline", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project } = await fixture("runner-truncated");
    const actor = securityContextFor(owner);
    const task = await createTask(getPrisma(), actor, definition(project.id));
    const first = await queueRun(actor, task.id);
    await executeScheduledTaskRun(runnerDeps(reportModel([])), first.runId);
    const baseline = await latestRun(task.id);
    expect(baseline.status).toBe("succeeded");
    const second = await queueRun(actor, task.id);
    await executeScheduledTaskRun(
      runnerDeps(reportModel([], "## Partial report", undefined, "length")),
      second.runId,
    );
    expect(await latestRun(task.id)).toMatchObject({
      status: "failed",
      errorCode: "CONTENT_INVALID",
      projectHeads: null,
    });
    expect(
      await getPrisma().document.findUniqueOrThrow({
        where: { id: baseline.outputDocumentId! },
      }),
    ).toMatchObject({ headCommitSha: baseline.outputCommitSha });
    expect(
      await getPrisma().scheduledTaskRun.findUniqueOrThrow({
        where: { id: first.runId },
      }),
    ).toMatchObject({ projectHeads: baseline.projectHeads });
    expect(
      await getPrisma().aiUsage.findFirstOrThrow({
        where: { runId: second.runId },
      }),
    ).toMatchObject({
      outcome: "validation_failure",
      inputTokens: 12,
      outputTokens: 5,
    });
  });

  it("writes the output document with provenance, accounts usage, and updates the same document on the next run", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project } = await fixture("runner");
    const actor = securityContextFor(owner);
    await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("restart nginx"),
        },
      },
      enriched(owner),
    );
    const task = await createTask(getPrisma(), actor, definition(project.id));
    const prompts: string[] = [];
    const deps = runnerDeps(reportModel(prompts));

    await addEligibleGitRemote(project.id);
    const first = await queueRun(actor, task.id);
    const pushQueue = new FakeJobQueue();
    setJobQueueForTests(pushQueue);
    await executeScheduledTaskRun(deps, first.runId);
    await vi.waitFor(
      () =>
        expect(pushQueue.jobs).toContainEqual(
          expect.objectContaining({ name: "project.git-push" }),
        ),
      { timeout: 5000 },
    );
    const firstRun = await latestRun(task.id);
    expect(firstRun).toMatchObject({
      status: "succeeded",
      inputTokens: 12,
      outputTokens: 5,
    });
    expect(prompts[0]).toContain("Runbook");
    const detail = await getTask(getPrisma(), actor, task.id);
    expect(detail.outputDocumentId).toBe(firstRun.outputDocumentId);
    const doc = await getPrisma().document.findUniqueOrThrow({
      where: { id: detail.outputDocumentId! },
    });
    expect(doc.title).toBe("Daily digest");
    expect(doc.headCommitSha).toBe(firstRun.outputCommitSha);
    const repo = await openProjectRepo(project.id);
    const [commit] = await repo!.logForPath(doc.path, { skip: 0, limit: 1 });
    expect(commit).toMatchObject({
      runId: first.runId,
      operationId: `task-run:${first.runId}`,
      userId: owner.id,
    });
    expect(
      await getPrisma().aiUsage.findFirst({
        where: { operation: "task.run", runId: first.runId },
      }),
    ).toMatchObject({
      projectId: project.id,
      inputTokens: 12,
      outputTokens: 5,
      outcome: "success",
    });

    const second = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, second.runId);
    const secondRun = await latestRun(task.id);
    expect(secondRun.status).toBe("succeeded");
    expect(secondRun.outputDocumentId).toBe(firstRun.outputDocumentId);
    expect(secondRun.outputCommitSha).not.toBe(firstRun.outputCommitSha);
    // The task's own report never feeds the next run.
    expect(prompts[1]).not.toContain("Document: Daily digest");
    expect(prompts[1]).toContain("Runbook");
    expect(
      await getPrisma().document.count({ where: { projectId: project.id } }),
    ).toBe(2);
  });

  it("writes into a chosen document, revises it in update mode, and names a created one", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project } = await fixture("target");
    const actor = securityContextFor(owner);
    const existing = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Status page",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Old status: all green"),
        },
      },
      enriched(owner),
    );
    await expect(
      createTask(getPrisma(), actor, {
        ...definition(project.id),
        outputDocumentId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "outputDocumentId" },
    });
    const task = await createTask(getPrisma(), actor, {
      ...definition(project.id),
      outputDocumentId: existing.id,
      outputMode: "update",
      outputTitle: "Status page (recreated)",
    });
    expect(task).toMatchObject({
      outputDocumentId: existing.id,
      outputMode: "update",
      outputTitle: "Status page (recreated)",
      ownerEmail: owner.email,
    });
    await expect(
      createTask(getPrisma(), actor, {
        ...definition(project.id),
        name: "Second writer",
        outputDocumentId: existing.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const prompts: string[] = [];
    const deps = runnerDeps(reportModel(prompts));
    const first = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, first.runId);
    const firstRun = await latestRun(task.id);
    expect(firstRun).toMatchObject({
      status: "succeeded",
      outputDocumentId: existing.id,
    });
    expect(prompts[0]).toContain("## Current document");
    expect(prompts[0]).toContain("Old status: all green");
    expect(
      await getPrisma().document.count({ where: { projectId: project.id } }),
    ).toBe(1);

    // A deleted target is recreated under the configured title.
    await deleteDocument(
      getPrisma(),
      { projectId: project.id, documentId: existing.id },
      enriched(owner),
    );
    const second = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, second.runId);
    const secondRun = await latestRun(task.id);
    expect(secondRun.status).toBe("succeeded");
    expect(secondRun.outputDocumentId).not.toBe(existing.id);
    expect(prompts[1]).not.toContain("## Current document");
    expect(
      (
        await getPrisma().document.findUniqueOrThrow({
          where: { id: secondRun.outputDocumentId! },
        })
      ).title,
    ).toBe("Status page (recreated)");

    // An edit that leaves the target out keeps it; null asks for a new document.
    const kept = await updateTask(getPrisma(), actor, {
      taskId: task.id,
      ...definition(project.id),
    });
    expect(kept.outputDocumentId).toBe(secondRun.outputDocumentId);
    expect(kept.outputMode).toBe("update");
    const cleared = await updateTask(getPrisma(), actor, {
      taskId: task.id,
      ...definition(project.id),
      outputDocumentId: null,
      outputMode: "replace",
    });
    expect(cleared).toMatchObject({
      outputDocumentId: null,
      outputMode: "replace",
    });
  });

  it("skips a run while the owner must change their password or is deactivated, and resumes afterwards", async () => {
    await seedTestLlmRouting({ jobs: true });
    const admin = await makeUser("Admin", "runner-admin");
    const { owner, project } = await fixture("runner-skip");
    const actor = securityContextFor(owner);
    const task = await createTask(getPrisma(), actor, definition(project.id));
    const deps = runnerDeps(reportModel([]));

    const ok = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, ok.runId);
    expect((await latestRun(task.id)).status).toBe("succeeded");

    await getPrisma().user.update({
      where: { id: owner.id },
      data: { mustChangePassword: true },
    });
    const flagged = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, flagged.runId);
    expect(await latestRun(task.id)).toMatchObject({
      status: "skipped",
      errorCode: "owner_password_change",
    });
    await getPrisma().user.update({
      where: { id: owner.id },
      data: { mustChangePassword: false },
    });

    await callerFor(admin).user.deactivate({
      userId: owner.id,
      reason: "left",
    });
    const banned = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, banned.runId);
    expect(await latestRun(task.id)).toMatchObject({
      status: "skipped",
      errorCode: "owner_inactive",
    });
    expect(
      (
        await getPrisma().scheduledTask.findUniqueOrThrow({
          where: { id: task.id },
        })
      ).status,
    ).toBe("active");

    await callerFor(admin).user.reactivate({ userId: owner.id });
    const again = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, again.runId);
    expect((await latestRun(task.id)).status).toBe("succeeded");
  });

  it("fails with OUTPUT_FORBIDDEN after losing Editor on the output project and SCOPE_EMPTY after losing the scope", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project: output } = await fixture("runner-access");
    const source = await makeProject("Source");
    await addMembership(source.id, owner.id, "Viewer");
    const actor = securityContextFor(owner);
    const task = await createTask(getPrisma(), actor, {
      ...definition(output.id),
      scope: { kind: "project" as const, projectId: source.id },
    });
    const deps = runnerDeps(reportModel([]));
    const ok = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, ok.runId);
    expect((await latestRun(task.id)).status).toBe("succeeded");

    const outputOrg = await getPrisma().project.findUniqueOrThrow({
      where: { id: output.id },
      select: { organizationId: true },
    });
    const outputMember = await getPrisma().member.findFirstOrThrow({
      where: { userId: owner.id, organizationId: outputOrg.organizationId },
    });
    await getPrisma().member.delete({ where: { id: outputMember.id } });
    const forbidden = await getPrisma().scheduledTaskRun.create({
      data: { taskId: task.id, trigger: "manual" },
      select: { id: true },
    });
    await executeScheduledTaskRun(deps, forbidden.id);
    expect(await latestRun(task.id)).toMatchObject({
      status: "failed",
      errorCode: "OUTPUT_FORBIDDEN",
    });

    await addMembership(output.id, owner.id, "Editor");
    const sourceOrg = await getPrisma().project.findUniqueOrThrow({
      where: { id: source.id },
      select: { organizationId: true },
    });
    await getPrisma().member.deleteMany({
      where: { userId: owner.id, organizationId: sourceOrg.organizationId },
    });
    const empty = await getPrisma().scheduledTaskRun.create({
      data: { taskId: task.id, trigger: "manual" },
      select: { id: true },
    });
    await executeScheduledTaskRun(deps, empty.id);
    expect(await latestRun(task.id)).toMatchObject({
      status: "failed",
      errorCode: "SCOPE_EMPTY",
    });
    expect(
      (
        await getPrisma().scheduledTask.findUniqueOrThrow({
          where: { id: task.id },
        })
      ).consecutiveFailures,
    ).toBe(2);
  });

  it("fails with SCOPE_EMPTY when the scoped document no longer exists", async () => {
    await seedTestLlmRouting({ jobs: true });
    const { owner, project } = await fixture("runner-scope-doc");
    const actor = securityContextFor(owner);
    const source = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("restart nginx"),
        },
      },
      enriched(owner),
    );
    const task = await createTask(getPrisma(), actor, {
      ...definition(project.id),
      scope: {
        kind: "document" as const,
        projectId: project.id,
        documentId: source.id,
      },
    });
    const deps = runnerDeps(reportModel([]));

    // Positive control: the document-scoped task runs while its document exists.
    const ok = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, ok.runId);
    expect((await latestRun(task.id)).status).toBe("succeeded");

    await deleteDocument(
      getPrisma(),
      { projectId: project.id, documentId: source.id },
      enriched(owner),
    );
    const gone = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, gone.runId);
    // The scope item is gone; the output document is untouched.
    expect(await latestRun(task.id)).toMatchObject({
      status: "failed",
      errorCode: "SCOPE_EMPTY",
    });
  });

  it("fails with ROUTE_MISSING when no jobs route is configured", async () => {
    const { owner, project } = await fixture("runner-route");
    const actor = securityContextFor(owner);
    const task = await createTask(getPrisma(), actor, definition(project.id));
    const deps = runnerDeps(reportModel([]));
    const run = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, run.runId);
    expect(await latestRun(task.id)).toMatchObject({
      status: "failed",
      errorCode: "ROUTE_MISSING",
    });

    // The same fixture succeeds once a jobs route exists.
    await seedTestLlmRouting({ jobs: true });
    const routed = await queueRun(actor, task.id);
    await executeScheduledTaskRun(deps, routed.runId);
    expect(await latestRun(task.id)).toMatchObject({ status: "succeeded" });
  });
});

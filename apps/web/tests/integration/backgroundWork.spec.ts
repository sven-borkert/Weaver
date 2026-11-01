import { Prisma } from "@weaver/db/client";
import { authorizedWorkSql } from "@weaver/core/services/backgroundWork/queries";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createApiKeySecurityContext,
  createOAuthSecurityContext,
} from "@weaver/core/security/context";
import { NOTEBOOK_PARSER_VERSION } from "@weaver/core/artifacts/notebookSchema";
import {
  getBackgroundWorkSummary,
  listBackgroundWork,
  markBackgroundWorkSeen,
  pruneBackgroundWorkReceipts,
} from "@weaver/core/services/backgroundWork";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const DAY = 24 * 60 * 60 * 1_000;

type UserFixture = Awaited<ReturnType<typeof makeUser>>;

async function removeMembership(projectId: string, userId: string) {
  const project = await getPrisma().project.findUniqueOrThrow({
    where: { id: projectId },
    select: { organizationId: true },
  });
  await getPrisma().member.deleteMany({
    where: { organizationId: project.organizationId, userId },
  });
}

async function createTaskRun(input: {
  owner: UserFixture;
  projectId: string;
  name: string;
  status?: "queued" | "running" | "succeeded" | "failed" | "skipped";
  errorMessage?: string;
  at?: Date;
}) {
  const at = input.at ?? new Date();
  const task = await getPrisma().scheduledTask.create({
    data: {
      ownerId: input.owner.id,
      name: input.name,
      instruction: "fixture",
      scopeRequest: { kind: "project", projectId: input.projectId },
      scopeSnapshot: {
        kind: "project",
        projectIds: [input.projectId],
        documentId: null,
        tableId: null,
        resolvedAt: at.toISOString(),
        truncated: false,
      },
      outputProjectId: input.projectId,
      outputFolderPath: [],
      schedule: { kind: "daily", hour: 7, minute: 0 },
      timezone: "UTC",
      cron: "0 7 * * *",
    },
  });
  const status = input.status ?? "succeeded";
  return getPrisma().scheduledTaskRun.create({
    data: {
      taskId: task.id,
      trigger: "manual",
      status,
      queuedAt: at,
      startedAt: status === "queued" ? null : at,
      finishedAt: ["succeeded", "failed", "skipped"].includes(status)
        ? at
        : null,
      errorMessage: input.errorMessage ?? null,
    },
  });
}

async function createImport(input: {
  owner: UserFixture;
  projectId: string;
  name: string;
  status?:
    | "pending"
    | "parsing"
    | "extracting"
    | "linking"
    | "ready"
    | "accepting"
    | "accepted"
    | "rejected"
    | "failed"
    | "blocked_configuration";
  failureMessage?: string;
  at?: Date;
  attemptCount?: number;
  origin?: "upload" | "external";
}) {
  const at = input.at ?? new Date();
  const batch = await getPrisma().ingestionBatch.create({
    data: {
      projectId: input.projectId,
      createdById: input.owner.id,
      origin: input.origin ?? "upload",
      createdAt: at,
    },
  });
  const status = input.status ?? "ready";
  return getPrisma().ingestionFile.create({
    data: {
      batchId: batch.id,
      projectId: input.projectId,
      fileName: input.name,
      mimeType: "text/markdown",
      byteSize: 10,
      contentDigest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      status,
      failureMessage: input.failureMessage ?? null,
      attemptCount: input.attemptCount ?? 1,
      createdAt: at,
      parseStartedAt: status === "pending" ? null : at,
      parseEndedAt: [
        "ready",
        "accepting",
        "accepted",
        "rejected",
        "failed",
        "blocked_configuration",
      ].includes(status)
        ? at
        : null,
    },
  });
}

async function createAssistantRun(input: {
  owner: UserFixture;
  projectIds: string[];
  status?:
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  errorMessage?: string;
  at?: Date;
  scopeSnapshot?: unknown;
}) {
  const at = input.at ?? new Date();
  const conversation = await getPrisma().assistantConversation.create({
    data: { ownerId: input.owner.id, title: "Private title", createdAt: at },
  });
  const message = await getPrisma().assistantMessage.create({
    data: {
      conversationId: conversation.id,
      position: 0,
      role: "user",
      status: "complete",
      content: { text: "secret prompt" },
      createdAt: at,
    },
  });
  const status = input.status ?? "completed";
  const scopeSnapshot = input.scopeSnapshot ?? {
    kind: input.projectIds.length === 1 ? "project" : "projects",
    projectIds: input.projectIds,
    documentId: null,
    tableId: null,
    resolvedAt: at.toISOString(),
    truncated: false,
  };
  return getPrisma().assistantRun.create({
    data: {
      conversationId: conversation.id,
      userMessageId: message.id,
      status,
      scopeSnapshot: scopeSnapshot as object,
      actorSnapshot: { userId: input.owner.id },
      queuedAt: at,
      startedAt: status === "queued" ? null : at,
      finishedAt: ["completed", "failed", "cancelled"].includes(status)
        ? at
        : null,
      errorMessage: input.errorMessage ?? null,
    },
  });
}

async function createKnowledge(input: {
  projectId: string;
  status: "building" | "active" | "failed" | "superseded";
  documentStates?: Array<
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "blocked_configuration"
    | "missing"
  >;
  failureSummary?: string;
  at?: Date;
  buildTrigger?:
    "initial" | "embedding_change" | "index_upgrade" | "manual_rebuild";
  requestedById?: string;
  graphSourceGenerationId?: string;
}) {
  const at = input.at ?? new Date();
  const generation = await getPrisma().knowledgeGeneration.create({
    data: {
      projectId: input.projectId,
      configFingerprint: randomUUID(),
      embeddingModel: "fixture",
      embeddingDimensions: 3,
      extractionSchemaVersion: 1,
      promptVersion: "fixture",
      status: input.status,
      createdAt: at,
      completedAt: input.status === "building" ? null : at,
      activatedAt: input.status === "active" ? at : null,
      supersededAt: input.status === "superseded" ? at : null,
      failureSummary: input.failureSummary ?? null,
      buildTrigger: input.buildTrigger ?? null,
      requestedById: input.requestedById ?? null,
      graphSourceGenerationId: input.graphSourceGenerationId ?? null,
    },
  });
  const states = input.documentStates ?? [];
  if (states.length > 0) {
    await getPrisma().knowledgeGenerationDocument.createMany({
      data: states.map((status) => ({
        generationId: generation.id,
        documentId: randomUUID(),
        projectId: input.projectId,
        targetSha: randomUUID(),
        configFingerprint: generation.configFingerprint,
        status,
      })),
    });
  }
  return generation;
}

async function baseFixture(suffix: string) {
  const owner = await makeUser("User", `${suffix}-owner`);
  const other = await makeUser("User", `${suffix}-other`);
  const maintainer = await makeUser("User", `${suffix}-maintainer`);
  const project = await makeProject(`${suffix} visible`);
  const secondProject = await makeProject(`${suffix} second`);
  await addMembership(project.id, owner.id, "Editor");
  await addMembership(secondProject.id, owner.id, "Viewer");
  await addMembership(project.id, maintainer.id, "Maintainer");
  await addMembership(secondProject.id, maintainer.id, "Maintainer");
  await addMembership(project.id, other.id, "Editor");
  return { owner, other, maintainer, project, secondProject };
}

describe("background work", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("maps every personal source status and only acknowledges terminal results", async () => {
    const fx = await baseFixture("status-matrix");
    const at = new Date(Date.now() - 60_000);
    const expected = new Map<
      string,
      { state: string; sourceStatus: string; terminal: boolean }
    >();
    const importStates = {
      pending: "queued",
      parsing: "running",
      extracting: "running",
      linking: "running",
      ready: "succeeded",
      accepting: "running",
      accepted: "succeeded",
      rejected: "succeeded",
      failed: "failed",
      blocked_configuration: "blocked",
    } as const;
    for (const sourceStatus of Object.keys(importStates) as Array<
      keyof typeof importStates
    >) {
      const row = await createImport({
        owner: fx.owner,
        projectId: fx.project.id,
        name: sourceStatus,
        status: sourceStatus,
        at,
      });
      const state = importStates[sourceStatus];
      expected.set(row.id, {
        state,
        sourceStatus,
        terminal: state !== "queued" && state !== "running",
      });
    }
    const assistantStates = {
      queued: "queued",
      running: "running",
      cancelling: "running",
      completed: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
    } as const;
    for (const sourceStatus of Object.keys(assistantStates) as Array<
      keyof typeof assistantStates
    >) {
      const row = await createAssistantRun({
        owner: fx.owner,
        projectIds: [fx.project.id],
        status: sourceStatus,
        at,
      });
      const state = assistantStates[sourceStatus];
      expected.set(row.id, {
        state,
        sourceStatus,
        terminal: state !== "queued" && state !== "running",
      });
    }
    for (const state of [
      "queued",
      "running",
      "succeeded",
      "failed",
      "skipped",
    ] as const) {
      const row = await createTaskRun({
        owner: fx.owner,
        projectId: fx.project.id,
        name: state,
        status: state,
        at,
      });
      expected.set(row.id, {
        state,
        sourceStatus: state,
        terminal: state !== "queued" && state !== "running",
      });
    }
    const actor = securityContextFor(fx.owner);
    const page = await listBackgroundWork(getPrisma(), actor, { limit: 50 });
    expect(page.items).toHaveLength(expected.size);
    for (const row of page.items) {
      const match = expected.get(row.id)!;
      expect(row).toMatchObject({
        state: match.state,
        sourceStatus: match.sourceStatus,
        unseen: match.terminal,
      });
      expect(row.finishedAt).toBe(match.terminal ? at.toISOString() : null);
      expect(row.acknowledgement !== null).toBe(match.terminal);
    }
    const accepting = page.items.find(
      (row) => row.kind === "import" && row.sourceStatus === "accepting",
    )!;
    await getPrisma().ingestionFile.update({
      where: { id: accepting.id },
      data: { status: "ready" },
    });
    const ready = (
      await listBackgroundWork(getPrisma(), actor, {
        view: "recent",
        limit: 50,
      })
    ).items.find((row) => row.id === accepting.id)!;
    await getPrisma().ingestionFile.update({
      where: { id: accepting.id },
      data: { status: "accepting" },
    });
    expect(
      await markBackgroundWorkSeen(getPrisma(), actor, {
        items: [ready.acknowledgement!],
      }),
    ).toEqual({ acknowledged: 0 });
    await getPrisma().ingestionFile.update({
      where: { id: accepting.id },
      data: { status: "accepted" },
    });
    const accepted = (
      await listBackgroundWork(getPrisma(), actor, {
        view: "recent",
        limit: 50,
      })
    ).items.find((row) => row.id === accepting.id)!;
    expect(accepted.acknowledgement).toEqual(ready.acknowledgement);
  });

  it("normalizes all four sources without leaking private payloads and aggregates active knowledge documents", async () => {
    const fx = await baseFixture("sources");
    const task = await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "Daily digest",
    });
    const imported = await createImport({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "brief.md",
      status: "ready",
    });
    const assistant = await createAssistantRun({
      owner: fx.owner,
      projectIds: [fx.project.id, fx.secondProject.id],
    });
    const knowledge = await createKnowledge({
      projectId: fx.project.id,
      status: "active",
      documentStates: ["ready", "processing", "failed"],
    });
    const failedTask = await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "Daily digest retry",
      status: "failed",
      errorMessage: "TASK_TEXT",
    });
    const failedImport = await createImport({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "broken.md",
      status: "failed",
      failureMessage: "IMPORT_TEXT",
    });
    const failedAssistant = await createAssistantRun({
      owner: fx.owner,
      projectIds: [fx.project.id],
      status: "failed",
      errorMessage: "ASSISTANT_TEXT",
    });
    const failedKnowledge = await createKnowledge({
      projectId: fx.project.id,
      status: "failed",
      failureSummary: "KNOWLEDGE_TEXT",
    });

    const mine = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      { audience: "mine", view: "all", limit: 50 },
    );
    expect(new Set(mine.items.map(({ kind }) => kind))).toEqual(
      new Set(["task", "import", "assistant"]),
    );
    expect(mine.items.map(({ id }) => id)).toEqual(
      expect.arrayContaining([task.id, imported.id, assistant.id]),
    );
    expect(JSON.stringify(mine)).not.toContain("secret prompt");
    expect(JSON.stringify(mine)).not.toContain("Private title");
    expect(mine.items.find(({ id }) => id === assistant.id)).toMatchObject({
      title: "Assistant response",
      projectName: "Multiple projects",
      destination: {
        kind: "assistant",
        conversationId: assistant.conversationId,
      },
    });
    expect(
      mine.items.find(({ id }) => id === failedTask.id)?.errorMessage,
    ).toBe("TASK_TEXT");
    expect(
      mine.items.find(({ id }) => id === failedImport.id)?.errorMessage,
    ).toBe("IMPORT_TEXT");
    expect(
      mine.items.find(({ id }) => id === failedAssistant.id)?.errorMessage,
    ).toBe("ASSISTANT_TEXT");
    expect(
      mine.items.find(({ id }) => id === task.id)?.errorMessage,
    ).toBeNull();
    expect(
      mine.items.find(({ id }) => id === imported.id)?.errorMessage,
    ).toBeNull();
    expect(
      mine.items.find(({ id }) => id === assistant.id)?.errorMessage,
    ).toBeNull();

    const shared = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.maintainer),
      { audience: "projects", view: "all", limit: 50 },
    );
    expect(shared.items.find(({ id }) => id === knowledge.id)).toMatchObject({
      kind: "knowledge",
      state: "running",
      progress: { ready: 1, total: 3, failed: 1 },
      acknowledgement: null,
      unseen: false,
    });
    expect(
      shared.items.find(({ id }) => id === failedKnowledge.id),
    ).toMatchObject({
      kind: "knowledge",
      state: "failed",
      errorMessage: "KNOWLEDGE_TEXT",
    });
    expect(shared.items.some(({ id }) => id === assistant.id)).toBe(false);
    expect(JSON.stringify(shared)).not.toContain("ASSISTANT_TEXT");
    expect(
      shared.items.find(({ id }) => id === failedTask.id)?.errorMessage,
    ).toBeNull();
    expect(JSON.stringify(shared)).not.toContain("TASK_TEXT");
  });

  it("bounds import and notebook rows before materializing authorized work", async () => {
    const fx = await baseFixture("source-window");
    const db = getPrisma();
    const expected: string[] = [];
    for (const [index, status] of [
      "ready",
      "blocked_configuration",
      "pending",
      "ready",
    ].entries()) {
      const at = new Date(Date.now() - (index === 3 ? 1 : 30) * DAY);
      const file = await createImport({
        owner: fx.owner,
        projectId: fx.project.id,
        name: `window-${index}`,
        status: status as "ready" | "blocked_configuration" | "pending",
        at,
      });
      const artifact = await db.artifact.create({
        data: {
          projectId: fx.project.id,
          filename: `window-${index}.onepkg`,
          filenameKey: `window-${index}.onepkg`,
          contentDigest: String(index).repeat(64),
          byteSize: 1,
          contentType: "application/onenote",
          uploadedById: fx.owner.id,
        },
      });
      await db.artifactNotebook.create({
        data: {
          artifactId: artifact.id,
          contentDigest: artifact.contentDigest,
          parserVersion: NOTEBOOK_PARSER_VERSION,
          status: index === 2 ? "queued" : "ready",
          queuedAt: at,
          updatedAt: at,
          finishedAt: index === 2 ? null : at,
          requestedById: fx.owner.id,
        },
      });
      if (index >= 2) expected.push(file.id, artifact.id);
    }
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`${authorizedWorkSql({ actor: securityContextFor(fx.owner), audience: "mine" })} SELECT id FROM authorized_work`,
    );
    expect(rows.map((row) => row.id).sort()).toEqual(expected.sort());
  });

  it("shows notebook preparation to its requester and to project Maintainers", async () => {
    const fx = await baseFixture("notebook");
    const db = getPrisma();
    const artifact = (filename: string, digest: string) =>
      db.artifact.create({
        data: {
          projectId: fx.project.id,
          filename,
          filenameKey: filename.toLowerCase(),
          contentDigest: digest,
          byteSize: 10,
          contentType: "application/onenote",
          uploadedById: fx.owner.id,
        },
      });
    const running = await artifact("Running.onepkg", "a".repeat(64));
    const failed = await artifact("Failed.onepkg", "b".repeat(64));
    const stale = await artifact("Stale.onepkg", "c".repeat(64));
    const finishedAt = new Date(Date.now() - 60_000);
    await db.artifactNotebook.createMany({
      data: [
        {
          artifactId: running.id,
          contentDigest: running.contentDigest,
          parserVersion: NOTEBOOK_PARSER_VERSION,
          status: "running",
          startedAt: new Date(),
          requestedById: fx.owner.id,
        },
        {
          artifactId: failed.id,
          contentDigest: failed.contentDigest,
          parserVersion: NOTEBOOK_PARSER_VERSION,
          status: "failed",
          error: "parse_timeout",
          finishedAt,
          requestedById: fx.owner.id,
        },
        // A superseded digest is not current work.
        {
          artifactId: stale.id,
          contentDigest: "d".repeat(64),
          parserVersion: NOTEBOOK_PARSER_VERSION,
          status: "running",
          requestedById: fx.owner.id,
        },
      ],
    });

    const mine = await listBackgroundWork(db, securityContextFor(fx.owner), {
      audience: "mine",
      kind: "notebook",
      view: "all",
      limit: 50,
    });
    expect(mine.items.map(({ id }) => id).sort()).toEqual(
      [running.id, failed.id].sort(),
    );
    expect(mine.items.find(({ id }) => id === running.id)).toMatchObject({
      title: "OneNote notebook: Running.onepkg",
      state: "running",
      sourceStatus: "running",
      acknowledgement: null,
      destination: {
        kind: "notebook",
        projectId: fx.project.id,
        filename: "Running.onepkg",
      },
    });
    const failure = mine.items.find(({ id }) => id === failed.id)!;
    expect(failure).toMatchObject({
      state: "failed",
      errorCode: "NOTEBOOK_FAILED",
      errorMessage: "Reading the notebook took longer than the time limit.",
      unseen: true,
    });
    await expect(
      markBackgroundWorkSeen(db, securityContextFor(fx.owner), {
        items: [failure.acknowledgement!],
      }),
    ).resolves.toEqual({ acknowledged: 1 });

    const others = await listBackgroundWork(db, securityContextFor(fx.other), {
      audience: "projects",
      kind: "notebook",
      view: "all",
      limit: 50,
    });
    expect(others.items).toEqual([]);
    const shared = await listBackgroundWork(
      db,
      securityContextFor(fx.maintainer),
      { audience: "projects", kind: "notebook", view: "all", limit: 50 },
    );
    expect(shared.items).toHaveLength(2);
    expect(shared.items.every((item) => item.acknowledgement === null)).toBe(
      true,
    );
  });

  it("reports a failing Git sync to Maintainers until it recovers", async () => {
    const fx = await baseFixture("git-sync");
    const db = getPrisma();
    const remote = await db.projectGitRemote.create({
      data: {
        projectId: fx.project.id,
        remoteUrl: "git@example.test:repo.git",
        branch: "main",
        enabled: true,
        keyName: "test key",
        keyFingerprint: "SHA256:test",
        keyUploadedAt: new Date(),
        credentialCiphertext: new Uint8Array([1]),
        credentialNonce: new Uint8Array([1]),
        credentialTag: new Uint8Array([1]),
        credentialKeyVersion: 1,
        nextAttemptAt: new Date(),
        lastErrorCode: "NETWORK_ERROR",
        failureCount: 1,
      },
    });
    const filters = { kind: "git_sync", view: "all", limit: 50 } as const;
    const mine = () =>
      listBackgroundWork(db, securityContextFor(fx.maintainer), {
        audience: "mine",
        ...filters,
      });

    const [failure] = (await mine()).items;
    expect(failure).toMatchObject({
      id: remote.id,
      title: "Git push failed",
      projectId: fx.project.id,
      state: "failed",
      errorCode: "GIT_SYNC_FAILED",
      errorMessage: expect.stringContaining("could not be reached"),
      destination: { kind: "git_sync", projectId: fx.project.id },
      unseen: true,
    });
    expect(
      (await getBackgroundWorkSummary(db, securityContextFor(fx.maintainer)))
        .unseen.value,
    ).toBe(1);
    // Editors cannot act on the remote and do not see its failures.
    for (const audience of ["mine", "projects"] as const)
      expect(
        (
          await listBackgroundWork(db, securityContextFor(fx.owner), {
            audience,
            ...filters,
          })
        ).items,
      ).toEqual([]);

    await markBackgroundWorkSeen(db, securityContextFor(fx.maintainer), {
      items: [failure!.acknowledgement!],
    });
    // A retry of the same incident stays acknowledged.
    await db.projectGitRemote.update({
      where: { id: remote.id },
      data: { failureCount: 2, lastAttemptAt: new Date() },
    });
    expect((await mine()).items[0]).toMatchObject({ unseen: false });

    await db.projectGitRemote.update({
      where: { id: remote.id },
      data: { lastErrorCode: null, failureCount: 0, lastPushedAt: new Date() },
    });
    expect((await mine()).items).toEqual([]);

    // A later incident is new, and a failed pull is reported on its own.
    await db.projectGitRemote.update({
      where: { id: remote.id },
      data: { lastPullErrorCode: "MERGE_FAILED" },
    });
    expect((await mine()).items[0]).toMatchObject({
      title: "Git pull failed",
      errorMessage: expect.stringContaining("Merging the remote branch failed"),
      unseen: true,
    });
  });

  it("shows requested builds only to their Maintainer requester", async () => {
    const fx = await baseFixture("knowledge-personal");
    const outsiderAdmin = await makeUser("Admin", "knowledge-personal-admin");
    const building = await createKnowledge({
      projectId: fx.project.id,
      status: "building",
      buildTrigger: "embedding_change",
      requestedById: fx.maintainer.id,
    });
    const finished = await createKnowledge({
      projectId: fx.project.id,
      status: "active",
      buildTrigger: "manual_rebuild",
      requestedById: fx.maintainer.id,
      documentStates: ["pending"],
    });
    const editorsRequest = await createKnowledge({
      projectId: fx.project.id,
      status: "building",
      buildTrigger: "manual_rebuild",
      requestedById: fx.owner.id,
    });

    const mine = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.maintainer),
      {
        audience: "mine",
        kind: "knowledge",
        view: "all",
        limit: 50,
      },
    );
    expect(mine.items.map(({ id }) => id).sort()).toEqual(
      [building.id, finished.id].sort(),
    );
    expect(mine.items.find(({ id }) => id === building.id)).toMatchObject({
      title: "Knowledge index rebuild: embedding model changed",
      state: "running",
      acknowledgement: null,
    });
    const done = mine.items.find(({ id }) => id === finished.id)!;
    expect(done).toMatchObject({
      title: "Knowledge index rebuild: requested",
      state: "succeeded",
      unseen: true,
    });
    await expect(
      markBackgroundWorkSeen(getPrisma(), securityContextFor(fx.maintainer), {
        items: [done.acknowledgement!],
      }),
    ).resolves.toEqual({ acknowledged: 1 });

    for (const user of [fx.owner, outsiderAdmin]) {
      const rows = await listBackgroundWork(
        getPrisma(),
        securityContextFor(user),
        {
          audience: "mine",
          kind: "knowledge",
          view: "all",
          limit: 50,
        },
      );
      expect(rows.items).toEqual([]);
    }
    expect(editorsRequest.requestedById).toBe(fx.owner.id);

    const shared = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.maintainer),
      {
        audience: "projects",
        kind: "knowledge",
        view: "all",
        limit: 50,
      },
    );
    expect(shared.items.find(({ id }) => id === finished.id)).toMatchObject({
      title: "Knowledge index: updating 1 document",
      state: "queued",
      acknowledgement: null,
    });
  });

  it("titles a build that kept its graph as a re-embedding", async () => {
    const fx = await baseFixture("knowledge-reembed");
    const reembed = await createKnowledge({
      projectId: fx.project.id,
      status: "building",
      buildTrigger: "embedding_change",
      requestedById: fx.maintainer.id,
      graphSourceGenerationId: randomUUID(),
    });

    const mine = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.maintainer),
      { audience: "mine", kind: "knowledge", view: "all", limit: 50 },
    );
    expect(mine.items.find(({ id }) => id === reembed.id)).toMatchObject({
      title: "Knowledge index re-embedding: embedding model changed",
    });
  });

  it("keeps a read requested build read after later document work on its generation", async () => {
    const fx = await baseFixture("knowledge-revision");
    const activatedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const generation = await createKnowledge({
      projectId: fx.project.id,
      status: "active",
      buildTrigger: "manual_rebuild",
      requestedById: fx.maintainer.id,
      documentStates: ["ready"],
      at: activatedAt,
    });
    const requestedBuild = async () =>
      (
        await listBackgroundWork(
          getPrisma(),
          securityContextFor(fx.maintainer),
          { audience: "mine", kind: "knowledge", view: "all", limit: 50 },
        )
      ).items.find(({ id }) => id === generation.id)!;
    const finished = await requestedBuild();
    expect(finished).toMatchObject({ state: "succeeded", unseen: true });
    await expect(
      markBackgroundWorkSeen(getPrisma(), securityContextFor(fx.maintainer), {
        items: [finished.acknowledgement!],
      }),
    ).resolves.toEqual({ acknowledged: 1 });

    await getPrisma().knowledgeGenerationDocument.updateMany({
      where: { generationId: generation.id },
      data: { completedAt: new Date(activatedAt.getTime() + 30 * 60 * 1_000) },
    });

    const later = await requestedBuild();
    expect(later.acknowledgement).toEqual(finished.acknowledgement);
    expect(later).toMatchObject({ state: "succeeded", unseen: false });
  });

  it("bounds terminal knowledge history while retaining recent document work and old active generations", async () => {
    const fx = await baseFixture("knowledge-window");
    const old = new Date(Date.now() - 30 * DAY);
    const recent = new Date(Date.now() - DAY);
    const oldSuperseded = await createKnowledge({
      projectId: fx.project.id,
      status: "superseded",
      documentStates: ["ready"],
      at: old,
    });
    const recentChild = await createKnowledge({
      projectId: fx.project.id,
      status: "failed",
      documentStates: ["missing"],
      at: old,
    });
    await getPrisma().knowledgeGenerationDocument.updateMany({
      where: { generationId: recentChild.id },
      data: { completedAt: recent },
    });
    const oldBuilding = await createKnowledge({
      projectId: fx.project.id,
      status: "building",
      at: old,
    });
    const oldActive = await createKnowledge({
      projectId: fx.project.id,
      status: "active",
      documentStates: ["pending", "processing"],
      at: old,
    });

    const page = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.maintainer),
      { audience: "projects", kind: "knowledge", view: "all", limit: 50 },
    );
    expect(page.items.map(({ id }) => id)).not.toContain(oldSuperseded.id);
    expect(page.items.find(({ id }) => id === recentChild.id)).toMatchObject({
      state: "failed",
      finishedAt: recent.toISOString(),
      progress: { ready: 0, total: 0, failed: 0 },
    });
    expect(page.items.find(({ id }) => id === oldBuilding.id)).toMatchObject({
      state: "running",
      progress: { ready: 0, total: 0, failed: 0 },
    });
    expect(page.items.find(({ id }) => id === oldActive.id)).toMatchObject({
      state: "running",
      progress: { ready: 0, total: 2, failed: 0 },
    });
  });

  it("normalizes knowledge document state precedence and superseded outcomes", async () => {
    const fx = await baseFixture("knowledge-states");
    const cases = [
      { states: ["ready"] as const, expected: "succeeded" },
      { states: ["missing"] as const, expected: "succeeded" },
      { states: ["pending"] as const, expected: "queued" },
      { states: ["processing", "pending"] as const, expected: "running" },
      { states: ["failed", "missing"] as const, expected: "failed" },
      { states: ["blocked_configuration"] as const, expected: "blocked" },
    ];
    const expected = new Map<string, string>();
    for (const [index, item] of cases.entries()) {
      const project = await makeProject(`knowledge state ${index}`);
      await addMembership(project.id, fx.maintainer.id, "Maintainer");
      const generation = await createKnowledge({
        projectId: project.id,
        status: "active",
        documentStates: [...item.states],
      });
      expected.set(generation.id, item.expected);
    }
    const cancelled = await createKnowledge({
      projectId: fx.project.id,
      status: "superseded",
    });
    const activated = await createKnowledge({
      projectId: fx.project.id,
      status: "superseded",
    });
    await getPrisma().knowledgeGeneration.update({
      where: { id: activated.id },
      data: { activatedAt: new Date() },
    });
    expected.set(cancelled.id, "cancelled");
    expected.set(activated.id, "succeeded");

    const page = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.maintainer),
      { audience: "projects", kind: "knowledge", view: "all", limit: 50 },
    );
    for (const [id, state] of expected) {
      expect(page.items.find((item) => item.id === id)?.state).toBe(state);
    }
  });

  it("applies live access before pagination and counts, including malformed and multi-project assistant scopes", async () => {
    const fx = await baseFixture("access");
    const inaccessible = await makeProject("inaccessible newest");
    for (let index = 0; index < 24; index += 1) {
      await createTaskRun({
        owner: fx.other,
        projectId: inaccessible.id,
        name: `hidden-${index}`,
        at: new Date(Date.now() + index * 1_000),
      });
    }
    const visible = await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "visible after prefix",
      at: new Date(Date.now() - DAY),
    });
    const multi = await createAssistantRun({
      owner: fx.owner,
      projectIds: [fx.project.id, fx.secondProject.id],
    });
    const malformed = await createAssistantRun({
      owner: fx.owner,
      projectIds: [],
      scopeSnapshot: { kind: "projects", projectIds: [] },
    });
    const page = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      { audience: "mine", view: "all", limit: 1 },
    );
    expect(page.items[0]?.id).toBe(multi.id);
    expect(page.items.some(({ id }) => id === malformed.id)).toBe(false);
    await removeMembership(fx.secondProject.id, fx.owner.id);
    const afterLoss = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      { audience: "mine", view: "all", limit: 50 },
    );
    expect(afterLoss.items.map(({ id }) => id)).toContain(visible.id);
    expect(afterLoss.items.map(({ id }) => id)).not.toContain(multi.id);
    expect(
      (
        await getBackgroundWorkSummary(
          getPrisma(),
          securityContextFor(fx.owner),
        )
      ).unseen.value,
    ).toBe(1);
  });

  it("does not grant project visibility to global admins and rechecks revocation, deletion, and explicit project filters", async () => {
    const fx = await baseFixture("boundaries");
    const admin = await makeUser("Admin", "background-outsider");
    await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "private task",
    });
    await expect(
      listBackgroundWork(getPrisma(), securityContextFor(admin), {
        audience: "mine",
        projectId: fx.project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listBackgroundWork(getPrisma(), securityContextFor(fx.owner), {
        audience: "projects",
        projectId: fx.project.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await removeMembership(fx.project.id, fx.owner.id);
    await expect(
      listBackgroundWork(getPrisma(), securityContextFor(fx.owner), {
        audience: "mine",
        projectId: fx.project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await getPrisma().project.update({
      where: { id: fx.project.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      listBackgroundWork(getPrisma(), securityContextFor(fx.maintainer), {
        audience: "projects",
        projectId: fx.project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses stable keyset cursors across kinds and rejects cursor replay by another actor or filter", async () => {
    const fx = await baseFixture("paging");
    const sameTime = new Date(Date.now() - 5_000);
    const ids = [
      (
        await createTaskRun({
          owner: fx.owner,
          projectId: fx.project.id,
          name: "t",
          at: sameTime,
        })
      ).id,
      (
        await createImport({
          owner: fx.owner,
          projectId: fx.project.id,
          name: "i",
          at: sameTime,
        })
      ).id,
      (
        await createAssistantRun({
          owner: fx.owner,
          projectIds: [fx.project.id],
          at: sameTime,
        })
      ).id,
    ];
    const first = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      {
        audience: "mine",
        view: "all",
        limit: 2,
      },
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      {
        audience: "mine",
        view: "all",
        limit: 2,
        cursor: first.nextCursor!,
      },
    );
    expect(
      [...first.items, ...second.items].map(({ id }) => id).sort(),
    ).toEqual(ids.sort());
    await expect(
      listBackgroundWork(getPrisma(), securityContextFor(fx.other), {
        audience: "mine",
        view: "all",
        limit: 2,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      listBackgroundWork(getPrisma(), securityContextFor(fx.owner), {
        audience: "mine",
        view: "recent",
        limit: 2,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      listBackgroundWork(getPrisma(), securityContextFor(fx.owner), {
        cursor: "not-a-cursor",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps old active work, excludes old terminal work, and filters state before limiting", async () => {
    const fx = await baseFixture("windows");
    const old = new Date(Date.now() - 9 * DAY);
    const active = await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "old active",
      status: "running",
      at: old,
    });
    const finished = await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "old done",
      status: "succeeded",
      at: old,
    });
    const recent = await createImport({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "recent failure",
      status: "failed",
    });
    const activePage = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      { view: "active", limit: 50 },
    );
    expect(activePage.items.map(({ id }) => id)).toContain(active.id);
    const recentPage = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      { view: "recent", limit: 50 },
    );
    expect(recentPage.items.map(({ id }) => id)).toContain(recent.id);
    expect(recentPage.items.map(({ id }) => id)).not.toContain(finished.id);
    const failures = await listBackgroundWork(
      getPrisma(),
      securityContextFor(fx.owner),
      { view: "all", state: "failed", limit: 1 },
    );
    expect(failures.items).toHaveLength(1);
    expect(failures.items[0]).toMatchObject({ id: recent.id, state: "failed" });
  });

  it("denies API keys and OAuth at both the service and tRPC boundaries", async () => {
    const fx = await baseFixture("credential");
    await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "session only",
    });
    await expect(
      callerFor(fx.owner).backgroundWork.summary(),
    ).resolves.toMatchObject({ unseen: { value: 1, capped: false } });
    const routed = await callerFor(fx.owner).backgroundWork.list({
      audience: "mine",
      view: "recent",
    });
    expect(routed.items).toHaveLength(1);
    expect(
      await callerFor(fx.owner).backgroundWork.markSeen({
        items: [routed.items[0]!.acknowledgement!],
      }),
    ).toEqual({ acknowledged: 1 });
    const actors = [
      createApiKeySecurityContext({
        userId: fx.owner.id,
        globalRole: "User",
        keyId: "background-key",
        permissions: { mcp: ["use"], content: ["read"] },
        projectIds: [fx.project.id],
      }),
      createOAuthSecurityContext({
        userId: fx.owner.id,
        globalRole: "User",
        tokenId: "background-oauth",
        scopes: ["content:read"],
      }),
    ];
    for (const actor of actors) {
      await expect(
        getBackgroundWorkSummary(getPrisma(), actor),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerWithSecurity(fx.owner, actor).backgroundWork.list({}),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("acknowledges exact revisions idempotently across sessions and preserves import pipeline identity", async () => {
    const fx = await baseFixture("receipts");
    const imported = await createImport({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "review.md",
      status: "ready",
    });
    const actor = securityContextFor(fx.owner);
    const ready = (
      await listBackgroundWork(getPrisma(), actor, { view: "recent" })
    ).items.find(({ id }) => id === imported.id)!;
    expect(ready.unseen).toBe(true);
    expect(
      await markBackgroundWorkSeen(getPrisma(), actor, {
        items: [ready.acknowledgement!, ready.acknowledgement!],
      }),
    ).toEqual({ acknowledged: 1 });
    expect(
      await markBackgroundWorkSeen(getPrisma(), actor, {
        items: [ready.acknowledgement!],
      }),
    ).toEqual({ acknowledged: 0 });
    expect(
      (
        await listBackgroundWork(
          getPrisma(),
          { ...actor, credentialId: "second-session" },
          { view: "recent" },
        )
      ).items[0]?.unseen,
    ).toBe(false);

    await getPrisma().ingestionFile.update({
      where: { id: imported.id },
      data: { status: "accepted" },
    });
    const accepted = (
      await listBackgroundWork(getPrisma(), actor, { view: "recent" })
    ).items.find(({ id }) => id === imported.id)!;
    expect(accepted.acknowledgement).toEqual(ready.acknowledgement);
    await getPrisma().ingestionFile.update({
      where: { id: imported.id },
      data: {
        status: "failed",
        attemptCount: 2,
        parseEndedAt: new Date(),
      },
    });
    const retried = (
      await listBackgroundWork(getPrisma(), actor, { view: "recent" })
    ).items.find(({ id }) => id === imported.id)!;
    expect(retried.acknowledgement?.revision).not.toBe(
      ready.acknowledgement?.revision,
    );
    expect(retried.unseen).toBe(true);
    expect(
      await markBackgroundWorkSeen(getPrisma(), actor, {
        items: [ready.acknowledgement!],
      }),
    ).toEqual({ acknowledged: 0 });
  });

  it("keeps a stable review revision for legacy terminal imports without inventing a finish time", async () => {
    const fx = await baseFixture("legacy-import");
    const imported = await createImport({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "legacy.md",
      status: "ready",
    });
    await getPrisma().ingestionFile.update({
      where: { id: imported.id },
      data: { parseStartedAt: null, parseEndedAt: null },
    });
    const actor = securityContextFor(fx.owner);
    const ready = (
      await listBackgroundWork(getPrisma(), actor, { view: "recent" })
    ).items.find(({ id }) => id === imported.id)!;
    expect(ready.finishedAt).toBeNull();
    await getPrisma().ingestionFile.update({
      where: { id: imported.id },
      data: { status: "accepted" },
    });
    const accepted = (
      await listBackgroundWork(getPrisma(), actor, { view: "recent" })
    ).items.find(({ id }) => id === imported.id)!;
    expect(accepted.finishedAt).toBeNull();
    expect(accepted.acknowledgement).toEqual(ready.acknowledgement);
  });

  it("handles concurrent acknowledgement and ignores inaccessible, foreign, and stale references", async () => {
    const fx = await baseFixture("race");
    const own = await createTaskRun({
      owner: fx.owner,
      projectId: fx.project.id,
      name: "own",
    });
    const foreign = await createTaskRun({
      owner: fx.other,
      projectId: fx.project.id,
      name: "foreign",
    });
    const actor = securityContextFor(fx.owner);
    const ownReference = (
      await listBackgroundWork(getPrisma(), actor, { view: "recent" })
    ).items.find(({ id }) => id === own.id)!.acknowledgement!;
    const foreignReference = (
      await listBackgroundWork(getPrisma(), securityContextFor(fx.other), {
        view: "recent",
      })
    ).items.find(({ id }) => id === foreign.id)!.acknowledgement!;
    const [left, right] = await Promise.all([
      markBackgroundWorkSeen(getPrisma(), actor, {
        items: [ownReference, foreignReference],
      }),
      markBackgroundWorkSeen(getPrisma(), actor, { items: [ownReference] }),
    ]);
    expect(left.acknowledged + right.acknowledged).toBe(1);
    await removeMembership(fx.project.id, fx.owner.id);
    expect(
      await markBackgroundWorkSeen(getPrisma(), actor, {
        items: [ownReference],
      }),
    ).toEqual({ acknowledged: 0 });
  });

  it("caps summary counts at 100 and excludes shared knowledge from personal unread", async () => {
    const fx = await baseFixture("summary");
    const task = await getPrisma().scheduledTask.create({
      data: {
        ownerId: fx.owner.id,
        name: "many",
        instruction: "fixture",
        scopeRequest: { kind: "project", projectId: fx.project.id },
        scopeSnapshot: { kind: "project", projectIds: [fx.project.id] },
        outputProjectId: fx.project.id,
        outputFolderPath: [],
        schedule: { kind: "daily", hour: 7, minute: 0 },
        timezone: "UTC",
        cron: "0 7 * * *",
      },
    });
    const now = new Date();
    await getPrisma().scheduledTaskRun.createMany({
      data: Array.from({ length: 101 }, (_, index) => ({
        taskId: task.id,
        trigger: "manual" as const,
        status: "succeeded" as const,
        queuedAt: new Date(now.getTime() - index),
        finishedAt: new Date(now.getTime() - index),
      })),
    });
    await createKnowledge({ projectId: fx.project.id, status: "failed" });
    expect(
      await getBackgroundWorkSummary(getPrisma(), securityContextFor(fx.owner)),
    ).toMatchObject({
      active: { value: 0, capped: false },
      unseen: { value: 100, capped: true },
    });
  });

  it("prunes at most 5,000 expired receipts, preserves the boundary, and cascades user receipts", async () => {
    const fx = await baseFixture("prune");
    const old = new Date(Date.now() - 15 * DAY);
    const boundary = new Date(Date.now() - 14 * DAY + 60_000);
    await getPrisma().backgroundWorkReceipt.createMany({
      data: [
        ...Array.from({ length: 5_001 }, () => ({
          userId: fx.owner.id,
          kind: "task" as const,
          workId: randomUUID(),
          revision: randomUUID().replaceAll("-", ""),
          seenAt: old,
        })),
        {
          userId: fx.owner.id,
          kind: "import" as const,
          workId: randomUUID(),
          revision: randomUUID().replaceAll("-", ""),
          seenAt: boundary,
        },
      ],
    });
    expect(await pruneBackgroundWorkReceipts(getPrisma())).toBe(5_000);
    expect(
      await getPrisma().backgroundWorkReceipt.count({
        where: { userId: fx.owner.id },
      }),
    ).toBe(2);
    expect(await pruneBackgroundWorkReceipts(getPrisma())).toBe(1);
    expect(
      await getPrisma().backgroundWorkReceipt.count({
        where: { userId: fx.owner.id },
      }),
    ).toBe(1);
    await getPrisma().user.delete({ where: { id: fx.owner.id } });
    expect(
      await getPrisma().backgroundWorkReceipt.count({
        where: { userId: fx.owner.id },
      }),
    ).toBe(0);
  });
});

describe("exam work", () => {
  beforeEach(resetDb);
  it("shows only the current trainee's work and hides it when Training is Off", async () => {
    const db = getPrisma();
    const trainee = await makeUser("User", "exam-bell-trainee");
    const project = await makeProject("Exam bell");
    await addMembership(project.id, trainee.id, "Viewer");
    await db.projectTrainingRole.create({
      data: { projectId: project.id, userId: trainee.id, role: "trainee" },
    });
    const exam = await db.exam.create({
      data: { projectId: project.id, title: "Exam bell", timeLimitMinutes: 5 },
    });
    const at = new Date();
    const attempt = await db.examAttempt.create({
      data: {
        examId: exam.id,
        projectId: project.id,
        traineeId: trainee.id,
        attemptNumber: 1,
        examRevision: 1,
        definitionSnapshot: {},
        status: "submitted",
        startedAt: at,
        deadlineAt: at,
        submittedAt: at,
        maxScore: 10,
      },
    });
    const actor = securityContextFor(trainee);
    expect(
      (await listBackgroundWork(db, actor, { audience: "mine" })).items.find(
        (row) => row.id === attempt.id,
      )?.state,
    ).toBe("running");
    await db.examAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "released",
        releasedAt: at,
        totalScore: 8,
        percent: 80,
        passed: true,
      },
    });
    expect(
      (await listBackgroundWork(db, actor, { audience: "mine" })).items.find(
        (row) => row.id === attempt.id,
      )?.unseen,
    ).toBe(true);
    await db.projectTrainingRole.deleteMany({
      where: { projectId: project.id, userId: trainee.id },
    });
    expect(
      (await listBackgroundWork(db, actor, { audience: "mine" })).items.some(
        (row) => row.id === attempt.id,
      ),
    ).toBe(false);
  });
});

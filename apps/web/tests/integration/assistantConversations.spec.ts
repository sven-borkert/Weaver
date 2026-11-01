import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  pinConversation,
  renameConversation,
} from "@weaver/core/services/assistantConversations";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import { assertInScope, effectiveScope } from "@weaver/core/assistant/scope";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import { CoreError } from "@weaver/core/errors";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

describe("assistant schema", () => {
  it("pages long transcripts newest-first without skipping earlier messages", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "conversation-pages");
    const actor = securityContextFor(user);
    const conversation = await createConversation(db, actor, {});
    await db.assistantMessage.createMany({
      data: Array.from({ length: 205 }, (_, position) => ({
        conversationId: conversation.id,
        position,
        role: "user" as const,
        status: "complete" as const,
        content: { text: String(position) },
      })),
    });
    const latest = await getConversation(db, actor, conversation.id);
    expect(latest.messages).toHaveLength(200);
    expect(latest.messages[0]?.position).toBe(5);
    expect(latest.hasEarlierMessages).toBe(true);
    const earlier = await getConversation(db, actor, conversation.id, 5);
    expect(earlier.messages.map((message) => message.position)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(earlier.hasEarlierMessages).toBe(false);
  });
  beforeEach(resetDb);

  it("stores a conversation, message, run, attempt, and event with unique sequences", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "schema");
    const conversation = await db.assistantConversation.create({
      data: { ownerId: user.id, title: "Untitled" },
    });
    const message = await db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: 0,
        role: "user",
        status: "complete",
        content: { text: "hello" },
        scopeSnapshot: {
          kind: "all",
          projectIds: [],
          documentId: null,
          tableId: null,
          resolvedAt: new Date().toISOString(),
        },
      },
    });
    const run = await db.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        status: "queued",
        scopeSnapshot: message.scopeSnapshot!,
        actorSnapshot: {},
      },
    });
    const attempt = await db.assistantRunAttempt.create({
      data: {
        runId: run.id,
        number: 1,
        workerId: "w",
        status: "running",
        leaseExpiresAt: new Date(),
      },
    });
    await db.assistantRunEvent.create({
      data: {
        runId: run.id,
        attemptId: attempt.id,
        sequence: 0,
        type: "run.started",
        payload: {},
      },
    });
    await expect(
      db.assistantRunEvent.create({
        data: {
          runId: run.id,
          attemptId: attempt.id,
          sequence: 0,
          type: "text.delta",
          payload: {},
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await expect(
      db.assistantRun.create({
        data: {
          conversationId: conversation.id,
          userMessageId: message.id,
          status: "queued",
          scopeSnapshot: {},
          actorSnapshot: {},
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });
});

// (Task 1 "assistant schema" describe block stays above this line.)

describe("assistant conversations", () => {
  const queue = new FakeJobQueue();
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
    queue.jobs.length = 0;
    setJobQueueForTests(queue);
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it("creates, lists, renames, pins, and deletes the owner's conversations only", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "owner");
    const other = await makeUser("User", "other");
    const project = await makeProject("Pinned");
    await addMembership(project.id, owner.id, "Viewer");
    const actor = securityContextFor(owner);

    const created = await createConversation(db, actor, {});
    expect(created.title).toBe("New conversation");
    await renameConversation(db, actor, {
      conversationId: created.id,
      title: "Roadmap questions",
    });
    await pinConversation(db, actor, {
      conversationId: created.id,
      projectId: project.id,
    });
    const listed = await listConversations(db, actor, {});
    expect(listed.items.map((c) => [c.title, c.pinnedProjectId])).toEqual([
      ["Roadmap questions", project.id],
    ]);

    const otherActor = securityContextFor(other);
    await expect(
      getConversation(db, otherActor, created.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      pinConversation(db, actor, {
        conversationId: created.id,
        projectId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await deleteConversation(db, actor, created.id);
    expect((await listConversations(db, actor, {})).items).toEqual([]);
  });

  it("submits a user message, resolves the scope snapshot, queues one run, and publishes the job", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "submit");
    const project = await makeProject("Scoped");
    await addMembership(project.id, owner.id, "Editor");
    const actor = securityContextFor(owner);
    const conversation = await createConversation(db, actor, {});

    const result = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "What is in this project?",
      scope: { kind: "project", projectId: project.id },
    });
    expect(result.userMessage.scopeSnapshot).toMatchObject({
      kind: "project",
      projectIds: [project.id],
    });
    expect(result.run.status).toBe("queued");
    expect(queue.jobs).toEqual([
      { name: "assistant.run", data: { runId: result.run.id } },
    ]);
    const events = await db.assistantRunEvent.findMany({
      where: { runId: result.run.id },
    });
    expect(events.map((e) => [e.sequence, e.type])).toEqual([
      [0, "run.queued"],
    ]);
    expect(
      (
        await db.assistantRun.findUniqueOrThrow({
          where: { id: result.run.id },
        })
      ).jobId,
    ).toBe("fake-job-1");

    await expect(
      submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "again",
        scope: { kind: "all" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects out-of-scope resources, oversized text, and non-session credentials", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "reject");
    const project = await makeProject("Hidden");
    const actor = securityContextFor(owner);
    const conversation = await createConversation(db, actor, {});
    await expect(
      submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "x",
        scope: { kind: "project", projectId: project.id },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "x".repeat(32_001),
        scope: { kind: "all" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const keyActor = createApiKeySecurityContext({
      userId: owner.id,
      globalRole: "User",
      keyId: "k",
      permissions: null,
      projectIds: [],
    });
    await expect(createConversation(db, keyActor, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("drops a revoked project from effectiveScope and rejects it in assertInScope (spec §12)", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "revoke");
    const keep = await makeProject("Keep");
    const revoke = await makeProject("Revoke");
    await addMembership(keep.id, user.id, "Viewer");
    await addMembership(revoke.id, user.id, "Viewer");
    const actor = securityContextFor(user);
    const conversation = await createConversation(db, actor, {});

    const submitted = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "What is in these projects?",
      scope: { kind: "projects", projectIds: [keep.id, revoke.id] },
    });
    const snapshot = submitted.userMessage.scopeSnapshot!;
    expect(snapshot.projectIds.sort()).toEqual([keep.id, revoke.id].sort());

    const revokeProject = await db.project.findUniqueOrThrow({
      where: { id: revoke.id },
      select: { organizationId: true },
    });
    await db.member.delete({
      where: {
        organizationId_userId: {
          organizationId: revokeProject.organizationId,
          userId: user.id,
        },
      },
    });

    const scoped = await effectiveScope(db, actor, snapshot);
    expect(scoped.projectIds).toEqual([keep.id]);

    let thrown: unknown;
    try {
      assertInScope(scoped, revoke.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreError);
    expect((thrown as CoreError).code).toBe("FORBIDDEN");
    expect((thrown as CoreError).details?.reason).toBe("SCOPE_VIOLATION");
  });

  it("allows only one active run per conversation under concurrent submits", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "race");
    const conversation = await createConversation(
      db,
      securityContextFor(owner),
      {},
    );
    const actor = securityContextFor(owner);

    const [first, second] = await Promise.allSettled([
      submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "first",
        scope: { kind: "all" },
      }),
      submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "second",
        scope: { kind: "all" },
      }),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0]!;
    expect(rejection.reason).toBeInstanceOf(CoreError);
    expect((rejection.reason as CoreError).code).toBe("CONFLICT");

    const runs = await db.assistantRun.findMany({
      where: { conversationId: conversation.id },
    });
    expect(runs).toHaveLength(1);
    const messages = await db.assistantMessage.findMany({
      where: { conversationId: conversation.id, role: "user" },
    });
    expect(messages).toHaveLength(1);
  });

  it("returns the stored failure on settled reads and marks the conversation's last run", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "fail-detail");
    const caller = callerFor(user);
    const conversation = await caller.assistant.createConversation({
      title: "Failing",
    });
    const message = await db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: 0,
        role: "user",
        status: "failed",
        content: { text: "do the thing" },
      },
    });
    await db.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        status: "failed",
        scopeSnapshot: {
          kind: "all",
          projectIds: [],
          documentId: null,
          tableId: null,
          resolvedAt: new Date().toISOString(),
        },
        actorSnapshot: {},
        queuedAt: new Date(),
        finishedAt: new Date(),
        errorCode: "PROVIDER_UNAVAILABLE",
        errorMessage: "The model did not respond (ref 0123abcd)",
        attemptCount: 3,
        maxAttempts: 3,
      },
    });
    const detail = await caller.assistant.getConversation({
      conversationId: conversation.id,
    });
    expect(detail.messages[0]).toMatchObject({
      status: "failed",
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "The model did not respond (ref 0123abcd)",
      },
    });
    const list = await caller.assistant.listConversations({});
    expect(list.items.find((c) => c.id === conversation.id)).toMatchObject({
      lastRunStatus: "failed",
      activeRun: null,
    });
    // Another user never sees it.
    const other = await makeUser("User", "fail-other");
    await expect(
      callerFor(other).assistant.getConversation({
        conversationId: conversation.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

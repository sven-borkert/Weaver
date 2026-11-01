import { createProposal } from "@weaver/core/services/assistantProposals";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SCOPE_PROJECTS,
  resolveScopeSnapshot,
  scopeSnapshotSchema,
} from "@weaver/core/assistant/scope";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { toOrganizationRole } from "@weaver/core/roles";
import {
  createConversation,
  getConversation,
} from "@weaver/core/services/assistantConversations";
import {
  appendRunEvent,
  cancelRunFromWorker,
  completeRun,
  failRunAttempt,
  heartbeatAttempt,
  leaseRunAttempt,
  listRunEvents,
  reconcileAssistantRuns,
  requestRunCancel,
  setRunRouteSnapshot,
  submitUserMessage,
} from "@weaver/core/services/assistantRuns";
import type { AssistantRouteSnapshot } from "@weaver/core/assistant/route";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

async function queuedRun(suffix: string) {
  const db = getPrisma();
  const user = await makeUser("User", suffix);
  const project = await makeProject(`P ${suffix}`);
  await addMembership(project.id, user.id, "Editor");
  const actor = securityContextFor(user);
  const conversation = await createConversation(db, actor, {});
  const { run, userMessage } = await submitUserMessage(db, actor, {
    conversationId: conversation.id,
    text: "hello",
    scope: { kind: "project", projectId: project.id },
  });
  return {
    db,
    user,
    actor,
    project,
    conversation,
    run,
    userMessageId: userMessage.id,
  };
}

/** Bulk-creates projects the user belongs to, newest `updatedAt` last. Returns ids newest-first. */
async function makeManyProjects(
  userId: string,
  count: number,
): Promise<string[]> {
  const db = getPrisma();
  const base = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: count }, (_unused, index) => ({
    projectId: randomUUID(),
    organizationId: randomUUID(),
    index,
  }));
  await db.organization.createMany({
    data: rows.map((row) => ({
      id: row.organizationId,
      name: `Bulk ${row.index}`,
      slug: `project-${row.projectId}`,
    })),
  });
  await db.project.createMany({
    data: rows.map((row) => ({
      id: row.projectId,
      name: `Bulk ${row.index}`,
      organizationId: row.organizationId,
      updatedAt: new Date(base + row.index * 60_000),
    })),
  });
  await db.member.createMany({
    data: rows.map((row) => ({
      organizationId: row.organizationId,
      userId,
      role: toOrganizationRole("Editor"),
    })),
  });
  return rows.map((row) => row.projectId).reverse();
}

const ROUTE_SNAPSHOT: AssistantRouteSnapshot = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  providerType: "openai_compatible",
  endpoint: "https://ai.test/v1",
  modelId: "22222222-2222-4222-8222-222222222222",
  providerModelId: "test-assistant",
  contextWindow: 128_000,
  promptVersion: "assistant-v1",
  configFingerprint: "fingerprint-live",
};

describe("assistant run lifecycle", () => {
  it.each(["reset", "session", "expired", "ban"])(
    "refuses queued work after %s invalidates the actor",
    async (kind) => {
      const { db, user, actor, run } = await queuedRun(`revoked-${kind}`);
      if (kind === "session")
        await db.session.delete({ where: { id: actor.credentialId } });
      else if (kind === "expired")
        await db.session.update({
          where: { id: actor.credentialId },
          data: { expiresAt: new Date(0) },
        });
      else
        await db.user.update({
          where: { id: user.id },
          data:
            kind === "ban" ? { banned: true } : { mustChangePassword: true },
        });
      expect(
        await leaseRunAttempt(db, { runId: run.id, workerId: "w" }),
      ).toBeNull();
      expect(
        await db.assistantRun.findUnique({ where: { id: run.id } }),
      ).toMatchObject({ status: "failed", errorCode: "FORBIDDEN" });
    },
  );
  it("stops a leased run after its session is revoked", async () => {
    const { db, actor, run } = await queuedRun("heartbeat-revoked");
    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w" });
    await db.session.delete({ where: { id: actor.credentialId } });
    await expect(
      heartbeatAttempt(db, { attemptId: leased!.attempt.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("does not replay source events after project membership is revoked", async () => {
    const { db, actor, run, user } = await queuedRun("replay-revoked");
    await db.member.deleteMany({ where: { userId: user.id } });
    await expect(
      listRunEvents(db, actor, { runId: run.id, after: -1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects pending proposals from failed attempts before retrying", async () => {
    const { db, actor, run, project, conversation } =
      await queuedRun("orphan-retry");
    const leased = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "test",
      leaseMs: 10000,
    });
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Create",
      operation: {
        kind: "document.create",
        projectId: project.id,
        title: "Proposal",
        markdown: "content",
        folderPath: [],
      },
    });
    await failRunAttempt(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      code: "PROVIDER_UNAVAILABLE",
      message: "unavailable",
      retryable: true,
    });
    expect(
      (
        await db.assistantProposal.findUniqueOrThrow({
          where: { id: proposal.id },
        })
      ).status,
    ).toBe("rejected");
  });
  const queue = new FakeJobQueue();
  it("completion honors a committed cancellation without inserting an answer", async () => {
    const { db, actor, run, conversation } = await queuedRun(
      "cancel-complete-race",
    );
    const leased = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "worker",
    });
    await requestRunCancel(db, actor, run.id);
    const result = await completeRun(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      text: "late answer",
      citations: [],
      proposalIds: [],
    });
    expect(result).toMatchObject({ status: "cancelled", messageId: null });
    expect(
      await db.assistantMessage.count({
        where: { conversationId: conversation.id, role: "assistant" },
      }),
    ).toBe(0);
    expect(
      (await listRunEvents(db, actor, { runId: run.id, after: 0 })).events.at(
        -1,
      )?.type,
    ).toBe("run.cancelled");
  });

  it("does not abandon a lease renewed after reconciliation discovery", async () => {
    const { db, run } = await queuedRun("renew-after-scan");
    const leased = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "worker",
      leaseMs: -1000,
    });
    const discovered = await db.assistantRunAttempt.findMany({
      where: { id: leased!.attempt.id },
    });
    await heartbeatAttempt(db, { attemptId: leased!.attempt.id });
    const spy = vi
      .spyOn(db.assistantRunAttempt, "findMany")
      .mockResolvedValueOnce(discovered);
    try {
      expect((await reconcileAssistantRuns(db)).abandoned).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await db.assistantRunAttempt.findUniqueOrThrow({
          where: { id: leased!.attempt.id },
        })
      ).status,
    ).toBe("running");
  });

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

  it("clamps an `all` scope past the cap so the run still leases and stays visible", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "allscope");
    const actor = securityContextFor(user);
    const newestFirst = await makeManyProjects(user.id, MAX_SCOPE_PROJECTS + 5);

    const snapshot = await resolveScopeSnapshot(db, actor, { kind: "all" });
    expect(snapshot.projectIds).toHaveLength(MAX_SCOPE_PROJECTS);
    expect(snapshot.truncated).toBe(true);
    // The invariant the lease transaction depends on.
    expect(scopeSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.projectIds).toEqual(
      newestFirst.slice(0, MAX_SCOPE_PROJECTS),
    );

    const conversation = await createConversation(db, actor, {});
    const { run } = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "hello",
      scope: { kind: "all" },
    });
    // Before the clamp this threw inside leaseRunAttempt's transaction, rolling
    // the lease back and leaving the conversation permanently blocked.
    const leased = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "w-all",
    });
    expect(leased?.run.scopeSnapshot.projectIds).toHaveLength(
      MAX_SCOPE_PROJECTS,
    );
    expect(leased?.run.scopeSnapshot.truncated).toBe(true);
    const row = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect([row.status, row.attemptCount]).toEqual(["running", 1]);

    // ...and the message view reports the scope instead of a silent null.
    const detail = await getConversation(db, actor, conversation.id);
    expect(detail.messages[0]?.scopeSnapshot).toMatchObject({
      kind: "all",
      truncated: true,
    });
  });

  it("leases a queued run once, streams events with monotonic sequences, and completes with an assistant message", async () => {
    const { db, actor, run, userMessageId } = await queuedRun("lease");
    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    expect(leased?.attempt.number).toBe(1);
    expect(leased?.actor.userId).toBe(actor.userId);
    expect(leased?.run.scopeSnapshot.kind).toBe("project");
    expect(leased?.history.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
    ]);
    expect(
      await leaseRunAttempt(db, { runId: run.id, workerId: "w2" }),
    ).toBeNull();

    await appendRunEvent(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      event: { type: "text.delta", text: "Hi " },
    });
    await appendRunEvent(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      event: { type: "text.delta", text: "there" },
    });
    const { messageId } = await completeRun(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      text: "Hi there",
      citations: [],
      proposalIds: [],
    });

    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.events.map((e) => [e.sequence, e.type])).toEqual([
      [0, "run.queued"],
      [1, "run.started"],
      [2, "text.delta"],
      [3, "text.delta"],
      [4, "run.completed"],
    ]);
    expect(page.status).toBe("completed");
    expect(page.nextAfter).toBe(4);
    const message = await db.assistantMessage.findUniqueOrThrow({
      where: { id: messageId! },
    });
    expect(message.role).toBe("assistant");
    expect(message.content).toEqual({
      text: "Hi there",
      contextProjectIds: null,
      hasExternalContext: false,
      externalSources: [],
      citationIds: [],
      proposalIds: [],
    });
    const userMessage = await db.assistantMessage.findUniqueOrThrow({
      where: { id: userMessageId },
    });
    expect(userMessage.status).toBe("complete");
    const afterCursor = await listRunEvents(db, actor, {
      runId: run.id,
      after: 3,
    });
    expect(afterCursor.events.map((e) => e.sequence)).toEqual([4]);
  });

  it("keeps event sequences gap-free and unique under concurrent appends", async () => {
    const { db, actor, run } = await queuedRun("concurrent");
    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendRunEvent(db, {
          runId: run.id,
          attemptId: leased!.attempt.id,
          event: { type: "text.delta", text: `d${index}` },
        }),
      ),
    );
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.events.map((e) => e.sequence)).toEqual(
      Array.from({ length: 14 }, (_, index) => index),
    );
  });

  it("bounds oversized event payloads instead of persisting them whole", async () => {
    const { db, actor, run } = await queuedRun("bounded");
    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    await appendRunEvent(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      event: {
        type: "tool.call",
        toolCallId: "c1",
        toolName: "search",
        input: { query: "x".repeat(20_000) },
      },
    });
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    const toolCall = page.events.find((e) => e.type === "tool.call");
    expect(JSON.stringify(toolCall?.payload).length).toBeLessThanOrEqual(8_000);
  });

  it("preserves historical runs without external records: retries up to maxAttempts and republishes", async () => {
    const { db, run, userMessageId } = await queuedRun("retry");
    expect(
      await db.externalMcpCall.count({ where: { assistantRunId: run.id } }),
    ).toBe(0);
    const first = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    queue.jobs.length = 0;
    const outcome = await failRunAttempt(db, {
      runId: run.id,
      attemptId: first!.attempt.id,
      code: "PROVIDER_UNAVAILABLE",
      message: "503",
      retryable: true,
    });
    expect(outcome.retrying).toBe(true);
    expect(queue.jobs).toEqual([
      { name: "assistant.run", data: { runId: run.id } },
    ]);
    const second = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    expect(second?.attempt.number).toBe(2);
    const third = await failRunAttempt(db, {
      runId: run.id,
      attemptId: second!.attempt.id,
      code: "PROVIDER_UNAVAILABLE",
      message: "503",
      retryable: true,
    });
    expect(third.retrying).toBe(true);
    const leased3 = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "w1",
    });
    expect(leased3?.attempt.number).toBe(3);
    const final = await failRunAttempt(db, {
      runId: run.id,
      attemptId: leased3!.attempt.id,
      code: "PROVIDER_UNAVAILABLE",
      message: "503",
      retryable: true,
    });
    expect(final.retrying).toBe(false);
    expect(
      await leaseRunAttempt(db, { runId: run.id, workerId: "w1" }),
    ).toBeNull();
    const row = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect([row.status, row.errorCode]).toEqual([
      "failed",
      "PROVIDER_UNAVAILABLE",
    ]);
    expect(
      (
        await db.assistantMessage.findUniqueOrThrow({
          where: { id: userMessageId },
        })
      ).status,
    ).toBe("failed");
  });

  it("does not retry non-retryable failures", async () => {
    const { db, run } = await queuedRun("noretry");
    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    queue.jobs.length = 0;
    const outcome = await failRunAttempt(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      code: "FORBIDDEN",
      message: "nope",
      retryable: false,
    });
    expect(outcome.retrying).toBe(false);
    expect(queue.jobs).toEqual([]);
    expect(
      (await db.assistantRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("failed");
  });

  it("cancels a queued run immediately and a running run through the heartbeat", async () => {
    const queued = await queuedRun("cancel-queued");
    const cancelled = await requestRunCancel(
      queued.db,
      queued.actor,
      queued.run.id,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(
      await leaseRunAttempt(queued.db, { runId: queued.run.id, workerId: "w" }),
    ).toBeNull();
    expect(
      (
        await queued.db.assistantMessage.findUniqueOrThrow({
          where: { id: queued.userMessageId },
        })
      ).status,
    ).toBe("cancelled");

    const running = await queuedRun("cancel-running");
    const leased = await leaseRunAttempt(running.db, {
      runId: running.run.id,
      workerId: "w",
    });
    expect(
      await heartbeatAttempt(running.db, { attemptId: leased!.attempt.id }),
    ).toBe("running");
    expect(
      (await requestRunCancel(running.db, running.actor, running.run.id))
        .status,
    ).toBe("cancelling");
    expect(
      await heartbeatAttempt(running.db, { attemptId: leased!.attempt.id }),
    ).toBe("cancelling");
    expect(
      await cancelRunFromWorker(running.db, {
        runId: running.run.id,
        attemptId: leased!.attempt.id,
      }),
    ).toEqual({ transitioned: true });
    const events = await listRunEvents(running.db, running.actor, {
      runId: running.run.id,
      after: -1,
    });
    expect(events.status).toBe("cancelled");
    expect(events.events.at(-1)?.type).toBe("run.cancelled");
    expect(
      await heartbeatAttempt(running.db, { attemptId: leased!.attempt.id }),
    ).toBeNull();
    expect(
      await cancelRunFromWorker(running.db, {
        runId: running.run.id,
        attemptId: leased!.attempt.id,
      }),
    ).toEqual({ transitioned: false });

    // Cancelling a terminal run is a no-op, not a second cancellation event.
    expect(
      (await requestRunCancel(running.db, running.actor, running.run.id))
        .status,
    ).toBe("cancelled");
    expect(
      (
        await listRunEvents(running.db, running.actor, {
          runId: running.run.id,
          after: -1,
        })
      ).events.filter((e) => e.type === "run.cancelled"),
    ).toHaveLength(1);
  });

  it("reconciles expired leases and republishes stale queued runs", async () => {
    const { db, run } = await queuedRun("reconcile");
    await db.assistantRun.update({
      where: { id: run.id },
      data: { queuedAt: new Date(Date.now() - 60_000), jobId: null },
    });
    queue.jobs.length = 0;
    let summary = await reconcileAssistantRuns(db);
    expect(summary.republished).toBe(1);
    expect(summary.expiredProposals).toBe(0);
    expect(queue.jobs).toEqual([
      { name: "assistant.run", data: { runId: run.id } },
    ]);

    const leased = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "dead",
    });
    await db.assistantRunAttempt.update({
      where: { id: leased!.attempt.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    queue.jobs.length = 0;
    summary = await reconcileAssistantRuns(db);
    expect(summary.abandoned).toBe(1);
    expect(
      (
        await db.assistantRunAttempt.findUniqueOrThrow({
          where: { id: leased!.attempt.id },
        })
      ).status,
    ).toBe("abandoned");
    expect(
      (await db.assistantRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("queued");
    expect(queue.jobs.map((j) => j.name)).toEqual(["assistant.run"]);
  });

  it("fails a run whose last attempt is abandoned past maxAttempts", async () => {
    const { db, run, userMessageId } = await queuedRun("abandon-final");
    await db.assistantRun.update({
      where: { id: run.id },
      data: { maxAttempts: 1 },
    });
    const leased = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "dead",
    });
    await db.assistantRunAttempt.update({
      where: { id: leased!.attempt.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const summary = await reconcileAssistantRuns(db);
    expect(summary.abandoned).toBe(1);
    const row = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect([row.status, row.errorCode]).toEqual(["failed", "WORKER_LOST"]);
    expect(
      (
        await db.assistantMessage.findUniqueOrThrow({
          where: { id: userMessageId },
        })
      ).status,
    ).toBe("failed");
  });

  it("ignores writes from a worker whose attempt was already abandoned", async () => {
    const { db, actor, run } = await queuedRun("zombie");
    const zombie = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "dead",
    });
    await db.assistantRunAttempt.update({
      where: { id: zombie!.attempt.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await reconcileAssistantRuns(db);
    const live = await leaseRunAttempt(db, { runId: run.id, workerId: "live" });
    expect(live?.attempt.number).toBe(2);

    await expect(
      completeRun(db, {
        runId: run.id,
        attemptId: zombie!.attempt.id,
        text: "stale",
        citations: [],
        proposalIds: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const { messageId } = await completeRun(db, {
      runId: run.id,
      attemptId: live!.attempt.id,
      text: "fresh",
      citations: [],
      proposalIds: [],
    });
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("completed");
    expect(
      await db.assistantMessage.count({
        where: { conversationId: run.conversationId, role: "assistant" },
      }),
    ).toBe(1);
    expect(
      (await db.assistantRun.findUniqueOrThrow({ where: { id: run.id } }))
        .assistantMessageId,
    ).toBe(messageId);
  });

  it("still appends on a queued, a running, and a cancelling run", async () => {
    const { db, actor, run } = await queuedRun("live-append");
    // submitUserMessage's own run.queued append goes straight through
    // appendRunEventTx, without the guarded public entry point.
    const queued = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(queued.events.map((e) => [e.sequence, e.type])).toEqual([
      [0, "run.queued"],
    ]);
    // A queued run is still active, so an unattributed append lands.
    expect(
      await appendRunEvent(db, {
        runId: run.id,
        attemptId: null,
        event: { type: "usage", inputTokens: null, outputTokens: null },
      }),
    ).toMatchObject({ sequence: 1, runStatus: "queued" });

    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    const first = await appendRunEvent(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      event: { type: "text.delta", text: "a" },
    });
    const second = await appendRunEvent(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      event: { type: "text.delta", text: "b" },
    });
    expect([first, second]).toEqual([
      { sequence: 3, runStatus: "running" },
      { sequence: 4, runStatus: "running" },
    ]);

    // A cancelling run is still active: the worker may flush its last deltas
    // before it calls cancelRunFromWorker.
    await requestRunCancel(db, actor, run.id);
    expect(
      await appendRunEvent(db, {
        runId: run.id,
        attemptId: leased!.attempt.id,
        event: { type: "text.delta", text: "c" },
      }),
    ).toMatchObject({ sequence: 5, runStatus: "cancelling" });
  });

  it("drops appends from an attempt that lost its lease", async () => {
    const { db, actor, run } = await queuedRun("stale-append");
    const zombie = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "dead",
    });
    await db.assistantRunAttempt.update({
      where: { id: zombie!.attempt.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await reconcileAssistantRuns(db);
    const live = await leaseRunAttempt(db, { runId: run.id, workerId: "live" });

    expect(
      await appendRunEvent(db, {
        runId: run.id,
        attemptId: zombie!.attempt.id,
        event: { type: "text.delta", text: "zombie" },
      }),
    ).toBeNull();
    const appended = await appendRunEvent(db, {
      runId: run.id,
      attemptId: live!.attempt.id,
      event: { type: "text.delta", text: "live" },
    });

    expect(
      await db.assistantRunEvent.count({
        where: {
          runId: run.id,
          attemptId: zombie!.attempt.id,
          type: "text.delta",
        },
      }),
    ).toBe(0);
    // The dropped append consumed no sequence, so attempt 2 keeps numbering
    // gap-free: run.queued, run.started, run.failed, run.started, text.delta.
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(page.events.at(-1)).toMatchObject({
      sequence: appended!.sequence,
      type: "text.delta",
    });
  });

  it("drops appends once the run reached its terminal event", async () => {
    const { db, actor, run } = await queuedRun("post-terminal");
    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    await completeRun(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      text: "done",
      citations: [],
      proposalIds: [],
    });

    expect(
      await appendRunEvent(db, {
        runId: run.id,
        attemptId: leased!.attempt.id,
        event: { type: "text.delta", text: "late" },
      }),
    ).toBeNull();
    expect(
      await appendRunEvent(db, {
        runId: run.id,
        attemptId: null,
        event: { type: "text.delta", text: "late and unattributed" },
      }),
    ).toBeNull();

    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.events.map((e) => e.type)).toEqual([
      "run.queued",
      "run.started",
      "run.completed",
    ]);
  });

  it("does not overwrite the route snapshot of a finished run", async () => {
    const { db, run } = await queuedRun("route-snapshot");
    const leased = await leaseRunAttempt(db, { runId: run.id, workerId: "w1" });
    await setRunRouteSnapshot(db, run.id, ROUTE_SNAPSHOT);
    await completeRun(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      text: "done",
      citations: [],
      proposalIds: [],
    });

    await setRunRouteSnapshot(db, run.id, {
      ...ROUTE_SNAPSHOT,
      providerModelId: "stale-assistant",
      configFingerprint: "fingerprint-stale",
    });
    expect(
      (await db.assistantRun.findUniqueOrThrow({ where: { id: run.id } }))
        .routeSnapshot,
    ).toMatchObject({
      providerModelId: "test-assistant",
      configFingerprint: "fingerprint-live",
    });
  });

  it("hides other users' runs", async () => {
    const { db, run } = await queuedRun("privacy");
    const stranger = securityContextFor(await makeUser("User", "stranger"));
    await expect(
      listRunEvents(db, stranger, { runId: run.id, after: -1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestRunCancel(db, stranger, run.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "./_harness";
import {
  makeEnabledExternalFixture,
  makeAssistantInvocation,
  makeTaskInvocation,
} from "./_externalMcpFixtures";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  listRunExternalCalls,
  prepareExternalCall,
  executeExternalCall,
  decideExternalApproval,
} from "@weaver/core/services/externalMcp";
import { reconcileExternalMcpState } from "@weaver/core/services/externalMcp/retention";
import {
  persistRunAttemptFailure,
  reconcileAssistantRuns,
  requestRunCancel,
} from "@weaver/core/services/assistantRuns";

beforeEach(async () => {
  await resetDb();
  setJobQueueForTests(new FakeJobQueue());
});
afterEach(() => setJobQueueForTests(null));
async function ready() {
  const f = await makeEnabledExternalFixture("read", undefined, "write");
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.readId);
  if (invocation.owner.kind !== "assistant")
    throw new Error("Expected assistant");
  const prepared = await prepareExternalCall(f.deps, f.owner, invocation);
  return { ...f, invocation, ownerIds: invocation.owner, ...prepared };
}
async function approve(f: Awaited<ReturnType<typeof ready>>) {
  await decideExternalApproval(f.deps, f.owner, {
    id: f.approvalId!,
    decision: "approve",
  });
}
async function execute(f: Awaited<ReturnType<typeof ready>>) {
  return executeExternalCall(f.deps, f.owner, {
    callId: f.callId,
    invocation: f.invocation,
    signal: AbortSignal.timeout(10000),
  });
}
async function approval(f: Awaited<ReturnType<typeof ready>>) {
  return f.db.externalMcpToolApproval.findUniqueOrThrow({
    where: { id: f.approvalId! },
  });
}
const cleared = {
  pendingArgumentsCiphertext: null,
  pendingArgumentsIv: null,
  pendingArgumentsTag: null,
  pendingArgumentsKeyVersion: null,
};
it.each([false, true])(
  "provider retry is gated by durable dispatch (dispatched=%s)",
  async (dispatched) => {
    const f = await ready();
    if (dispatched) {
      await approve(f);
      expect((await execute(f)).status).toBe("completed");
    }
    const result = await persistRunAttemptFailure(f.db, {
      ...f.ownerIds,
      code: "RATE_LIMIT",
      message: "provider unavailable",
      retryable: true,
    });
    expect(result.retrying).toBe(!dispatched);
    expect(
      await f.db.assistantRun.findUniqueOrThrow({
        where: { id: f.ownerIds.runId },
      }),
    ).toMatchObject(
      dispatched
        ? { status: "failed", errorCode: "EXTERNAL_CALL_DISPATCHED" }
        : { status: "queued" },
    );
    expect(await approval(f)).toMatchObject({
      ...cleared,
      state: dispatched ? "settled" : "invalidated",
    });
  },
);
it("reconciliation racing an admitted external call cannot replay the attempt", async () => {
  const f = await ready();
  await approve(f);
  let entered!: () => void, release!: () => void;
  const atCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.calls.onCall = async () => {
    entered();
    await blocked;
  };
  const executing = execute(f);
  await atCall;
  try {
    await f.db.assistantRunAttempt.update({
      where: { id: f.ownerIds.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    expect((await reconcileAssistantRuns(f.db)).republished).toBe(0);
    expect(
      await f.db.assistantRun.findUniqueOrThrow({
        where: { id: f.ownerIds.runId },
      }),
    ).toMatchObject({
      status: "failed",
      errorCode: "EXTERNAL_CALL_DISPATCHED",
    });
    expect(
      await f.db.externalMcpCall.findUniqueOrThrow({ where: { id: f.callId } }),
    ).toMatchObject({ status: "unknown", dispatchedAt: expect.any(Date) });
    const restored = await listRunExternalCalls(f.deps, f.owner, {
      runId: f.ownerIds.runId,
    });
    expect(restored.calls[0]).toMatchObject({
      callId: f.callId,
      status: "unknown",
    });
    expect(restored.calls[0]?.summary).toContain("not replayed automatically");
    const events = await f.db.assistantRunEvent.findMany({
      where: { runId: f.ownerIds.runId, type: "external.call.status" },
    });
    expect(
      events.some(
        (event) => (event.payload as { status?: string }).status === "unknown",
      ),
    ).toBe(true);

    expect(await approval(f)).toMatchObject({ state: "settled", ...cleared });
  } finally {
    release();
    await executing;
  }
  expect(f.calls.tools).toEqual(["read"]);
});
it("cancel invalidates pending arguments immediately without claiming a remote rollback", async () => {
  const f = await ready();
  await requestRunCancel(f.db, f.owner, f.ownerIds.runId);
  expect(await approval(f)).toMatchObject({ state: "invalidated", ...cleared });
});
it.each(["expiry", "terminal", "lease"])(
  "reconciles %s approval payloads",
  async (reason) => {
    const f = await ready();
    if (reason === "expiry")
      await f.db.externalMcpToolApproval.update({
        where: { id: f.approvalId! },
        data: { expiresAt: new Date(0) },
      });
    if (reason === "terminal")
      await f.db.assistantRun.update({
        where: { id: f.ownerIds.runId },
        data: { status: "failed" },
      });
    if (reason === "lease")
      await f.db.assistantRunAttempt.update({
        where: { id: f.ownerIds.attemptId },
        data: { leaseExpiresAt: new Date(0) },
      });
    expect((await reconcileExternalMcpState(f.db, new Date())).approvals).toBe(
      1,
    );
    expect(await approval(f)).toMatchObject({
      state: reason === "expiry" ? "expired" : "invalidated",
      ...cleared,
    });
  },
);
it("keeps active task dispatch evidence and settles only after its own lease expires", async () => {
  const f = await makeEnabledExternalFixture();
  const { actor, invocation } = await makeTaskInvocation(f);
  const { callId } = await prepareExternalCall(f.deps, actor, invocation);
  await f.db.externalMcpCall.update({
    where: { id: callId },
    data: {
      status: "dispatched",
      dispatchedAt: new Date(),
      retainedUntil: new Date(0),
    },
  });
  expect(await reconcileExternalMcpState(f.db, new Date())).toMatchObject({
    calls: 0,
    pruned: 0,
  });
  await f.db.scheduledTaskRun.update({
    where: { id: invocation.owner.runId },
    data: { leaseExpiresAt: new Date(0) },
  });
  expect((await reconcileExternalMcpState(f.db, new Date())).calls).toBe(1);
  expect(
    await f.db.externalMcpCall.findUniqueOrThrow({ where: { id: callId } }),
  ).toMatchObject({ status: "unknown" });
});
it("prunes expired settled metadata only after the owning run is terminal", async () => {
  const f = await ready();
  await approve(f);
  await execute(f);
  await f.db.externalMcpCall.update({
    where: { id: f.callId },
    data: { retainedUntil: new Date(0) },
  });
  await f.db.externalMcpToolApproval.update({
    where: { id: f.approvalId! },
    data: { retainedUntil: new Date(0) },
  });
  expect((await reconcileExternalMcpState(f.db, new Date())).pruned).toBe(0);
  await f.db.assistantRun.update({
    where: { id: f.ownerIds.runId },
    data: { status: "completed" },
  });
  expect((await reconcileExternalMcpState(f.db, new Date())).pruned).toBe(2);
  expect(await f.db.externalMcpCall.count()).toBe(0);
  expect(await f.db.externalMcpToolApproval.count()).toBe(0);
});

it("keeps approved arguments during a live dispatch, then clears them at its deadline", async () => {
  const f = await ready();
  await approve(f);
  await f.db.externalMcpCall.update({
    where: { id: f.callId },
    data: { status: "dispatched", dispatchedAt: new Date() },
  });
  await f.db.externalMcpToolApproval.update({
    where: { id: f.approvalId! },
    data: { expiresAt: new Date(0) },
  });
  expect(await reconcileExternalMcpState(f.db, new Date())).toMatchObject({
    approvals: 0,
    calls: 0,
  });
  expect((await approval(f)).pendingArgumentsCiphertext).not.toBeNull();
  await f.db.externalMcpCall.update({
    where: { id: f.callId },
    data: { deadline: new Date(0) },
  });
  expect(await reconcileExternalMcpState(f.db, new Date())).toMatchObject({
    approvals: 1,
    calls: 1,
    pruned: 0,
  });
  expect(await approval(f)).toMatchObject({ state: "settled", ...cleared });
});
it("bounds approval expiry batches at 500", async () => {
  const f = await ready();
  const template = await approval(f);
  const call = await f.db.externalMcpCall.findUniqueOrThrow({
    where: { id: f.callId },
  });
  const ids = Array.from({ length: 500 }, () => ({
    id: crypto.randomUUID(),
    callId: crypto.randomUUID(),
  }));
  await f.db.externalMcpCall.createMany({
    data: ids.map((id) => ({
      ...call,
      id: id.callId,
      toolCallId: id.id,
      scopeSnapshot: {},
    })),
  });
  await f.db.externalMcpToolApproval.createMany({
    data: ids.map((id) => ({
      ...template,
      ...id,
      toolCallId: id.id,
      scopeSnapshot: {},
      expiresAt: new Date(0),
    })),
  });
  await f.db.externalMcpToolApproval.update({
    where: { id: template.id },
    data: { expiresAt: new Date(0) },
  });
  expect((await reconcileExternalMcpState(f.db, new Date())).approvals).toBe(
    500,
  );
  expect((await reconcileExternalMcpState(f.db, new Date())).approvals).toBe(1);
});
it("bounds settled metadata pruning at 5000 rows", async () => {
  const f = await ready();
  await approve(f);
  await execute(f);
  await f.db.assistantRun.update({
    where: { id: f.ownerIds.runId },
    data: { status: "completed" },
  });
  const call = await f.db.externalMcpCall.findUniqueOrThrow({
    where: { id: f.callId },
  });
  for (let offset = 0; offset < 5001; offset += 250)
    await f.db.externalMcpCall.createMany({
      data: Array.from({ length: Math.min(250, 5001 - offset) }, () => ({
        ...call,
        id: crypto.randomUUID(),
        toolCallId: crypto.randomUUID(),
        scopeSnapshot: {},
        retainedUntil: new Date(0),
      })),
    });
  expect((await reconcileExternalMcpState(f.db, new Date())).pruned).toBe(5000);
  expect((await reconcileExternalMcpState(f.db, new Date())).pruned).toBe(1);
});

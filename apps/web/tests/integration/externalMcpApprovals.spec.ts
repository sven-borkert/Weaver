import * as writer from "@weaver/core/diagnostics/writer";
import { beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "./_harness";
import { setAutoApproveChanges } from "@weaver/core/services/assistantConversations";
import {
  makeEnabledExternalFixture,
  makeAssistantInvocation,
} from "./_externalMcpFixtures";
import {
  prepareExternalCall,
  executeExternalCall,
  getExternalApproval,
  decideExternalApproval,
  listRunExternalApprovals,
  updateExternalConnection,
  getExternalConnection,
  reviewExternalTools,
  deleteExternalConnection,
} from "@weaver/core/services/externalMcp";
beforeEach(resetDb);
it("runs a write without asking when the conversation auto-approves", async () => {
  const f = await makeEnabledExternalFixture();
  const { invocation, conversationId } = await makeAssistantInvocation(
    f,
    f.owner,
    f.writeId,
  );
  await setAutoApproveChanges(f.db, f.owner, { conversationId, enabled: true });
  const prepared = await prepareExternalCall(f.deps, f.owner, invocation);
  expect(prepared.approvalId).toBeNull();
  await expect(
    executeExternalCall(f.deps, f.owner, {
      callId: prepared.callId,
      invocation,
      signal: AbortSignal.timeout(5000),
    }),
  ).resolves.toMatchObject({ status: "completed" });
  expect(f.calls.tools).toEqual(["write"]);
});
it("keeps a pending approval required after auto-approve is switched on", async () => {
  const f = await makeEnabledExternalFixture();
  const { invocation, conversationId } = await makeAssistantInvocation(
    f,
    f.owner,
    f.writeId,
  );
  const prepared = await prepareExternalCall(f.deps, f.owner, invocation);
  expect(prepared.approvalId).not.toBeNull();
  await setAutoApproveChanges(f.db, f.owner, { conversationId, enabled: true });
  await expect(
    executeExternalCall(f.deps, f.owner, {
      callId: prepared.callId,
      invocation,
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(f.calls.tools).toHaveLength(0);
});

async function prepared() {
  const f = await makeEnabledExternalFixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.writeId);
  invocation.arguments = { value: "private exact arguments" };
  const call = await prepareExternalCall(f.deps, f.owner, invocation);
  return { ...f, invocation, ...call, approvalId: call.approvalId! };
}
it("encrypts exact arguments, reads only for the owner, and deduplicates preparation", async () => {
  const f = await prepared();
  const row = await f.db.externalMcpToolApproval.findUniqueOrThrow({
    where: { id: f.approvalId },
  });
  expect(JSON.stringify(row)).not.toContain("private exact arguments");
  expect(
    await getExternalApproval(f.deps, f.owner, f.approvalId),
  ).toMatchObject({ arguments: f.invocation.arguments, status: "pending" });
  expect(
    await listRunExternalApprovals(f.deps, f.owner, f.invocation.owner.runId),
  ).toHaveLength(1);
  await expect(
    getExternalApproval(f.deps, f.outsider, f.approvalId),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await prepareExternalCall(f.deps, f.owner, f.invocation),
  ).toMatchObject({ callId: f.callId, approvalId: f.approvalId });
  await expect(
    prepareExternalCall(f.deps, f.owner, {
      ...f.invocation,
      arguments: { value: "changed" },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.db.externalMcpCall.count()).toBe(1);
});
it("serializes concurrent approvals without sending HTTP and conflicts on opposite decisions", async () => {
  const f = await prepared();
  const results = await Promise.all(
    [1, 2].map(() =>
      decideExternalApproval(f.deps, f.owner, {
        id: f.approvalId,
        decision: "approve",
      }),
    ),
  );
  expect(results.map((r) => r.status)).toEqual(["approved", "approved"]);
  expect(f.calls.tools).toEqual([]);
  expect(
    (
      await f.db.externalMcpToolApproval.findUniqueOrThrow({
        where: { id: f.approvalId },
      })
    ).pendingArgumentsCiphertext,
  ).not.toBeNull();
  await expect(
    decideExternalApproval(f.deps, f.owner, {
      id: f.approvalId,
      decision: "deny",
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("serializes racing approve/deny clicks and clears denied arguments", async () => {
  const f = await prepared();
  const results = await Promise.allSettled(
    (["approve", "deny"] as const).map((decision) =>
      decideExternalApproval(f.deps, f.owner, { id: f.approvalId, decision }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(f.calls.tools).toEqual([]);
});
it("reuses a run-wide denial for a fresh tool-call ID without repeating the prompt", async () => {
  const f = await prepared();
  await decideExternalApproval(f.deps, f.owner, {
    id: f.approvalId,
    decision: "deny",
  });
  expect(
    await decideExternalApproval(f.deps, f.owner, {
      id: f.approvalId,
      decision: "deny",
    }),
  ).toMatchObject({ status: "denied", arguments: null });
  const next = {
    ...f.invocation,
    owner: { ...f.invocation.owner, toolCallId: crypto.randomUUID() },
  };
  expect(await prepareExternalCall(f.deps, f.owner, next)).toMatchObject({
    status: "denied",
    approvalId: null,
  });
  expect(await f.db.externalMcpToolApproval.count()).toBe(1);
  expect(
    (
      await f.db.externalMcpToolApproval.findUniqueOrThrow({
        where: { id: f.approvalId },
      })
    ).pendingArgumentsCiphertext,
  ).toBeNull();
  await expect(
    executeExternalCall(f.deps, f.owner, {
      callId: f.callId,
      invocation: f.invocation,
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});
it.each(["pending", "approved"] as const)(
  "invalidates %s payloads on configuration change and still exposes safe status",
  async (state) => {
    const f = await prepared();
    if (state === "approved")
      await decideExternalApproval(f.deps, f.owner, {
        id: f.approvalId,
        decision: "approve",
      });
    const c = await getExternalConnection(f.db, f.owner, f.connectionId);
    await updateExternalConnection(f.deps, f.owner, {
      id: c.id,
      expectedRevision: c.revision,
      patch: { timeoutMs: 31_000 },
    });
    expect(
      await getExternalApproval(f.deps, f.owner, f.approvalId),
    ).toMatchObject({ status: "invalidated", arguments: null });
    expect(
      (
        await f.db.externalMcpToolApproval.findUniqueOrThrow({
          where: { id: f.approvalId },
        })
      ).pendingArgumentsCiphertext,
    ).toBeNull();
    await expect(
      executeExternalCall(f.deps, f.owner, {
        callId: f.callId,
        invocation: f.invocation,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  },
);
it("clears an expired payload even when the user attempts to approve it", async () => {
  const f = await prepared();
  f.deps.now = () => new Date(f.invocation.deadline.getTime() + 1);
  await expect(
    decideExternalApproval(f.deps, f.owner, {
      id: f.approvalId,
      decision: "approve",
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  const row = await f.db.externalMcpToolApproval.findUniqueOrThrow({
    where: { id: f.approvalId },
  });
  expect(row).toMatchObject({
    state: "expired",
    pendingArgumentsCiphertext: null,
  });
});
it.each(["lease", "cancel", "session", "membership", "reclassification"])(
  "rechecks %s before approving",
  async (change) => {
    const f = await prepared();
    if (change === "lease" && f.invocation.owner.kind === "assistant")
      await f.db.assistantRunAttempt.update({
        where: { id: f.invocation.owner.attemptId },
        data: { leaseExpiresAt: new Date(0) },
      });
    if (change === "cancel")
      await f.db.assistantRun.update({
        where: { id: f.invocation.owner.runId },
        data: { cancelRequestedAt: new Date() },
      });
    if (change === "session")
      await f.db.session.delete({ where: { id: f.owner.credentialId } });
    if (change === "membership")
      await f.db.member.deleteMany({ where: { userId: f.owner.userId } });
    if (change === "reclassification") {
      const tool = await f.db.externalMcpTool.findUniqueOrThrow({
        where: { id: f.writeId },
      });
      await reviewExternalTools(f.deps, f.owner, {
        connectionId: tool.connectionId,
        items: [
          {
            toolId: f.writeId,
            expectedRemoteDigest: tool.discoveredRemoteDigest,
            enabled: true,
            effect: "read",
          },
        ],
      });
    }
    await expect(
      decideExternalApproval(f.deps, f.owner, {
        id: f.approvalId,
        decision: "approve",
      }),
    ).rejects.toBeDefined();
    expect(f.calls.tools).toEqual([]);
  },
);
it("retains historical denied metadata after deletion without exposing arguments", async () => {
  const f = await prepared();
  await decideExternalApproval(f.deps, f.owner, {
    id: f.approvalId,
    decision: "deny",
  });
  const c = await getExternalConnection(f.db, f.owner, f.connectionId);
  await deleteExternalConnection(f.db, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  expect(
    await getExternalApproval(f.deps, f.owner, f.approvalId),
  ).toMatchObject({
    status: "denied",
    connectionName: "Example",
    arguments: null,
  });
});
it("creates a single encrypted prompt under concurrent preparation", async () => {
  const f = await makeEnabledExternalFixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.writeId);
  const results = await Promise.all(
    [1, 2, 3].map(() => prepareExternalCall(f.deps, f.owner, invocation)),
  );
  expect(new Set(results.map((r) => r.callId)).size).toBe(1);
  expect(await f.db.externalMcpCall.count()).toBe(1);
  expect(await f.db.externalMcpToolApproval.count()).toBe(1);
});

it("emits approval decisions once after commit with no argument payload", async () => {
  const f = await prepared();
  const emit = vi.spyOn(writer, "emitDiagnostic");
  try {
    await Promise.all(
      [1, 2].map(() =>
        decideExternalApproval(f.deps, f.owner, {
          id: f.approvalId,
          decision: "approve",
        }),
      ),
    );
    const events = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.event === "external.approval.changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      details: {
        callId: f.callId,
        approvalId: f.approvalId,
        decision: "approved",
      },
    });
    expect(JSON.stringify(events)).not.toMatch(
      /private exact|ciphertext|example.test|external-owner/,
    );
  } finally {
    emit.mockRestore();
  }
});

it("asks only before write tools", async () => {
  const f = await makeEnabledExternalFixture();
  const read = await makeAssistantInvocation(f, f.owner, f.readId);
  const write = await makeAssistantInvocation(f, f.owner, f.writeId);
  expect(
    (await prepareExternalCall(f.deps, f.owner, read.invocation)).approvalId,
  ).toBeNull();
  expect(
    (await prepareExternalCall(f.deps, f.owner, write.invocation)).approvalId,
  ).toEqual(expect.any(String));
});

it("refuses an unapproved write without transport and runs a read without approval", async () => {
  const f = await makeEnabledExternalFixture();
  const write = await makeAssistantInvocation(f, f.owner, f.writeId);
  const preparedWrite = await prepareExternalCall(
    f.deps,
    f.owner,
    write.invocation,
  );
  expect(preparedWrite.approvalId).toEqual(expect.any(String));
  const opened = f.calls.opens.length;
  await expect(
    executeExternalCall(f.deps, f.owner, {
      callId: preparedWrite.callId,
      invocation: write.invocation,
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(f.calls.opens).toHaveLength(opened);
  expect(f.calls.tools).toEqual([]);
  const read = await makeAssistantInvocation(f, f.owner, f.readId);
  const preparedRead = await prepareExternalCall(
    f.deps,
    f.owner,
    read.invocation,
  );
  expect(preparedRead.approvalId).toBeNull();
  await expect(
    executeExternalCall(f.deps, f.owner, {
      callId: preparedRead.callId,
      invocation: read.invocation,
      signal: AbortSignal.timeout(5000),
    }),
  ).resolves.toMatchObject({ status: "completed" });
  expect(f.calls.opens).toHaveLength(opened + 1);
  expect(f.calls.tools).toEqual(["read"]);
});

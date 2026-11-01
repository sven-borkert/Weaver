import * as diagnosticWriter from "@weaver/core/diagnostics/writer";
import { ExternalMcpError } from "@weaver/external-mcp";
import { beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "./_harness";
import {
  makeEnabledExternalFixture,
  makeAssistantInvocation,
  makeTaskInvocation,
} from "./_externalMcpFixtures";
import {
  listRunExternalCalls,
  prepareExternalCall,
  executeExternalCall,
  decideExternalApproval,
  getExternalApproval,
  hasExternalDispatch,
  updateExternalConnection,
  getExternalConnection,
  rotateExternalMcpSecrets,
} from "@weaver/core/services/externalMcp";
import type { ExternalRuntimeDeps } from "@weaver/core/externalMcp/types";
import { ASSISTANT_RUN_TIMEOUT_MS } from "@weaver/core/assistant/limits";
beforeEach(resetDb);
async function ready(automatic = false) {
  const f = await makeEnabledExternalFixture();
  const { invocation, conversationId } = await makeAssistantInvocation(
    f,
    f.owner,
    f.writeId,
  );
  if (automatic)
    await f.db.assistantConversation.update({
      where: { id: conversationId },
      data: { autoApproveChanges: true },
    });
  const prepared = await prepareExternalCall(f.deps, f.owner, invocation);
  if (prepared.approvalId)
    await decideExternalApproval(f.deps, f.owner, {
      id: prepared.approvalId,
      decision: "approve",
    });
  return { ...f, invocation, ...prepared, signal: AbortSignal.timeout(10000) };
}
function execute(f: Awaited<ReturnType<typeof ready>>) {
  return executeExternalCall(f.deps, f.owner, {
    callId: f.callId,
    invocation: f.invocation,
    signal: f.signal,
  });
}
it("passes the connection's allowInsecureTls setting to the transport on tool calls", async () => {
  const f = await makeEnabledExternalFixture();
  const current = await getExternalConnection(f.db, f.owner, f.connectionId);
  await updateExternalConnection(f.deps, f.owner, {
    id: f.connectionId,
    expectedRevision: current.revision,
    patch: { allowInsecureTls: true },
  });
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.writeId);
  const prepared = await prepareExternalCall(f.deps, f.owner, invocation);
  if (prepared.approvalId)
    await decideExternalApproval(f.deps, f.owner, {
      id: prepared.approvalId,
      decision: "approve",
    });
  await executeExternalCall(f.deps, f.owner, {
    callId: prepared.callId,
    invocation,
    signal: AbortSignal.timeout(10000),
  });
  expect(f.calls.opens.at(-1)?.insecureTls).toBe(true);
});
it.each([false, true])(
  "dispatches concurrent duplicate writes once (automatic=%s), settles ciphertext and preserves dispatch evidence",
  async (automatic) => {
    const f = await ready(automatic);
    const results = await Promise.allSettled([execute(f), execute(f)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(f.calls.counter).toBe(1);
    expect(f.calls.tools).toEqual(["write"]);
    expect(await execute(f)).toMatchObject({
      status: "completed",
      output: null,
      source: null,
    });
    if (f.approvalId)
      expect(
        await getExternalApproval(f.deps, f.owner, f.approvalId),
      ).toMatchObject({ status: "settled", arguments: null });
    if (f.invocation.owner.kind === "assistant")
      expect(
        await f.db.$transaction((tx) =>
          hasExternalDispatch(
            tx,
            f.invocation.owner.kind === "assistant"
              ? f.invocation.owner.attemptId
              : "",
          ),
        ),
      ).toBe(true);
  },
);
it("rejects changed arguments for an approved tool-call ID", async () => {
  const f = await ready();
  f.invocation.arguments = { value: 42 };
  await expect(execute(f)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.calls.counter).toBe(0);
});
it.each(["completed", "failed", "unknown"] as const)(
  "persists bounded %s outcomes without retaining raw results or exception text",
  async (status) => {
    const f = await ready();
    if (status === "failed") f.calls.toolError = true;
    if (status === "unknown")
      f.calls.callError = new Error("private response token argument");
    const result = await execute(f);
    expect(result.status).toBe(status);
    const row = await f.db.externalMcpCall.findUniqueOrThrow({
      where: { id: f.callId },
    });
    expect(row.status).toBe(status);
    expect(JSON.stringify(row)).not.toContain(
      "private response token argument",
    );
    expect(
      (
        await f.db.externalMcpToolApproval.findUniqueOrThrow({
          where: { id: f.approvalId! },
        })
      ).pendingArgumentsCiphertext,
    ).toBeNull();
    expect((await execute(f)).output).toBeNull();
    expect(f.calls.counter).toBe(1);
  },
);
it("never retries a dead worker's persisted dispatch", async () => {
  const f = await ready();
  await f.db.externalMcpCall.update({
    where: { id: f.callId },
    data: { status: "dispatched", dispatchedAt: new Date() },
  });
  expect(await execute(f)).toMatchObject({ status: "unknown", output: null });
  expect(f.calls.counter).toBe(0);
});
it.each(["lease", "cancel", "membership", "config"])(
  "blocks live %s changes before dispatch",
  async (change) => {
    const f = await ready();
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
    if (change === "membership")
      await f.db.member.deleteMany({ where: { userId: f.owner.userId } });
    if (change === "config")
      await f.db.externalMcpConnection.update({
        where: { id: f.connectionId },
        data: { revision: { increment: 1 } },
      });
    await expect(execute(f)).rejects.toBeDefined();
    expect(f.calls.counter).toBe(0);
    expect(
      (
        await f.db.externalMcpCall.findUniqueOrThrow({
          where: { id: f.callId },
        })
      ).dispatchedAt,
    ).toBeNull();
  },
);
it("cannot recall an admitted write when configuration changes while its response is pending", async () => {
  const f = await ready();
  let entered!: () => void, release!: () => void;
  const atCall = new Promise<void>((r) => (entered = r)),
    blocked = new Promise<void>((r) => (release = r));
  f.calls.onCall = async () => {
    entered();
    await blocked;
  };
  const running = execute(f);
  await atCall;
  const c = await getExternalConnection(f.db, f.owner, f.connectionId);
  await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { enabled: false },
  });
  expect(
    (
      await f.db.externalMcpToolApproval.findUniqueOrThrow({
        where: { id: f.approvalId! },
      })
    ).pendingArgumentsCiphertext,
  ).not.toBeNull();
  release();
  expect(await running).toMatchObject({ status: "completed" });
  expect(f.calls.counter).toBe(1);
});
it("treats cancellation after dispatch as unknown and never sends the write again", async () => {
  const f = await ready();
  const abort = new AbortController();
  f.signal = abort.signal;
  f.calls.onCall = async () => {
    abort.abort();
  };
  expect(await execute(f)).toMatchObject({ status: "unknown" });
  expect(await execute(f)).toMatchObject({ status: "unknown", output: null });
  expect(f.calls.counter).toBe(1);
});
it("does not invoke a changed remote definition or remote confirmation as local approval", async () => {
  const f = await ready(true);
  f.calls.catalog.tools.find((t) => t.name === "write")!.inputSchema = {
    type: "object",
    required: ["remote_confirmation"],
    properties: { remote_confirmation: { type: "boolean" } },
  };
  expect(await execute(f)).toMatchObject({ status: "unknown" });
  expect(f.calls.counter).toBe(0);
});
it("checks live connection identity on every token resolution", async () => {
  const f = await ready(true);
  const original = f.transport.open.bind(f.transport);
  f.transport.open = async (options) => {
    const session = await original(options);
    return {
      ...session,
      discover: async () => {
        const catalog = await session.discover();
        await f.db.externalMcpConnection.update({
          where: { id: f.connectionId },
          data: { enabled: false },
        });
        return catalog;
      },
    };
  };
  expect(await execute(f)).toMatchObject({ status: "unknown" });
  expect(f.calls.counter).toBe(0);
});
it("uses rotated encryption keys and live bearer credentials", async () => {
  const f = await makeEnabledExternalFixture();
  const c = await getExternalConnection(f.db, f.owner, f.connectionId);
  await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: {
      authMode: "bearer",
      token: "fixture-bearer",
    },
  });
  const { invocation, conversationId } = await makeAssistantInvocation(
    f,
    f.owner,
    f.writeId,
  );
  await f.db.assistantConversation.update({
    where: { id: conversationId },
    data: { autoApproveChanges: true },
  });
  const call = await prepareExternalCall(f.deps, f.owner, invocation);
  const rotated = {
    activeVersion: 2,
    keys: new Map([...f.ring.keys, [2, Buffer.alloc(32, 3)]]),
  };
  await rotateExternalMcpSecrets(f.db, rotated);
  f.deps.ring = rotated;
  expect(
    await executeExternalCall(f.deps, f.owner, {
      callId: call.callId,
      invocation,
      signal: AbortSignal.timeout(5000),
    }),
  ).toMatchObject({ status: "completed" });
  expect(f.calls.tokens.slice(-2)).toEqual([
    "fixture-bearer",
    "fixture-bearer",
  ]);
});
it("returns unknown if observed results cannot be persisted, retaining durable no-replay evidence", async () => {
  const f = await ready();
  const transaction = f.db.$transaction.bind(f.db);
  let transactions = 0;
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === "$transaction")
        return (...args: unknown[]) => {
          transactions++;
          if (transactions > 1) throw new Error("private persistence error");
          return Reflect.apply(transaction, target, args) as unknown;
        };
      return Reflect.get(target, key) as unknown;
    },
  });
  const deps: ExternalRuntimeDeps = { ...f.deps, db };
  expect(
    await executeExternalCall(deps, f.owner, {
      callId: f.callId,
      invocation: f.invocation,
      signal: f.signal,
    }),
  ).toMatchObject({ status: "unknown", output: null });
  expect(
    (await f.db.externalMcpCall.findUniqueOrThrow({ where: { id: f.callId } }))
      .status,
  ).toBe("dispatched");
  expect(await execute(f)).toMatchObject({ status: "unknown", output: null });
  expect(f.calls.counter).toBe(1);
});

it("keeps an admitted invocation immutable across asynchronous transport setup", async () => {
  const f = await ready();
  const open = f.transport.open.bind(f.transport);
  f.transport.open = async (options) => {
    f.invocation.arguments = { changed: "unapproved" };
    return open(options);
  };
  expect(await execute(f)).toMatchObject({ status: "completed" });
  expect(f.calls.arguments).toEqual([{}]);
});
it("returns the settled state for an identical repeated approval", async () => {
  const f = await ready();
  await execute(f);
  expect(
    await decideExternalApproval(f.deps, f.owner, {
      id: f.approvalId!,
      decision: "approve",
    }),
  ).toMatchObject({ status: "settled", arguments: null });
});
it("expires and clears approval arguments when execution observes the deadline", async () => {
  const f = await ready();
  f.deps.now = () => new Date(f.invocation.deadline.getTime() + 1);
  await expect(execute(f)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(
    await f.db.externalMcpToolApproval.findUniqueOrThrow({
      where: { id: f.approvalId! },
    }),
  ).toMatchObject({ state: "expired", pendingArgumentsCiphertext: null });
  expect(f.calls.counter).toBe(0);
});
it.each(["active", "lease", "input"])(
  "requires the saved task input and a live lease (%s)",
  async (mode) => {
    const f = await makeEnabledExternalFixture();
    const t = await makeTaskInvocation(f);
    const call = await prepareExternalCall(f.deps, t.actor, t.invocation);
    expect(call.approvalId).toBeNull();
    if (mode === "lease")
      await f.db.scheduledTaskRun.update({
        where: { id: t.run.id },
        data: { leaseExpiresAt: new Date(0) },
      });
    if (mode === "input")
      await f.db.scheduledTaskExternalInput.update({
        where: { id: t.input.id },
        data: { toolId: f.writeId },
      });
    const execute = () =>
      executeExternalCall(f.deps, t.actor, {
        callId: call.callId,
        invocation: t.invocation,
        signal: AbortSignal.timeout(5000),
      });
    if (mode === "active") {
      expect(await Promise.all([execute(), execute()])).toHaveLength(2);
      expect(f.calls.tools).toEqual(["read"]);
    } else {
      await expect(execute()).rejects.toBeDefined();
      expect(f.calls.tools).toEqual([]);
    }
  },
);
it("fails closed on legacy rows without exact identity evidence", async () => {
  const f = await ready();
  await f.db.externalMcpCall.update({
    where: { id: f.callId },
    data: { invocationDigest: null, deadline: null },
  });
  await expect(execute(f)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(f.calls.counter).toBe(0);
});
it("caps caller deadlines at the actual assistant run lifetime", async () => {
  const f = await makeEnabledExternalFixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.writeId);
  invocation.deadline = new Date(Date.now() + 2 * ASSISTANT_RUN_TIMEOUT_MS);
  const call = await prepareExternalCall(f.deps, f.owner, invocation);
  const run = await f.db.assistantRun.findUniqueOrThrow({
    where: { id: invocation.owner.runId },
  });
  const row = await f.db.externalMcpCall.findUniqueOrThrow({
    where: { id: call.callId },
  });
  expect(row.deadline!.getTime()).toBe(
    run.startedAt!.getTime() + ASSISTANT_RUN_TIMEOUT_MS,
  );
  expect(
    (await getExternalApproval(f.deps, f.owner, call.approvalId!)).expiresAt,
  ).toBe(row.deadline!.toISOString());
});

it.each(["connection", "cancel"])(
  "waits for a competing %s mutation before admission",
  async (kind) => {
    const f = await ready();
    let entered!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    const mutation = f.db.$transaction(async (tx) => {
      if (kind === "connection")
        await tx.$queryRaw`SELECT id FROM "ExternalMcpConnection" WHERE id = ${f.connectionId}::uuid FOR UPDATE`;
      else
        await tx.$queryRaw`SELECT id FROM "AssistantRun" WHERE id = ${f.invocation.owner.runId}::uuid FOR UPDATE`;
      entered();
      await gate;
      if (kind === "connection")
        await tx.externalMcpConnection.update({
          where: { id: f.connectionId },
          data: { enabled: false, revision: { increment: 1 } },
        });
      else
        await tx.assistantRun.update({
          where: { id: f.invocation.owner.runId },
          data: { status: "cancelling", cancelRequestedAt: new Date() },
        });
    });
    await acquired;
    const execution = execute(f);
    const rejected = expect(execution).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    release();
    await mutation;
    await rejected;
    expect(f.calls.counter).toBe(0);
  },
);
it("allows an admitted response to settle after durable cancellation", async () => {
  const f = await ready();
  let entered!: () => void, release!: () => void;
  const acquired = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  f.calls.onCall = async () => {
    entered();
    await gate;
  };
  const running = execute(f);
  await acquired;
  const { requestRunCancel } =
    await import("@weaver/core/services/assistantRuns");
  await requestRunCancel(f.db, f.owner, f.invocation.owner.runId);
  release();
  expect(await running).toMatchObject({ status: "completed" });
  expect(f.calls.counter).toBe(1);
});
it("does not locally fulfill a remote confirmation request", async () => {
  const f = await ready(true);
  f.calls.toolError = true;
  f.calls.content = [{ type: "text", text: "Remote confirmation is required" }];
  const result = await execute(f);
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "EXTERNAL_TOOL_ERROR" },
  });
  expect(f.calls.tools).toEqual(["write"]);
  expect(await f.db.externalMcpToolApproval.count()).toBe(0);
});
it("invalidates an approved request on bearer token replacement before dispatch", async () => {
  const f = await ready();
  const c = await getExternalConnection(f.db, f.owner, f.connectionId);
  await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { authMode: "bearer", token: "fixture-rotated" },
  });
  await expect(execute(f)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  expect(f.calls.counter).toBe(0);
  expect(
    (
      await f.db.externalMcpToolApproval.findUniqueOrThrow({
        where: { id: f.approvalId! },
      })
    ).pendingArgumentsCiphertext,
  ).toBeNull();
});

it("requires a current owner session even when a duplicate only returns status", async () => {
  const f = await ready();
  await execute(f);
  await f.db.session.delete({ where: { id: f.owner.credentialId } });
  await expect(execute(f)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(f.calls.counter).toBe(1);
});
it("does not open transport when the deadline elapses after the claim commits", async () => {
  const f = await ready();
  const transaction = f.db.$transaction.bind(f.db);
  let admitted = false,
    opens = 0;
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === "$transaction")
        return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(
            transaction,
            target,
            args,
          );
          admitted = true;
          return result;
        };
      return Reflect.get(target, key) as unknown;
    },
  });
  const open = f.transport.open.bind(f.transport);
  f.transport.open = async (options) => {
    opens++;
    return open(options);
  };
  const deps: ExternalRuntimeDeps = {
    ...f.deps,
    db,
    now: () =>
      admitted ? new Date(f.invocation.deadline.getTime() + 1) : new Date(),
  };
  expect(
    await executeExternalCall(deps, f.owner, {
      callId: f.callId,
      invocation: f.invocation,
      signal: f.signal,
    }),
  ).toMatchObject({ status: "unknown" });
  expect(opens).toBe(0);
  expect(f.calls.counter).toBe(0);
});

it("keeps a safe transport auth code with unknown outcome and no replay", async () => {
  const { ExternalMcpError } = await import("@weaver/external-mcp");
  const f = await ready(true);
  f.calls.callError = new ExternalMcpError("UNAUTHORIZED");
  expect(await execute(f)).toMatchObject({
    status: "unknown",
    error: { code: "EXTERNAL_AUTH_FAILED" },
  });
  expect((await execute(f)).status).toBe("unknown");
  expect(f.calls.counter).toBe(1);
  expect(
    await f.db.externalMcpCall.findUniqueOrThrow({ where: { id: f.callId } }),
  ).toMatchObject({
    dispatchedAt: expect.any(Date),
    errorCode: "EXTERNAL_AUTH_FAILED",
  });
});

it("restores durable bounded call metadata independent of events and connection drift", async () => {
  const f = await ready(true);
  f.calls.callError = new Error("private argument result token");
  await execute(f);
  await f.db.assistantRunEvent.deleteMany({
    where: { runId: f.invocation.owner.runId },
  });
  await f.db.externalMcpConnection.update({
    where: { id: f.connectionId },
    data: { name: "Renamed", enabled: false },
  });
  const page = await listRunExternalCalls(f.deps, f.owner, {
    runId: f.invocation.owner.runId,
  });
  expect(page.calls).toHaveLength(1);
  expect(page.calls[0]).toMatchObject({
    callId: f.callId,
    status: "unknown",
    connectionId: f.connectionId,
    toolName: "write",
  });
  expect(page.calls[0]?.connectionName).not.toBe("Renamed");
  expect(page.calls[0]?.summary).toContain("not replayed automatically");
  expect(JSON.stringify(page)).not.toMatch(
    /private argument|argsDigest|scopeSnapshot|endpoint|pendingArguments/,
  );
  await expect(
    listRunExternalCalls(f.deps, f.admin, { runId: f.invocation.owner.runId }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    listRunExternalCalls(
      f.deps,
      { ...f.owner, authenticationMethod: "apiKey" },
      { runId: f.invocation.owner.runId },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("emits one payload-free execution diagnostic per committed transition", async () => {
  const f = await ready(true);
  const emit = vi.spyOn(diagnosticWriter, "emitDiagnostic");
  try {
    f.calls.callError = new ExternalMcpError("RESPONSE_TOO_LARGE");
    await Promise.all([execute(f), execute(f)]);
    await execute(f);
    const events = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.event.startsWith("external.call."));
    expect(events.map((event) => event.event)).toEqual([
      "external.call.dispatched",
      "external.call.settled",
    ]);
    expect(events[1]).toMatchObject({
      details: {
        callId: f.callId,
        status: "unknown",
        errorCode: "EXTERNAL_RESPONSE_TOO_LARGE",
      },
    });
    expect(JSON.stringify(events)).not.toMatch(
      /example.test|external-owner|argument|ciphertext|endpoint|bearer|write/,
    );
  } finally {
    emit.mockRestore();
  }
});
it.each([
  ["FORBIDDEN", "EXTERNAL_FORBIDDEN"],
  ["UNSUPPORTED_PROTOCOL", "EXTERNAL_UNSUPPORTED_PROTOCOL"],
  ["RESPONSE_TOO_LARGE", "EXTERNAL_RESPONSE_TOO_LARGE"],
  ["UNSUPPORTED_SCHEMA", "EXTERNAL_UNSUPPORTED_SCHEMA"],
  ["INVALID_RESULT", "EXTERNAL_INVALID_RESULT"],
] as const)(
  "retains actionable %s cause independently from unknown certainty",
  async (transportCode, code) => {
    const f = await ready(true);
    f.calls.callError = new ExternalMcpError(transportCode);
    expect(await execute(f)).toMatchObject({
      status: "unknown",
      error: { code },
    });
    expect(
      (
        await listRunExternalCalls(f.deps, f.owner, {
          runId: f.invocation.owner.runId,
        })
      ).calls[0],
    ).toMatchObject({ status: "unknown", error: { code } });
  },
);
it("shows committed dispatch before an HTTP barrier and never calls a changed definition", async () => {
  const f = await ready(true);
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.calls.onCall = async () => {
    entered();
    await barrier;
  };
  const observed: unknown[] = [];
  const pending = executeExternalCall(f.deps, f.owner, {
    callId: f.callId,
    invocation: f.invocation,
    signal: f.signal,
    onDispatched: async (activity) => {
      observed.push(activity);
    },
  });
  await dispatched;
  try {
    expect(observed).toMatchObject([
      {
        callId: f.callId,
        status: "dispatched",
        connectionId: f.connectionId,
        toolName: "write",
      },
    ]);
    expect(
      (
        await listRunExternalCalls(f.deps, f.owner, {
          runId: f.invocation.owner.runId,
        })
      ).calls[0]?.status,
    ).toBe("dispatched");
  } finally {
    release();
  }
  await pending;
  const next = {
    ...f.invocation,
    owner: { ...f.invocation.owner, toolCallId: "changed-definition" },
  };
  const prepared = await prepareExternalCall(f.deps, f.owner, next);
  f.calls.catalog.tools = [];
  expect(
    await executeExternalCall(f.deps, f.owner, {
      callId: prepared.callId,
      invocation: next,
      signal: f.signal,
    }),
  ).toMatchObject({
    status: "unknown",
    error: { code: "EXTERNAL_TOOL_CHANGED" },
  });
  expect(f.calls.counter).toBe(1);
});

it("rechecks every historical scope project and the live session", async () => {
  const f = await ready(true);
  await execute(f);
  const { makeProject, addMembership } = await import("./_harness");
  const second = await makeProject("Historical second scope");
  await addMembership(second.id, f.owner.userId, "Viewer");
  await f.db.assistantRun.update({
    where: { id: f.invocation.owner.runId },
    data: {
      scopeSnapshot: {
        ...f.invocation.scope,
        projectIds: [...f.invocation.scope.projectIds, second.id],
      },
    },
  });
  expect(
    (
      await listRunExternalCalls(f.deps, f.owner, {
        runId: f.invocation.owner.runId,
      })
    ).calls,
  ).toHaveLength(1);
  const secondProject = await f.db.project.findUniqueOrThrow({
    where: { id: second.id },
    select: { organizationId: true },
  });
  expect(
    (
      await f.db.member.deleteMany({
        where: {
          userId: f.owner.userId,
          organizationId: secondProject.organizationId,
        },
      })
    ).count,
  ).toBe(1);
  await expect(
    listRunExternalCalls(f.deps, f.owner, { runId: f.invocation.owner.runId }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await addMembership(second.id, f.owner.userId, "Viewer");
  expect(
    (
      await listRunExternalCalls(f.deps, f.owner, {
        runId: f.invocation.owner.runId,
      })
    ).calls,
  ).toHaveLength(1);
  await f.db.session.deleteMany({ where: { id: f.owner.credentialId } });
  await expect(
    listRunExternalCalls(f.deps, f.owner, { runId: f.invocation.owner.runId }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
it("does not emit lifecycle evidence for rolled-back changes", async () => {
  const f = await ready(true);
  const { externalTransaction, recordExternalCall } =
    await import("@weaver/core/services/externalMcp/diagnostics");
  const emit = vi.spyOn(diagnosticWriter, "emitDiagnostic");
  try {
    await expect(
      externalTransaction(f.db, async (tx, events) => {
        const call = await tx.externalMcpCall.update({
          where: { id: f.callId },
          data: { status: "dispatched", dispatchedAt: new Date() },
        });
        recordExternalCall(events, call, "external.call.dispatched");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(emit).not.toHaveBeenCalled();
    expect(
      (
        await f.db.externalMcpCall.findUniqueOrThrow({
          where: { id: f.callId },
        })
      ).status,
    ).toBe("prepared");
  } finally {
    emit.mockRestore();
  }
});

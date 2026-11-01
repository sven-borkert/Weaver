import { beforeEach, afterEach, expect, it } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { createConversation } from "@weaver/core/services/assistantConversations";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import { resetDb } from "./_harness";
import {
  makeEnabledExternalFixture,
  preloadExternalTools,
} from "./_externalMcpFixtures";

beforeEach(async () => {
  await resetDb();
  setJobQueueForTests(new FakeJobQueue());
});
afterEach(() => setJobQueueForTests(null));

it("stores only the message text on submission", async () => {
  const f = await makeEnabledExternalFixture("read_counter");
  const c = await createConversation(f.db, f.owner, {});
  const submitted = await submitUserMessage(f.db, f.owner, {
    conversationId: c.id,
    text: "Read the counter",
    scope: { kind: "project", projectId: f.project.id },
  });
  const row = await f.db.assistantMessage.findUniqueOrThrow({
    where: { id: submitted.userMessage.id },
  });
  expect(row.content).toEqual({ text: "Read the counter" });
});
it("waits for persisted owner approval before calling the tool and stores external lineage", async () => {
  const { executeAssistantRun } = await import("@weaver/ai/runner");
  const { externalToolName } = await import("@weaver/ai/externalTools");
  const { MockLanguageModelV4 } = await import("ai/test");
  const { simulateReadableStream } = await import("ai");
  const { seedTestLlmRouting } = await import("./_harness");
  const { decideExternalApproval, getExternalApproval } =
    await import("@weaver/core/services/externalMcp");
  await seedTestLlmRouting();
  const f = await makeEnabledExternalFixture(
    "read_counter",
    undefined,
    "write",
  );
  f.calls.content = [{ type: "text", text: "counter=7" }];
  const c = await createConversation(f.db, f.owner, {});
  const submitted = await submitUserMessage(f.db, f.owner, {
    conversationId: c.id,
    text: "Read the counter",
    scope: { kind: "project", projectId: f.project.id },
  });
  await preloadExternalTools(f, submitted.userMessage.id, [f.readId]);
  let step = 0;
  const finish = (reason: "stop" | "tool-calls") => ({
    type: "finish",
    finishReason: { unified: reason, raw: undefined },
    usage: {
      inputTokens: {
        total: 10,
        noCache: 10,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
  });
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<Record<string, unknown>>({
        chunks:
          step++ === 0
            ? [
                {
                  type: "tool-call",
                  toolCallId: "counter-call",
                  toolName: externalToolName(f.readId),
                  input: "{}",
                },
                finish("tool-calls"),
              ]
            : [
                { type: "text-start", id: "answer" },
                { type: "text-delta", id: "answer", delta: "Counter is 7." },
                { type: "text-end", id: "answer" },
                finish("stop"),
              ],
      }) as never,
    }),
  });
  const running = executeAssistantRun(
    {
      db: f.db,
      ring: f.ring,
      workerId: "external-runner",
      externalTransport: f.transport,
      modelFactory: () => model,
    },
    submitted.run.id,
  );
  try {
    await expect
      .poll(
        async () =>
          f.db.externalMcpToolApproval.count({
            where: { runId: submitted.run.id },
          }),
        { timeout: 4000 },
      )
      .toBe(1);
    expect(f.calls.tools).toEqual([]);
    const approval = await f.db.externalMcpToolApproval.findFirstOrThrow({
      where: { runId: submitted.run.id },
    });
    await expect(
      getExternalApproval(f.deps, f.outsider, approval.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await getExternalApproval(f.deps, f.owner, approval.id)).arguments,
    ).toEqual({});
    await decideExternalApproval(f.deps, f.owner, {
      id: approval.id,
      decision: "approve",
    });
  } finally {
    await running;
  }
  expect(f.calls.tools).toEqual(["read_counter"]);
  const answer = await f.db.assistantMessage.findFirstOrThrow({
    where: { conversationId: c.id, role: "assistant" },
  });
  expect(answer.content).toMatchObject({
    text: "Counter is 7.",
    hasExternalContext: true,
    contextProjectIds: [f.project.id],
    externalSources: [
      { connectionId: f.connectionId, toolName: "read_counter" },
    ],
  });
});

async function runnerFixture(
  options: {
    automatic?: boolean;
    write?: boolean;
    repeats?: number;
    parallel?: boolean;
    args?: string;
    nextFailure?: boolean;
    heartbeatMs?: number;
    description?: string;
    secondConnection?: boolean;
    alternateConnection?: boolean;
  } = {},
) {
  const { executeAssistantRun } = await import("@weaver/ai/runner");
  const { externalToolName } = await import("@weaver/ai/externalTools");
  const { MockLanguageModelV4 } = await import("ai/test");
  const { simulateReadableStream, APICallError } = await import("ai");
  const { seedTestLlmRouting } = await import("./_harness");
  await seedTestLlmRouting();
  const askedEffect = options.automatic ? "read" : "write";
  const f = await makeEnabledExternalFixture(
    "read_counter",
    options.description,
    askedEffect,
  );
  let second: { connectionId: string; toolId: string } | null = null;
  if (options.secondConnection) {
    const management = await import("@weaver/core/services/externalMcp");
    let connection = await management.createExternalConnection(
      f.deps,
      f.owner,
      {
        name: "Second connection",
        endpoint: "https://example.test/second",
        authMode: "none",
      },
    );
    await management.discoverExternalConnection(f.deps, f.owner, {
      id: connection.id,
      expectedRevision: connection.revision,
    });
    const tool = (
      await management.listExternalTools(f.db, f.owner, {
        connectionId: connection.id,
      })
    ).items.find((item) => item.remoteName === "read_counter")!;
    await management.reviewExternalTools(f.deps, f.owner, {
      connectionId: connection.id,
      items: [
        {
          toolId: tool.id,
          expectedRemoteDigest: tool.discoveredRemoteDigest,
          enabled: true,
          effect: askedEffect,
        },
      ],
    });
    connection = await management.getExternalConnection(
      f.db,
      f.owner,
      connection.id,
    );
    await management.updateExternalConnection(f.deps, f.owner, {
      id: connection.id,
      expectedRevision: connection.revision,
      patch: { enabled: true },
    });
    second = { connectionId: connection.id, toolId: tool.id };
  }
  const c = await createConversation(f.db, f.owner, {});
  if (options.automatic)
    await f.db.assistantConversation.update({
      where: { id: c.id },
      data: { autoApproveChanges: true },
    });
  const toolId = options.write ? f.writeId : f.readId;
  const submitted = await submitUserMessage(f.db, f.owner, {
    conversationId: c.id,
    text: "Use the selected tool",
    scope: { kind: "project", projectId: f.project.id },
  });
  await preloadExternalTools(f, submitted.userMessage.id, [
    toolId,
    ...(second ? [second.toolId] : []),
  ]);
  const hooks = { beforeTool: null as (() => Promise<void>) | null };
  let step = 0;
  const finish = (reason: "stop" | "tool-calls") => ({
    type: "finish",
    finishReason: { unified: reason, raw: undefined },
    usage: {
      inputTokens: {
        total: 10,
        noCache: 10,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
  });
  const model = new MockLanguageModelV4({
    doStream: async () => {
      if (step === 0) await hooks.beforeTool?.();
      if (step && options.nextFailure)
        throw new APICallError({
          message: "private error",
          url: "https://example.test",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      return {
        stream: simulateReadableStream<Record<string, unknown>>({
          chunks:
            step++ < (options.repeats ?? 1)
              ? [
                  {
                    type: "tool-call",
                    toolCallId: `call-${step}`,
                    toolName: externalToolName(
                      options.alternateConnection && step > 1
                        ? second!.toolId
                        : toolId,
                    ),
                    input: options.args ?? "{}",
                  },
                  ...(options.parallel
                    ? [
                        {
                          type: "tool-call",
                          toolCallId: `parallel-${step}`,
                          toolName: externalToolName(toolId),
                          input: options.args ?? "{}",
                        },
                      ]
                    : []),
                  finish("tool-calls"),
                ]
              : [
                  { type: "text-start", id: "answer" },
                  { type: "text-delta", id: "answer", delta: "Done." },
                  { type: "text-end", id: "answer" },
                  finish("stop"),
                ],
        }) as never,
      };
    },
  });
  const controller = new AbortController();
  const { currentDiagnosticContext } =
    await import("@weaver/core/diagnostics/context");
  const providerContexts: boolean[] = [];
  const start = () =>
    executeAssistantRun(
      {
        db: f.db,
        ring: f.ring,
        workerId: "external-runner",
        externalTransport: f.transport,
        modelFactory: () => {
          providerContexts.push(
            currentDiagnosticContext().suppressProviderBodies === true,
          );
          return model;
        },
        heartbeatMs: options.heartbeatMs ?? 10,
      },
      submitted.run.id,
      controller.signal,
    );
  const approval = async () => {
    await expect
      .poll(
        async () =>
          f.db.externalMcpToolApproval.count({
            where: { runId: submitted.run.id },
          }),
        { timeout: 4000 },
      )
      .toBe(1);
    return f.db.externalMcpToolApproval.findFirstOrThrow({
      where: { runId: submitted.run.id },
    });
  };
  return {
    ...f,
    c,
    submitted,
    start,
    approval,
    controller,
    providerContexts,
    hooks,
    second,
  };
}

it.each([false, true])(
  "executes automatic tools without approval (write=%s)",
  async (write) => {
    const f = await runnerFixture({ automatic: true, write });
    await f.start();
    expect(f.providerContexts).toEqual([true]);
    expect(f.calls.tools).toEqual([write ? "write" : "read_counter"]);
    expect(f.calls.counter).toBe(write ? 1 : 0);
    expect(await f.db.externalMcpToolApproval.count()).toBe(0);
  },
);
it("denies repeated identical calls without another approval or dispatch", async () => {
  const { decideExternalApproval } =
    await import("@weaver/core/services/externalMcp");
  const f = await runnerFixture({ repeats: 2, write: true });
  const running = f.start();
  try {
    const approval = await f.approval();
    await decideExternalApproval(f.deps, f.owner, {
      id: approval.id,
      decision: "deny",
    });
    await running;
  } finally {
    f.controller.abort();
    await running;
  }
  expect(f.calls.tools).toEqual([]);
  expect(await f.db.externalMcpToolApproval.count()).toBe(1);
  expect(
    await f.db.externalMcpCall.count({ where: { status: "denied" } }),
  ).toBe(2);
});
it("cancels an approval wait without dispatch", async () => {
  const { requestRunCancel } =
    await import("@weaver/core/services/assistantRuns");
  const f = await runnerFixture();
  const running = f.start();
  try {
    await f.approval();
    await requestRunCancel(f.db, f.owner, f.submitted.run.id);
    await running;
  } finally {
    f.controller.abort();
    await running;
  }
  expect(f.calls.tools).toEqual([]);
  expect(
    (
      await f.db.assistantRun.findUniqueOrThrow({
        where: { id: f.submitted.run.id },
      })
    ).status,
  ).toBe("cancelled");
});
it("does not retry a provider failure after dispatch", async () => {
  const f = await runnerFixture({ automatic: true, nextFailure: true });
  await f.start();
  expect(f.calls.tools).toEqual(["read_counter"]);
  expect(
    await f.db.assistantRun.findUniqueOrThrow({
      where: { id: f.submitted.run.id },
    }),
  ).toMatchObject({
    status: "failed",
    attemptCount: 1,
    errorCode: "EXTERNAL_CALL_DISPATCHED",
  });
});
it("keeps a lost write response unknown without replay", async () => {
  const f = await runnerFixture({ automatic: true, write: true });
  f.calls.callError = new Error("private transport body");
  await f.start();
  expect(f.calls.counter).toBe(1);
  expect(await f.db.externalMcpCall.findFirstOrThrow()).toMatchObject({
    status: "unknown",
  });
});
it("rejects malformed model arguments before approval or dispatch", async () => {
  const f = await runnerFixture({ args: "[]", write: true });
  await f.start();
  expect(f.calls.tools).toEqual([]);
  expect(await f.db.externalMcpToolApproval.count()).toBe(0);
});
it("drops a stale loaded tool at run start and lets the model recover", async () => {
  const f = await runnerFixture({ automatic: true });
  await f.db.externalMcpConnection.update({
    where: { id: f.connectionId },
    data: { revision: { increment: 1 } },
  });
  await f.start();
  expect(f.calls.tools).toEqual([]);
  expect(f.providerContexts).toEqual([true]);
  expect(
    await f.db.assistantRun.findUniqueOrThrow({
      where: { id: f.submitted.run.id },
    }),
  ).toMatchObject({ status: "completed" });
});
it("approves a write only once and records its real outcome", async () => {
  const { decideExternalApproval } =
    await import("@weaver/core/services/externalMcp");
  const f = await runnerFixture({ write: true });
  const running = f.start();
  try {
    const approval = await f.approval();
    expect(f.calls.counter).toBe(0);
    await decideExternalApproval(f.deps, f.owner, {
      id: approval.id,
      decision: "approve",
    });
    await running;
  } finally {
    f.controller.abort();
    await running;
  }
  expect(f.calls.counter).toBe(1);
});
it("offers no external tools after access loss and never dispatches", async () => {
  const f = await runnerFixture({ automatic: true });
  await f.db.member.deleteMany({ where: { userId: f.owner.userId } });
  await f.start();
  expect(f.calls.tools).toEqual([]);
  expect(await f.db.externalMcpCall.count()).toBe(0);
});
it("keeps approval waits inside an active lease", async () => {
  const { reconcileAssistantRuns } =
    await import("@weaver/core/services/assistantRuns");
  const f = await runnerFixture({ heartbeatMs: 60000 });
  const running = f.start();
  try {
    const approval = await f.approval();
    await f.db.assistantRunAttempt.update({
      where: { id: approval.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await running;
  } finally {
    f.controller.abort();
    await running;
  }
  await reconcileAssistantRuns(f.db);
  expect(f.calls.tools).toEqual([]);
  expect((await f.db.externalMcpToolApproval.findFirstOrThrow()).state).toBe(
    "invalidated",
  );
});
async function answerPlainly(
  f: Awaited<ReturnType<typeof makeEnabledExternalFixture>>,
  runId: string,
) {
  const { executeAssistantRun } = await import("@weaver/ai/runner");
  const { MockLanguageModelV4 } = await import("ai/test");
  const { simulateReadableStream } = await import("ai");
  const { currentDiagnosticContext } =
    await import("@weaver/core/diagnostics/context");
  const contexts: boolean[] = [];
  await executeAssistantRun(
    {
      db: f.db,
      ring: f.ring,
      workerId: "plain",
      modelFactory: () => {
        contexts.push(
          currentDiagnosticContext().suppressProviderBodies === true,
        );
        return new MockLanguageModelV4({
          doStream: async () => ({
            stream: simulateReadableStream<Record<string, unknown>>({
              chunks: [
                { type: "text-start", id: "text" },
                { type: "text-delta", id: "text", delta: "Answer." },
                { type: "text-end", id: "text" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: undefined },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: 10,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 5, text: 5, reasoning: undefined },
                  },
                },
              ],
            }) as never,
          }),
        });
      },
    },
    runId,
  );
  return contexts;
}
it("suppresses provider construction on later internal-only turns replaying external context", async () => {
  const f = await runnerFixture({ automatic: true });
  await f.start();
  const next = await submitUserMessage(f.db, f.owner, {
    conversationId: f.c.id,
    text: "Explain the prior result",
    scope: { kind: "project", projectId: f.project.id },
  });
  expect(await answerPlainly(f, next.run.id)).toEqual([true]);
  const answer = await f.db.assistantMessage.findFirstOrThrow({
    where: { conversationId: f.c.id, role: "assistant" },
    orderBy: { position: "desc" },
  });
  expect(answer.content).toMatchObject({
    hasExternalContext: true,
    contextProjectIds: [f.project.id],
    externalSources: [],
  });
});
it("cannot shed broad lineage after the original broad user message leaves the history window", async () => {
  const { addMembership, makeProject, seedTestLlmRouting } =
    await import("./_harness");
  await seedTestLlmRouting();
  const f = await makeEnabledExternalFixture("read_counter");
  const other = await makeProject("Other context");
  await addMembership(other.id, f.owner.userId, "Editor");
  const c = await createConversation(f.db, f.owner, {});
  const broad = await submitUserMessage(f.db, f.owner, {
    conversationId: c.id,
    text: "Use both projects",
    scope: { kind: "projects", projectIds: [f.project.id, other.id] },
  });
  // The owner has an enabled connection, so provider bodies stay suppressed.
  expect(await answerPlainly(f, broad.run.id)).toEqual([true]);
  const originalAnswer = await f.db.assistantMessage.findFirstOrThrow({
    where: { conversationId: c.id, role: "assistant" },
  });
  expect(originalAnswer.content).toMatchObject({
    contextProjectIds: [f.project.id, other.id],
  });
  const scope = {
    kind: "project",
    projectIds: [f.project.id],
    documentId: null,
    tableId: null,
    resolvedAt: new Date().toISOString(),
    truncated: false,
  };
  await f.db.assistantMessage.createMany({
    data: Array.from({ length: 99 }, (_, i) => ({
      conversationId: c.id,
      position: i + 2,
      role: "assistant" as const,
      status: "complete" as const,
      content: {
        text: "Earlier narrow answer",
        contextProjectIds: [f.project.id, other.id],
      },
      scopeSnapshot: scope,
    })),
  });
  const narrow = await submitUserMessage(f.db, f.owner, {
    conversationId: c.id,
    text: "Answer in this project",
    scope: { kind: "project", projectId: f.project.id },
  });
  await answerPlainly(f, narrow.run.id);
  const answer = await f.db.assistantMessage.findFirstOrThrow({
    where: { conversationId: c.id, role: "assistant" },
    orderBy: { position: "desc" },
  });
  expect(answer.content).toMatchObject({
    contextProjectIds: [f.project.id, other.id],
  });
});
it("keeps unknown legacy context lineage unknown on new internal answers", async () => {
  const { seedTestLlmRouting } = await import("./_harness");
  await seedTestLlmRouting();
  const f = await makeEnabledExternalFixture("read_counter");
  const c = await createConversation(f.db, f.owner, {});
  await f.db.assistantMessage.create({
    data: {
      conversationId: c.id,
      position: 0,
      role: "assistant",
      status: "complete",
      content: { text: "Legacy answer" },
    },
  });
  const submitted = await submitUserMessage(f.db, f.owner, {
    conversationId: c.id,
    text: "Continue",
    scope: { kind: "project", projectId: f.project.id },
  });
  await answerPlainly(f, submitted.run.id);
  const answer = await f.db.assistantMessage.findFirstOrThrow({
    where: { conversationId: c.id, role: "assistant" },
    orderBy: { position: "desc" },
  });
  expect(answer.content).toMatchObject({ contextProjectIds: null });
});
it("refuses configuration drift after load with a visible failure", async () => {
  const f = await runnerFixture({ automatic: true });
  f.hooks.beforeTool = async () => {
    await f.db.externalMcpConnection.update({
      where: { id: f.connectionId },
      data: { revision: { increment: 1 } },
    });
  };
  await f.start();
  expect(f.calls.tools).toEqual([]);
  expect(
    (
      await f.db.assistantRun.findUniqueOrThrow({
        where: { id: f.submitted.run.id },
      })
    ).status,
  ).toBe("failed");
});
it("serializes parallel model calls so a second approval waits for the first outcome", async () => {
  const { decideExternalApproval } =
    await import("@weaver/core/services/externalMcp");
  const f = await runnerFixture({ parallel: true });
  const running = f.start();
  try {
    const first = await f.approval();
    expect(await f.db.externalMcpCall.count()).toBe(1);
    expect(f.calls.tools).toEqual([]);
    await decideExternalApproval(f.deps, f.owner, {
      id: first.id,
      decision: "approve",
    });
    await expect
      .poll(async () => f.db.externalMcpToolApproval.count(), { timeout: 4000 })
      .toBe(2);
    expect(f.calls.tools).toEqual(["read_counter"]);
    const second = await f.db.externalMcpToolApproval.findFirstOrThrow({
      where: { id: { not: first.id } },
    });
    await decideExternalApproval(f.deps, f.owner, {
      id: second.id,
      decision: "approve",
    });
    await running;
  } finally {
    f.controller.abort();
    await running;
  }
  expect(f.calls.tools).toEqual(["read_counter", "read_counter"]);
});
it("lets the model explain remote errors without retrying the external tool", async () => {
  const f = await runnerFixture({ automatic: true });
  f.calls.toolError = true;
  await f.start();
  expect(f.calls.tools).toEqual(["read_counter"]);
  expect((await f.db.externalMcpCall.findFirstOrThrow()).status).toBe("failed");
  expect(
    (
      await f.db.assistantRun.findUniqueOrThrow({
        where: { id: f.submitted.run.id },
      })
    ).status,
  ).toBe("completed");
});

it.each(["disable", "revise"] as const)(
  "refuses dispatch when the called connection changes during approval (%s)",
  async (change) => {
    const management = await import("@weaver/core/services/externalMcp");
    const f = await runnerFixture({ secondConnection: true });
    const running = f.start();
    try {
      const approval = await f.approval();
      expect(f.calls.tools).toEqual([]);
      const called = await management.getExternalConnection(
        f.db,
        f.owner,
        f.connectionId,
      );
      await management.updateExternalConnection(f.deps, f.owner, {
        id: called.id,
        expectedRevision: called.revision,
        patch: change === "disable" ? { enabled: false } : { timeoutMs: 60000 },
      });
      await management
        .decideExternalApproval(f.deps, f.owner, {
          id: approval.id,
          decision: "approve",
        })
        .catch(() => undefined);
      await running;
    } finally {
      f.controller.abort();
      await running;
    }
    expect(f.calls.tools).toEqual([]);
    expect(
      await f.db.externalMcpCall.count({
        where: { dispatchedAt: { not: null } },
      }),
    ).toBe(0);
    expect(
      await f.db.assistantRun.findUniqueOrThrow({
        where: { id: f.submitted.run.id },
      }),
    ).toMatchObject({ status: "failed", errorCode: "PRECONDITION_FAILED" });
  },
);
it("dispatches an approved call when an uncalled loaded connection changes", async () => {
  const management = await import("@weaver/core/services/externalMcp");
  const f = await runnerFixture({ secondConnection: true });
  const running = f.start();
  try {
    const approval = await f.approval();
    const other = await management.getExternalConnection(
      f.db,
      f.owner,
      f.second!.connectionId,
    );
    await management.updateExternalConnection(f.deps, f.owner, {
      id: other.id,
      expectedRevision: other.revision,
      patch: { timeoutMs: 60000 },
    });
    await management.decideExternalApproval(f.deps, f.owner, {
      id: approval.id,
      decision: "approve",
    });
    await running;
  } finally {
    f.controller.abort();
    await running;
  }
  expect(f.calls.tools).toEqual(["read_counter"]);
});

it("persists real running activity before HTTP settles and distinguishes identically named tools across connections", async () => {
  const f = await runnerFixture({
    automatic: true,
    secondConnection: true,
    alternateConnection: true,
    repeats: 2,
  });
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atHttp = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.calls.onCall = async () => {
    entered();
    await barrier;
  };
  const running = f.start();
  await atHttp;
  try {
    const events = await f.db.assistantRunEvent.findMany({
      where: { runId: f.submitted.run.id, type: "external.call.status" },
    });
    expect(events.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "dispatched",
          connectionId: f.connectionId,
          toolName: "read_counter",
        }),
      ]),
    );
  } finally {
    release();
    await running;
  }
  const { listRunExternalCalls } =
    await import("@weaver/core/services/externalMcp");
  const page = await listRunExternalCalls(f.deps, f.owner, {
    runId: f.submitted.run.id,
  });
  expect(page.calls).toHaveLength(2);
  expect(new Set(page.calls.map((call) => call.connectionId)).size).toBe(2);
  expect(new Set(page.calls.map((call) => call.connectionName)).size).toBe(2);
  expect(
    page.calls.every(
      (call) =>
        call.status === "completed" &&
        call.toolName === "read_counter" &&
        call.summary?.includes("bytes of external data"),
    ),
  ).toBe(true);
});
const finishChunk = (reason: "stop" | "tool-calls") => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: {
      total: 10,
      noCache: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  },
});
let scriptedCall = 0;
const callChunk = (toolName: string, input: unknown) => ({
  type: "tool-call",
  toolCallId: `scripted-${++scriptedCall}`,
  toolName,
  input: JSON.stringify(input),
});
async function runScripted(
  f: Awaited<ReturnType<typeof makeEnabledExternalFixture>>,
  runId: string,
  steps: Array<Array<Record<string, unknown>>>,
) {
  const { executeAssistantRun } = await import("@weaver/ai/runner");
  const { MockLanguageModelV4 } = await import("ai/test");
  const { simulateReadableStream } = await import("ai");
  const { currentDiagnosticContext } =
    await import("@weaver/core/diagnostics/context");
  const contexts: boolean[] = [];
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<Record<string, unknown>>({
        chunks:
          step < steps.length
            ? [...steps[step++]!, finishChunk("tool-calls")]
            : [
                { type: "text-start", id: "a" },
                { type: "text-delta", id: "a", delta: "Done." },
                { type: "text-end", id: "a" },
                finishChunk("stop"),
              ],
      }) as never,
    }),
  });
  await executeAssistantRun(
    {
      db: f.db,
      ring: f.ring,
      workerId: "scripted",
      externalTransport: f.transport,
      modelFactory: () => {
        contexts.push(
          currentDiagnosticContext().suppressProviderBodies === true,
        );
        return model;
      },
    },
    runId,
  );
  return {
    model,
    contexts,
    toolNames: (i: number) =>
      (model.doStreamCalls[i]?.tools ?? []).map((t) => t.name),
    prompt: (i: number) => JSON.stringify(model.doStreamCalls[i]?.prompt ?? []),
  };
}
async function scriptedSetup(owner: "owner" | "outsider" = "owner") {
  const { addMembership, seedTestLlmRouting } = await import("./_harness");
  await seedTestLlmRouting();
  const f = await makeEnabledExternalFixture("read_counter");
  if (owner === "outsider")
    await addMembership(f.project.id, f.outsider.userId, "Editor");
  const actor = owner === "owner" ? f.owner : f.outsider;
  const c = await createConversation(f.db, actor, {});
  const submit = () =>
    submitUserMessage(f.db, actor, {
      conversationId: c.id,
      text: "Read the counter",
      scope: { kind: "project", projectId: f.project.id },
    });
  return { f, c, submit };
}

it("finds, loads and calls an external tool within one message", async () => {
  const { externalToolName } = await import("@weaver/ai/externalTools");
  const { f, c, submit } = await scriptedSetup();
  f.calls.content = [{ type: "text", text: "counter=7" }];
  const submitted = await submit();
  const name = externalToolName(f.readId);
  const run = await runScripted(f, submitted.run.id, [
    [callChunk("find_external_tools", { query: "counter" })],
    [callChunk("find_external_tools", { load: [name] })],
    [callChunk(name, {})],
  ]);
  expect(run.toolNames(0)).toContain("find_external_tools");
  expect(run.toolNames(0)).not.toContain(name);
  expect(run.toolNames(2)).toContain(name);
  expect(run.prompt(0)).toContain("Example (");
  expect(f.calls.tools).toEqual(["read_counter"]);
  expect(run.contexts).toEqual([true]);
  const user = await f.db.assistantMessage.findUniqueOrThrow({
    where: { id: submitted.userMessage.id },
  });
  expect(user.content).toMatchObject({
    externalToolSnapshots: [{ toolId: f.readId }],
  });
  const answer = await f.db.assistantMessage.findFirstOrThrow({
    where: { conversationId: c.id, role: "assistant" },
  });
  expect(answer.content).toMatchObject({
    text: "Done.",
    hasExternalContext: true,
  });
});

it("returns a call to a tool that is not loaded to the model and continues", async () => {
  const { externalToolName } = await import("@weaver/ai/externalTools");
  const { f, submit } = await scriptedSetup();
  const submitted = await submit();
  const run = await runScripted(f, submitted.run.id, [
    [callChunk(externalToolName(f.readId), {})],
  ]);
  expect(f.calls.tools).toEqual([]);
  expect(run.model.doStreamCalls).toHaveLength(2);
  expect(
    await f.db.assistantRun.findUniqueOrThrow({
      where: { id: submitted.run.id },
    }),
  ).toMatchObject({ status: "completed" });
});

it("runs without external tools when earlier messages used a broader scope", async () => {
  const { addMembership, makeProject } = await import("./_harness");
  const { f, c, submit } = await scriptedSetup();
  const other = await makeProject("Other context");
  await addMembership(other.id, f.owner.userId, "Editor");
  await f.db.assistantMessage.create({
    data: {
      conversationId: c.id,
      position: 0,
      role: "assistant",
      status: "complete",
      content: {
        text: "Earlier broad answer",
        contextProjectIds: [f.project.id, other.id],
      },
    },
  });
  const submitted = await submit();
  const run = await runScripted(f, submitted.run.id, []);
  expect(run.toolNames(0)).not.toContain("find_external_tools");
  expect(run.prompt(0)).toContain("ask the user to start a new conversation");
  expect(
    await f.db.assistantRun.findUniqueOrThrow({
      where: { id: submitted.run.id },
    }),
  ).toMatchObject({ status: "completed" });
});

it("runs without external tools when the schema reserve does not fit the context window", async () => {
  const { z } = await import("zod");
  const { budgetModelMessages, buildInstructions } =
    await import("@weaver/ai/prompt");
  const { findToolDefinition } = await import("@weaver/ai/externalTools");
  const { externalSchemaReserve } =
    await import("@weaver/ai/externalToolSearch");
  const { toolsForActor } = await import("@weaver/assistant-tools/registry");
  const { f, submit } = await scriptedSetup();
  const submitted = await submit();
  const [project, user, model] = await Promise.all([
    f.db.project.findUniqueOrThrow({
      where: { id: f.project.id },
      select: { name: true },
    }),
    f.db.user.findUniqueOrThrow({
      where: { id: f.owner.userId },
      select: { name: true },
    }),
    f.db.llmModel.findFirstOrThrow({ select: { maxOutputTokens: true } }),
  ]);
  const scope = {
    kind: "project" as const,
    projectIds: [f.project.id],
    documentId: null,
    tableId: null,
    resolvedAt: new Date().toISOString(),
    truncated: false,
  };
  const native = toolsForActor(f.owner).map((contract) => ({
    name: contract.name,
    description: contract.description,
    inputSchema: z.toJSONSchema(contract.inputSchema),
  }));
  const fits = (contextWindow: number, offered: boolean) => {
    try {
      budgetModelMessages([submitted.userMessage], {
        contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        instructions: buildInstructions({
          scope,
          projects: [{ id: f.project.id, name: project.name }],
          userName: user.name,
          canPropose: true,
          external: offered
            ? {
                kind: "offered",
                connections: [{ name: "Example", toolCount: 2 }],
              }
            : { kind: "unavailable", reason: "context" },
        }),
        toolDefinitions: JSON.stringify(
          offered ? [...native, findToolDefinition()] : native,
        ),
        reservedBytes: offered ? externalSchemaReserve(contextWindow) : 0,
      });
      return true;
    } catch {
      return false;
    }
  };
  let contextWindow = 40_000;
  while (!fits(contextWindow, false)) contextWindow += 100;
  contextWindow += 500;
  expect(fits(contextWindow, true)).toBe(false);
  await f.db.llmModel.updateMany({ data: { contextWindow } });
  const run = await runScripted(f, submitted.run.id, []);
  expect(run.toolNames(0)).not.toContain("find_external_tools");
  expect(run.prompt(0)).toContain("context window is too small");
  expect(
    await f.db.assistantRun.findUniqueOrThrow({
      where: { id: submitted.run.id },
    }),
  ).toMatchObject({ status: "completed" });
});

it("offers no external tools and keeps provider bodies for users without connections", async () => {
  const { f, submit } = await scriptedSetup("outsider");
  const submitted = await submit();
  const run = await runScripted(f, submitted.run.id, []);
  expect(run.contexts).toEqual([false]);
  expect(run.toolNames(0)).not.toContain("find_external_tools");
});

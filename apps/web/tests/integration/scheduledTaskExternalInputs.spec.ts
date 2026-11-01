import { buildTaskPrompt } from "@weaver/ai/taskPrompt";
import { beforeEach, describe, expect, it } from "vitest";
import { ExternalMcpError } from "@weaver/external-mcp";
import { fetchTaskExternalInputs } from "@weaver/core/scheduledTasks/externalInputs";
import { createTaskSecurityContext } from "@weaver/core/security/context";
import { MockLanguageModelV4 } from "ai/test";
import { executeScheduledTaskRun } from "@weaver/ai/taskRunner";
import { currentDiagnosticContext } from "@weaver/core/diagnostics/context";
import { serializeDocumentBody } from "@weaver/core/editor/markdown";
import { getDocument } from "@weaver/core/services/documents";
import {
  createTask,
  updateTask,
  deleteTask,
  leaseTaskRun,
} from "@weaver/core/services/scheduledTasks";
import { makeEnabledExternalFixture } from "./_externalMcpFixtures";
import { resetDb, seedTestLlmRouting, markdownContent } from "./_harness";

async function fixture(count = 1) {
  const f = await makeEnabledExternalFixture();
  const definition = {
    name: "External report",
    instruction: "Summarize",
    scope: { kind: "project", projectId: f.project.id },
    outputProjectId: f.project.id,
    outputFolderPath: [],
    schedule: { kind: "hourly", minute: 0 },
    timezone: "UTC",
    externalInputs: Array.from({ length: count }, (_, i) => ({
      name: `Input ${i}`,
      toolId: f.readId,
      arguments: {
        from: { kind: "period_start" as const },
        to: { kind: "period_end" as const },
      },
    })),
  };
  const task = await createTask(f.db, f.owner, definition);
  await seedTestLlmRouting({ jobs: true });
  const prompts: string[] = [];
  let onGenerate: (() => Promise<void>) | undefined;
  const deps = {
    db: f.db,
    ring: f.ring,
    workerId: "external-task-test",
    externalTransport: f.transport,
    modelFactory: () => {
      expect(currentDiagnosticContext().suppressProviderBodies).toBe(true);
      return new MockLanguageModelV4({
        doGenerate: async (options) => {
          expect(options.tools ?? []).toHaveLength(0);
          prompts.push(JSON.stringify(options.prompt));
          await onGenerate?.();
          return {
            content: [{ type: "text", text: "## Report\n\nExternal facts." }],
            finishReason: { unified: "stop", raw: undefined },
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
    },
  };
  const run = async () => {
    const row = await f.db.scheduledTaskRun.create({
      data: { taskId: task.id, trigger: "manual" },
    });
    await executeScheduledTaskRun(deps, row.id);
    return f.db.scheduledTaskRun.findUniqueOrThrow({ where: { id: row.id } });
  };
  return {
    ...f,
    task,
    definition,
    deps,
    prompts,
    run,
    onGenerate: (callback: () => Promise<void>) => {
      onGenerate = callback;
    },
  };
}

describe("scheduled report external inputs", () => {
  beforeEach(resetDb);
  it("persists ordered inputs, preserves omitted and unchanged IDs, clears explicit empty inputs", async () => {
    const f = await fixture(2);
    expect(f.task.externalInputs).toEqual(f.definition.externalInputs);
    const saved = await f.db.scheduledTaskExternalInput.findMany({
      where: { taskId: f.task.id },
      orderBy: { position: "asc" },
    });
    expect(saved).toHaveLength(2);
    const { externalInputs: _inputs, ...legacy } = f.definition;
    await updateTask(f.db, f.owner, { taskId: f.task.id, ...legacy });
    await updateTask(f.db, f.owner, { taskId: f.task.id, ...f.definition });
    expect(
      (
        await f.db.scheduledTaskExternalInput.findMany({
          where: { taskId: f.task.id },
          orderBy: { position: "asc" },
        })
      ).map((i) => i.id),
    ).toEqual(saved.map((i) => i.id));
    await updateTask(f.db, f.owner, {
      taskId: f.task.id,
      ...legacy,
      externalInputs: [],
    });
    expect(await f.db.scheduledTaskExternalInput.count()).toBe(0);
  });
  it("publishes one completion with fixed-period inputs and deterministic provenance", async () => {
    const f = await fixture(2);
    f.calls.content = [{ type: "text", text: "Remote facts" }];
    const run = await f.run();
    expect(run.status).toBe("succeeded");
    expect(f.calls.tools).toEqual(["read", "read"]);
    expect(f.calls.arguments[0]).toEqual(f.calls.arguments[1]);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain("Remote facts");
    expect(run.contextSummary).toMatchObject({
      externalInputs: [{ status: "completed" }, { status: "completed" }],
    });
    const doc = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: run.outputDocumentId! },
      f.owner,
    );
    const markdown = serializeDocumentBody(markdownContent(doc));
    expect(markdown).toContain("External sources");
    const calls = await f.db.externalMcpCall.findMany();
    for (const call of calls) expect(markdown).toContain(call.id);
  });
  it.each([1, 2])(
    "stops at required input failure %i and preserves the previous report",
    async (failedAt) => {
      const f = await fixture(2);
      const previous = await f.run();
      const modelCalls = f.prompts.length;
      f.calls.tools = [];
      f.calls.onCall = async () => {
        f.calls.toolError = f.calls.tools.length === failedAt;
      };
      const failed = await f.run();
      expect(failed).toMatchObject({
        status: "failed",
        errorCode: "EXTERNAL_TOOL_ERROR",
        outputDocumentId: null,
      });
      expect(f.calls.tools).toHaveLength(failedAt);
      expect(f.prompts).toHaveLength(modelCalls);
      expect(
        (failed.contextSummary as { externalInputs: unknown[] }).externalInputs,
      ).toHaveLength(failedAt);
      expect(
        (
          await f.db.scheduledTask.findUniqueOrThrow({
            where: { id: f.task.id },
          })
        ).outputDocumentId,
      ).toBe(previous.outputDocumentId);
    },
  );
  it("rechecks the connection after generation and does not publish", async () => {
    const f = await fixture();
    f.onGenerate(async () => {
      await f.db.externalMcpConnection.update({
        where: { id: f.connectionId },
        data: { enabled: false },
      });
    });
    const run = await f.run();
    expect(run.status).toBe("failed");
    expect(run.outputDocumentId).toBeNull();
    expect(await f.db.document.count()).toBe(0);
  });
  it("admits duplicate workers once and locks active external definitions", async () => {
    const f = await fixture();
    const run = await f.db.scheduledTaskRun.create({
      data: { taskId: f.task.id, trigger: "manual" },
    });
    await expect(
      updateTask(f.db, f.owner, { taskId: f.task.id, ...f.definition }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await Promise.all([
      executeScheduledTaskRun(f.deps, run.id),
      executeScheduledTaskRun(f.deps, run.id),
    ]);
    expect(f.calls.tools).toEqual(["read"]);
    expect(f.prompts).toHaveLength(1);
    expect(
      await leaseTaskRun(f.db, {
        runId: run.id,
        workerId: "duplicate",
        leaseMs: 60000,
      }),
    ).toBeNull();
  });
});

it("retains immutable call identity while replacing/removing completed inputs", async () => {
  await resetDb();
  const f = await fixture();
  await f.run();
  const first = await f.db.externalMcpCall.findFirstOrThrow();
  await updateTask(f.db, f.owner, {
    taskId: f.task.id,
    ...f.definition,
    externalInputs: [{ ...f.definition.externalInputs[0]!, arguments: {} }],
  });
  const replacement = await f.db.scheduledTaskExternalInput.findFirstOrThrow();
  expect(replacement.id).not.toBe(first.inputSnapshotId);
  expect(
    await f.db.externalMcpCall.findUniqueOrThrow({ where: { id: first.id } }),
  ).toMatchObject({
    inputId: null,
    inputSnapshotId: first.inputSnapshotId,
    status: "completed",
  });
  await f.run();
  await updateTask(f.db, f.owner, {
    taskId: f.task.id,
    ...f.definition,
    externalInputs: [],
  });
  expect(await f.db.externalMcpCall.count({ where: { inputId: null } })).toBe(
    2,
  );
  await deleteTask(f.db, f.owner, f.task.id);
  expect(await f.db.scheduledTask.count()).toBe(0);
});
it.each([
  ["UNAUTHORIZED", "EXTERNAL_AUTH_FAILED"],
  ["TRANSPORT_ERROR", "EXTERNAL_UNAVAILABLE"],
  ["CANCELLED", "EXTERNAL_TIMEOUT"],
  ["FORBIDDEN", "EXTERNAL_FORBIDDEN"],
  ["UNSUPPORTED_PROTOCOL", "EXTERNAL_UNSUPPORTED_PROTOCOL"],
  ["RESPONSE_TOO_LARGE", "EXTERNAL_RESPONSE_TOO_LARGE"],
  ["TOOL_CHANGED", "EXTERNAL_TOOL_CHANGED"],
  ["INVALID_RESULT", "EXTERNAL_INVALID_RESULT"],
] as const)(
  "maps transport %s without publishing or replay",
  async (remote, expected) => {
    await resetDb();
    const f = await fixture();
    f.calls.callError = new ExternalMcpError(remote);
    const failed = await f.run();
    expect(failed.errorCode).toBe(expected);
    expect(failed.contextSummary).toMatchObject({
      externalInputs: [
        { status: "failed", outcome: "unknown", errorCode: expected },
      ],
    });
    expect(f.prompts).toHaveLength(0);
    expect(await f.db.externalMcpCall.findFirstOrThrow()).toMatchObject({
      status: "unknown",
      dispatchedAt: expect.any(Date),
      errorCode: expected,
    });
  },
);
it("uses UTF-8 shares including framing and fails if required framing cannot fit", async () => {
  await resetDb();
  const f = await fixture(2);
  f.calls.content = [{ type: "text", text: "😀漢字".repeat(1000) }];
  async function fetchInputs(budgetBytes: number) {
    const row = await f.db.scheduledTaskRun.create({
      data: { taskId: f.task.id, trigger: "manual" },
    });
    const leased = (await leaseTaskRun(f.db, {
      runId: row.id,
      workerId: "budget",
      leaseMs: 60000,
    }))!;
    const actor = createTaskSecurityContext({
      userId: f.owner.userId,
      globalRole: "User",
      runId: row.id,
    });
    return {
      row,
      result: fetchTaskExternalInputs(
        {
          db: f.db,
          ring: f.ring,
          transport: f.transport,
          now: () => new Date(),
        },
        actor,
        {
          runId: row.id,
          scope: leased.task.scopeSnapshot,
          outputProjectId: f.project.id,
          inputs: leased.task.externalInputs,
          period: {
            start: "2026-09-08T00:00:00.000Z",
            end: "2026-09-09T00:00:00.000Z",
          },
          budgetBytes,
          signal: new AbortController().signal,
        },
      ),
    };
  }
  const promptInput = {
    taskName: "Report",
    instruction: "Summarize",
    digest: "Digest",
    content: "Content",
    period: { from: null, to: new Date("2026-09-09T00:00:00.000Z") },
    truncated: false,
  };
  const contributionBytes = (blocks: string[]) =>
    Buffer.byteLength(
      buildTaskPrompt({ ...promptInput, externalBlocks: blocks }),
    ) - Buffer.byteLength(buildTaskPrompt(promptInput));
  const first = await fetchInputs(1600);
  const result = await first.result;
  expect(contributionBytes(result.blocks)).toBeLessThanOrEqual(1600);
  expect(result.blocks[0]).toContain("[truncated]");
  expect(result.blocks[0]).not.toContain("�");
  expect(result.sources[0]?.truncated).toBe(true);
  await f.db.scheduledTaskRun.update({
    where: { id: first.row.id },
    data: { status: "failed" },
  });
  f.calls.content = [{ type: "text", text: "Exact boundary" }];
  const measured = await fetchInputs(5000);
  const measuredResult = await measured.result;
  const exactBudget = measuredResult.blocks.reduce(
    (bytes, block) => bytes + Buffer.byteLength(block),
    0,
  );
  await f.db.scheduledTaskRun.update({
    where: { id: measured.row.id },
    data: { status: "failed" },
  });
  const exact = await fetchInputs(exactBudget);
  const exactResult = await exact.result;
  expect(exactResult.sources.every((source) => !source.truncated)).toBe(true);
  expect(contributionBytes(exactResult.blocks)).toBe(exactBudget);
  await f.db.scheduledTaskRun.update({
    where: { id: exact.row.id },
    data: { status: "failed" },
  });
  const second = await fetchInputs(10);
  await expect(second.result).rejects.toMatchObject({
    code: "EXTERNAL_CONTEXT_LIMIT",
  });
});
it("rejects malformed saved bindings before dispatch", async () => {
  await resetDb();
  const f = await fixture();
  await f.db.scheduledTaskExternalInput.updateMany({
    where: { taskId: f.task.id },
    data: { argumentBindings: { from: { kind: "bad" } } },
  });
  const run = await f.run();
  expect(run.errorCode).toBe("EXTERNAL_INPUT_INVALID");
  expect(f.calls.tools).toHaveLength(0);
});

it("validates read policy, unique names, cap, and owner flags at definition time", async () => {
  await resetDb();
  const f = await fixture();
  for (const externalInputs of [
    [{ name: "write", toolId: f.writeId, arguments: {} }],
    Array.from({ length: 6 }, (_, i) => ({
      name: `Input ${i}`,
      toolId: f.readId,
      arguments: {},
    })),
    [
      { name: "same", toolId: f.readId, arguments: {} },
      { name: "SAME", toolId: f.readId, arguments: {} },
    ],
  ]) {
    await expect(
      createTask(f.db, f.owner, { ...f.definition, externalInputs }),
    ).rejects.toBeDefined();
  }
  await f.db.user.update({
    where: { id: f.owner.userId },
    data: { mustChangePassword: true },
  });
  await expect(createTask(f.db, f.owner, f.definition)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
it("accepts the owner's read tools and refuses other users' tools", async () => {
  await resetDb();
  const f = await fixture();
  await expect(
    createTask(f.db, f.owner, { ...f.definition, name: "Second report" }),
  ).resolves.toBeDefined();
  await f.db.externalMcpConnection.update({
    where: { id: f.connectionId },
    data: { ownerId: f.viewer.userId },
  });
  await expect(
    createTask(f.db, f.owner, { ...f.definition, name: "Third report" }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});
it("does not shrink a saved external scope after source access is lost", async () => {
  await resetDb();
  const f = await fixture();
  const { makeProject, addMembership } = await import("./_harness");
  const source = await makeProject("Additional external source");
  await addMembership(source.id, f.owner.userId, "Viewer");
  await updateTask(f.db, f.owner, {
    ...f.definition,
    taskId: f.task.id,
    scope: { kind: "projects", projectIds: [f.project.id, source.id] },
  });
  await f.db.member.deleteMany({
    where: {
      userId: f.owner.userId,
      organizationId: (
        await f.db.project.findUniqueOrThrow({ where: { id: source.id } })
      ).organizationId,
    },
  });
  const failed = await f.run();
  expect(failed.errorCode).toBe("EXTERNAL_AUTH_FAILED");
  expect(f.calls.tools).toHaveLength(0);
  expect(f.prompts).toHaveLength(0);
});
it("captures contiguous external periods across successful reports", async () => {
  await resetDb();
  const f = await fixture();
  const first = await f.run();
  await f.run();
  expect(f.calls.arguments[1]?.from).toBe(f.calls.arguments[0]?.to);
  expect(first.contextSummary).toMatchObject({
    period: { end: f.calls.arguments[0]?.to },
  });
});
it("rejects literal type and format violations against the reviewed schema", async () => {
  await resetDb();
  const f = await fixture();
  const { canonicalDigest } = await import("@weaver/core/externalMcp/digest");
  const definition = {
    name: "read",
    inputSchema: {
      type: "object",
      required: ["from", "limit"],
      properties: {
        from: { type: "string", format: "date-time" },
        limit: { type: "integer" },
      },
    },
    supportStatus: { available: true as const },
  };
  const digest = canonicalDigest(definition);
  await f.db.externalMcpTool.update({
    where: { id: f.readId },
    data: {
      reviewedDefinition: definition,
      reviewedRemoteDigest: digest,
      discoveredRemoteDigest: digest,
      reviewDigest: canonicalDigest({ remoteDigest: digest, effect: "read" }),
    },
  });
  for (const argumentsValue of [
    {
      from: { kind: "literal" as const, value: "not-a-date" },
      limit: { kind: "literal" as const, value: 1 },
    },
    {
      from: { kind: "period_start" as const },
      limit: { kind: "literal" as const, value: "one" },
    },
  ]) {
    await expect(
      createTask(f.db, f.owner, {
        ...f.definition,
        externalInputs: [
          { name: "Typed", toolId: f.readId, arguments: argumentsValue },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  const valid = await createTask(f.db, f.owner, {
    ...f.definition,
    externalInputs: [
      {
        name: "Typed",
        toolId: f.readId,
        arguments: {
          from: { kind: "period_start" },
          limit: { kind: "literal", value: 10 },
        },
      },
    ],
  });
  expect(valid.externalInputs).toHaveLength(1);
});

it("redacts arbitrary external-context echoes from provider failure summaries", async () => {
  await resetDb();
  const f = await fixture();
  f.onGenerate(async () => {
    throw new (await import("@weaver/core/errors")).CoreError(
      "INTERNAL_SERVER_ERROR",
      "external-sensitive-sentinel",
    );
  });
  const failed = await f.run();
  expect(failed.errorCode).toBe("PROVIDER_ERROR");
  expect(JSON.stringify(failed)).not.toContain("external-sensitive-sentinel");
});

it("includes commits after a captured period end in the next report digest", async () => {
  await resetDb();
  const f = await fixture();
  f.calls.onCall = async () => {
    if (f.calls.tools.length !== 1) return;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { createDocument } = await import("@weaver/core/services/documents");
    const { parseDocumentBody } = await import("@weaver/core/editor/markdown");
    await createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        title: "During external fetch",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("A later fact"),
        },
      },
      { ...f.owner, name: "Owner", email: "owner@example.test" },
    );
  };
  await f.run();
  await f.run();
  expect(f.prompts[1]?.match(/During external fetch/g)?.length).toBe(2);
});

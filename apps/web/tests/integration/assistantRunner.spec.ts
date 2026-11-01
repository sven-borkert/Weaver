import * as citationValidation from "@weaver/core/assistant/citations";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
} from "@weaver/core/diagnostics/writer";
import { withDiagnosticContext } from "@weaver/core/diagnostics/context";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  createConversation,
  getConversation,
} from "@weaver/core/services/assistantConversations";
import {
  ASSISTANT_LEASE_MS,
  listRunEvents,
  reconcileAssistantRuns,
  requestRunCancel,
  submitUserMessage,
} from "@weaver/core/services/assistantRuns";
import {
  invalidateDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import { createDocument } from "@weaver/core/services/documents";
import { getConversationUsage } from "@weaver/core/services/assistantUsage";
import {
  createFolder,
  listContentFolders,
} from "@weaver/core/services/folders";
import { getDiagnosticEvent } from "@weaver/core/services/diagnosticEvents";
import { createExam } from "@weaver/core/services/exams";
import {
  startAttempt,
  submitAttempt,
  getOwnAttempt,
} from "@weaver/core/services/examAttempts";
import { executeAssistantRun } from "@weaver/ai/runner";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
  testEncryptionKeys,
} from "./_harness";

const finish = (reason: "stop" | "tool-calls" | "length") => ({
  type: "finish" as const,
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

function scriptedModel(steps: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: steps[Math.min(call++, steps.length - 1)]!,
      }) as never,
    }),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function holdTransactionResult(
  db: ReturnType<typeof getPrisma>,
  matches: (result: unknown) => boolean,
) {
  const reached = deferred();
  const release = deferred();
  let held = false;
  const transaction = db.$transaction.bind(db) as unknown as (
    input: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  vi.spyOn(db, "$transaction").mockImplementation(((
    input: unknown,
    options?: unknown,
  ) => {
    return transaction(input, options).then(async (result) => {
      if (!held && matches(result)) {
        held = true;
        reached.resolve();
        await release.promise;
      }
      return result;
    });
  }) as typeof db.$transaction);
  return { reached: reached.promise, release: release.resolve };
}

function providerFailureModel(retryable: boolean) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new APICallError({
        message: retryable ? "HTTP 503" : "HTTP 400",
        url: "https://ai.test",
        requestBodyValues: {},
        statusCode: retryable ? 503 : 400,
        isRetryable: retryable,
      });
    },
  });
}

/** A provider stream that emits one delta and then hangs until it is aborted. */
function stallingModel(onAbort?: () => void) {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({
            type: "text-delta",
            id: "t1",
            delta: "thinking",
          });
          abortSignal?.addEventListener("abort", () => {
            onAbort?.();
            controller.error(abortSignal.reason);
          });
        },
      }) as never,
    }),
  });
}

async function waitUntilRunning(
  db: ReturnType<typeof getPrisma>,
  runId: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const row = await db.assistantRun.findUniqueOrThrow({
      where: { id: runId },
    });
    if (row.status === "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run never reached the running status");
}

async function createRealProviderMock(): Promise<Server> {
  const moduleUrl = new URL("../e2e/mock-ai-server.mjs", import.meta.url);
  const loaded = (await import(/* @vite-ignore */ moduleUrl.href)) as {
    createMockAiServer: () => Server;
  };
  return loaded.createMockAiServer();
}

async function fixture(suffix: string) {
  const db = getPrisma();
  const user = await makeUser("User", suffix);
  const project = await makeProject(`Runner ${suffix}`);
  await addMembership(project.id, user.id, "Editor");
  const actor = {
    ...securityContextFor(user),
    name: `Runner ${suffix}`,
    email: user.email,
  };
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Facts",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("# Facts\n\nThe sky is blue.\n"),
      },
    },
    actor,
  );
  const conversation = await createConversation(db, actor, {});
  const { run } = await submitUserMessage(db, actor, {
    conversationId: conversation.id,
    text: "What colour is the sky?",
    scope: { kind: "project", projectId: project.id },
  });
  return { db, user, project, actor, doc, conversation, run };
}

async function enableRunnerDiagnostics(suffix: string): Promise<void> {
  const admin = await makeUser("Admin", suffix);
  await setDiagnosticsSettings(getPrisma(), securityContextFor(admin), {
    level: "standard",
  });
  startDiagnosticWriter({
    db: getPrisma(),
    runtime: "worker",
    flushIntervalMs: 60_000,
  });
}

async function attemptTerminalEvents(runId: string): Promise<string[]> {
  await flushDiagnostics(true);
  const rows = await getPrisma().diagnosticEvent.findMany({
    where: {
      runId,
      event: {
        in: [
          "assistant.attempt.succeeded",
          "assistant.attempt.failed",
          "assistant.attempt.cancelled",
          "assistant.attempt.abandoned",
        ],
      },
    },
    select: { event: true },
  });
  return rows.map((row) => row.event);
}

describe("assistant runner", () => {
  const queue = new FakeJobQueue();
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
    queue.jobs.length = 0;
    setJobQueueForTests(queue);
  });

  afterEach(async () => {
    await stopDiagnosticWriter();
    invalidateDiagnosticsSettingsCache();
    setJobQueueForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["known", "legacy"] as const)(
    "protects provider bodies across project scopes with %s history lineage",
    async (lineage) => {
      await seedTestLlmRouting();
      const {
        db,
        actor,
        conversation,
        run,
        project: projectA,
      } = await fixture(`diagnostic-lineage-${lineage}`);
      const privateAnswer = "PROJECT_A_CONTEXT_SENTINEL";
      await executeAssistantRun(
        {
          db,
          ring: testEncryptionKeys(),
          workerId: "lineage-first",
          modelFactory: () =>
            scriptedModel([
              [
                { type: "text-start", id: "first" },
                { type: "text-delta", id: "first", delta: privateAnswer },
                { type: "text-end", id: "first" },
                finish("stop"),
              ],
            ]),
        },
        run.id,
      );
      const firstAnswer = (
        await getConversation(db, actor, conversation.id)
      ).messages.at(-1)!;
      expect(firstAnswer.contextProjectIds).toEqual([projectA.id]);
      if (lineage === "legacy") {
        await db.assistantMessage.update({
          where: { id: firstAnswer.id },
          data: { content: { text: privateAnswer } },
        });
      }
      const projectB = await makeProject(`Diagnostic follow-up ${lineage}`);
      await addMembership(projectB.id, actor.userId, "Editor");
      const admin = await makeUser("Admin", `lineage-reader-${lineage}`);
      const reader = securityContextFor(admin);
      await addMembership(projectB.id, admin.id, "Viewer");
      await setDiagnosticsSettings(db, reader, { level: "verbose" });
      startDiagnosticWriter({ db, runtime: "worker", flushIntervalMs: 60_000 });
      const { run: followup } = await submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "Use the earlier answer in this project.",
        scope: { kind: "project", projectId: projectB.id },
      });
      const requests: string[] = [];
      await executeAssistantRun(
        {
          db,
          ring: testEncryptionKeys(),
          workerId: "lineage-followup",
          fetchImpl: async (_input, init) => {
            if (typeof init?.body !== "string")
              throw new Error("Expected a serialized provider request");
            requests.push(init.body);
            const chunk = {
              id: "lineage-response",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-extraction",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: privateAnswer },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            };
            return new Response(
              `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          },
        },
        followup.id,
      );
      await flushDiagnostics(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(privateAnswer);
      expect(
        (await listRunEvents(db, actor, { runId: followup.id, after: -1 }))
          .status,
      ).toBe("completed");
      const row = await db.diagnosticEvent.findFirstOrThrow({
        where: { runId: followup.id, event: "ai.request" },
      });
      expect(row.projectId).toBe(projectB.id);
      if (lineage === "legacy") {
        expect(row).toMatchObject({
          bodyProjectIds: null,
          hasRequestBody: false,
          hasResponseBody: false,
          requestBody: null,
          responseBody: null,
        });
        expect(JSON.stringify(row)).not.toContain(privateAnswer);
        return;
      }
      expect(row.bodyProjectIds).toEqual([projectB.id, projectA.id]);
      for (const body of ["request", "response"] as const) {
        await expect(
          getDiagnosticEvent(db, reader, { id: row.id, body }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      expect(
        await getDiagnosticEvent(db, reader, { id: row.id }),
      ).toMatchObject({ body: null });
      await addMembership(projectA.id, admin.id, "Viewer");
      await db.assistantConversation.delete({ where: { id: conversation.id } });
      for (const body of ["request", "response"] as const) {
        const text = (
          await getDiagnosticEvent(db, reader, { id: row.id, body })
        ).body?.text;
        expect(typeof text).toBe("string");
        // Tool schemas may exceed the bounded request capture; responses carry the sentinel.
        if (body === "response") expect(text).toContain(privateAnswer);
      }
      await db.member.deleteMany({
        where: {
          userId: admin.id,
          organization: { project: { id: projectA.id } },
        },
      });
      for (const body of ["request", "response"] as const) {
        await expect(
          getDiagnosticEvent(db, reader, { id: row.id, body }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    },
  );

  it("persists an explicit notice when the provider output is truncated", async () => {
    await seedTestLlmRouting();
    const { db, actor, conversation, run } = await fixture("output-limit");
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "limit",
        modelFactory: () => scriptedModel([[finish("length")]]),
      },
      run.id,
    );
    expect(
      (await getConversation(db, actor, conversation.id)).messages.at(-1)?.text,
    ).toContain("output limit");
  });

  it("does not invent a provider call when prompt admission fails", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("no-provider-call");
    await db.llmModel.updateMany({ data: { contextWindow: 16 } });
    const modelFactory = vi.fn(() => scriptedModel([[finish("stop")]]));
    await executeAssistantRun(
      { db, ring: testEncryptionKeys(), workerId: "no-call", modelFactory },
      run.id,
    );
    expect(modelFactory).not.toHaveBeenCalled();
    expect(await db.aiUsage.count({ where: { runId: run.id } })).toBe(0);
  });
  it("retains billed usage from a completed tool step when a later provider step fails", async () => {
    await seedTestLlmRouting();
    const { db, run, actor } = await fixture("partial-usage");
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "partial-usage",
        modelFactory: () =>
          scriptedModel([
            [
              { type: "text-start", id: "intro" },
              { type: "text-delta", id: "intro", delta: "Checking projects." },
              { type: "text-end", id: "intro" },
              {
                type: "tool-call",
                toolCallId: "projects",
                toolName: "list_projects",
                input: "{}",
              },
              finish("tool-calls"),
            ],
            [{ type: "error", error: new Error("later step failed") }],
          ]),
      },
      run.id,
    );
    expect(
      await db.aiUsage.findFirst({ where: { runId: run.id } }),
    ).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      outcome: "provider_failure",
    });
    const { events } = await listRunEvents(db, actor, {
      runId: run.id,
      after: -1,
    });
    const textIndex = events.findIndex((event) => event.type === "text.delta");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeLessThan(
      events.findIndex((event) => event.type === "tool.call"),
    );
  });

  it("executes a tool-using run: events, citations, assistant message, usage row, route snapshot", async () => {
    await seedTestLlmRouting({
      pricing: { input: 1_000_000, output: 2_000_000, currency: "USD" },
    });
    const { db, actor, project, doc, conversation, run } = await fixture("ok");
    const model = scriptedModel([
      [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_document",
          input: JSON.stringify({ projectId: project.id, documentId: doc.id }),
        },
        finish("tool-calls"),
      ],
      [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "The sky is " },
        { type: "text-delta", id: "t1", delta: "blue." },
        { type: "text-end", id: "t1" },
        finish("stop"),
      ],
    ]);
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-test",
        modelFactory: () => model,
        heartbeatMs: 50,
      },
      run.id,
    );

    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("completed");
    expect(page.events.map((e) => e.type)).toEqual([
      "run.queued",
      "run.started",
      "tool.call",
      "tool.result",
      "text.delta",
      "usage",
      "citation",
      "run.completed",
    ]);
    const detail = await getConversation(db, actor, conversation.id);
    expect(detail.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "What colour is the sky?"],
      ["assistant", "The sky is blue."],
    ]);
    expect(detail.messages[1]!.citationIds).toHaveLength(1);
    const citation = await db.assistantCitation.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(citation).toMatchObject({
      kind: "document",
      resourceId: doc.id,
      commitSha: doc.headCommitSha,
      label: "Facts",
    });
    const usage = await db.aiUsage.findFirstOrThrow({
      where: { runId: run.id },
    });
    expect(usage).toMatchObject({
      operation: "assistant.run",
      outcome: "success",
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(usage.connectionId).not.toBeNull();
    const row = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(row.routeSnapshot).toMatchObject({
      providerModelId: "test-extraction",
      promptVersion: "assistant-v2",
    });
    expect(JSON.stringify(row.routeSnapshot)).not.toContain("test-key");
  });

  it("replays an earlier tool-using turn to the model as a tool call and result", async () => {
    await seedTestLlmRouting();
    const { db, actor, project, doc, conversation, run } =
      await fixture("replay");
    const deps = {
      db,
      ring: testEncryptionKeys(),
      workerId: "w-test",
      heartbeatMs: 50,
    };
    const first = scriptedModel([
      [
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "Let me read it. 🙂" },
        { type: "text-end", id: "t0" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_document",
          input: JSON.stringify({ projectId: project.id, documentId: doc.id }),
        },
        finish("tool-calls"),
      ],
      [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "The sky is blue." },
        { type: "text-end", id: "t1" },
        finish("stop"),
      ],
    ]);
    await executeAssistantRun({ ...deps, modelFactory: () => first }, run.id);
    const { run: followup } = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "And grass?",
      scope: { kind: "project", projectId: project.id },
    });
    const second = scriptedModel([
      [
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "Green." },
        { type: "text-end", id: "t2" },
        finish("stop"),
      ],
    ]);
    await executeAssistantRun(
      { ...deps, modelFactory: () => second },
      followup.id,
    );
    const prompt = second.doStreamCalls[0]!.prompt.filter(
      (m) => m.role !== "system",
    );
    expect(prompt.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(prompt[1]!.content).toMatchObject([
      { type: "text", text: "Let me read it. 🙂" },
      {
        type: "tool-call",
        toolName: "read_document",
        input: { projectId: project.id, documentId: doc.id },
      },
    ]);
    expect(JSON.stringify(prompt[2])).toContain("not kept in the conversation");
    expect(JSON.stringify(prompt[3])).toContain("The sky is blue.");

    const usage = await getConversationUsage(db, actor, conversation.id);
    expect(usage.model).toBe("test-extraction");
    expect(usage.totals).toMatchObject({ replies: 2, toolCalls: 1 });
    expect(usage.totals.inputTokens).toBeGreaterThan(0);
    expect(usage.runs[run.id]).toMatchObject({
      model: "test-extraction",
      toolCalls: 1,
    });
    expect(usage.runs[followup.id]).toMatchObject({ toolCalls: 0 });
    const outsider = securityContextFor(await makeUser("User", "usage-out"));
    await expect(
      getConversationUsage(db, outsider, conversation.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("tells the model about a folder focus and refuses a folder that does not exist", async () => {
    await seedTestLlmRouting();
    const { db, actor, project, conversation, run } = await fixture("folder");
    const settle = scriptedModel([
      [
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "Blue." },
        { type: "text-end", id: "t0" },
        finish("stop"),
      ],
    ]);
    const deps = {
      db,
      ring: testEncryptionKeys(),
      workerId: "w-test",
      heartbeatMs: 50,
    };
    await executeAssistantRun({ ...deps, modelFactory: () => settle }, run.id);
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Specs" },
      actor,
    );
    const folderPath = (
      await listContentFolders(
        db,
        { projectId: project.id, resourceType: "document" },
        actor,
      )
    ).folders[0]!.path;
    await expect(
      submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "Nope",
        scope: {
          kind: "folder",
          projectId: project.id,
          resourceType: "document",
          folderPath: ["missing"],
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { run: focused } = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "List it",
      scope: {
        kind: "folder",
        projectId: project.id,
        resourceType: "document",
        folderPath,
      },
    });
    const model = scriptedModel([
      [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Empty." },
        { type: "text-end", id: "t1" },
        finish("stop"),
      ],
    ]);
    await executeAssistantRun(
      { ...deps, modelFactory: () => model },
      focused.id,
    );
    const system = JSON.stringify(
      model.doStreamCalls[0]!.prompt.filter((m) => m.role === "system"),
    );
    expect(system).toContain(
      "restricted this conversation to the documents folder",
    );
    expect(system).toContain(folderPath[0]);
    const row = await db.assistantRun.findUniqueOrThrow({
      where: { id: focused.id },
    });
    expect(row.scopeSnapshot).toMatchObject({
      kind: "folder",
      projectIds: [project.id],
      folderPath,
      folderResourceType: "document",
    });
  });

  it("keeps a completed transition as the sole attempt terminal when usage persistence fails", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("usage-failure-terminal");
    await enableRunnerDiagnostics("usage-failure-terminal-admin");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db.aiUsage, "upsert").mockRejectedValueOnce(
      new Error("usage persistence unavailable"),
    );

    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-usage-failure",
        modelFactory: () => scriptedModel([[finish("stop")]]),
      },
      run.id,
    );

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "completed",
      attempts: [{ status: "succeeded" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.succeeded",
    ]);
  });

  it("does not abandon a completed attempt while usage persistence is still settling", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("heartbeat-terminal");
    await enableRunnerDiagnostics("heartbeat-terminal-admin");
    const usageStarted = deferred();
    const releaseUsage = deferred();
    const heartbeatObserved = deferred();
    const createUsage = db.aiUsage.upsert.bind(db.aiUsage);
    vi.spyOn(db.aiUsage, "upsert").mockImplementation((args) => {
      if (args.update.outcome !== "success") return createUsage(args);
      const delayed = (async () => {
        usageStarted.resolve();
        await releaseUsage.promise;
        return createUsage(args);
      })();
      return delayed as unknown as ReturnType<typeof createUsage>;
    });
    const updateAttempt = db.assistantRunAttempt.updateMany.bind(
      db.assistantRunAttempt,
    );
    vi.spyOn(db.assistantRunAttempt, "updateMany").mockImplementation(
      (args) => {
        const observed = (async () => {
          const result = await updateAttempt(args);
          if (result.count === 0)
            setTimeout(() => heartbeatObserved.resolve(), 0);
          return result;
        })();
        return observed as unknown as ReturnType<typeof updateAttempt>;
      },
    );

    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-heartbeat-terminal",
        heartbeatMs: 1,
        modelFactory: () => scriptedModel([[finish("stop")]]),
      },
      run.id,
    );
    await usageStarted.promise;
    expect(
      await db.aiUsage.findFirst({ where: { runId: run.id } }),
    ).toMatchObject({ outcome: "success" });
    await heartbeatObserved.promise;
    releaseUsage.resolve();
    await execution;

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "completed",
      attempts: [{ status: "succeeded" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.succeeded",
    ]);
  });

  it("lets a committed completion win when shutdown arrives while completeRun is awaited", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("shutdown-during-complete");
    await enableRunnerDiagnostics("shutdown-during-complete-admin");
    const completion = holdTransactionResult(
      db,
      (result) =>
        typeof result === "object" && result !== null && "messageId" in result,
    );
    const shutdown = new AbortController();

    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-shutdown-during-complete",
        modelFactory: () => scriptedModel([[finish("stop")]]),
      },
      run.id,
      shutdown.signal,
    );
    await completion.reached;
    shutdown.abort();
    completion.release();
    await execution;

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "completed",
      attempts: [{ status: "succeeded" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.succeeded",
    ]);
  });

  it("lets a committed failure win when shutdown arrives while failRunAttempt is awaited", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("shutdown-during-failure");
    await enableRunnerDiagnostics("shutdown-during-failure-admin");
    const failure = holdTransactionResult(
      db,
      (result) =>
        typeof result === "object" &&
        result !== null &&
        "transitioned" in result,
    );
    const shutdown = new AbortController();

    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-shutdown-during-failure",
        modelFactory: () => providerFailureModel(false),
      },
      run.id,
      shutdown.signal,
    );
    await failure.reached;
    shutdown.abort();
    failure.release();
    await execution;

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "failed",
      attempts: [{ status: "failed" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.failed",
    ]);
  });

  it("keeps a committed retry failure terminal while dispatch and a lost heartbeat overlap", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("heartbeat-during-retry-dispatch");
    await enableRunnerDiagnostics("heartbeat-during-retry-dispatch-admin");
    queue.jobs.length = 0;
    const dispatchStarted = deferred();
    const releaseDispatch = deferred();
    const heartbeatObserved = deferred();
    const send = queue.send.bind(queue);
    vi.spyOn(queue, "send").mockImplementation(async (...args) => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return send(...args);
    });
    const updateAttempt = db.assistantRunAttempt.updateMany.bind(
      db.assistantRunAttempt,
    );
    vi.spyOn(db.assistantRunAttempt, "updateMany").mockImplementation(
      (args) => {
        const observed = (async () => {
          const result = await updateAttempt(args);
          if (result.count === 0) heartbeatObserved.resolve();
          return result;
        })();
        return observed as unknown as ReturnType<typeof updateAttempt>;
      },
    );

    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-heartbeat-during-retry-dispatch",
        heartbeatMs: 1,
        modelFactory: () => providerFailureModel(true),
      },
      run.id,
    );
    await dispatchStarted.promise;
    await heartbeatObserved.promise;
    releaseDispatch.resolve();
    await execution;

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "queued",
      attempts: [{ status: "failed" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.failed",
    ]);
  });

  it("emits the committed retry failure before rethrowing the dispatch error identity", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("retry-dispatch-failure");
    await enableRunnerDiagnostics("retry-dispatch-failure-admin");
    queue.jobs.length = 0;
    const dispatchError = new Error("retry dispatch unavailable");
    vi.spyOn(queue, "send").mockRejectedValueOnce(dispatchError);

    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-retry-dispatch-failure",
        modelFactory: () => providerFailureModel(true),
      },
      run.id,
    );
    await expect(execution).rejects.toBe(dispatchError);

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "queued",
      attempts: [{ status: "failed" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.failed",
    ]);
  });

  it("fails without retry when no assistant route is ready", async () => {
    const { db, actor, run } = await fixture("noroute");
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => scriptedModel([[finish("stop")]]),
      },
      run.id,
    );
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("failed");
    expect(page.events.at(-1)?.payload).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retrying: false,
    });
    expect(queue.jobs.filter((j) => j.name === "assistant.run")).toHaveLength(
      1,
    ); // only the original submit
  });

  it("requeues on a retryable provider failure", async () => {
    await seedTestLlmRouting();
    const { db, actor, run } = await fixture("retry");
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "HTTP 503",
          url: "https://ai.test",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      },
    });
    queue.jobs.length = 0;
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => model,
      },
      run.id,
    );
    expect(
      (await listRunEvents(db, actor, { runId: run.id, after: -1 })).status,
    ).toBe("queued");
    expect(queue.jobs).toEqual([
      { name: "assistant.run", data: { runId: run.id } },
    ]);
  });

  it("persists the network cause and a diagnostic reference when the provider is unreachable", async () => {
    await seedTestLlmRouting();
    await enableRunnerDiagnostics("unreachable-admin");
    const { db, run } = await fixture("unreachable");
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error("outbound endpoint is not allowed"), {
          code: "OUTBOUND_NOT_ALLOWED",
        });
      },
    });
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => model,
      },
      run.id,
    );
    const stored = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, errorCode: true, errorMessage: true },
    });
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(stored.errorMessage).toMatch(
      /^Could not reach the LLM provider: endpoint not allowed by the outbound policy \(WEAVER_OUTBOUND_ALLOWED_ORIGINS\) \[OUTBOUND_NOT_ALLOWED\] \(ref [0-9a-f]{8}\)$/,
    );
    const reference = /\(ref ([0-9a-f]{8})\)$/.exec(stored.errorMessage!)![1]!;
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.failed",
    ]);
    const failed = await db.diagnosticEvent.findFirstOrThrow({
      where: { event: "assistant.attempt.failed", runId: run.id },
    });
    expect(failed.id.startsWith(reference)).toBe(true);
    expect(failed.details).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      reference,
      error: { code: "OUTBOUND_NOT_ALLOWED" },
    });
  });

  // Three terminal paths must stay distinguishable: a user cancel ends the run
  // `cancelled`, a worker shutdown abandons it for the reconciler to requeue, and
  // the run timeout fails it without a retry.

  it("cancels a running run through the heartbeat and aborts the provider stream", async () => {
    await seedTestLlmRouting();
    const { db, actor, run } = await fixture("cancel");
    let aborted = false;
    const model = stallingModel(() => {
      aborted = true;
    });
    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => model,
        heartbeatMs: 25,
        textFlushChars: 1,
      },
      run.id,
    );
    await waitUntilRunning(db, run.id);
    await requestRunCancel(db, actor, run.id);
    await execution;
    expect(aborted).toBe(true);
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("cancelled");
    expect(page.events.at(-1)?.type).toBe("run.cancelled");
  });

  it("ends cancelled, not completed, when the cancel lands mid-answer", async () => {
    await seedTestLlmRouting();
    const { db, actor, conversation, run } = await fixture("cancel-late");
    // The provider answers in full and the stream never observes the abort:
    // the whole reply stays under the 400-char flush threshold, so the first
    // emit that can see `cancelling` comes at the very end of the turn.
    // Completing here would hand back an answer the user cancelled.
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await requestRunCancel(db, actor, run.id);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "The sky is blue." },
              { type: "text-end", id: "t1" },
              finish("stop"),
            ],
          }) as never,
        };
      },
    });

    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => model,
      },
      run.id,
    );

    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("cancelled");
    expect(page.events.at(-1)?.type).toBe("run.cancelled");
    expect(page.events.map((e) => e.type)).not.toContain("run.completed");
    const detail = await getConversation(db, actor, conversation.id);
    expect(detail.messages.map((m) => m.role)).toEqual(["user"]);
    expect(detail.messages[0]!.status).toBe("cancelled");
  });

  it("lets a committed cancellation win when shutdown arrives while cancelRunFromWorker is awaited", async () => {
    await seedTestLlmRouting();
    const { db, actor, run } = await fixture("shutdown-during-cancel");
    await enableRunnerDiagnostics("shutdown-during-cancel-admin");
    const cancellation = holdTransactionResult(
      db,
      (result) =>
        result === undefined ||
        (typeof result === "object" &&
          result !== null &&
          "transitioned" in result),
    );
    const shutdown = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await requestRunCancel(db, actor, run.id);
        return {
          stream: simulateReadableStream({ chunks: [finish("stop")] }) as never,
        };
      },
    });

    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-shutdown-during-cancel",
        modelFactory: () => model,
      },
      run.id,
      shutdown.signal,
    );
    await cancellation.reached;
    shutdown.abort();
    cancellation.release();
    await execution;

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "cancelled",
      attempts: [{ status: "cancelled" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.cancelled",
    ]);
  });

  it("lets a committed cancellation win when its zero-row heartbeat resolves first", async () => {
    await seedTestLlmRouting();
    const { db, actor, run } = await fixture("heartbeat-during-cancel");
    await enableRunnerDiagnostics("heartbeat-during-cancel-admin");
    const cancellation = holdTransactionResult(
      db,
      (result) =>
        result === undefined ||
        (typeof result === "object" &&
          result !== null &&
          "transitioned" in result),
    );
    const heartbeatObserved = deferred();
    const updateAttempt = db.assistantRunAttempt.updateMany.bind(
      db.assistantRunAttempt,
    );
    vi.spyOn(db.assistantRunAttempt, "updateMany").mockImplementation(
      (args) => {
        const observed = (async () => {
          const result = await updateAttempt(args);
          if (result.count === 0)
            setTimeout(() => heartbeatObserved.resolve(), 0);
          return result;
        })();
        return observed as unknown as ReturnType<typeof updateAttempt>;
      },
    );
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await requestRunCancel(db, actor, run.id);
        return {
          stream: simulateReadableStream({ chunks: [finish("stop")] }) as never,
        };
      },
    });

    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-heartbeat-during-cancel",
        heartbeatMs: 1,
        modelFactory: () => model,
      },
      run.id,
    );
    await cancellation.reached;
    await heartbeatObserved.promise;
    cancellation.release();
    await execution;

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "cancelled",
      attempts: [{ status: "cancelled" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.cancelled",
    ]);
  });

  it("publishes a deferred abandon when the pending cancellation did not transition", async () => {
    await seedTestLlmRouting();
    const { db, actor, run } = await fixture("stale-cancel");
    await enableRunnerDiagnostics("stale-cancel-admin");
    const shutdown = new AbortController();
    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w-stale-cancel",
        heartbeatMs: 25,
        modelFactory: () => stallingModel(),
      },
      run.id,
      shutdown.signal,
    );
    await waitUntilRunning(db, run.id);
    await requestRunCancel(db, actor, run.id);
    const cancellation = holdTransactionResult(
      db,
      (result) =>
        result === undefined ||
        (typeof result === "object" &&
          result !== null &&
          "transitioned" in result),
    );
    const heartbeatPrepared = deferred();
    const updateAttempt = db.assistantRunAttempt.updateMany.bind(
      db.assistantRunAttempt,
    );
    vi.spyOn(db.assistantRunAttempt, "updateMany").mockImplementation(
      (args) => {
        const observed = (async () => {
          const result = await updateAttempt(args);
          if (result.count === 1) {
            await updateAttempt({
              where: { runId: run.id, status: "running" },
              data: { status: "abandoned", endedAt: new Date() },
            });
            heartbeatPrepared.resolve();
          }
          return result;
        })();
        return observed as unknown as ReturnType<typeof updateAttempt>;
      },
    );

    await heartbeatPrepared.promise;
    await cancellation.reached;
    shutdown.abort();
    const pendingEvents = await attemptTerminalEvents(run.id);
    cancellation.release();
    await execution;
    expect(pendingEvents).toEqual([]);

    const persisted = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, attempts: { select: { status: true } } },
    });
    expect(persisted).toEqual({
      status: "cancelling",
      attempts: [{ status: "abandoned" }],
    });
    expect(await attemptTerminalEvents(run.id)).toEqual([
      "assistant.attempt.abandoned",
    ]);
  });

  it("abandons the attempt for the reconciler when the worker shuts down mid-run", async () => {
    await seedTestLlmRouting();
    const { db, actor, conversation, run } = await fixture("shutdown");
    const shutdown = new AbortController();
    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => stallingModel(),
      },
      run.id,
      shutdown.signal,
    );
    await waitUntilRunning(db, run.id);
    queue.jobs.length = 0;
    // pg-boss aborts the job signal on graceful shutdown, not on user intent.
    shutdown.abort();
    await execution;

    // Nothing terminal was written: the run is still the leased attempt's.
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("running");
    const types = page.events.map((e) => e.type);
    expect(types).not.toContain("run.cancelled");
    expect(types).not.toContain("run.failed");
    expect(types).not.toContain("run.completed");
    const detail = await getConversation(db, actor, conversation.id);
    expect(detail.messages[0]!.status).toBe("pending");

    // ...so the expired lease is recoverable: the reconciler requeues it.
    const later = new Date(Date.now() + ASSISTANT_LEASE_MS + 1_000);
    expect((await reconcileAssistantRuns(db, later)).abandoned).toBe(1);
    expect(
      (await listRunEvents(db, actor, { runId: run.id, after: -1 })).status,
    ).toBe("queued");
    expect(queue.jobs.filter((j) => j.name === "assistant.run")).toHaveLength(
      1,
    );
  });

  it("keeps the leased diagnostic context when shutdown is triggered by another caller", async () => {
    await seedTestLlmRouting();
    const { db, user, run } = await fixture("shutdown-context");
    await enableRunnerDiagnostics("shutdown-context-admin");
    const shutdown = new AbortController();
    const execution = withDiagnosticContext(
      { jobId: "leased-job", requestId: "leased-request" },
      () =>
        executeAssistantRun(
          {
            db,
            ring: testEncryptionKeys(),
            workerId: "w-shutdown-context",
            modelFactory: () => stallingModel(),
          },
          run.id,
          shutdown.signal,
        ),
    );
    await waitUntilRunning(db, run.id);

    withDiagnosticContext(
      { jobId: "abort-caller-job", requestId: "abort-caller-request" },
      () => shutdown.abort(),
    );
    await execution;
    await flushDiagnostics(true);

    const event = await db.diagnosticEvent.findFirstOrThrow({
      where: { event: "assistant.attempt.abandoned" },
    });
    expect(event).toMatchObject({
      runId: run.id,
      userId: user.id,
      jobId: "leased-job",
      requestId: "leased-request",
      details: { attempt: 1 },
    });
    expect(JSON.stringify(event)).not.toContain("abort-caller");
    expect(event.details).toEqual({ attempt: 1 });
  });

  it("creates no proposal when the run is cancelled before the tool executes", async () => {
    await seedTestLlmRouting();
    const { db, actor, project, doc, run } = await fixture("cancel-tool");
    // The cancel lands while the model is choosing its tool call, so the
    // `tool.call` emit is the first thing that sees `cancelling`.
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await requestRunCancel(db, actor, run.id);
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "propose_document_edit",
                input: JSON.stringify({
                  projectId: project.id,
                  documentId: doc.id,
                  baseCommitSha: doc.headCommitSha,
                  markdown: "# Facts\n\nThe sky is green.\n",
                  summary: "Recolour the sky",
                }),
              },
              finish("tool-calls"),
            ],
          }) as never,
        };
      },
    });

    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => model,
      },
      run.id,
    );

    expect(await db.assistantProposal.count()).toBe(0);
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("cancelled");
    expect(page.events.map((e) => e.type)).not.toContain("proposal.created");
  });

  it("creates no proposal when the attempt is abandoned before the tool executes", async () => {
    await seedTestLlmRouting();
    const { db, actor, project, doc, run } = await fixture("abandon-tool");
    const model = new MockLanguageModelV4({
      doStream: async () => {
        // Exactly what reconcileAssistantRuns does to a stalled worker.
        await db.assistantRunAttempt.updateMany({
          where: { runId: run.id, status: "running" },
          data: { status: "abandoned", endedAt: new Date() },
        });
        await db.assistantRun.update({
          where: { id: run.id },
          data: { status: "queued" },
        });
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "propose_document_edit",
                input: JSON.stringify({
                  projectId: project.id,
                  documentId: doc.id,
                  baseCommitSha: doc.headCommitSha,
                  markdown: "# Facts\n\nThe sky is green.\n",
                  summary: "Recolour the sky",
                }),
              },
              finish("tool-calls"),
            ],
          }) as never,
        };
      },
    });

    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => model,
      },
      run.id,
    );

    // A zombie attempt writes nothing at all — not even a row the completing
    // message would never list but listProposals would still show.
    expect(await db.assistantProposal.count()).toBe(0);
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("queued");
  });

  it("fails when the deadline expires during final citation validation", async () => {
    await seedTestLlmRouting();
    const { db, run } = await fixture("final-timeout");
    const original = citationValidation.validateSourceLocators;
    const validation = vi
      .spyOn(citationValidation, "validateSourceLocators")
      .mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 550));
        return original(...args);
      });
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => scriptedModel([[finish("stop")]]),
        runTimeoutMs: 500,
      },
      run.id,
    );
    expect(validation).toHaveBeenCalled();
    const result = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("run timed out");
  });

  it("fails the run without a retry when it exceeds the run timeout", async () => {
    await seedTestLlmRouting();
    const { db, actor, conversation, run } = await fixture("timeout");
    queue.jobs.length = 0;
    await executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => stallingModel(),
        runTimeoutMs: 25,
      },
      run.id,
    );
    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("failed");
    expect(page.events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { code: "PROVIDER_UNAVAILABLE", retrying: false },
    });
    const row = await db.assistantRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(row.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(row.errorMessage).toBe("run timed out");
    const detail = await getConversation(db, actor, conversation.id);
    expect(detail.messages[0]!.status).toBe("failed");
    expect(queue.jobs.filter((j) => j.name === "assistant.run")).toHaveLength(
      0,
    );
  });

  it("stops writing when the reconciler abandons the attempt mid-run", async () => {
    await seedTestLlmRouting();
    const { db, actor, run } = await fixture("abandon");
    const execution = executeAssistantRun(
      {
        db,
        ring: testEncryptionKeys(),
        workerId: "w",
        modelFactory: () => stallingModel(),
        heartbeatMs: 25,
      },
      run.id,
    );
    await waitUntilRunning(db, run.id);
    // What reconcileAssistantRuns does to a stalled worker: abandon the
    // attempt and requeue the run for the next one.
    await db.assistantRunAttempt.updateMany({
      where: { runId: run.id, status: "running" },
      data: { status: "abandoned", endedAt: new Date() },
    });
    await db.assistantRun.update({
      where: { id: run.id },
      data: { status: "queued" },
    });
    await execution;

    const page = await listRunEvents(db, actor, { runId: run.id, after: -1 });
    expect(page.status).toBe("queued");
    expect(page.events.map((e) => e.type)).not.toContain("run.failed");
    expect(page.events.map((e) => e.type)).not.toContain("run.cancelled");
    expect(page.events.map((e) => e.type)).not.toContain("run.completed");
    expect(
      await db.aiUsage.findFirst({ where: { runId: run.id } }),
    ).toMatchObject({
      outcome: "stale_discarded",
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("runs a tool loop through the real provider SDK against the mock AI server", async () => {
    // No modelFactory: the runner resolves the route, decrypts the credential,
    // and builds the openai-compatible model exactly as production does, so the
    // provider SDK validates every tool result on the model's next step.
    const mock = await createRealProviderMock();
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const address = mock.address();
    if (!address || typeof address === "string")
      throw new Error("mock bind failed");
    try {
      await seedTestLlmRouting({
        endpoint: `http://127.0.0.1:${address.port}`,
        extractionModel: "e2e-extraction",
      });
      const db = getPrisma();
      const user = await makeUser("User", "real-sdk");
      const project = await makeProject("Real SDK");
      await addMembership(project.id, user.id, "Editor");
      const actor = {
        ...securityContextFor(user),
        name: "Real SDK",
        email: user.email,
      };
      const doc = await createDocument(
        db,
        {
          projectId: project.id,
          folderPath: [],
          title: "Facts",
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("# Facts\n\nThe sky is blue.\n"),
          },
        },
        actor,
      );
      const conversation = await createConversation(db, actor, {});
      const { run } = await submitUserMessage(db, actor, {
        conversationId: conversation.id,
        text: "Please list documents before you cite the facts",
        scope: {
          kind: "document",
          projectId: project.id,
          documentId: doc.id,
        },
      });
      await executeAssistantRun(
        {
          db,
          ring: testEncryptionKeys(),
          workerId: "w-real",
          heartbeatMs: 50,
        },
        run.id,
      );
      const page = await listRunEvents(db, actor, {
        runId: run.id,
        after: -1,
      });
      expect(page.status).toBe("completed");
      const types = page.events.map((event) => event.type);
      expect(types).toContain("tool.call");
      expect(types).toContain("tool.result");
      expect(types.at(-1)).toBe("run.completed");
      expect(
        page.events.filter((event) => event.type === "tool.call"),
      ).toMatchObject([
        { payload: { toolName: "list_documents" } },
        { payload: { toolName: "read_document" } },
      ]);
    } finally {
      await new Promise<void>((resolve) => mock.close(() => resolve()));
    }
  });
  describe("exam tools for trainers", () => {
    it.each([true, false])(
      "offers exam tools only to a trainer in the effective scope: %s",
      async (inScope) => {
        await seedTestLlmRouting();
        const { db, user, project, run } = await fixture(
          `exam-scope-${inScope}`,
        );
        const trainerProject = inScope
          ? project
          : await makeProject("Other training project");
        if (!inScope) await addMembership(trainerProject.id, user.id, "Editor");
        await db.projectTrainingRole.create({
          data: {
            projectId: trainerProject.id,
            userId: user.id,
            role: "trainer",
          },
        });
        const model = scriptedModel([[finish("stop")]]);
        await executeAssistantRun(
          {
            db,
            ring: testEncryptionKeys(),
            workerId: "exam-scope",
            modelFactory: () => model,
          },
          run.id,
        );
        const names =
          model.doStreamCalls[0]!.tools?.map((tool) => tool.name) ?? [];
        expect(names.includes("list_exams")).toBe(inScope);
        expect(names.includes("propose_exam_create")).toBe(inScope);
        expect(names.includes("grade_exam_attempt")).toBe(inScope);
        expect(names).not.toContain("create_exam");
        expect(names).not.toContain("update_exam");
      },
    );
    it.each([false, true])(
      "waits for review of a proposed exam unless auto-approve is on: %s",
      async (autoApprove) => {
        await seedTestLlmRouting();
        const { db, user, project, conversation, run } = await fixture(
          `exam-create-${autoApprove}`,
        );
        await db.projectTrainingRole.create({
          data: { projectId: project.id, userId: user.id, role: "trainer" },
        });
        await db.assistantConversation.update({
          where: { id: conversation.id },
          data: { autoApproveChanges: autoApprove },
        });
        const model = scriptedModel([
          [
            {
              type: "tool-call",
              toolCallId: "create-exam",
              toolName: "propose_exam_create",
              input: JSON.stringify({
                projectId: project.id,
                title: "Assistant exam",
                timeLimitMinutes: 15,
                summary: "Create a one-question exam",
                questions: [
                  {
                    id: randomUUID(),
                    kind: "multiple_choice",
                    prompt: "Pick",
                    weight: 1,
                    choices: [
                      { id: randomUUID(), text: "Yes", correct: true },
                      { text: "No", correct: false },
                    ],
                  },
                ],
              }),
            },
            finish("tool-calls"),
          ],
          [finish("stop")],
        ]);
        await executeAssistantRun(
          {
            db,
            ring: testEncryptionKeys(),
            workerId: "exam-create",
            modelFactory: () => model,
          },
          run.id,
        );
        const proposal = await db.assistantProposal.findFirstOrThrow({
          where: { runId: run.id },
        });
        expect(proposal).toMatchObject({
          kind: "exam.create",
          status: autoApprove ? "accepted" : "pending",
        });
        const exams = await db.exam.findMany({ include: { questions: true } });
        expect(exams).toHaveLength(autoApprove ? 1 : 0);
        if (autoApprove)
          expect(exams[0]).toMatchObject({
            id: proposal.resourceId,
            status: "draft",
            questions: [expect.objectContaining({ prompt: "Pick" })],
          });
      },
    );
    it("executes an assistant grade proposal without releasing any result", async () => {
      await seedTestLlmRouting();
      const { db, user, actor, project, run } = await fixture("exam-propose");
      await db.projectTrainingRole.create({
        data: { projectId: project.id, userId: user.id, role: "trainer" },
      });
      const trainee = await makeUser("User", "exam-runner-trainee");
      await addMembership(project.id, trainee.id, "Viewer");
      await db.projectTrainingRole.create({
        data: { projectId: project.id, userId: trainee.id, role: "trainee" },
      });
      const exam = await createExam(db, actor, {
        projectId: project.id,
        status: "published",
        definition: {
          title: "Runner exam",
          timeLimitMinutes: 30,
          questions: [
            {
              kind: "free_text",
              prompt: "Explain",
              weight: 6,
              expectedAnswer: "A reason",
            },
          ],
        },
      });
      const traineeActor = securityContextFor(trainee);
      const now = new Date();
      const attempt = await startAttempt(
        db,
        traineeActor,
        { examId: exam.id },
        now,
      );
      await submitAttempt(db, traineeActor, { attemptId: attempt.id }, now);
      const revision = (
        await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
      ).revision;
      const model = scriptedModel([
        [
          {
            type: "tool-call",
            toolCallId: "grade-exam",
            toolName: "grade_exam_attempt",
            input: JSON.stringify({
              attemptId: attempt.id,
              idempotencyKey: randomUUID(),
              expectedRevision: revision,
              grades: [
                {
                  questionId: exam.questions[0]!.id,
                  score: 4.5,
                  rationale: "Covers the essential idea",
                },
              ],
            }),
          },
          finish("tool-calls"),
        ],
        [finish("stop")],
      ]);
      await executeAssistantRun(
        {
          db,
          ring: testEncryptionKeys(),
          workerId: "exam-propose",
          modelFactory: () => model,
        },
        run.id,
      );
      expect(
        await db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ).toMatchObject({
        status: "in_review",
        gradedVia: "assistant",
        totalScore: 4.5,
      });
      expect(
        (await getOwnAttempt(db, traineeActor, attempt.id)).totalScore,
      ).toBeNull();
      const { events } = await listRunEvents(db, actor, {
        runId: run.id,
        after: -1,
      });
      for (const type of ["tool.call", "tool.result"]) {
        expect(
          JSON.stringify(events.find((event) => event.type === type)?.payload),
        ).toContain("grade_exam_attempt");
      }
    });
  });
});

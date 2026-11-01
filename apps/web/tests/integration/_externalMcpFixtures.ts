import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import { createTaskSecurityContext } from "@weaver/core/security/context";
import { leaseTaskRun } from "@weaver/core/services/scheduledTasks";
import type { SecurityContext } from "@weaver/core/security/context";
import type {
  ExecutionOwner,
  ExternalInvocation,
} from "@weaver/core/externalMcp/types";

type OwnedInvocation<K extends ExecutionOwner["kind"]> = ExternalInvocation & {
  owner: Extract<ExecutionOwner, { kind: K }>;
};
import * as management from "@weaver/core/services/externalMcp";
import type {
  ExternalMcpTransport,
  RemoteCatalog,
  JsonObject,
  JsonValue,
} from "@weaver/external-mcp";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  securityContextFor,
  testEncryptionKeys,
} from "./_harness";

export async function makeExternalFixture() {
  const admin = securityContextFor(await makeUser("Admin", "external-admin"));
  const owner = securityContextFor(await makeUser("User", "external-owner"));
  const viewer = securityContextFor(await makeUser("User", "external-viewer"));
  const outsider = securityContextFor(
    await makeUser("User", "external-outsider"),
  );
  const project = await makeProject("External project");
  await addMembership(project.id, owner.userId, "Owner");
  await addMembership(project.id, viewer.userId, "Viewer");
  const calls = {
    tokens: [] as (string | null)[],
    tools: [] as string[],
    closed: 0,
    counter: 0,
    arguments: [] as JsonObject[],
    onCall: null as (() => Promise<void>) | null,
    callError: null as Error | null,
    toolError: false,
    content: [] as JsonValue[],
    catalog: {
      canonicalEndpoint: "https://example.test/mcp",
      serverInfo: { name: "Fixture" },
      protocolVersion: "2024-11-05",
      tools: ["read", "write"].map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} } as JsonObject,
        supportStatus: { available: true as const },
      })),
    } as RemoteCatalog,
    error: null as Error | null,
    blocked: null as Promise<void> | null,
    opens: [] as {
      endpoint: string;
      insecureTls?: boolean;
    }[],
  };
  const transport: ExternalMcpTransport = {
    async open(options) {
      calls.opens.push({
        endpoint: options.endpoint,
        insecureTls: options.insecureTls,
      });
      return {
        async discover() {
          calls.tokens.push(await options.token());
          if (calls.blocked) await calls.blocked;
          if (calls.error) throw calls.error;
          return structuredClone(calls.catalog);
        },
        async call(input) {
          calls.tokens.push(await options.token());
          calls.tools.push(input.name);
          calls.arguments.push(structuredClone(input.arguments));
          if (input.name === "write") calls.counter++;
          if (calls.onCall) await calls.onCall();
          if (calls.callError) throw calls.callError;
          if (calls.blocked) await calls.blocked;
          return {
            isError: calls.toolError,
            content: structuredClone(calls.content),
            truncated: false,
            responseBytes: 2,
          };
        },
        async close() {
          calls.closed++;
        },
      };
    },
  };
  const db = getPrisma();
  const sessions = new Map<string, string>();
  for (const actor of [admin, owner, viewer, outsider]) {
    const session = await db.session.create({
      data: {
        userId: actor.userId,
        token: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    sessions.set(actor.userId, session.id);
  }
  const withSession = (actor: typeof owner) => ({
    ...actor,
    credentialId: sessions.get(actor.userId)!,
  });
  const ring = testEncryptionKeys();
  return {
    db,
    ring,
    admin: withSession(admin),
    owner: withSession(owner),
    viewer: withSession(viewer),
    outsider: withSession(outsider),
    project,
    transport,
    calls,
    deps: { db, ring, transport, now: () => new Date() },
  };
}

export async function makeExternalApproval(
  f: Awaited<ReturnType<typeof makeExternalFixture>>,
  connectionId: string,
  toolId: string,
  state: "pending" | "approved" = "pending",
) {
  const { randomUUID } = await import("node:crypto");
  const { encryptExternalSecret } =
    await import("@weaver/core/services/externalMcp/credentials");
  const now = f.deps.now();
  const id = randomUUID();
  const conversation = await f.db.assistantConversation.create({
    data: { ownerId: f.owner.userId, title: "External" },
  });
  const message = await f.db.assistantMessage.create({
    data: {
      conversationId: conversation.id,
      position: 0,
      role: "user",
      content: { text: "Read" },
    },
  });
  const run = await f.db.assistantRun.create({
    data: {
      conversationId: conversation.id,
      userMessageId: message.id,
      scopeSnapshot: { kind: "all" },
      actorSnapshot: { userId: f.owner.userId },
    },
  });
  const attempt = await f.db.assistantRunAttempt.create({
    data: {
      runId: run.id,
      number: 1,
      workerId: "test",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    },
  });
  const call = await f.db.externalMcpCall.create({
    data: {
      connectionId,
      toolId,
      userId: f.owner.userId,
      assistantRunId: run.id,
      attemptId: attempt.id,
      toolCallId: id,
      userSnapshotId: f.owner.userId,
      userSnapshotName: "Owner",
      connectionSnapshotId: connectionId,
      connectionSnapshotName: "Example",
      toolSnapshotId: toolId,
      toolSnapshotName: "read",
      remoteDigest: "a".repeat(64),
      reviewDigest: "b".repeat(64),
      argsDigest: "c".repeat(64),
      configRevision: 2,
      effect: "read",
      scopeSnapshot: { kind: "all" },
      preparedAt: now,
      retainedUntil: new Date(now.getTime() + 30 * 86400000),
    },
  });
  const v = encryptExternalSecret(
    f.ring,
    '{"fixture":"private-arguments"}',
    "approval",
    id,
  );
  return f.db.externalMcpToolApproval.create({
    data: {
      id,
      callId: call.id,
      ownerId: f.owner.userId,
      runId: run.id,
      attemptId: attempt.id,
      connectionId,
      toolId,
      toolCallId: id,
      scopeSnapshot: { kind: "all" },
      configRevision: 2,
      reviewDigest: "b".repeat(64),
      argsDigest: "c".repeat(64),
      state,
      pendingArgumentsCiphertext: v.ciphertext,
      pendingArgumentsKeyVersion: v.keyVersion,
      pendingArgumentsIv: v.iv,
      pendingArgumentsTag: v.tag,
      expiresAt: new Date(now.getTime() + 60000),
      createdAt: now,
      retainedUntil: new Date(now.getTime() + 30 * 86400000),
    },
  });
}

export async function makeAssistantInvocation(
  f: Awaited<ReturnType<typeof makeExternalFixture>>,
  actor: SecurityContext,
  toolId: string,
) {
  const { createConversation } =
    await import("@weaver/core/services/assistantConversations");
  const { submitUserMessage, leaseRunAttempt } =
    await import("@weaver/core/services/assistantRuns");
  const c = await createConversation(f.db, actor, {});
  const submitted = await submitUserMessage(f.db, actor, {
    conversationId: c.id,
    text: "Read external input",
    scope: { kind: "project", projectId: f.project.id },
  });
  const tool = await f.db.externalMcpTool.findUniqueOrThrow({
    where: { id: toolId },
    include: { connection: true },
  });
  await f.db.assistantMessage.update({
    where: { id: submitted.userMessage.id },
    data: {
      content: {
        text: submitted.userMessage.text,
        externalToolSnapshots: [
          {
            connectionId: tool.connectionId,
            toolId,
            configRevision: tool.connection.revision,
            toolDigest: tool.reviewDigest!,
          },
        ],
      },
    },
  });
  const leased = await leaseRunAttempt(f.db, {
    runId: submitted.run.id,
    workerId: "external-access-test",
    leaseMs: 60000,
  });
  if (!leased) throw new Error("Fixture run was not leased");
  const scope = leased.run.scopeSnapshot;
  const invocation: OwnedInvocation<"assistant"> = {
    owner: {
      kind: "assistant",
      runId: submitted.run.id,
      attemptId: leased.attempt.id,
      toolCallId: crypto.randomUUID(),
    },
    scope,
    toolId,
    expectedConfigRevision: tool.connection.revision,
    expectedToolDigest: tool.reviewDigest!,
    arguments: {},
    deadline: new Date(Date.now() + 30000),
  };
  return {
    invocation,
    scope,
    conversationId: c.id,
    userMessageId: submitted.userMessage.id,
  };
}

/** Stores loaded-tool snapshots on a user message, as find_external_tools would. */
export async function preloadExternalTools(
  f: Awaited<ReturnType<typeof makeExternalFixture>>,
  userMessageId: string,
  toolIds: string[],
) {
  const tools = await f.db.externalMcpTool.findMany({
    where: { id: { in: toolIds } },
    include: { connection: true },
  });
  const message = await f.db.assistantMessage.findUniqueOrThrow({
    where: { id: userMessageId },
  });
  await f.db.assistantMessage.update({
    where: { id: userMessageId },
    data: {
      content: {
        ...(message.content as Record<string, unknown>),
        externalToolSnapshots: toolIds.map((id) => {
          const tool = tools.find((t) => t.id === id)!;
          return {
            connectionId: tool.connectionId,
            toolId: id,
            configRevision: tool.connection.revision,
            toolDigest: tool.reviewDigest!,
          };
        }),
      },
    },
  });
}

/** Creates, discovers, reviews and enables an "Example" connection owned by `actor`. */
export async function enableExternalConnection(
  f: Awaited<ReturnType<typeof makeExternalFixture>>,
  actor: SecurityContext,
  readName = "read",
  // "write" makes the assistant ask before the tool behind readId as well.
  readEffect: "read" | "write" = "read",
) {
  let c = await management.createExternalConnection(f.deps, actor, {
    name: "Example",
    endpoint: "https://example.test/mcp",
    authMode: "none",
  });
  await management.discoverExternalConnection(f.deps, actor, {
    id: c.id,
    expectedRevision: c.revision,
  });
  const tools = (
    await management.listExternalTools(f.db, actor, { connectionId: c.id })
  ).items;
  for (const tool of tools)
    await management.reviewExternalTools(f.deps, actor, {
      connectionId: c.id,
      items: [
        {
          toolId: tool.id,
          expectedRemoteDigest: tool.discoveredRemoteDigest,
          enabled: true,
          effect: tool.remoteName === readName ? readEffect : "write",
        },
      ],
    });
  c = await management.getExternalConnection(f.db, actor, c.id);
  await management.updateExternalConnection(f.deps, actor, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { enabled: true },
  });
  return {
    connectionId: c.id,
    readId: tools.find((t) => t.remoteName === readName)!.id,
    writeId: tools.find((t) => t.remoteName === "write")!.id,
  };
}

export async function makeEnabledExternalFixture(
  readName = "read",
  description?: string,
  readEffect: "read" | "write" = "read",
) {
  const f = await makeExternalFixture();
  f.calls.catalog.tools[0]!.name = readName;
  if (description) f.calls.catalog.tools[0]!.description = description;
  return {
    ...f,
    ...(await enableExternalConnection(f, f.owner, readName, readEffect)),
  };
}

export async function makeTaskInvocation(
  f: Awaited<ReturnType<typeof makeEnabledExternalFixture>>,
) {
  const output = await makeProject("Output");
  await addMembership(output.id, f.owner.userId, "Editor");
  const scope = await resolveScopeSnapshot(f.db, f.owner, {
    kind: "project",
    projectId: f.project.id,
  });
  const task = await f.db.scheduledTask.create({
    data: {
      ownerId: f.owner.userId,
      name: "External task",
      instruction: "Report",
      scopeRequest: { kind: "project", projectId: f.project.id },
      scopeSnapshot: scope,
      outputProjectId: output.id,
      outputFolderPath: [],
      schedule: { preset: "hourly" },
      timezone: "UTC",
      cron: "0 * * * *",
    },
  });
  const input = await f.db.scheduledTaskExternalInput.create({
    data: {
      taskId: task.id,
      position: 0,
      name: "Read input",
      toolId: f.readId,
      argumentBindings: {},
      createdAt: new Date(),
    },
  });
  const run = await f.db.scheduledTaskRun.create({
    data: { taskId: task.id, trigger: "manual" },
  });
  await leaseTaskRun(f.db, {
    runId: run.id,
    workerId: "external-task-test",
    leaseMs: 60000,
  });
  const c = await f.db.externalMcpConnection.findUniqueOrThrow({
    where: { id: f.connectionId },
  });
  const tool = await f.db.externalMcpTool.findUniqueOrThrow({
    where: { id: f.readId },
  });
  const actor = createTaskSecurityContext({
    userId: f.owner.userId,
    globalRole: "User",
    runId: run.id,
  });
  const invocation: OwnedInvocation<"task"> = {
    owner: { kind: "task", runId: run.id, inputId: input.id },
    scope,
    toolId: tool.id,
    expectedConfigRevision: c.revision,
    expectedToolDigest: tool.reviewDigest!,
    arguments: {},
    deadline: new Date(Date.now() + 30000),
  };
  return { actor, invocation, output, task, input, run };
}

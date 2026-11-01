import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getPrisma, makeUser, resetDb } from "./_harness";

function callSnapshotData(now: Date) {
  return {
    status: "prepared" as const,
    userSnapshotId: randomUUID(),
    userSnapshotName: "User",
    connectionSnapshotId: randomUUID(),
    connectionSnapshotName: "Connection",
    toolSnapshotId: randomUUID(),
    toolSnapshotName: "tool",
    remoteDigest: "a".repeat(64),
    reviewDigest: "b".repeat(64),
    configRevision: 1,
    effect: "read" as const,
    argsDigest: "c".repeat(64),
    scopeSnapshot: { kind: "all" },
    preparedAt: now,
    retainedUntil: new Date(now.getTime() + 30 * 86_400_000),
  };
}

async function createAssistantOwner(suffix: string) {
  const db = getPrisma();
  const user = await makeUser("User", suffix);
  const conversation = await db.assistantConversation.create({
    data: { ownerId: user.id, title: "External call" },
  });
  const message = await db.assistantMessage.create({
    data: {
      conversationId: conversation.id,
      position: 0,
      role: "user",
      content: { text: "Read" },
    },
  });
  const run = await db.assistantRun.create({
    data: {
      conversationId: conversation.id,
      userMessageId: message.id,
      scopeSnapshot: { kind: "all" },
      actorSnapshot: { userId: user.id },
    },
  });
  const attempt = await db.assistantRunAttempt.create({
    data: {
      runId: run.id,
      number: 1,
      workerId: "test",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { user, run, attempt };
}

describe("external MCP persistence schema", () => {
  beforeEach(resetDb);

  it("enforces connection defaults, credentials, and unique names", async () => {
    const db = getPrisma();
    const now = new Date();
    const user = await makeUser("User", "external-defaults");
    const other = await makeUser("User", "external-defaults-other");
    const connection = await db.externalMcpConnection.create({
      data: {
        ownerId: user.id,
        name: "Example",
        endpoint: "https://example.test/mcp",
        createdAt: now,
      },
    });
    expect(connection).toMatchObject({
      enabled: false,
      authMode: "none",
      revision: 1,
      timeoutMs: 30_000,
    });
    await expect(
      db.externalMcpConnection.create({
        data: {
          ownerId: user.id,
          name: "Example",
          endpoint: "https://other.example.test/mcp",
          createdAt: now,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.externalMcpConnection.create({
        data: {
          ownerId: other.id,
          name: "Example",
          endpoint: "https://other.example.test/mcp",
          createdAt: now,
        },
      }),
    ).resolves.toMatchObject({ ownerId: other.id, name: "Example" });
    await expect(
      db.$executeRaw`
        INSERT INTO "ExternalMcpConnection"
          ("id", "ownerId", "name", "endpoint", "authMode", "credentialCiphertext", "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}::uuid, ${other.id}::uuid, 'Broken', 'https://example.test/mcp', 'bearer', 'secret', ${now}, ${now})
      `,
    ).rejects.toThrow(/ExternalMcpConnection_credentials_check/);
  });

  it("enforces ownership shape and per-owner invocation uniqueness", async () => {
    const db = getPrisma();
    const now = new Date();
    const id = randomUUID();
    await expect(
      db.$executeRaw`
        INSERT INTO "ExternalMcpCall"
          ("id", "status", "userSnapshotId", "userSnapshotName",
           "connectionSnapshotId", "connectionSnapshotName", "toolSnapshotId",
           "toolSnapshotName", "remoteDigest", "reviewDigest", "configRevision",
           "effect", "argsDigest", "scopeSnapshot", "preparedAt",
           "retainedUntil")
        VALUES
          (${id}::uuid, 'prepared', ${randomUUID()}::uuid, 'User',
           ${randomUUID()}::uuid, 'Connection', ${randomUUID()}::uuid,
           'tool', ${"a".repeat(64)}, ${"b".repeat(64)}, 1,
           'read', ${"c".repeat(64)}, '{}'::jsonb, ${now},
           ${new Date(now.getTime() + 86_400_000)})
      `,
    ).rejects.toThrow(/ExternalMcpCall_owner_shape_check/);

    const { run, attempt } = await createAssistantOwner("assistant-unique");
    await db.externalMcpCall.create({
      data: {
        ...callSnapshotData(now),
        assistantRunId: run.id,
        attemptId: attempt.id,
        toolCallId: "duplicate",
      },
    });
    await expect(
      db.externalMcpCall.create({
        data: {
          ...callSnapshotData(now),
          assistantRunId: run.id,
          attemptId: attempt.id,
          toolCallId: "duplicate",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("prevents deleting connections referenced by task inputs", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "external-schema");
    const now = new Date();
    const connection = await db.externalMcpConnection.create({
      data: {
        ownerId: user.id,
        name: "Task source",
        endpoint: "https://example.test/mcp",
        createdAt: now,
      },
    });
    const tool = await db.externalMcpTool.create({
      data: {
        connectionId: connection.id,
        remoteName: "read",
        discoveredDefinition: {},
        discoveredRemoteDigest: "a".repeat(64),
        discoveredAt: now,
      },
    });
    const project = await db.project.create({
      data: {
        name: "Output",
        organization: {
          create: { name: "Output", slug: `external-${randomUUID()}` },
        },
      },
    });
    const task = await db.scheduledTask.create({
      data: {
        ownerId: user.id,
        name: "Report",
        instruction: "Report",
        scopeRequest: { kind: "projects", projectIds: [project.id] },
        scopeSnapshot: { kind: "projects", projectIds: [project.id] },
        outputProjectId: project.id,
        outputFolderPath: [],
        schedule: { kind: "daily", time: "08:00" },
        timezone: "UTC",
        cron: "0 8 * * *",
      },
    });
    const input = await db.scheduledTaskExternalInput.create({
      data: {
        taskId: task.id,
        position: 0,
        name: "Source",
        toolId: tool.id,
        argumentBindings: {},
        createdAt: now,
      },
    });
    await expect(
      db.$executeRaw`DELETE FROM "ExternalMcpConnection" WHERE "id" = ${connection.id}::uuid`,
    ).rejects.toMatchObject({
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "ForeignKeyConstraintViolation",
            originalCode: "23503",
          },
        },
      },
    });
    expect(
      await db.externalMcpConnection.count({ where: { id: connection.id } }),
    ).toBe(1);
    expect(await db.externalMcpTool.count({ where: { id: tool.id } })).toBe(1);
    expect(
      await db.scheduledTaskExternalInput.count({ where: { id: input.id } }),
    ).toBe(1);

    const taskRun = await db.scheduledTaskRun.create({
      data: { taskId: task.id, trigger: "manual" },
    });
    await db.externalMcpCall.create({
      data: {
        ...callSnapshotData(now),
        taskRunId: taskRun.id,
        inputId: input.id,
        inputSnapshotId: input.id,
      },
    });
    await expect(
      db.externalMcpCall.create({
        data: {
          ...callSnapshotData(now),
          taskRunId: taskRun.id,
          inputId: input.id,
          inputSnapshotId: input.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("retains approved arguments until settlement and cascades run-private records", async () => {
    const db = getPrisma();
    const now = new Date();
    const { user, run, attempt } =
      await createAssistantOwner("approval-lifecycle");
    const call = await db.externalMcpCall.create({
      data: {
        ...callSnapshotData(now),
        userId: user.id,
        userSnapshotId: user.id,
        assistantRunId: run.id,
        attemptId: attempt.id,
        toolCallId: "approval-call",
      },
    });
    const encrypted = {
      pendingArgumentsCiphertext: "ciphertext",
      pendingArgumentsKeyVersion: 1,
      pendingArgumentsIv: "iv",
      pendingArgumentsTag: "tag",
    };
    const approval = await db.externalMcpToolApproval.create({
      data: {
        callId: call.id,
        ownerId: user.id,
        runId: run.id,
        attemptId: attempt.id,
        toolCallId: "approval-call",
        scopeSnapshot: { kind: "all" },
        configRevision: 1,
        reviewDigest: "b".repeat(64),
        argsDigest: "c".repeat(64),
        ...encrypted,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        retainedUntil: new Date(now.getTime() + 30 * 86_400_000),
      },
    });
    const approved = await db.externalMcpToolApproval.update({
      where: { id: approval.id },
      data: { state: "approved", decidedById: user.id, decidedAt: now },
    });
    expect(approved).toMatchObject({ state: "approved", ...encrypted });
    expect(
      await db.externalMcpCall.findUniqueOrThrow({ where: { id: call.id } }),
    ).toMatchObject({ status: "prepared", dispatchedAt: null });
    await db.externalMcpToolApproval.update({
      where: { id: approval.id },
      data: {
        state: "settled",
        pendingArgumentsCiphertext: null,
        pendingArgumentsKeyVersion: null,
        pendingArgumentsIv: null,
        pendingArgumentsTag: null,
      },
    });
    await db.assistantRun.delete({ where: { id: run.id } });
    expect(await db.externalMcpCall.count({ where: { id: call.id } })).toBe(0);
    expect(
      await db.externalMcpToolApproval.count({ where: { id: approval.id } }),
    ).toBe(0);
  });

  it.each(["denied", "expired", "invalidated"] as const)(
    "requires encrypted arguments to be cleared when approval becomes %s",
    async (state) => {
      const db = getPrisma();
      const now = new Date();
      const { user, run, attempt } = await createAssistantOwner(
        `approval-${state}`,
      );
      const call = await db.externalMcpCall.create({
        data: {
          ...callSnapshotData(now),
          assistantRunId: run.id,
          attemptId: attempt.id,
          toolCallId: state,
        },
      });
      const approval = await db.externalMcpToolApproval.create({
        data: {
          callId: call.id,
          ownerId: user.id,
          runId: run.id,
          attemptId: attempt.id,
          toolCallId: state,
          scopeSnapshot: { kind: "all" },
          configRevision: 1,
          reviewDigest: "b".repeat(64),
          argsDigest: "c".repeat(64),
          pendingArgumentsCiphertext: "ciphertext",
          pendingArgumentsKeyVersion: 1,
          pendingArgumentsIv: "iv",
          pendingArgumentsTag: "tag",
          expiresAt: new Date(now.getTime() + 60_000),
          createdAt: now,
          retainedUntil: new Date(now.getTime() + 30 * 86_400_000),
        },
      });
      await expect(
        db.externalMcpToolApproval.update({
          where: { id: approval.id },
          data: { state },
        }),
      ).rejects.toThrow(/ExternalMcpToolApproval_pending_arguments_check/);
      await expect(
        db.externalMcpToolApproval.update({
          where: { id: approval.id },
          data: {
            state,
            pendingArgumentsCiphertext: null,
            pendingArgumentsKeyVersion: null,
            pendingArgumentsIv: null,
            pendingArgumentsTag: null,
          },
        }),
      ).resolves.toMatchObject({
        state,
        pendingArgumentsCiphertext: null,
      });
    },
  );

  it("allows completed call history to outlive connection deletion", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "external-history");
    const now = new Date();
    const connection = await db.externalMcpConnection.create({
      data: {
        ownerId: user.id,
        name: "Historical",
        endpoint: "https://example.test/mcp",
        createdAt: now,
      },
    });
    const tool = await db.externalMcpTool.create({
      data: {
        connectionId: connection.id,
        remoteName: "read",
        discoveredDefinition: {},
        discoveredRemoteDigest: "a".repeat(64),
        discoveredAt: now,
      },
    });
    const conversation = await db.assistantConversation.create({
      data: { ownerId: user.id, title: "History" },
    });
    const message = await db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: 0,
        role: "user",
        content: { text: "Read" },
      },
    });
    const run = await db.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        scopeSnapshot: { kind: "all" },
        actorSnapshot: { userId: user.id },
      },
    });
    const attempt = await db.assistantRunAttempt.create({
      data: {
        runId: run.id,
        number: 1,
        workerId: "test",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
    });
    const call = await db.externalMcpCall.create({
      data: {
        userId: user.id,
        connectionId: connection.id,
        toolId: tool.id,
        assistantRunId: run.id,
        attemptId: attempt.id,
        toolCallId: "call-1",
        status: "completed",
        userSnapshotId: user.id,
        userSnapshotName: "User",
        connectionSnapshotId: connection.id,
        connectionSnapshotName: connection.name,
        toolSnapshotId: tool.id,
        toolSnapshotName: tool.remoteName,
        remoteDigest: "a".repeat(64),
        reviewDigest: "b".repeat(64),
        configRevision: 1,
        effect: "read",
        argsDigest: "c".repeat(64),
        scopeSnapshot: { kind: "all" },
        preparedAt: now,
        dispatchedAt: now,
        completedAt: now,
        retainedUntil: new Date(now.getTime() + 30 * 86_400_000),
      },
    });
    await db.$executeRaw`DELETE FROM "ExternalMcpConnection" WHERE "id" = ${connection.id}::uuid`;
    expect(
      await db.externalMcpCall.findUniqueOrThrow({ where: { id: call.id } }),
    ).toMatchObject({
      connectionId: null,
      toolId: null,
      connectionSnapshotId: connection.id,
      toolSnapshotId: tool.id,
    });
  });

  it("deletes a user's connections and tasks together and keeps MCP call history", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "external-delete");
    const now = new Date();
    const connection = await db.externalMcpConnection.create({
      data: {
        ownerId: user.id,
        name: "Mine",
        endpoint: "https://example.test/mcp",
        createdAt: now,
      },
    });
    const tool = await db.externalMcpTool.create({
      data: {
        connectionId: connection.id,
        remoteName: "read",
        discoveredDefinition: {},
        discoveredRemoteDigest: "a".repeat(64),
        discoveredAt: now,
      },
    });
    const project = await db.project.create({
      data: {
        name: "Output",
        organization: {
          create: { name: "Output", slug: `external-${randomUUID()}` },
        },
      },
    });
    const task = await db.scheduledTask.create({
      data: {
        ownerId: user.id,
        name: "Report",
        instruction: "Report",
        scopeRequest: { kind: "projects", projectIds: [project.id] },
        scopeSnapshot: { kind: "projects", projectIds: [project.id] },
        outputProjectId: project.id,
        outputFolderPath: [],
        schedule: { kind: "daily", time: "08:00" },
        timezone: "UTC",
        cron: "0 8 * * *",
      },
    });
    const input = await db.scheduledTaskExternalInput.create({
      data: {
        taskId: task.id,
        position: 0,
        name: "Source",
        toolId: tool.id,
        argumentBindings: {},
        createdAt: now,
      },
    });
    const call = await db.externalMcpCall.create({
      data: {
        ...callSnapshotData(now),
        userId: user.id,
        connectionId: connection.id,
        toolId: tool.id,
        mcpRequestId: randomUUID(),
        mcpCredentialId: "key-1",
        mcpAuthMethod: "apiKey",
      },
    });
    await db.user.delete({ where: { id: user.id } });
    expect(
      await db.externalMcpConnection.count({ where: { id: connection.id } }),
    ).toBe(0);
    expect(
      await db.scheduledTaskExternalInput.count({ where: { id: input.id } }),
    ).toBe(0);
    expect(
      await db.externalMcpCall.findUniqueOrThrow({ where: { id: call.id } }),
    ).toMatchObject({ userId: null, connectionId: null, toolId: null });
  });

  it("accepts the MCP owner shape and rejects mixed owners", async () => {
    const db = getPrisma();
    const now = new Date();
    const mcp = {
      mcpRequestId: randomUUID(),
      mcpCredentialId: "key-1",
      mcpAuthMethod: "apiKey",
    };
    await db.externalMcpCall.create({
      data: { ...callSnapshotData(now), ...mcp },
    });
    await expect(
      db.externalMcpCall.create({
        data: { ...callSnapshotData(now), ...mcp },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const { run, attempt } = await createAssistantOwner("mixed-mcp");
    await expect(
      db.externalMcpCall.create({
        data: {
          ...callSnapshotData(now),
          assistantRunId: run.id,
          attemptId: attempt.id,
          toolCallId: "mixed",
          mcpRequestId: randomUUID(),
          mcpCredentialId: "key-1",
          mcpAuthMethod: "apiKey",
        },
      }),
    ).rejects.toThrow(/ExternalMcpCall_owner_shape_check/);
    await expect(
      db.externalMcpCall.create({
        data: {
          ...callSnapshotData(now),
          mcpRequestId: randomUUID(),
          mcpCredentialId: "key-1",
          mcpAuthMethod: "session",
        },
      }),
    ).rejects.toThrow(/ExternalMcpCall_owner_shape_check/);
  });
});

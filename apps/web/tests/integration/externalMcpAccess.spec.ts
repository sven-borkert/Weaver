import { beforeEach, expect, it, vi } from "vitest";
import { resetDb, addMembership, makeProject } from "./_harness";
import {
  makeExternalFixture,
  makeAssistantInvocation,
} from "./_externalMcpFixtures";
import {
  createExternalConnection,
  discoverExternalConnection,
  reviewExternalTools,
  listExternalTools,
  getExternalConnection,
  updateExternalConnection,
} from "@weaver/core/services/externalMcp";
import * as access from "@weaver/core/services/externalMcp/access";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";

beforeEach(resetDb);
async function fixture() {
  const f = await makeExternalFixture();
  let c = await createExternalConnection(f.deps, f.owner, {
    name: "Example",
    endpoint: "https://example.test/mcp",
    authMode: "none",
  });
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  const tools = (await listExternalTools(f.db, f.owner, { connectionId: c.id }))
    .items;
  for (const tool of tools)
    await reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: [
        {
          toolId: tool.id,
          expectedRemoteDigest: tool.discoveredRemoteDigest,
          enabled: true,
          effect: tool.remoteName === "read" ? "read" : "write",
        },
      ],
    });
  c = await getExternalConnection(f.db, f.owner, c.id);
  await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { enabled: true },
  });
  return {
    ...f,
    connectionId: c.id,
    readId: tools.find((t) => t.remoteName === "read")!.id,
    writeId: tools.find((t) => t.remoteName === "write")!.id,
  };
}
it("offers each user only their own connections, reads and writes alike, whatever their project role", async () => {
  const f = await fixture();
  const { invocation, scope } = await makeAssistantInvocation(
    f,
    f.owner,
    f.readId,
  );
  const effects = async (actor: typeof f.owner, s = scope) =>
    (
      await access.listAvailableExternalTools(f.deps, actor, { scope: s })
    ).tools.map((t) => t.effect);
  expect(await effects(f.owner)).toEqual(["read", "write"]);
  const viewerScope = await resolveScopeSnapshot(f.db, f.viewer, {
    kind: "project",
    projectId: f.project.id,
  });
  expect(await effects(f.viewer, viewerScope)).toEqual([]);
  await f.db.member.updateMany({
    where: { userId: f.owner.userId },
    data: { role: "viewer" },
  });
  expect(await effects(f.owner)).toEqual(["read", "write"]);
  for (const stranger of [f.outsider, f.admin, f.viewer])
    await expect(
      access.authorizeExternalInvocation(f.deps, stranger, invocation),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).toMatchObject({
    toolId: f.readId,
    effect: "read",
    scopeProjectIds: [f.project.id],
  });
});
it("lets the owner run their own write tool after demotion to Viewer", async () => {
  const f = await fixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.writeId);
  await f.db.member.updateMany({
    where: { userId: f.owner.userId },
    data: { role: "viewer" },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).resolves.toMatchObject({ effect: "write" });
});
it("requires membership in every scope project, including removed projects", async () => {
  const f = await fixture();
  const other = await makeProject("Other");
  await addMembership(other.id, f.owner.userId, "Owner");
  const scope = await resolveScopeSnapshot(f.db, f.owner, {
    kind: "projects",
    projectIds: [f.project.id, other.id],
  });
  expect(
    (
      await access.listAvailableExternalTools(f.deps, f.owner, { scope })
    ).tools.map((t) => t.effect),
  ).toEqual(["read", "write"]);
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.readId);
  await f.db.project.update({
    where: { id: f.project.id },
    data: { deletedAt: new Date() },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("binds exact run, active attempt, loaded snapshots and scope", async () => {
  const f = await fixture();
  const { invocation, userMessageId } = await makeAssistantInvocation(
    f,
    f.owner,
    f.readId,
  );
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, {
      ...invocation,
      scope: { ...invocation.scope, projectIds: [] },
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, {
      ...invocation,
      owner: {
        ...invocation.owner,
        attemptId: crypto.randomUUID(),
      } as typeof invocation.owner,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await f.db.assistantMessage.update({
    where: { id: userMessageId },
    data: { content: { text: "legacy" } },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});
it.each([
  "session",
  "ban",
  "password",
  "lease",
  "cancel",
  "config",
  "digest",
  "membership",
  "absent",
  "disabled",
  "schema",
])("rejects live %s changes", async (change) => {
  const f = await fixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.readId);
  if (change === "session")
    await f.db.session.delete({ where: { id: f.owner.credentialId } });
  if (change === "ban")
    await f.db.user.update({
      where: { id: f.owner.userId },
      data: { banned: true },
    });
  if (change === "password")
    await f.db.user.update({
      where: { id: f.owner.userId },
      data: { mustChangePassword: true },
    });
  if (change === "lease" && invocation.owner.kind === "assistant")
    await f.db.assistantRunAttempt.update({
      where: { id: invocation.owner.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
  if (change === "cancel")
    await f.db.assistantRun.update({
      where: { id: invocation.owner.runId },
      data: { cancelRequestedAt: new Date() },
    });
  if (change === "config")
    await f.db.externalMcpConnection.update({
      where: { id: f.connectionId },
      data: { revision: { increment: 1 } },
    });
  if (change === "digest")
    await f.db.externalMcpTool.update({
      where: { id: f.readId },
      data: { discoveredRemoteDigest: "f".repeat(64) },
    });
  if (change === "membership")
    await f.db.member.deleteMany({ where: { userId: f.owner.userId } });
  if (change === "absent")
    await f.db.externalMcpTool.update({
      where: { id: f.readId },
      data: { presentInCatalog: false },
    });
  if (change === "disabled")
    await f.db.externalMcpTool.update({
      where: { id: f.readId },
      data: { enabled: false },
    });
  if (change === "schema") invocation.arguments = { bad: "x".repeat(17000) };
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toBeDefined();
});
it("rejects old unscoped and outside-scope assistant history", async () => {
  const f = await fixture();
  const { invocation, conversationId } = await makeAssistantInvocation(
    f,
    f.owner,
    f.readId,
  );
  const row = await f.db.assistantMessage.create({
    data: {
      conversationId,
      position: -1,
      role: "assistant",
      content: { text: "legacy" },
    },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toThrow(/fresh conversation/i);
  await f.db.assistantMessage.update({
    where: { id: row.id },
    data: {
      content: { text: "other", contextProjectIds: [crypto.randomUUID()] },
    },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toThrow(/fresh conversation/i);
});

import { createTaskSecurityContext } from "@weaver/core/security/context";
import { leaseTaskRun } from "@weaver/core/services/scheduledTasks";
import type { ExternalInvocation } from "@weaver/core/externalMcp/types";
async function taskInvocation(f: Awaited<ReturnType<typeof fixture>>) {
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
  const invocation: ExternalInvocation = {
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
it("lets tasks run the owner's read tools", async () => {
  const f = await fixture();
  const t = await taskInvocation(f);
  await expect(
    access.authorizeExternalInvocation(f.deps, t.actor, t.invocation),
  ).resolves.toMatchObject({
    effect: "read",
    scopeProjectIds: [f.project.id],
  });
});
it("binds task identity, active run, saved input and source scope", async () => {
  const f = await fixture();
  const t = await taskInvocation(f);
  await expect(
    access.authorizeExternalInvocation(
      f.deps,
      { ...t.actor, credentialId: `task-run:${crypto.randomUUID()}` },
      t.invocation,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    access.authorizeExternalInvocation(f.deps, t.actor, {
      ...t.invocation,
      owner: { kind: "task", runId: t.run.id, inputId: crypto.randomUUID() },
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    access.authorizeExternalInvocation(f.deps, t.actor, {
      ...t.invocation,
      scope: { ...t.invocation.scope, projectIds: [t.output.id] },
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await f.db.scheduledTaskExternalInput.update({
    where: { id: t.input.id },
    data: { toolId: f.writeId },
  });
  const write = await f.db.externalMcpTool.findUniqueOrThrow({
    where: { id: f.writeId },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, t.actor, {
      ...t.invocation,
      toolId: write.id,
      expectedToolDigest: write.reviewDigest!,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await f.db.scheduledTaskRun.update({
    where: { id: t.run.id },
    data: { status: "succeeded", finishedAt: new Date() },
  });
  await expect(
    access.listAvailableExternalTools(f.deps, t.actor, {
      scope: t.invocation.scope,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("rejects forged fresh expected revisions when the queued snapshot is stale", async () => {
  const f = await fixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.readId);
  const c = await f.db.externalMcpConnection.update({
    where: { id: f.connectionId },
    data: { revision: { increment: 1 } },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, {
      ...invocation,
      expectedConfigRevision: c.revision,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});
it("intersects saved and current capabilities for writes", async () => {
  const f = await fixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.writeId);
  const capabilities = new Set(f.owner.capabilities);
  capabilities.delete("content:write");
  await expect(
    access.authorizeExternalInvocation(
      f.deps,
      { ...f.owner, capabilities },
      invocation,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("validates the reviewed schema without coercing or exposing supplied arguments", async () => {
  const f = await fixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.readId);
  invocation.arguments = [] as unknown as ExternalInvocation["arguments"];
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("allows the owner's writes in every member role", async () => {
  const f = await fixture();
  const { invocation, scope } = await makeAssistantInvocation(
    f,
    f.owner,
    f.writeId,
  );
  for (const role of ["owner", "maintainer", "editor", "viewer"]) {
    await f.db.member.updateMany({
      where: { userId: f.owner.userId },
      data: { role },
    });
    expect(
      (
        await access.listAvailableExternalTools(f.deps, f.owner, { scope })
      ).tools.map((t) => t.effect),
    ).toEqual(["read", "write"]);
    await expect(
      access.authorizeExternalInvocation(f.deps, f.owner, invocation),
    ).resolves.toMatchObject({ effect: "write" });
  }
});
it("accepts expired bans but rejects expired sessions, deadlines and replaced owner credentials", async () => {
  const f = await fixture();
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.readId);
  await f.db.user.update({
    where: { id: f.owner.userId },
    data: { banned: true, banExpires: new Date(0) },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).resolves.toMatchObject({ effect: "read" });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, {
      ...invocation,
      deadline: new Date(0),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  const session = await f.db.session.create({
    data: {
      userId: f.owner.userId,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  await expect(
    access.authorizeExternalInvocation(
      f.deps,
      { ...f.owner, credentialId: session.id },
      invocation,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await f.db.session.update({
    where: { id: f.owner.credentialId },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
it("checks stored schema types and support status for availability and execution", async () => {
  const f = await fixture();
  const definition = {
    name: "read",
    inputSchema: {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    },
    supportStatus: { available: true },
  };
  const { canonicalDigest } = await import("@weaver/core/externalMcp/digest");
  const remoteDigest = canonicalDigest(definition);
  await f.db.externalMcpTool.update({
    where: { id: f.readId },
    data: {
      reviewedDefinition: definition,
      discoveredDefinition: definition,
      discoveredRemoteDigest: remoteDigest,
      reviewedRemoteDigest: remoteDigest,
      reviewDigest: canonicalDigest({ remoteDigest, effect: "read" }),
    },
  });
  const { invocation, scope } = await makeAssistantInvocation(
    f,
    f.owner,
    f.readId,
  );
  const invalidArguments: ExternalInvocation["arguments"][] = [
    {},
    { count: "1" },
    { count: 1, other: true },
  ];
  for (const args of invalidArguments)
    await expect(
      access.authorizeExternalInvocation(f.deps, f.owner, {
        ...invocation,
        arguments: args,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, {
      ...invocation,
      arguments: { count: 1 },
    }),
  ).resolves.toMatchObject({ effect: "read" });
  const unsupported = {
    ...definition,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", pattern: ".+" } },
    },
    supportStatus: { available: false, reason: "UNSUPPORTED_SCHEMA" },
  };
  const digest = canonicalDigest(unsupported);
  await f.db.externalMcpTool.update({
    where: { id: f.readId },
    data: {
      reviewedDefinition: unsupported,
      discoveredDefinition: unsupported,
      reviewedRemoteDigest: digest,
      discoveredRemoteDigest: digest,
      reviewDigest: canonicalDigest({ remoteDigest: digest, effect: "read" }),
    },
  });
  expect(
    (
      await access.listAvailableExternalTools(f.deps, f.owner, { scope })
    ).tools.map((t) => t.effect),
  ).toEqual(["write"]);
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, invocation),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});

it("loads project membership once for availability", async () => {
  const f = await fixture();
  const { scope } = await makeAssistantInvocation(f, f.owner, f.readId);
  const one = vi.spyOn(f.db.project, "findFirst");
  const many = vi.spyOn(f.db.project, "findMany");
  try {
    const available = await access.listAvailableExternalTools(f.deps, f.owner, {
      scope,
    });
    expect(available.tools.map((tool) => tool.effect)).toEqual([
      "read",
      "write",
    ]);
    expect(one.mock.calls.length + many.mock.calls.length).toBeLessThanOrEqual(
      1,
    );
  } finally {
    one.mockRestore();
    many.mockRestore();
  }
});

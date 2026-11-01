import { beforeEach, expect, it } from "vitest";
import * as access from "@weaver/core/services/externalMcp/access";
import {
  loadExternalToolsForRun,
  ownsEnabledExternalConnection,
} from "@weaver/core/services/externalMcp";
import { createConversation } from "@weaver/core/services/assistantConversations";
import { resetDb } from "./_harness";
import {
  makeAssistantInvocation,
  makeEnabledExternalFixture,
} from "./_externalMcpFixtures";

beforeEach(resetDb);

async function loadedFixture() {
  const f = await makeEnabledExternalFixture("read_counter");
  const made = await makeAssistantInvocation(f, f.owner, f.readId);
  await f.db.assistantMessage.update({
    where: { id: made.userMessageId },
    data: { content: { text: "Read external input" } },
  });
  const owner = made.invocation.owner as { runId: string; attemptId: string };
  const snapshot = {
    connectionId: f.connectionId,
    toolId: f.readId,
    configRevision: made.invocation.expectedConfigRevision,
    toolDigest: made.invocation.expectedToolDigest,
  };
  const load = (snapshots = [snapshot], actor = f.owner) =>
    loadExternalToolsForRun(f.deps, actor, {
      runId: owner.runId,
      attemptId: owner.attemptId,
      snapshots,
    });
  const stored = async () =>
    (
      (
        await f.db.assistantMessage.findUniqueOrThrow({
          where: { id: made.userMessageId },
        })
      ).content as { externalToolSnapshots?: unknown }
    ).externalToolSnapshots;
  return { ...f, ...made, owner_: owner, snapshot, load, stored };
}

it("loads reviewed tools onto the triggering message and authorizes calls by snapshot alone", async () => {
  const f = await loadedFixture();
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, f.invocation),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(await f.load()).toEqual({ loaded: [f.snapshot], refused: [] });
  expect(await f.stored()).toEqual([f.snapshot]);
  await expect(
    access.authorizeExternalInvocation(f.deps, f.owner, f.invocation),
  ).resolves.toBeTruthy();
});

it("refuses changed, unknown and foreign tools without storing them", async () => {
  const f = await loadedFixture();
  const unknown = { ...f.snapshot, toolId: crypto.randomUUID() };
  await f.db.externalMcpConnection.update({
    where: { id: f.connectionId },
    data: { revision: { increment: 1 } },
  });
  expect(await f.load([f.snapshot, unknown])).toEqual({
    loaded: [],
    refused: [
      { toolId: f.readId, reason: "CHANGED" },
      { toolId: unknown.toolId, reason: "UNKNOWN_TOOL" },
    ],
  });
  expect(await f.stored()).toBeUndefined();
  await expect(f.load([f.snapshot], f.outsider)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

it("caps loaded tools at twenty per run and lets a loaded tool reload", async () => {
  const f = await loadedFixture();
  const filler = Array.from({ length: 20 }, () => ({
    ...f.snapshot,
    toolId: crypto.randomUUID(),
  }));
  await f.db.assistantMessage.update({
    where: { id: f.userMessageId },
    data: { content: { text: "x", externalToolSnapshots: filler } },
  });
  expect((await f.load()).refused).toEqual([
    { toolId: f.readId, reason: "LIMIT_REACHED" },
  ]);
  await f.db.assistantMessage.update({
    where: { id: f.userMessageId },
    data: {
      content: {
        text: "x",
        externalToolSnapshots: [...filler.slice(0, 19), f.snapshot],
      },
    },
  });
  expect((await f.load()).loaded).toEqual([f.snapshot]);
  expect(await f.stored()).toHaveLength(20);
});

it("requires the live attempt", async () => {
  const f = await loadedFixture();
  await f.db.assistantRunAttempt.update({
    where: { id: f.owner_.attemptId },
    data: { leaseExpiresAt: new Date(0) },
  });
  await expect(f.load()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});

it("reports enabled connection ownership", async () => {
  const f = await makeEnabledExternalFixture("read_counter");
  expect(await ownsEnabledExternalConnection(f.db, f.owner.userId)).toBe(true);
  expect(await ownsEnabledExternalConnection(f.db, f.outsider.userId)).toBe(
    false,
  );
  await f.db.externalMcpConnection.update({
    where: { id: f.connectionId },
    data: { enabled: false },
  });
  expect(await ownsEnabledExternalConnection(f.db, f.owner.userId)).toBe(false);
});

it("marks history-scope refusals and exposes snapshot fields on available tools", async () => {
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
  const scope = {
    kind: "project" as const,
    projectIds: [f.project.id],
    documentId: null,
    tableId: null,
    resolvedAt: new Date().toISOString(),
    truncated: false,
  };
  await expect(
    access.listAvailableExternalTools(f.deps, f.owner, {
      scope,
      conversationId: c.id,
    }),
  ).rejects.toMatchObject({ details: { reason: "EXTERNAL_HISTORY_SCOPE" } });
  const tool = await f.db.externalMcpTool.findUniqueOrThrow({
    where: { id: f.readId },
    include: { connection: true },
  });
  const available = await access.listAvailableExternalTools(f.deps, f.owner, {
    scope,
  });
  expect(available.tools.find((t) => t.id === f.readId)).toMatchObject({
    configRevision: tool.connection.revision,
    reviewDigest: tool.reviewDigest,
  });
});

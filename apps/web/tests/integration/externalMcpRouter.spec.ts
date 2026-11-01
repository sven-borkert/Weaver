import { beforeEach, expect, it } from "vitest";
import { createExternalConnection } from "@weaver/core/services/externalMcp";
import {
  discoverExternalConnection,
  reviewExternalTools,
} from "@weaver/core/services/externalMcp";
import { callerWithSecurity, resetDb } from "./_harness";
import {
  makeExternalApproval,
  makeEnabledExternalFixture,
  makeExternalFixture,
} from "./_externalMcpFixtures";

beforeEach(resetDb);

const userFor = (actor: { userId: string; globalRole: "Admin" | "User" }) => ({
  id: actor.userId,
  role: actor.globalRole,
  email: `${actor.userId}@test.local`,
});

it("keeps configuration owner-only and all router DTOs secret-free", async () => {
  const f = await makeExternalFixture();
  const mine = callerWithSecurity(userFor(f.owner), f.owner);
  const admin = callerWithSecurity(userFor(f.admin), f.admin);
  const created = await mine.externalMcp.create({
    name: "Router fixture",
    endpoint: "https://router.test/mcp",
    authMode: "bearer",
    token: "router-secret",
  });
  const detail = await mine.externalMcp.get({ id: created.id });
  expect(JSON.stringify(detail)).not.toMatch(
    /router-secret|ciphertext|credentialIv|credentialTag/i,
  );
  expect((await admin.externalMcp.list({ limit: 25 })).items).toEqual([]);
  await expect(
    admin.externalMcp.update({
      id: created.id,
      expectedRevision: created.revision,
      patch: { name: "Foreign edit" },
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("pages connections and filters an exact connection catalog without leaking private fields", async () => {
  const f = await makeExternalFixture();
  const mine = callerWithSecurity(userFor(f.owner), f.owner);
  for (let index = 0; index < 26; index++)
    await createExternalConnection(f.deps, f.owner, {
      name: `Paged ${String(index).padStart(2, "0")}`,
      endpoint: `https://page-${index}.test/mcp`,
      authMode: "none",
    });
  const first = await mine.externalMcp.list({ limit: 25, search: "Paged" });
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).toBeTypeOf("string");
  const second = await mine.externalMcp.list({
    limit: 25,
    search: "Paged",
    cursor: first.nextCursor!,
  });
  expect(second.items).toHaveLength(1);
  expect(JSON.stringify([first, second])).not.toMatch(
    /ciphertext|credentialIv|credentialTag|authorization|token/i,
  );

  const connection = await createExternalConnection(f.deps, f.owner, {
    name: "Catalog filters",
    endpoint: "https://example.test/mcp",
    authMode: "none",
  });
  await discoverExternalConnection(f.deps, f.owner, {
    id: connection.id,
    expectedRevision: connection.revision,
  });
  const catalog = await mine.externalMcp.tools({
    connectionId: connection.id,
    reviewState: "unreviewed",
    limit: 25,
    search: "read",
  });
  expect(catalog.items.map((tool) => tool.remoteName)).toEqual(["read"]);
  const [reviewed] = await reviewExternalTools(f.deps, f.owner, {
    connectionId: connection.id,
    items: [
      {
        toolId: catalog.items[0]!.id,
        expectedRemoteDigest: catalog.items[0]!.discoveredRemoteDigest,
        enabled: false,
        effect: "read",
      },
    ],
  });
  const reads = await mine.externalMcp.tools({
    connectionId: connection.id,
    reviewState: "reviewed",
    effect: "read",
    limit: 25,
  });
  expect(reads.items).toMatchObject([{ id: reviewed!.id, effect: "read" }]);
  expect(JSON.stringify(reads)).not.toMatch(
    /ciphertext|credentialIv|credentialTag|authorization|token/i,
  );
});

it("does not let global Admin replace project membership for tool availability", async () => {
  const f = await makeExternalFixture();
  const connection = await createExternalConnection(f.deps, f.owner, {
    name: "Unavailable",
    endpoint: "https://example.test/mcp",
    authMode: "none",
  });
  const admin = callerWithSecurity(userFor(f.admin), f.admin);
  await expect(
    admin.externalMcp.availability({
      scope: { kind: "project", projectId: f.project.id },
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(connection.enabled).toBe(false);
});

it("does not expose or decide another owner's exact-call approval", async () => {
  const f = await makeEnabledExternalFixture();
  const approval = await makeExternalApproval(f, f.connectionId, f.readId);
  const outsider = callerWithSecurity(userFor(f.outsider), f.outsider);
  await expect(
    outsider.externalMcp.listCalls({ runId: approval.runId }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  await expect(
    outsider.externalMcp.getApproval({ id: approval.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    outsider.externalMcp.decideApproval({
      id: approval.id,
      decision: "approve",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("returns bounded owner call activity through the session router", async () => {
  const f = await makeEnabledExternalFixture();
  const { makeAssistantInvocation } = await import("./_externalMcpFixtures");
  const { prepareExternalCall } =
    await import("@weaver/core/services/externalMcp");
  const { invocation } = await makeAssistantInvocation(f, f.owner, f.readId);
  const call = await prepareExternalCall(f.deps, f.owner, invocation);
  const owner = callerWithSecurity(userFor(f.owner), f.owner);
  const page = await owner.externalMcp.listCalls({
    runId: invocation.owner.runId,
  });
  expect(page.calls).toMatchObject([
    { callId: call.callId, connectionId: f.connectionId, status: "prepared" },
  ]);
  expect(page.nextAfter).toBeNull();
});

it("reviews tools in bulk and lists filter keys through the router", async () => {
  const { getExternalConnection } =
    await import("@weaver/core/services/externalMcp");
  const f = await makeExternalFixture();
  const created = await createExternalConnection(f.deps, f.owner, {
    name: "Router bulk",
    endpoint: "https://example.test/mcp",
    authMode: "none",
  });
  await discoverExternalConnection(f.deps, f.owner, {
    id: created.id,
    expectedRevision: created.revision,
  });
  const mine = callerWithSecurity(userFor(f.owner), f.owner);
  const keys = await mine.externalMcp.toolKeys({
    connectionId: created.id,
    search: "rea",
  });
  expect(keys.items.map((k) => [k.remoteName, k.state])).toEqual([
    ["read", "new"],
  ]);
  const saved = await mine.externalMcp.reviewTools({
    connectionId: created.id,
    items: keys.items.map((k) => ({
      toolId: k.id,
      expectedRemoteDigest: k.discoveredRemoteDigest,
      enabled: true,
    })),
  });
  expect(saved[0]).toMatchObject({
    remoteName: "read",
    enabled: true,
    effect: "write",
  });
  const enabled = await mine.externalMcp.tools({
    connectionId: created.id,
    enabled: true,
  });
  expect(enabled.items.map((t) => t.remoteName)).toEqual(["read"]);
  expect(
    (await getExternalConnection(f.db, f.owner, created.id)).revision,
  ).toBe(created.revision + 2);
  await expect(
    callerWithSecurity(userFor(f.outsider), f.outsider).externalMcp.toolKeys({
      connectionId: created.id,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

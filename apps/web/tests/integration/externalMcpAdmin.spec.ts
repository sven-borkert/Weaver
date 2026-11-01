import * as diagnosticWriter from "@weaver/core/diagnostics/writer";
import { beforeEach, expect, it } from "vitest";
import {
  apiKeyPermissionsFromCapabilities,
  createApiKeySecurityContext,
  createOAuthSecurityContext,
  createTaskSecurityContext,
} from "@weaver/core/security/context";
import {
  createExternalConnection,
  getExternalConnection,
  listExternalConnections,
} from "@weaver/core/services/externalMcp";
import { resetDb } from "./_harness";
import { makeExternalFixture } from "./_externalMcpFixtures";
beforeEach(resetDb);
it("creates owner-only connections with secret-free DTOs", async () => {
  const f = await makeExternalFixture();
  const result = await createExternalConnection(f.deps, f.owner, {
    name: "Example",
    endpoint: "https://example.test/mcp",
    authMode: "bearer",
    token: "fixture-secret",
  });
  expect(result).toMatchObject({ enabled: false });
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(
    Object.keys(result).some((key) =>
      /ciphertext|credentialIv|credentialTag/i.test(key),
    ),
  ).toBe(false);
  await expect(
    getExternalConnection(f.db, f.outsider, result.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    getExternalConnection(f.db, f.admin, result.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await listExternalConnections(f.db, f.admin, {})).items).toEqual([]);
  await expect(
    createExternalConnection(
      f.deps,
      createTaskSecurityContext({
        userId: f.owner.userId,
        globalRole: "User",
        runId: "r1",
      }),
      { name: "Task", endpoint: "https://example.test/mcp", authMode: "none" },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("requires mcp:use alongside external:manage for OAuth and API-key principals", async () => {
  const f = await makeExternalFixture();
  const oauth = (scopes: string[]) =>
    createOAuthSecurityContext({
      userId: f.owner.userId,
      globalRole: "User",
      tokenId: "token-1",
      scopes,
    });
  await expect(
    listExternalConnections(f.db, oauth(["external:manage"]), {}),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    listExternalConnections(f.db, oauth(["mcp:use", "external:manage"]), {}),
  ).resolves.toMatchObject({ items: [] });
  // Keys always carry mcp:use today; the gate must not rely on that default.
  const key = createApiKeySecurityContext({
    userId: f.owner.userId,
    globalRole: "User",
    keyId: "key-1",
    permissions: apiKeyPermissionsFromCapabilities(["external:manage"]),
    projectIds: [],
  });
  await expect(
    listExternalConnections(
      f.db,
      { ...key, capabilities: new Set(["external:manage"] as const) },
      {},
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(listExternalConnections(f.db, key, {})).resolves.toMatchObject({
    items: [],
  });
});

it("keeps names unique per owner and pins duplicates to the name field", async () => {
  const f = await makeExternalFixture();
  const input = {
    name: "Example",
    endpoint: "https://example.test/mcp",
    authMode: "none" as const,
  };
  await createExternalConnection(f.deps, f.owner, input);
  await expect(
    createExternalConnection(f.deps, f.outsider, input),
  ).resolves.toMatchObject({ name: "Example" });
  await expect(
    createExternalConnection(f.deps, f.owner, input),
  ).rejects.toMatchObject({ code: "CONFLICT", details: { field: "name" } });
});

it("creates an enabled connection when asked", async () => {
  const f = await makeExternalFixture();
  await expect(
    createExternalConnection(f.deps, f.owner, {
      name: "Enabled",
      endpoint: "https://example.test/mcp",
      authMode: "none",
      enabled: true,
    }),
  ).resolves.toMatchObject({ enabled: true });
});

import { vi } from "vitest";
import { ExternalMcpError } from "@weaver/external-mcp";
import {
  discoverExternalConnection,
  updateExternalConnection,
  listExternalTools,
  reviewExternalTools,
  deleteExternalConnection,
  assertExternalMcpSecretsDecryptable,
  rotateExternalMcpSecrets,
} from "@weaver/core/services/externalMcp";
import {
  decryptExternalConnectionCredential,
  decryptExternalSecret,
} from "@weaver/core/services/externalMcp/credentials";
import { makeExternalApproval } from "./_externalMcpFixtures";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
const create = (f: Awaited<ReturnType<typeof makeExternalFixture>>) =>
  createExternalConnection(f.deps, f.owner, {
    name: "Example",
    endpoint: "https://example.test/mcp",
    authMode: "bearer",
    token: "fixture-secret",
  });
async function discovered(f: Awaited<ReturnType<typeof makeExternalFixture>>) {
  const c = await create(f);
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  return getExternalConnection(f.db, f.owner, c.id);
}
it("keeps/replaces/removes credentials and binds live reads to their destination", async () => {
  const f = await makeExternalFixture();
  let c = await create(f);
  const token = () =>
    decryptExternalConnectionCredential(
      f.db,
      f.ring,
      c.id,
      "https://example.test/mcp",
    );
  c = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { name: "Renamed" },
  });
  expect(await token()).toBe("fixture-secret");
  c = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { token: "replacement" },
  });
  expect(await token()).toBe("replacement");
  c = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { authMode: "none" },
  });
  expect(await token()).toBeNull();
  await expect(
    updateExternalConnection(f.deps, f.owner, {
      id: c.id,
      expectedRevision: c.revision,
      patch: { authMode: "bearer" },
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  c = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { endpoint: "https://other.test/mcp" },
  });
  await expect(token()).rejects.toMatchObject({ code: "CONFLICT" });
});
it("never carries a kept bearer token to a different endpoint origin", async () => {
  const f = await makeExternalFixture();
  let c = await create(f);
  const token = (endpoint: string) =>
    decryptExternalConnectionCredential(f.db, f.ring, c.id, endpoint);
  await expect(
    updateExternalConnection(f.deps, f.owner, {
      id: c.id,
      expectedRevision: c.revision,
      patch: { endpoint: "https://other.test/mcp" },
    }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    details: { field: "token" },
  });
  expect(await getExternalConnection(f.db, f.owner, c.id)).toMatchObject({
    endpoint: "https://example.test/mcp",
    revision: c.revision,
  });
  expect(await token("https://example.test/mcp")).toBe("fixture-secret");
  c = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { endpoint: "https://example.test/v2/mcp?tenant=a" },
  });
  expect(await token("https://example.test/v2/mcp?tenant=a")).toBe(
    "fixture-secret",
  );
  c = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { endpoint: "https://other.test/mcp", token: "other-secret" },
  });
  expect(await token("https://other.test/mcp")).toBe("other-secret");
  c = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { endpoint: "https://third.test/mcp", authMode: "none" },
  });
  expect(c).toMatchObject({
    endpoint: "https://third.test/mcp",
    authMode: "none",
  });
  expect(
    await f.db.externalMcpConnection.findUniqueOrThrow({
      where: { id: c.id },
      select: { credentialCiphertext: true },
    }),
  ).toEqual({ credentialCiphertext: null });
});
it("discovers disabled connections without calls, preserves disabled review and handles drift/removal/reappearance", async () => {
  const f = await makeExternalFixture();
  f.calls.catalog.tools[0]!.annotations = { readOnlyHint: true };
  let c = await discovered(f);
  const read = c.tools[0]!;
  expect(read).toMatchObject({
    remoteName: "read",
    effect: "read",
    enabled: false,
  });
  expect(c.tools[1]).toMatchObject({ remoteName: "write", effect: "write" });
  const [reviewed] = await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: read.id,
        expectedRemoteDigest: read.discoveredRemoteDigest,
        enabled: false,
        effect: "read",
      },
    ],
  });
  c = await getExternalConnection(f.db, f.owner, c.id);
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  c = await getExternalConnection(f.db, f.owner, c.id);
  expect(c.tools[0]).toMatchObject({
    enabled: false,
    reviewDigest: reviewed!.reviewDigest,
  });
  f.calls.catalog.tools[0]!.description = "Changed";
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  c = await getExternalConnection(f.db, f.owner, c.id);
  expect(c.tools[0]).toMatchObject({
    enabled: false,
    reviewedRemoteDigest: read.discoveredRemoteDigest,
  });
  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: [
        {
          toolId: read.id,
          expectedRemoteDigest: read.discoveredRemoteDigest,
          enabled: true,
          effect: "read",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: read.id,
        expectedRemoteDigest: c.tools[0]!.discoveredRemoteDigest,
        enabled: true,
        effect: "read",
      },
    ],
  });
  const removed = f.calls.catalog.tools.shift()!;
  c = await getExternalConnection(f.db, f.owner, c.id);
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  c = await getExternalConnection(f.db, f.owner, c.id);
  expect(c.tools.map((t) => t.id)).not.toContain(read.id);
  const gone = (
    await listExternalTools(f.db, f.owner, {
      connectionId: c.id,
      reviewState: "removed",
    })
  ).items;
  expect(gone).toHaveLength(1);
  expect(gone[0]).toMatchObject({
    id: read.id,
    enabled: false,
    presentInCatalog: false,
  });
  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: [
        {
          toolId: read.id,
          expectedRemoteDigest: gone[0]!.discoveredRemoteDigest,
          enabled: true,
          effect: "read",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  f.calls.catalog.tools.unshift(removed);
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  c = await getExternalConnection(f.db, f.owner, c.id);
  expect(c.tools[0]).toMatchObject({ enabled: false, presentInCatalog: true });
  expect(f.calls.tools).toEqual([]);
  expect(f.calls.closed).toBe(5);
});
it("passes the connection's allowInsecureTls setting to the transport on discovery", async () => {
  const f = await makeExternalFixture();
  const created = await createExternalConnection(f.deps, f.owner, {
    name: "Insecure",
    endpoint: "https://example.test/mcp",
    authMode: "none",
    allowInsecureTls: true,
  });
  expect(created.allowInsecureTls).toBe(true);
  await discoverExternalConnection(f.deps, f.owner, {
    id: created.id,
    expectedRevision: created.revision,
  });
  expect(f.calls.opens.at(-1)?.insecureTls).toBe(true);
});
it("rejects stale discovery and reports canonical redirect without changing identity", async () => {
  const f = await makeExternalFixture();
  const c = await create(f);
  f.calls.catalog.canonicalEndpoint =
    "https://example.test/canonical?fixture=1";
  let release!: () => void;
  f.calls.blocked = new Promise((resolve) => {
    release = resolve;
  });
  const discovery = discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  await vi.waitFor(() => expect(f.calls.tokens).toHaveLength(1));
  const edited = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { enabled: true },
  });
  release();
  await expect(discovery).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.db.externalMcpTool.count()).toBe(0);
  const result = await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: edited.revision,
  });
  expect(result.canonicalEndpoint).toBe(f.calls.catalog.canonicalEndpoint);
  expect(result.connection.endpoint).toBe(c.endpoint);
  const updated = await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: result.connection.revision,
    patch: { endpoint: result.canonicalEndpoint! },
  });
  const stale = await f.db.externalMcpTool.findMany({
    where: { connectionId: c.id },
    select: { presentInCatalog: true, enabled: true },
  });
  expect(stale.length).toBeGreaterThan(0);
  expect(stale.every((t) => !t.presentInCatalog && !t.enabled)).toBe(true);
  expect((await getExternalConnection(f.db, f.owner, c.id)).tools).toEqual([]);
  expect(updated.endpoint).toBe(f.calls.catalog.canonicalEndpoint);
});
it("leaves catalog atomic on overflow and redacts failures including 401", async () => {
  const f = await makeExternalFixture();
  const c = await discovered(f);
  const before = c.tools;
  f.calls.catalog.tools = Array.from({ length: 501 }, (_, i) => ({
    ...f.calls.catalog.tools[0]!,
    name: `tool${i}`,
  }));
  const overflow = await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  expect(overflow.status).toBe("failed");
  expect((await getExternalConnection(f.db, f.owner, c.id)).tools).toEqual(
    before,
  );
  f.calls.error = new ExternalMcpError("UNAUTHORIZED");
  const unauthorized = await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  expect(unauthorized.connection.discoveryErrorCode).toBe("UNAUTHORIZED");
  f.calls.error = new Error(
    "Authorization: Bearer fixture-secret https://private.invalid",
  );
  const failure = await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  expect(JSON.stringify(failure)).not.toMatch(
    /fixture-secret|private.invalid|Authorization/,
  );
});
it("rejects unsupported schemas and hides every management entry from other users", async () => {
  const f = await makeExternalFixture();
  f.calls.catalog.tools[0]!.inputSchema = {
    type: "object",
    properties: { value: { type: "string", pattern: "^(a)\\1$" } },
  };
  const c = await discovered(f);
  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: [
        {
          toolId: c.tools[0]!.id,
          expectedRemoteDigest: c.tools[0]!.discoveredRemoteDigest,
          enabled: true,
          effect: "read",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect((await listExternalConnections(f.db, f.outsider, {})).items).toEqual(
    [],
  );
  for (const action of [
    () => getExternalConnection(f.db, f.outsider, c.id),
    () =>
      updateExternalConnection(f.deps, f.outsider, {
        id: c.id,
        expectedRevision: c.revision,
        patch: { enabled: true },
      }),
    () =>
      deleteExternalConnection(f.db, f.outsider, {
        id: c.id,
        expectedRevision: c.revision,
      }),
    () =>
      discoverExternalConnection(f.deps, f.outsider, {
        id: c.id,
        expectedRevision: c.revision,
      }),
    () =>
      reviewExternalTools(f.deps, f.outsider, {
        connectionId: c.id,
        items: [
          {
            toolId: c.tools[0]!.id,
            expectedRemoteDigest: c.tools[0]!.discoveredRemoteDigest,
            enabled: true,
            effect: "read",
          },
        ],
      }),
  ])
    await expect(action()).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("invalidates pending and approved prepared calls atomically while retaining dispatched arguments", async () => {
  const f = await makeExternalFixture();
  const c = await discovered(f);
  const pending = await makeExternalApproval(f, c.id, c.tools[0]!.id);
  const approved = await makeExternalApproval(
    f,
    c.id,
    c.tools[0]!.id,
    "approved",
  );
  const dispatched = await makeExternalApproval(
    f,
    c.id,
    c.tools[0]!.id,
    "approved",
  );
  await f.db.externalMcpCall.update({
    where: { id: dispatched.callId },
    data: { status: "dispatched", dispatchedAt: f.deps.now() },
  });
  await expect(
    updateExternalConnection(f.deps, f.owner, {
      id: c.id,
      expectedRevision: 1,
      patch: { enabled: true },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    (
      await f.db.externalMcpToolApproval.findUniqueOrThrow({
        where: { id: pending.id },
      })
    ).state,
  ).toBe("pending");
  await updateExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
    patch: { enabled: true },
  });
  expect(
    await f.db.externalMcpToolApproval.findUniqueOrThrow({
      where: { id: pending.id },
    }),
  ).toMatchObject({
    state: "invalidated",
    pendingArgumentsCiphertext: null,
    pendingArgumentsKeyVersion: null,
    pendingArgumentsIv: null,
    pendingArgumentsTag: null,
  });
  expect(
    await f.db.externalMcpToolApproval.findUniqueOrThrow({
      where: { id: approved.id },
    }),
  ).toMatchObject({
    state: "invalidated",
    pendingArgumentsCiphertext: null,
    pendingArgumentsKeyVersion: null,
    pendingArgumentsIv: null,
    pendingArgumentsTag: null,
  });
  expect(
    await f.db.externalMcpToolApproval.findUniqueOrThrow({
      where: { id: dispatched.id },
    }),
  ).toMatchObject({
    state: "approved",
    pendingArgumentsCiphertext: dispatched.pendingArgumentsCiphertext,
    pendingArgumentsKeyVersion: dispatched.pendingArgumentsKeyVersion,
    pendingArgumentsIv: dispatched.pendingArgumentsIv,
    pendingArgumentsTag: dispatched.pendingArgumentsTag,
  });
});
it("checks all encrypted payloads, rotates both kinds, and cannot overwrite concurrent credential edits", async () => {
  const f = await makeExternalFixture();
  const c = await discovered(f);
  const approval = await makeExternalApproval(
    f,
    c.id,
    c.tools[0]!.id,
    "approved",
  );
  await f.db.externalMcpCall.update({
    where: { id: approval.callId },
    data: { status: "dispatched", dispatchedAt: f.deps.now() },
  });
  await expect(
    assertExternalMcpSecretsDecryptable(f.db, null),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  const ring = {
    activeVersion: f.ring.activeVersion + 1,
    keys: new Map([
      ...f.ring.keys,
      [f.ring.activeVersion + 1, Buffer.alloc(32, 3)],
    ]),
  };
  const original = f.db.externalMcpConnection.updateMany.bind(
    f.db.externalMcpConnection,
  );
  const spy = vi
    .spyOn(f.db.externalMcpConnection, "updateMany")
    .mockImplementationOnce((async (args: Parameters<typeof original>[0]) => {
      await updateExternalConnection(f.deps, f.owner, {
        id: c.id,
        expectedRevision: c.revision,
        patch: { token: "concurrent-edit" },
      });
      return original(args);
    }) as unknown as typeof original);
  const rotated = await rotateExternalMcpSecrets(f.db, ring);
  spy.mockRestore();
  expect(rotated).toEqual({ rotated: 1, skipped: 1 });
  expect(
    await decryptExternalConnectionCredential(f.db, ring, c.id, c.endpoint),
  ).toBe("concurrent-edit");
  const row = await f.db.externalMcpToolApproval.findUniqueOrThrow({
    where: { id: approval.id },
  });
  expect(row.pendingArgumentsKeyVersion).toBe(ring.activeVersion);
  expect(
    decryptExternalSecret(
      ring,
      {
        ciphertext: row.pendingArgumentsCiphertext,
        keyVersion: row.pendingArgumentsKeyVersion,
        iv: row.pendingArgumentsIv,
        tag: row.pendingArgumentsTag,
      },
      "approval",
      row.id,
    ),
  ).toContain("private-arguments");
  expect(await rotateExternalMcpSecrets(f.db, ring)).toEqual({
    rotated: 1,
    skipped: 1,
  });
  await assertExternalMcpSecretsDecryptable(f.db, ring);
  await expect(
    assertExternalMcpSecretsDecryptable(f.db, f.ring),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});
it("blocks deletion used by scheduled task inputs and bounds list pagination", async () => {
  const f = await makeExternalFixture();
  const c = await discovered(f);
  const task = await f.db.scheduledTask.create({
    data: {
      ownerId: f.owner.userId,
      name: "Report",
      instruction: "Report",
      scopeRequest: { kind: "all" },
      scopeSnapshot: { kind: "all" },
      outputProjectId: f.project.id,
      outputFolderPath: [],
      schedule: { kind: "daily", time: "08:00" },
      timezone: "UTC",
      cron: "0 8 * * *",
    },
  });
  const input = await f.db.scheduledTaskExternalInput.create({
    data: {
      taskId: task.id,
      position: 0,
      name: "Source",
      toolId: c.tools[0]!.id,
      argumentBindings: {},
      createdAt: f.deps.now(),
    },
  });
  await expect(
    deleteExternalConnection(f.db, f.owner, {
      id: c.id,
      expectedRevision: c.revision,
    }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining(`"${task.name}"`),
  });
  await f.db.scheduledTaskExternalInput.delete({ where: { id: input.id } });
  await createExternalConnection(f.deps, f.owner, {
    name: "Second",
    endpoint: c.endpoint,
    authMode: "none",
  });
  const page = await listExternalConnections(f.db, f.owner, { limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).not.toBeNull();
  expect(
    (
      await listExternalConnections(f.db, f.owner, {
        limit: 1,
        cursor: page.nextCursor!,
      })
    ).items,
  ).toHaveLength(1);
  expect(
    (
      await listExternalConnections(f.db, f.owner, { search: "example" })
    ).items.map((i) => i.id),
  ).toEqual([c.id]);
  await expect(
    listExternalConnections(f.db, f.owner, { limit: 101 }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await deleteExternalConnection(f.db, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  await expect(
    getExternalConnection(f.db, f.owner, c.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("serializes competing revisions and returns safe conflicts for duplicate edits", async () => {
  const f = await makeExternalFixture();
  const c = await create(f);
  await createExternalConnection(f.deps, f.owner, {
    name: "Taken",
    endpoint: c.endpoint,
    authMode: "none",
  });
  await expect(
    updateExternalConnection(f.deps, f.owner, {
      id: c.id,
      expectedRevision: c.revision,
      patch: { name: "Taken", token: "not-in-errors" },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const results = await Promise.allSettled(
    [true, false].map((enabled) =>
      updateExternalConnection(f.deps, f.owner, {
        id: c.id,
        expectedRevision: c.revision,
        patch: { enabled },
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "CONFLICT" },
  });
});
it("bounds connection tool previews even when removed history accumulates", async () => {
  const f = await makeExternalFixture();
  f.calls.catalog.tools = Array.from({ length: 26 }, (_, i) => ({
    ...f.calls.catalog.tools[0]!,
    name: `tool${i}`,
  }));
  const c = await discovered(f);
  expect(c.tools).toHaveLength(25);
  expect(c).toMatchObject({ totalTools: 26, toolsTruncated: true });
});
it("pages and filters current and historical catalog reviews", async () => {
  const f = await makeExternalFixture();
  let c = await discovered(f);
  await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: c.tools[0]!.id,
        expectedRemoteDigest: c.tools[0]!.discoveredRemoteDigest,
        enabled: true,
        effect: "read",
      },
    ],
  });
  expect(
    (
      await listExternalTools(f.db, f.owner, {
        connectionId: c.id,
        reviewState: "reviewed",
        effect: "read",
      })
    ).items.map((t) => t.remoteName),
  ).toEqual(["read"]);
  expect(
    (
      await listExternalTools(f.db, f.owner, {
        connectionId: c.id,
        reviewState: "unreviewed",
      })
    ).items.map((t) => t.remoteName),
  ).toEqual(["write"]);
  const first = await listExternalTools(f.db, f.owner, {
    connectionId: c.id,
    limit: 1,
  });
  const second = await listExternalTools(f.db, f.owner, {
    connectionId: c.id,
    limit: 1,
    cursor: first.nextCursor!,
  });
  expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  expect(second.nextCursor).toBeNull();
  f.calls.catalog.tools[0]!.description = "Changed";
  f.calls.catalog.tools.pop();
  c = await getExternalConnection(f.db, f.owner, c.id);
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  expect(
    (
      await listExternalTools(f.db, f.owner, {
        connectionId: c.id,
        reviewState: "changed",
        search: "READ",
      })
    ).items.map((t) => t.remoteName),
  ).toEqual(["read"]);
  expect(
    (
      await listExternalTools(f.db, f.owner, {
        connectionId: c.id,
        reviewState: "removed",
      })
    ).items.map((t) => t.remoteName),
  ).toEqual(["write"]);
  const current = await listExternalTools(f.db, f.owner, {
    connectionId: c.id,
    limit: 1,
  });
  expect(current.items.map((t) => t.remoteName)).toEqual(["read"]);
  expect(current.nextCursor).toBeNull();
  expect(await getExternalConnection(f.db, f.owner, c.id)).toMatchObject({
    totalTools: 1,
  });
  await expect(
    listExternalTools(f.db, f.owner, {
      connectionId: c.id,
      cursor: encodePageCursor(["alpha", "not-a-uuid"]),
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    listExternalTools(f.db, f.outsider, { connectionId: c.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("emits safe discovery failure evidence only after the failure summary commits", async () => {
  const f = await makeExternalFixture();
  const connection = await createExternalConnection(f.deps, f.owner, {
    name: "private name",
    endpoint: "https://example.test/mcp",
    authMode: "none",
  });
  f.calls.error = new Error("private response token argument");
  const emit = vi.spyOn(diagnosticWriter, "emitDiagnostic");
  try {
    const result = await discoverExternalConnection(f.deps, f.owner, {
      id: connection.id,
      expectedRevision: connection.revision,
    });
    expect(result.status).toBe("failed");
    const events = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.event === "external.discovery.completed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "error",
      connectionId: connection.id,
      details: { errorCode: "TRANSPORT_ERROR" },
    });
    expect(JSON.stringify(events)).not.toMatch(
      /private|example.test|argument|token/,
    );
    await expect(
      discoverExternalConnection(f.deps, f.owner, {
        id: connection.id,
        expectedRevision: connection.revision + 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      emit.mock.calls.filter(
        ([event]) => event.event === "external.discovery.completed",
      ),
    ).toHaveLength(1);
  } finally {
    emit.mockRestore();
  }
});

it("stores the discovered description for catalog search", async () => {
  const f = await makeExternalFixture();
  f.calls.catalog.tools[0]!.description = "Reads Specified Nodes";
  const c = await discovered(f);
  const read = c.tools.find((t) => t.remoteName === "read")!;
  expect(read.description).toBe("Reads Specified Nodes");
  expect(c.tools.find((t) => t.remoteName === "write")!.description).toBeNull();
});

it("keeps an unreviewed tool's effect in step with readOnlyHint while a reviewed tool keeps the owner's", async () => {
  const f = await makeExternalFixture();
  for (const tool of f.calls.catalog.tools)
    tool.annotations = { readOnlyHint: true };
  let c = await discovered(f);
  const effects = () =>
    Object.fromEntries(c.tools.map((t) => [t.remoteName, t.effect]));
  const rediscover = async () => {
    c = await getExternalConnection(f.db, f.owner, c.id);
    await discoverExternalConnection(f.deps, f.owner, {
      id: c.id,
      expectedRevision: c.revision,
    });
    c = await getExternalConnection(f.db, f.owner, c.id);
  };
  expect(effects()).toEqual({ read: "read", write: "read" });
  const reviewed = c.tools.find((t) => t.remoteName === "write")!;
  await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: reviewed.id,
        expectedRemoteDigest: reviewed.discoveredRemoteDigest,
        enabled: false,
        effect: "read",
      },
    ],
  });
  for (const tool of f.calls.catalog.tools) delete tool.annotations;
  await rediscover();
  expect(effects()).toEqual({ read: "write", write: "read" });
  f.calls.catalog.tools[0]!.annotations = { readOnlyHint: true };
  await rediscover();
  expect(effects()).toEqual({ read: "read", write: "read" });
});

it("narrows key listings to tools whose current definition is read-only", async () => {
  const { listExternalToolKeys } =
    await import("@weaver/core/services/externalMcp");
  const f = await makeExternalFixture();
  f.calls.catalog.tools = ["changed", "fresh", "plain"].map((name) => ({
    name,
    annotations: { readOnlyHint: name === "plain" ? "true" : true },
    inputSchema: { type: "object", properties: {} },
    supportStatus: { available: true as const },
  }));
  let c = await discovered(f);
  const changed = c.tools.find((t) => t.remoteName === "changed")!;
  await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: changed.id,
        expectedRemoteDigest: changed.discoveredRemoteDigest,
        enabled: true,
        effect: "read",
      },
    ],
  });
  delete f.calls.catalog.tools[0]!.annotations;
  c = await getExternalConnection(f.db, f.owner, c.id);
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  const keys = async (filter: Record<string, unknown>) =>
    (
      await listExternalToolKeys(f.db, f.owner, {
        connectionId: c.id,
        ...filter,
      })
    ).items.map((k) => [k.remoteName, k.state]);
  const quick = { effect: "read", enabled: false };
  expect(await keys(quick)).toEqual([
    ["changed", "changed"],
    ["fresh", "new"],
  ]);
  expect(await keys({ ...quick, suggestedEffect: "read" })).toEqual([
    ["fresh", "new"],
  ]);
  expect(
    await keys({ suggestedEffect: "read", reviewState: "unsupported" }),
  ).toEqual([]);
  expect(await keys({ suggestedEffect: "read", search: "e" })).toEqual([
    ["fresh", "new"],
  ]);
});

it("searches names and descriptions, filters enabled, orders by name, and lists keys", async () => {
  const { listExternalTools, listExternalToolKeys, getExternalTool } =
    await import("@weaver/core/services/externalMcp");
  const f = await makeExternalFixture();
  f.calls.catalog.tools = ["zeta", "alpha", "mid"].map((name) => ({
    name,
    ...(name === "zeta" ? { description: "Lists Applications" } : {}),
    inputSchema: { type: "object", properties: {} },
    supportStatus: { available: true as const },
  }));
  const c = await discovered(f);
  const names = (items: { remoteName: string }[]) =>
    items.map((t) => t.remoteName);

  expect(
    names(
      (await listExternalTools(f.db, f.owner, { connectionId: c.id })).items,
    ),
  ).toEqual(["alpha", "mid", "zeta"]);
  expect(
    names(
      (
        await listExternalTools(f.db, f.owner, {
          connectionId: c.id,
          search: "applications",
        })
      ).items,
    ),
  ).toEqual(["zeta"]);

  const first = await listExternalTools(f.db, f.owner, {
    connectionId: c.id,
    limit: 2,
  });
  const rest = await listExternalTools(f.db, f.owner, {
    connectionId: c.id,
    limit: 2,
    cursor: first.nextCursor!,
  });
  expect(names([...first.items, ...rest.items])).toEqual([
    "alpha",
    "mid",
    "zeta",
  ]);
  expect(rest.nextCursor).toBeNull();

  const alpha = first.items[0]!;
  await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: alpha.id,
        expectedRemoteDigest: alpha.discoveredRemoteDigest,
        enabled: true,
        effect: "read",
      },
    ],
  });
  expect(
    names(
      (
        await listExternalTools(f.db, f.owner, {
          connectionId: c.id,
          enabled: true,
        })
      ).items,
    ),
  ).toEqual(["alpha"]);

  const keys = await listExternalToolKeys(f.db, f.owner, {
    connectionId: c.id,
    enabled: false,
  });
  expect(keys.items).toEqual([
    {
      id: expect.any(String),
      remoteName: "mid",
      discoveredRemoteDigest: expect.any(String),
      state: "new",
    },
    {
      id: expect.any(String),
      remoteName: "zeta",
      discoveredRemoteDigest: expect.any(String),
      state: "new",
    },
  ]);
  expect((await getExternalTool(f.db, f.owner, alpha.id)).remoteName).toBe(
    "alpha",
  );
  await expect(
    getExternalTool(f.db, f.outsider, alpha.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    listExternalToolKeys(f.db, f.outsider, { connectionId: c.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("refuses key listings above the cap", async () => {
  const { listExternalToolKeys } =
    await import("@weaver/core/services/externalMcp");
  const { MAX_TOOL_KEYS } = await import("@weaver/core/externalMcp/limits");
  const f = await makeExternalFixture();
  const c = await discovered(f);
  await f.db.externalMcpTool.createMany({
    data: Array.from({ length: MAX_TOOL_KEYS }, (_, i) => ({
      connectionId: c.id,
      remoteName: `bulk-${String(i).padStart(5, "0")}`,
      discoveredDefinition: { name: `bulk-${i}` },
      discoveredRemoteDigest: "a".repeat(64),
      discoveredAt: new Date(),
    })),
  });
  await expect(
    listExternalToolKeys(f.db, f.owner, { connectionId: c.id }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
});

it("reviews tools in one atomic batch with a single revision bump", async () => {
  const f = await makeExternalFixture();
  const c = await discovered(f);
  const [read, write] = c.tools;
  const before = c.revision;

  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: [
        {
          toolId: read!.id,
          expectedRemoteDigest: read!.discoveredRemoteDigest,
          enabled: true,
        },
        {
          toolId: write!.id,
          expectedRemoteDigest: "0".repeat(64),
          enabled: true,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  let current = await getExternalConnection(f.db, f.owner, c.id);
  expect(current.revision).toBe(before);
  expect(
    current.tools.every((t) => !t.enabled && !t.reviewedRemoteDigest),
  ).toBe(true);

  const saved = await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: read!.id,
        expectedRemoteDigest: read!.discoveredRemoteDigest,
        enabled: true,
        effect: "read",
      },
      {
        toolId: write!.id,
        expectedRemoteDigest: write!.discoveredRemoteDigest,
        enabled: true,
      },
    ],
  });
  expect(saved.map((t) => [t.remoteName, t.enabled, t.effect])).toEqual([
    ["read", true, "read"],
    ["write", true, "write"],
  ]);
  current = await getExternalConnection(f.db, f.owner, c.id);
  expect(current.revision).toBe(before + 1);

  const [disabled] = await reviewExternalTools(f.deps, f.owner, {
    connectionId: c.id,
    items: [
      {
        toolId: read!.id,
        expectedRemoteDigest: read!.discoveredRemoteDigest,
        enabled: false,
      },
    ],
  });
  expect([disabled!.enabled, disabled!.effect]).toEqual([false, "read"]);

  const other = await createExternalConnection(f.deps, f.owner, {
    name: "Other",
    endpoint: "https://other.test/mcp",
    authMode: "none",
  });
  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: other.id,
      items: [
        {
          toolId: read!.id,
          expectedRemoteDigest: read!.discoveredRemoteDigest,
          enabled: true,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    reviewExternalTools(f.deps, f.outsider, {
      connectionId: c.id,
      items: [
        {
          toolId: read!.id,
          expectedRemoteDigest: read!.discoveredRemoteDigest,
          enabled: true,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: [
        {
          toolId: read!.id,
          expectedRemoteDigest: read!.discoveredRemoteDigest,
        },
        {
          toolId: read!.id,
          expectedRemoteDigest: read!.discoveredRemoteDigest,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("refuses a batch containing an unavailable tool", async () => {
  const f = await makeExternalFixture();
  let c = await discovered(f);
  const write = c.tools.find((t) => t.remoteName === "write")!;
  f.calls.catalog.tools.pop();
  await discoverExternalConnection(f.deps, f.owner, {
    id: c.id,
    expectedRevision: c.revision,
  });
  c = await getExternalConnection(f.db, f.owner, c.id);
  const read = c.tools.find((t) => t.remoteName === "read")!;
  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: [
        {
          toolId: read.id,
          expectedRemoteDigest: read.discoveredRemoteDigest,
          enabled: true,
        },
        {
          toolId: write.id,
          expectedRemoteDigest: write.discoveredRemoteDigest,
          enabled: true,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(
    (await getExternalConnection(f.db, f.owner, c.id)).tools.find(
      (t) => t.id === read.id,
    )!.enabled,
  ).toBe(false);
});

it("serializes the per-owner connection capacity", async () => {
  const f = await makeExternalFixture();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) =>
      createExternalConnection(f.deps, f.owner, {
        name: `Connection ${index}`,
        endpoint: "https://example.test/mcp",
        authMode: "none",
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(10);
  expect(
    await f.db.externalMcpConnection.count({
      where: { ownerId: f.owner.userId },
    }),
  ).toBe(10);
});
it("bounds enabled tools across the owner's catalogs", async () => {
  const f = await makeExternalFixture();
  f.calls.catalog.tools = Array.from({ length: 101 }, (_, i) => ({
    name: `read_${i}`,
    inputSchema: { type: "object", properties: {} },
    supportStatus: { available: true },
  }));
  const c = await discovered(f);
  const tools = await f.db.externalMcpTool.findMany({
    where: { connectionId: c.id },
  });
  await expect(
    reviewExternalTools(f.deps, f.owner, {
      connectionId: c.id,
      items: tools.map((t) => ({
        toolId: t.id,
        expectedRemoteDigest: t.discoveredRemoteDigest,
        enabled: true,
        effect: "read",
      })),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(
    await f.db.externalMcpTool.count({
      where: { connectionId: c.id, enabled: true },
    }),
  ).toBe(0);
});

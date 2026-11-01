import { beforeEach, describe, expect, it } from "vitest";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  testAuth,
} from "./_harness";

describe("apiKey router", () => {
  it("prevents hard project deletion from widening a restricted key", async () => {
    const user = await makeUser("User", "purge-key");
    const project = await makeProject("Restricted");
    await addMembership(project.id, user.id, "Owner");
    const issued = await callerFor(user).apiKey.create({
      name: "Restricted",
      projectIds: [project.id],
    });
    await expect(
      getPrisma().project.delete({ where: { id: project.id } }),
    ).rejects.toThrow();
    expect(
      await getPrisma().apiKeyProject.findMany({
        where: { apiKeyId: issued.key.id },
      }),
    ).toHaveLength(1);
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a read-only key, returns the secret once, and stores only a hash", async () => {
    const user = await makeUser("User", "ak1");
    const result = await callerFor(user).apiKey.create({ name: "Laptop MCP" });

    expect(result.secret).toMatch(/^wvr_[A-Za-z0-9_-]{20,}$/);
    expect(result.key).toMatchObject({
      name: "Laptop MCP",
      start: result.secret.slice(0, 8),
      projectIds: [],
      expiresAt: null,
      lastUsedAt: null,
      rateLimitPerMinute: 10_000,
      enabled: true,
    });
    expect([...result.key.capabilities].sort()).toEqual([
      "content:read",
      "mcp:use",
    ]);

    const stored = await getPrisma().apiKey.findUniqueOrThrow({
      where: { id: result.key.id },
    });
    expect(stored.referenceId).toBe(user.id);
    expect(stored.key).not.toBe(result.secret);
    expect(stored.key).not.toContain(result.secret.slice(8));

    const listed = await callerFor(user).apiKey.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(result.secret.slice(8));

    const verified = await testAuth().api.verifyApiKey({
      body: { key: result.secret },
    });
    expect(verified.valid).toBe(true);
    expect(verified.key?.permissions).toEqual({
      mcp: ["use"],
      content: ["read"],
    });
  });

  it("grants write/propose explicitly, restricts to member projects, and applies expiry and rate limits", async () => {
    const user = await makeUser("User", "ak2");
    const mine = await makeProject("Mine");
    const other = await makeProject("Other");
    await addMembership(mine.id, user.id, "Editor");

    const result = await callerFor(user).apiKey.create({
      name: "Writer",
      capabilities: ["content:write", "content:propose"],
      projectIds: [mine.id],
      expiresInDays: 30,
      rateLimitPerMinute: 120,
    });
    expect([...result.key.capabilities].sort()).toEqual([
      "content:propose",
      "content:read",
      "content:write",
      "mcp:use",
    ]);
    expect(result.key.projectIds).toEqual([mine.id]);
    expect(result.key.rateLimitPerMinute).toBe(120);
    const inDays = (result.key.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(inDays).toBeGreaterThan(29.9);
    expect(inDays).toBeLessThanOrEqual(30);
    expect(
      await getPrisma().apiKeyProject.count({
        where: { apiKeyId: result.key.id },
      }),
    ).toBe(1);

    await expect(
      callerFor(user).apiKey.create({ name: "Leak", projectIds: [other.id] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await getPrisma().apiKey.count()).toBe(1);
  });

  it("lists only the caller's keys and revokes immediately", async () => {
    const alice = await makeUser("User", "ak3a");
    const bob = await makeUser("User", "ak3b");
    const aliceKey = await callerFor(alice).apiKey.create({ name: "A" });
    await callerFor(bob).apiKey.create({ name: "B" });

    expect((await callerFor(alice).apiKey.list()).map((k) => k.name)).toEqual([
      "A",
    ]);
    await expect(
      callerFor(bob).apiKey.revoke({ keyId: aliceKey.key.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await callerFor(alice).apiKey.revoke({ keyId: aliceKey.key.id });
    expect(await callerFor(alice).apiKey.list()).toEqual([]);
    const verified = await testAuth().api.verifyApiKey({
      body: { key: aliceKey.secret },
    });
    expect(verified.valid).toBe(false);
  });

  it("surfaces fail-closed disabled keys instead of presenting them as active", async () => {
    const user = await makeUser("User", "ak-disabled");
    const created = await callerFor(user).apiKey.create({ name: "Disabled" });
    await getPrisma().apiKey.update({
      where: { id: created.key.id },
      data: { enabled: false },
    });

    expect(await callerFor(user).apiKey.list()).toEqual([
      expect.objectContaining({ id: created.key.id, enabled: false }),
    ]);
  });

  it("refuses key management from a non-session credential", async () => {
    const user = await makeUser("User", "ak4");
    const viaKey = callerWithSecurity(
      user,
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: "User",
        keyId: "k",
        permissions: { content: ["read", "write"], mcp: ["use"] },
        projectIds: [],
      }),
    );
    await expect(
      viaKey.apiKey.create({ name: "Nested" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("validates the name", async () => {
    const user = await makeUser("User", "ak5");
    await expect(
      callerFor(user).apiKey.create({ name: "   " }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("lets only global Admins grant system administration to a key", async () => {
    const admin = await makeUser("Admin", "ak-admin");
    const user = await makeUser("User", "ak-user");

    const granted = await callerFor(admin).apiKey.create({
      name: "Claude Code admin",
      capabilities: ["system:admin"],
    });
    expect([...granted.key.capabilities].sort()).toEqual([
      "content:read",
      "mcp:use",
      "system:admin",
    ]);
    const stored = await getPrisma().apiKey.findUniqueOrThrow({
      where: { id: granted.key.id },
    });
    expect(JSON.parse(stored.permissions ?? "{}")).toEqual({
      mcp: ["use"],
      content: ["read"],
      system: ["admin"],
    });

    await expect(
      callerFor(user).apiKey.create({
        name: "not allowed",
        capabilities: ["system:admin"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("drops system:admin from a key whose owner is no longer an Admin", async () => {
    const admin = await makeUser("Admin", "ak-demoted");
    const created = await callerFor(admin).apiKey.create({
      name: "admin key",
      capabilities: ["system:admin"],
    });
    const verified = await testAuth().api.verifyApiKey({
      body: { key: created.secret },
    });
    const permissions = verified.key?.permissions as Record<string, string[]>;

    const active = createApiKeySecurityContext({
      userId: admin.id,
      globalRole: "Admin",
      keyId: created.key.id,
      permissions,
      projectIds: [],
    });
    expect(active.capabilities.has("system:admin")).toBe(true);

    await getPrisma().user.update({
      where: { id: admin.id },
      data: { role: "User" },
    });
    const demotedUser = await getPrisma().user.findUniqueOrThrow({
      where: { id: admin.id },
    });
    const demoted = createApiKeySecurityContext({
      userId: admin.id,
      globalRole: demotedUser.role,
      keyId: created.key.id,
      permissions,
      projectIds: [],
    });
    expect(demoted.capabilities.has("system:admin")).toBe(false);
  });

  it("updates a key's name, capabilities, projects and rate limit in place", async () => {
    const user = await makeUser("User", "ak-update");
    const mine = await makeProject("Mine");
    const alsoMine = await makeProject("Also mine");
    await addMembership(mine.id, user.id, "Editor");
    await addMembership(alsoMine.id, user.id, "Viewer");
    const created = await callerFor(user).apiKey.create({
      name: "Reader",
      projectIds: [mine.id],
      expiresInDays: 30,
    });

    const updated = await callerFor(user).apiKey.update({
      keyId: created.key.id,
      name: "Writer",
      capabilities: ["content:write"],
      projectIds: [alsoMine.id],
      rateLimitPerMinute: 60,
    });

    expect(updated).toMatchObject({
      id: created.key.id,
      name: "Writer",
      start: created.key.start,
      projectIds: [alsoMine.id],
      expiresAt: created.key.expiresAt,
      rateLimitPerMinute: 60,
      enabled: true,
    });
    expect([...updated.capabilities].sort()).toEqual([
      "content:read",
      "content:write",
      "mcp:use",
    ]);
    const verified = await testAuth().api.verifyApiKey({
      body: { key: created.secret },
    });
    expect(verified.valid).toBe(true);
    expect(verified.key?.permissions).toEqual({
      mcp: ["use"],
      content: ["read", "write"],
    });
    expect(
      await getPrisma().apiKeyProject.findMany({
        where: { apiKeyId: created.key.id },
        select: { projectId: true },
      }),
    ).toEqual([{ projectId: alsoMine.id }]);

    const relaxed = await callerFor(user).apiKey.update({
      keyId: created.key.id,
      name: "Writer",
      capabilities: [],
      projectIds: [],
      rateLimitPerMinute: null,
    });
    expect(relaxed.projectIds).toEqual([]);
    expect(relaxed.rateLimitPerMinute).toBe(10_000);
    expect([...relaxed.capabilities].sort()).toEqual([
      "content:read",
      "mcp:use",
    ]);
  });

  it("refuses to update another user's key, a foreign project, or an Admin grant from a User", async () => {
    const alice = await makeUser("User", "ak-update-a");
    const bob = await makeUser("User", "ak-update-b");
    const other = await makeProject("Other");
    const aliceKey = await callerFor(alice).apiKey.create({ name: "A" });
    const base = {
      keyId: aliceKey.key.id,
      name: "A",
      capabilities: [] as ("content:write" | "system:admin")[],
      projectIds: [] as string[],
      rateLimitPerMinute: null,
    };

    await expect(
      callerFor(bob).apiKey.update({ ...base, name: "Stolen" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(alice).apiKey.update({ ...base, projectIds: [other.id] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      callerFor(alice).apiKey.update({
        ...base,
        capabilities: ["system:admin"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const viaKey = callerWithSecurity(
      alice,
      createApiKeySecurityContext({
        userId: alice.id,
        globalRole: "User",
        keyId: aliceKey.key.id,
        permissions: { content: ["read", "write"], mcp: ["use"] },
        projectIds: [],
      }),
    );
    await expect(
      viaKey.apiKey.update({ ...base, capabilities: ["content:write"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await callerFor(alice).apiKey.list())[0]).toMatchObject({
      name: "A",
      projectIds: [],
    });
  });

  it("grants ingest:external explicitly and stores it as an ingest permission", async () => {
    const user = await makeUser("User", "ak-ingest");
    const result = await callerFor(user).apiKey.create({
      name: "Nightly feed",
      capabilities: ["ingest:external"],
    });

    expect([...result.key.capabilities].sort()).toEqual([
      "content:read",
      "ingest:external",
      "mcp:use",
    ]);
    const verified = await testAuth().api.verifyApiKey({
      body: { key: result.secret },
    });
    expect(verified.valid).toBe(true);
    expect(verified.key?.permissions).toEqual({
      mcp: ["use"],
      content: ["read"],
      ingest: ["external"],
    });

    const listed = await callerFor(user).apiKey.list();
    expect(listed[0]?.capabilities).toContain("ingest:external");
  });

  it("stores external:use only when requested", async () => {
    const user = await makeUser("User", "external-key");
    const caller = callerFor(user);
    const plain = await caller.apiKey.create({ name: "plain" });
    const external = await caller.apiKey.create({
      name: "external",
      capabilities: ["external:use"],
    });
    const keys = await caller.apiKey.list();
    expect(keys.find((k) => k.id === plain.key.id)!.capabilities).not.toContain(
      "external:use",
    );
    expect(keys.find((k) => k.id === external.key.id)!.capabilities).toContain(
      "external:use",
    );
  });

  it("stores external:manage only when requested, independent of external:use", async () => {
    const user = await makeUser("User", "external-manage-key");
    const created = await callerFor(user).apiKey.create({
      name: "manage",
      capabilities: ["external:manage"],
    });
    expect(created.key.capabilities).toContain("external:manage");
    expect(created.key.capabilities).not.toContain("external:use");
    const verified = await testAuth().api.verifyApiKey({
      body: { key: created.secret },
    });
    expect(verified.key?.permissions).toEqual({
      mcp: ["use"],
      content: ["read"],
      external: ["manage"],
    });
  });

  it("lets an Admin create a key with every grantable capability", async () => {
    const admin = await makeUser("Admin", "ak-all-caps");
    const result = await callerFor(admin).apiKey.create({
      name: "everything",
      capabilities: [
        "content:propose",
        "content:write",
        "system:admin",
        "ingest:external",
        "external:use",
      ],
    });
    expect(result.key.capabilities).toContain("external:use");
    expect(result.key.capabilities).toContain("system:admin");
  });
});

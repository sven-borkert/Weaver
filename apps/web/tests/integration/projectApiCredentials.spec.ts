import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveProjectMachineContext } from "@weaver/core/security/projectMachine";
import { admitProjectMachineRequest } from "@weaver/core/projectApi/rateLimit";
import {
  makeMachineFixture,
  seedProjectMachineKey,
} from "./_projectApiHarness";
import { resetDb } from "./_harness";

describe("project machine credentials", () => {
  beforeEach(resetDb);

  it("authenticates a project identity without a user owner or role", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["update"],
      },
    ]);
    const context = await resolveProjectMachineContext(
      f.db,
      `Bearer ${key.secret}`,
      f.project.id,
    );
    expect(context).toEqual({
      kind: "projectMachine",
      projectId: f.project.id,
      keyId: key.keyId,
      name: "Audit publisher",
      policyVersion: 1,
    });
    expect(context).not.toHaveProperty("userId");
    expect(context).not.toHaveProperty("globalRole");
    const stored = await f.db.projectApiKey.findUniqueOrThrow({
      where: { id: key.keyId },
    });
    expect(JSON.stringify(stored)).not.toContain(key.secret);
    expect(stored.digest).toMatch(/^[a-f0-9]{64}$/);
    const grant = await f.db.projectApiKeyGrant.findFirstOrThrow({
      where: { keyId: key.keyId },
    });
    expect(grant).toMatchObject({
      canRead: false,
      canCreate: false,
      canUpdate: true,
      canDelete: false,
    });
  });

  it("continues authenticating after the creator leaves, is banned, and is deleted", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["read"],
      },
    ]);
    await f.db.member.deleteMany({ where: { userId: f.owner.id } });
    await f.db.user.update({
      where: { id: f.owner.id },
      data: { banned: true, mustChangePassword: true },
    });
    expect(
      (
        await resolveProjectMachineContext(
          f.db,
          `Bearer ${key.secret}`,
          f.project.id,
        )
      ).keyId,
    ).toBe(key.keyId);
    await f.db.user.delete({ where: { id: f.owner.id } });
    expect(
      (await f.db.projectApiKey.findUniqueOrThrow({ where: { id: key.keyId } }))
        .createdById,
    ).toBeNull();
    expect(
      (
        await resolveProjectMachineContext(
          f.db,
          `Bearer ${key.secret}`,
          f.project.id,
        )
      ).keyId,
    ).toBe(key.keyId);
  });

  it("rejects malformed, unknown, and modified bearer tokens", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, []);
    for (const header of [
      null,
      "",
      `Basic ${key.secret}`,
      `Bearer ${key.secret} extra`,
      `Bearer ${key.secret.slice(0, -1)}!`,
      `Bearer ${key.secret.replace(key.keyId, randomUUID())}`,
    ]) {
      await expect(
        resolveProjectMachineContext(f.db, header, f.project.id),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("rejects a key at its exact expiry and after irreversible revocation", async () => {
    const f = await makeMachineFixture();
    const now = new Date("2030-01-01T00:00:00.000Z");
    const key = await seedProjectMachineKey(f, [], { expiresAt: now });
    await expect(
      resolveProjectMachineContext(
        f.db,
        `Bearer ${key.secret}`,
        f.project.id,
        now,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      (
        await resolveProjectMachineContext(
          f.db,
          `Bearer ${key.secret}`,
          f.project.id,
          new Date(now.getTime() - 1),
        )
      ).keyId,
    ).toBe(key.keyId);
    await f.db.projectApiKey.update({
      where: { id: key.keyId },
      data: { expiresAt: null, revokedAt: new Date() },
    });
    await expect(
      resolveProjectMachineContext(f.db, `Bearer ${key.secret}`, f.project.id),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("never authenticates a different or soft-deleted project", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, []);
    await expect(
      resolveProjectMachineContext(f.db, `Bearer ${key.secret}`, randomUUID()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.db.project.update({
      where: { id: f.project.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      resolveProjectMachineContext(f.db, `Bearer ${key.secret}`, f.project.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.db.project.update({
      where: { id: f.project.id },
      data: { deletedAt: null },
    });
    expect(
      (
        await resolveProjectMachineContext(
          f.db,
          `Bearer ${key.secret}`,
          f.project.id,
        )
      ).keyId,
    ).toBe(key.keyId);
  });

  it("admits exactly the configured concurrent requests and rolls over the UTC minute", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, [], { rateLimitPerMinute: 3 });
    const now = new Date("2030-01-01T12:34:59.999Z");
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        admitProjectMachineRequest(f.db, key.context, now),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results)
      if (r.status === "rejected")
        expect(r.reason).toMatchObject({
          code: "TOO_MANY_REQUESTS",
          details: { retryAfterSeconds: 1 },
        });
    await expect(
      admitProjectMachineRequest(
        f.db,
        key.context,
        new Date("2030-01-01T12:35:00.000Z"),
      ),
    ).resolves.toEqual({ retryAfterSeconds: null });
    await expect(
      admitProjectMachineRequest(f.db, key.context, now),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    const window = await f.db.projectApiRateWindow.findUniqueOrThrow({
      where: { keyId: key.keyId },
    });
    expect(window.requestCount).toBe(1);
    expect(window.windowStartedAt.toISOString()).toBe(
      "2030-01-01T12:35:00.000Z",
    );
  });

  it("refuses a successful operation receipt without its committed revision", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, []);
    await expect(
      f.db.projectApiOperation.create({
        data: {
          keyId: key.keyId,
          projectId: f.project.id,
          idempotencyKey: "null-commit-receipt",
          operation: "document.create",
          requestHash: "a".repeat(64),
          state: "succeeded",
          generatedIds: {},
          authorizingAnchors: [],
          receipt: { resourceId: f.document.id },
          commitSha: null,
          createdAt: new Date(),
          completedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

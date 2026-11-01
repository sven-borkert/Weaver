import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createUserAdministrator } from "@weaver/auth";
import {
  createProjectApiKey,
  listProjectApiGrantTargets,
  listProjectApiKeys,
  listUnresolvedProjectApiOperations,
  revokeProjectApiKey,
  updateProjectApiKey,
} from "@weaver/core/services/projectApiKeys";
import { resolveProjectMachineContext } from "@weaver/core/security/projectMachine";
import { lockProjectMembershipWrites } from "@weaver/core/services/projectMembers";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { softDeleteProject } from "@weaver/core/services/projects";
import { deleteDocument } from "@weaver/core/services/documents";
import { publishProjectMachineContent } from "@weaver/core/services/projectApi";
import { closeProjectApiOperationPool } from "@weaver/core/projectApi/operationLock";
import { deactivateUser, resetUserPassword } from "@weaver/core/services/users";
import {
  composeFolderMetadata,
  parseFolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import { toOrganizationRole } from "@weaver/core/roles";
import {
  makeMachineFixture,
  seedProjectMachineKey,
  type MachineFixture,
} from "./_projectApiHarness";
import {
  addMembership,
  callerFor,
  makeUser,
  resetDb,
  securityContextFor,
  testAuth,
} from "./_harness";

const DAY = 86_400_000;
const bearer = (secret: string) => `Bearer ${secret}`;

async function memberAs(
  f: MachineFixture,
  role: "Owner" | "Maintainer" | "Editor" | "Viewer",
) {
  const user = await makeUser("User", `${role}-${randomUUID()}`);
  await addMembership(f.project.id, user.id, role);
  return { user, actor: securityContextFor(user) };
}

async function setRole(
  f: MachineFixture,
  userId: string,
  role: "Owner" | "Maintainer" | "Editor" | "Viewer",
) {
  const { organizationId } = await f.db.project.findUniqueOrThrow({
    where: { id: f.project.id },
  });
  await f.db.member.update({
    where: { organizationId_userId: { organizationId, userId } },
    data: { role: toOrganizationRole(role) },
  });
}

const documentGrant = (f: MachineFixture) => ({
  kind: "document" as const,
  targetId: f.document.id,
  actions: ["update" as const],
});

describe("project machine key management", () => {
  beforeEach(resetDb);
  afterAll(closeProjectApiOperationPool);

  it("lets session Owners and Maintainers manage keys and refuses every other principal", async () => {
    const f = await makeMachineFixture();
    const maintainer = await memberAs(f, "Maintainer");
    const created = await createProjectApiKey(f.db, maintainer.actor, {
      projectId: f.project.id,
      name: "Daily audit",
      grants: [documentGrant(f)],
    });
    expect(created.secret).toMatch(/^wvr_project_/);
    expect(
      (await listProjectApiKeys(f.db, f.actor, f.project.id)).map((k) => k.id),
    ).toEqual([created.key.id]);
    expect(
      await callerFor(maintainer.user).projectApiKey.list({
        projectId: f.project.id,
      }),
    ).toHaveLength(1);

    for (const role of ["Editor", "Viewer"] as const) {
      const member = await memberAs(f, role);
      await expect(
        listProjectApiKeys(f.db, member.actor, f.project.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerFor(member.user).projectApiKey.create({
          projectId: f.project.id,
          name: "Blocked",
          grants: [documentGrant(f)],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    for (const authenticationMethod of ["apiKey", "oauth", "task"] as const)
      await expect(
        revokeProjectApiKey(
          f.db,
          { ...f.actor, authenticationMethod },
          { projectId: f.project.id, keyId: created.key.id },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await makeUser("Admin", `outsider-${randomUUID()}`);
    await expect(
      listProjectApiKeys(f.db, securityContextFor(admin), f.project.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(admin).projectApiKey.targets({
        projectId: f.project.id,
        kind: "document",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await resolveProjectMachineContext(
          f.db,
          bearer(created.secret),
          f.project.id,
        )
      ).keyId,
    ).toBe(created.key.id);
  });

  it("applies defaults, explicit no-expiry and field-pinned limits", async () => {
    const f = await makeMachineFixture();
    const before = Date.now();
    const defaults = await createProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      name: "Defaults",
      grants: [documentGrant(f)],
    });
    expect(defaults.key.rateLimitPerMinute).toBe(100);
    expect(defaults.key.expiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 90 * DAY,
    );
    expect(defaults.key.expiresAt!.getTime()).toBeLessThanOrEqual(
      Date.now() + 90 * DAY,
    );
    const forever = await createProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      name: "Forever",
      grants: [documentGrant(f)],
      expiresInDays: null,
      rateLimitPerMinute: 10_000,
    });
    expect(forever.key.expiresAt).toBeNull();
    const shortest = await createProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      name: "Shortest",
      grants: [documentGrant(f)],
      expiresInDays: 1,
      rateLimitPerMinute: 1,
    });
    expect(shortest.key.expiresAt!.getTime()).toBeLessThanOrEqual(
      Date.now() + DAY,
    );
    const invalid: [Record<string, unknown>, string][] = [
      [{ expiresInDays: 0 }, "expiresInDays"],
      [{ expiresInDays: 366 }, "expiresInDays"],
      [{ rateLimitPerMinute: 0 }, "rateLimitPerMinute"],
      [{ rateLimitPerMinute: 10_001 }, "rateLimitPerMinute"],
      [{ grants: [] }, "grants"],
      [{ name: " " }, "name"],
    ];
    for (const [override, field] of invalid)
      await expect(
        createProjectApiKey(f.db, f.actor, {
          projectId: f.project.id,
          name: "Invalid",
          grants: [documentGrant(f)],
          ...override,
        } as never),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { field },
      });
  });

  it("rejects foreign, unsupported, mixed and inapplicable grant targets", async () => {
    const f = await makeMachineFixture();
    const other = await makeMachineFixture();
    const attempts = [
      { kind: "document", targetId: other.document.id, actions: ["read"] },
      { kind: "table", targetId: other.table.id, actions: ["create"] },
      { kind: "documentFolder", targetId: randomUUID(), actions: ["create"] },
      { kind: "python", targetId: f.document.id, actions: ["read"] },
      {
        kind: "documentFolder",
        root: true,
        targetId: randomUUID(),
        actions: ["read"],
      },
      { kind: "document", root: true, actions: ["read"] },
      { kind: "documentFolder", path: [".."], actions: ["read"] },
      { kind: "documentFolder", path: ["tables"], actions: ["read"] },
      { kind: "documentFolder", path: ["missing"], actions: ["read"] },
      { kind: "document", targetId: f.document.id, actions: ["create"] },
      { kind: "document", targetId: f.document.id, actions: [] },
    ];
    for (const grant of attempts)
      await expect(
        createProjectApiKey(f.db, f.actor, {
          projectId: f.project.id,
          name: "Bad target",
          grants: [grant],
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await f.db.projectApiKey.count()).toBe(0);
  });

  it("merges duplicate targets and caps grants and active keys", async () => {
    const f = await makeMachineFixture();
    const merged = await createProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      name: "Merged",
      grants: [
        { kind: "document", targetId: f.document.id, actions: ["update"] },
        { kind: "document", targetId: f.document.id, actions: ["read"] },
        { kind: "tableFolder", root: true, actions: ["create"] },
        { kind: "tableFolder", root: true, actions: ["create", "delete"] },
      ],
    });
    expect(merged.key.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "document",
          targetId: f.document.id,
          actions: ["read", "update"],
          available: true,
          label: "Latest audit",
        }),
        expect.objectContaining({
          kind: "tableFolder",
          root: true,
          actions: ["create", "delete"],
          label: "Tables root",
        }),
      ]),
    );
    expect(merged.key.grants).toHaveLength(2);
    await expect(
      createProjectApiKey(f.db, f.actor, {
        projectId: f.project.id,
        name: "Too many grants",
        grants: Array.from({ length: 101 }, () => documentGrant(f)),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "grants" },
    });

    for (let i = 1; i < 100; i += 1)
      await seedProjectMachineKey(f, [
        {
          kind: "document",
          targetId: f.document.id,
          root: false,
          actions: ["read"],
        },
      ]);
    await expect(
      createProjectApiKey(f.db, f.actor, {
        projectId: f.project.id,
        name: "Over the limit",
        grants: [documentGrant(f)],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await revokeProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      keyId: merged.key.id,
    });
    await expect(
      createProjectApiKey(f.db, f.actor, {
        projectId: f.project.id,
        name: "Replacement",
        grants: [documentGrant(f)],
      }),
    ).resolves.toMatchObject({ key: { name: "Replacement" } });
  });

  it("replaces policy coherently, preserves unavailable targets and keeps project and secret immutable", async () => {
    const f = await makeMachineFixture();
    const created = await createProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      name: "Daily audit",
      grants: [
        {
          kind: "document",
          targetId: f.document.id,
          actions: ["read", "update"],
        },
      ],
      expiresInDays: 30,
    });
    const list = await listProjectApiKeys(f.db, f.actor, f.project.id);
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(JSON.stringify(list)).not.toContain("digest");

    await deleteDocument(
      f.db,
      { projectId: f.project.id, documentId: f.document.id },
      f.actor,
    );
    const [unavailable] = await listProjectApiKeys(f.db, f.actor, f.project.id);
    expect(unavailable!.grants[0]).toMatchObject({
      targetId: f.document.id,
      available: false,
    });
    const edited = await updateProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      keyId: created.key.id,
      name: "Audit reports",
      rateLimitPerMinute: 10,
      grants: [
        { kind: "document", targetId: f.document.id, actions: ["read"] },
        { kind: "documentFolder", root: true, actions: ["create"] },
      ],
    });
    expect(edited).toMatchObject({
      name: "Audit reports",
      rateLimitPerMinute: 10,
      policyVersion: 2,
      expiresAt: created.key.expiresAt,
    });
    expect(edited.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: f.document.id,
          actions: ["read"],
          available: false,
        }),
        expect.objectContaining({ root: true, actions: ["create"] }),
      ]),
    );
    await expect(
      updateProjectApiKey(f.db, f.actor, {
        projectId: f.project.id,
        keyId: created.key.id,
        name: "Audit reports",
        rateLimitPerMinute: 10,
        grants: [{ kind: "table", targetId: randomUUID(), actions: ["read"] }],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "grants" },
    });
    const cleared = await updateProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      keyId: created.key.id,
      name: "Audit reports",
      rateLimitPerMinute: 10,
      expiresInDays: null,
      grants: [{ kind: "documentFolder", root: true, actions: ["create"] }],
    });
    expect(cleared).toMatchObject({ expiresAt: null, policyVersion: 3 });

    const other = await makeMachineFixture();
    await addMembership(other.project.id, f.owner.id, "Owner");
    await expect(
      updateProjectApiKey(f.db, f.actor, {
        projectId: other.project.id,
        keyId: created.key.id,
        name: "Moved",
        rateLimitPerMinute: 10,
        grants: [{ kind: "documentFolder", root: true, actions: ["create"] }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const context = await resolveProjectMachineContext(
      f.db,
      bearer(created.secret),
      f.project.id,
    );
    expect(context).toMatchObject({
      projectId: f.project.id,
      name: "Audit reports",
      policyVersion: 3,
    });
  });

  it("assigns legacy folder identities only when granted", async () => {
    const f = await makeMachineFixture();
    const head = await withProjectRepo(f.project.id, async (repo) => {
      const { id: _id, ...legacy } = parseFolderMetadata(
        await repo.readFileFromWorktree("audit/.folder.json"),
      )!;
      await repo.writeFileAtomic(
        "audit/.folder.json",
        composeFolderMetadata(legacy),
      );
      return repo.commitAll("test: legacy metadata", {
        name: f.actor.name,
        email: f.actor.email,
        userId: f.actor.userId,
      });
    });
    const page = await listProjectApiGrantTargets(f.db, f.actor, {
      projectId: f.project.id,
      kind: "documentFolder",
    });
    expect(page.items).toEqual([
      expect.objectContaining({ root: true, label: "Documents root" }),
      expect.objectContaining({ path: ["audit"], label: "audit" }),
    ]);
    expect(
      await withProjectRepo(f.project.id, (repo) => repo.resolveHead()),
    ).toBe(head);
    const created = await createProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      name: "Legacy",
      grants: [
        { kind: "documentFolder", path: ["audit"], actions: ["create"] },
      ],
    });
    const grant = created.key.grants[0]!;
    expect(grant).toMatchObject({ available: true, label: "audit" });
    expect(grant.targetId).toMatch(/^[0-9a-f-]{36}$/);
    const after = await listProjectApiGrantTargets(f.db, f.actor, {
      projectId: f.project.id,
      kind: "documentFolder",
    });
    expect(after.items[1]).toMatchObject({ targetId: grant.targetId });
  });

  it("pages and searches grant targets against one captured HEAD", async () => {
    const f = await makeMachineFixture();
    const first = await listProjectApiGrantTargets(f.db, f.actor, {
      projectId: f.project.id,
      kind: "tableFolder",
      limit: 1,
    });
    expect(first.items).toEqual([expect.objectContaining({ root: true })]);
    const second = await listProjectApiGrantTargets(f.db, f.actor, {
      projectId: f.project.id,
      kind: "tableFolder",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second).toMatchObject({
      items: [{ label: "audit", location: "audit" }],
      nextCursor: null,
    });
    const tables = await listProjectApiGrantTargets(f.db, f.actor, {
      projectId: f.project.id,
      kind: "table",
      search: "RESULTS",
    });
    expect(tables.items).toEqual([
      expect.objectContaining({
        targetId: f.table.id,
        label: "Audit results",
        columns: [expect.objectContaining({ name: "Account" })],
      }),
    ]);
    expect(
      (
        await listProjectApiGrantTargets(f.db, f.actor, {
          projectId: f.project.id,
          kind: "document",
          search: "nothing like this",
        })
      ).items,
    ).toEqual([]);
    await deleteDocument(
      f.db,
      { projectId: f.project.id, documentId: f.document.id },
      f.actor,
    );
    await expect(
      listProjectApiGrantTargets(f.db, f.actor, {
        projectId: f.project.id,
        kind: "tableFolder",
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("accepts the cursor and direction an infinite query sends", async () => {
    const f = await makeMachineFixture();
    const caller = callerFor(f.owner);
    const first = await caller.projectApiKey.targets({
      projectId: f.project.id,
      kind: "tableFolder",
      limit: 1,
      direction: "forward",
    });
    expect(first.items).toEqual([expect.objectContaining({ root: true })]);
    const second = await caller.projectApiKey.targets({
      projectId: f.project.id,
      kind: "tableFolder",
      limit: 1,
      cursor: first.nextCursor!,
      direction: "forward",
    });
    expect(second.items).toEqual([
      expect.objectContaining({ label: "audit", location: "audit" }),
    ]);
  });

  it("keeps keys independent of their creator's role, account and deletion", async () => {
    const f = await makeMachineFixture();
    const creator = await memberAs(f, "Maintainer");
    const created = await createProjectApiKey(f.db, creator.actor, {
      projectId: f.project.id,
      name: "Creator independent",
      grants: [documentGrant(f)],
    });
    const stillValid = async () =>
      expect(
        (
          await resolveProjectMachineContext(
            f.db,
            bearer(created.secret),
            f.project.id,
          )
        ).keyId,
      ).toBe(created.key.id);
    await setRole(f, creator.user.id, "Viewer");
    await stillValid();
    await expect(
      listProjectApiKeys(f.db, creator.actor, f.project.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await f.db.member.deleteMany({ where: { userId: creator.user.id } });
    await stillValid();
    const admin = await makeUser("Admin", `admin-${randomUUID()}`);
    const administrator = createUserAdministrator(testAuth());
    await resetUserPassword(
      f.db,
      securityContextFor(admin),
      { userId: creator.user.id, password: "another-password-123" },
      administrator,
    );
    await stillValid();
    await deactivateUser(
      f.db,
      securityContextFor(admin),
      { userId: creator.user.id, reason: "Left the team" },
      administrator,
    );
    await stillValid();
    await f.db.user.delete({ where: { id: creator.user.id } });
    await stillValid();
    expect(
      await f.db.projectApiKey.findUniqueOrThrow({
        where: { id: created.key.id },
        select: { createdById: true },
      }),
    ).toEqual({ createdById: null });
  });

  it("revokes irreversibly", async () => {
    const f = await makeMachineFixture();
    const created = await createProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      name: "Short lived",
      grants: [documentGrant(f)],
    });
    await revokeProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      keyId: created.key.id,
    });
    await revokeProjectApiKey(f.db, f.actor, {
      projectId: f.project.id,
      keyId: created.key.id,
    });
    const [revoked] = await listProjectApiKeys(f.db, f.actor, f.project.id);
    expect(revoked).toMatchObject({ status: "Revoked", policyVersion: 2 });
    await expect(
      resolveProjectMachineContext(f.db, bearer(created.secret), f.project.id),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      updateProjectApiKey(f.db, f.actor, {
        projectId: f.project.id,
        keyId: created.key.id,
        name: "Revived",
        rateLimitPerMinute: 100,
        grants: [documentGrant(f)],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      revokeProjectApiKey(f.db, f.actor, {
        projectId: f.project.id,
        keyId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rechecks membership after waiting for a concurrent demotion", async () => {
    const f = await makeMachineFixture();
    const maintainer = await memberAs(f, "Maintainer");
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => (locked = resolve));
    const demotion = f.db.$transaction(async (tx) => {
      await lockProjectMembershipWrites(tx, f.project.id);
      const { organizationId } = await tx.project.findUniqueOrThrow({
        where: { id: f.project.id },
      });
      await tx.member.update({
        where: {
          organizationId_userId: { organizationId, userId: maintainer.user.id },
        },
        data: { role: toOrganizationRole("Editor") },
      });
      locked();
      await released;
    });
    await lockHeld;
    let settled = false;
    const creation = createProjectApiKey(f.db, maintainer.actor, {
      projectId: f.project.id,
      name: "Raced",
      grants: [documentGrant(f)],
    }).finally(() => (settled = true));
    await sleep(300);
    expect(settled).toBe(false);
    release();
    await demotion;
    await expect(creation).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.db.projectApiKey.count()).toBe(0);
  });

  it("serializes project soft deletion with publishing and restores only valid keys", async () => {
    const f = await makeMachineFixture();
    const valid = await seedProjectMachineKey(f, [
      {
        kind: "documentFolder",
        targetId: null,
        root: true,
        actions: ["create"],
      },
    ]);
    const revoked = await seedProjectMachineKey(
      f,
      [
        {
          kind: "documentFolder",
          targetId: null,
          root: true,
          actions: ["create"],
        },
      ],
      { revokedAt: new Date() },
    );
    const expired = await seedProjectMachineKey(
      f,
      [
        {
          kind: "documentFolder",
          targetId: null,
          root: true,
          actions: ["create"],
        },
      ],
      { expiresAt: new Date(Date.now() - 1_000) },
    );
    let deleted = false;
    let deletion!: Promise<void>;
    await withProjectRepo(f.project.id, async () => {
      deletion = softDeleteProject(f.db, f.project.id, f.actor).then(
        () => void (deleted = true),
      );
      await sleep(300);
      expect(deleted).toBe(false);
      expect(
        (await f.db.project.findUniqueOrThrow({ where: { id: f.project.id } }))
          .deletedAt,
      ).toBeNull();
    });
    await deletion;
    await expect(
      publishProjectMachineContent(
        f.db,
        valid.context,
        {
          kind: "document.create",
          folder: { root: true },
          title: "After deletion",
          markdown: "Late",
        },
        {
          requestId: randomUUID(),
          idempotencyKey: "after-deletion",
          method: "POST",
          ifMatch: null,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      resolveProjectMachineContext(f.db, bearer(valid.secret), f.project.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await f.db.project.update({
      where: { id: f.project.id },
      data: { deletedAt: null },
    });
    expect(
      (
        await resolveProjectMachineContext(
          f.db,
          bearer(valid.secret),
          f.project.id,
        )
      ).keyId,
    ).toBe(valid.keyId);
    for (const key of [revoked, expired])
      await expect(
        resolveProjectMachineContext(f.db, bearer(key.secret), f.project.id),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("exposes unresolved operations only to key managers", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "documentFolder",
        targetId: null,
        root: true,
        actions: ["create"],
      },
    ]);
    await f.db.projectApiOperation.create({
      data: {
        id: randomUUID(),
        keyId: k.keyId,
        projectId: f.project.id,
        idempotencyKey: "pending-report",
        operation: "document.create",
        requestHash: "a".repeat(64),
        state: "reserved",
        generatedIds: {},
        authorizingAnchors: {},
        createdAt: new Date(),
      },
    });
    const unresolved = await listUnresolvedProjectApiOperations(
      f.db,
      f.actor,
      f.project.id,
    );
    expect(unresolved).toEqual([
      expect.objectContaining({
        keyId: k.keyId,
        operation: "document.create",
        reason: expect.any(String),
      }),
    ]);
    expect(Object.keys(unresolved[0]!).sort()).toEqual(
      ["createdAt", "id", "keyId", "operation", "reason"].sort(),
    );
    const viewer = await memberAs(f, "Viewer");
    await expect(
      listUnresolvedProjectApiOperations(f.db, viewer.actor, f.project.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

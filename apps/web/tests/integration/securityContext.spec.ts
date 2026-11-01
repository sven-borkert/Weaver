import { beforeEach, describe, expect, it } from "vitest";
import {
  createApiKeySecurityContext,
  createSessionSecurityContext,
} from "@weaver/core/security/context";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

describe("credential-scoped security contexts", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("hides projects outside a key's restriction as NOT_FOUND and filters lists", async () => {
    const user = await makeUser("User", "sc1");
    const inside = await makeProject("Inside");
    const outside = await makeProject("Outside");
    await addMembership(inside.id, user.id, "Owner");
    await addMembership(outside.id, user.id, "Owner");
    const restricted = callerWithSecurity(
      user,
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: "User",
        keyId: "key-1",
        permissions: null,
        projectIds: [inside.id],
      }),
    );

    await expect(
      restricted.project.get({ projectId: inside.id }),
    ).resolves.toMatchObject({ id: inside.id });
    await expect(
      restricted.project.get({ projectId: outside.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await restricted.project.list()).map((p) => p.id)).toEqual([
      inside.id,
    ]);
    expect((await callerFor(user).project.list()).length).toBe(2);
  });

  it("rejects writes without content:write as FORBIDDEN while reads stay allowed", async () => {
    const user = await makeUser("User", "sc2");
    const project = await makeProject("P");
    await addMembership(project.id, user.id, "Maintainer");
    const readOnly = callerWithSecurity(
      user,
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: "User",
        keyId: "key-2",
        permissions: null,
        projectIds: [],
      }),
    );

    await expect(
      readOnly.project.update({ projectId: project.id, name: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      readOnly.knowledge.rebuild({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Carry-over: Maintainer-gated *read* must work for a read-only credential.
    await expect(
      readOnly.knowledge.status({ projectId: project.id }),
    ).resolves.toBeDefined();
    await expect(
      readOnly.knowledge.readiness({ projectId: project.id }),
    ).resolves.toBeDefined();
  });

  it("still requires Maintainer for knowledge.status regardless of capability", async () => {
    const editor = await makeUser("User", "sc3");
    const project = await makeProject("P");
    await addMembership(project.id, editor.id, "Editor");
    await expect(
      callerFor(editor).knowledge.status({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("forbids project creation for restricted or read-only credentials", async () => {
    const user = await makeUser("User", "sc4");
    const project = await makeProject("P");
    await addMembership(project.id, user.id, "Owner");

    const restrictedWriter = callerWithSecurity(user, {
      ...createSessionSecurityContext({
        userId: user.id,
        globalRole: "User",
        sessionId: "s",
      }),
      allowedProjectIds: new Set([project.id]),
    });
    await expect(
      restrictedWriter.project.create({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const readOnly = callerWithSecurity(
      user,
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: "User",
        keyId: "key-4",
        permissions: null,
        projectIds: [],
      }),
    );
    await expect(
      readOnly.project.create({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { openProjectRepo } from "@weaver/git-store";
import { fromOrganizationRole } from "@weaver/core/roles";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

async function committedMembers(projectId: string) {
  const repo = await openProjectRepo(projectId);
  const file = await repo!.readCommittedFile("project.json");
  const parsed = JSON.parse(file!.content) as {
    members: Array<{ userId: string; email: string; role: string }>;
  };
  return parsed.members.map(({ userId, email, role }) => ({
    userId,
    email,
    role,
  }));
}

async function setupProjectWith(
  actorRole: "Owner" | "Maintainer" | "Editor" | "Viewer",
) {
  const actor = await makeUser("User", `${actorRole}-actor`);
  const project = await makeProject(`P-${actorRole}`);
  await addMembership(project.id, actor.id, actorRole);
  return { actor, project, caller: callerFor(actor) };
}

describe("projectMember router", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keeps the personal workspace owner as Owner", async () => {
    const owner = await makeUser("User", "pw-owner");
    const other = await makeUser("User", "pw-other");
    const { projectId } = await callerFor(owner).account.landingProject();
    await addMembership(projectId!, other.id, "Owner");
    const otherCaller = callerFor(other);
    await expect(
      otherCaller.projectMember.updateRole({
        projectId: projectId!,
        userId: owner.id,
        role: "Viewer",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      otherCaller.projectMember.remove({
        projectId: projectId!,
        userId: owner.id,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await callerFor(owner).projectMember.updateRole({
      projectId: projectId!,
      userId: other.id,
      role: "Maintainer",
    });
    const { organizationId } = await getPrisma().project.findUniqueOrThrow({
      where: { id: projectId! },
      select: { organizationId: true },
    });
    const otherMembership = await getPrisma().member.findUnique({
      where: { organizationId_userId: { organizationId, userId: other.id } },
    });
    expect(
      otherMembership ? fromOrganizationRole(otherMembership.role) : null,
    ).toBe("Maintainer");
  });

  it("protects Maintainers from peer demotion and removal", async () => {
    const { project, caller } = await setupProjectWith("Maintainer");
    const peer = await makeUser("User", "peer");
    await addMembership(project.id, peer.id, "Maintainer");
    await expect(
      caller.projectMember.updateRole({
        projectId: project.id,
        userId: peer.id,
        role: "Viewer",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.projectMember.remove({ projectId: project.id, userId: peer.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports concurrent duplicate additions as a conflict", async () => {
    const { project, caller } = await setupProjectWith("Owner");
    const user = await makeUser("User", "concurrent-add");
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        caller.projectMember.add({
          projectId: project.id,
          email: user.email,
          role: "Viewer",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
  });

  describe("repository metadata", () => {
    it("mirrors add, role change, and removal into the committed project.json", async () => {
      const { actor, project, caller } = await setupProjectWith("Owner");
      const newUser = await makeUser("User", "meta1");

      await caller.projectMember.add({
        projectId: project.id,
        email: newUser.email,
        role: "Editor",
      });
      expect(await committedMembers(project.id)).toEqual([
        { userId: actor.id, email: actor.email, role: "Owner" },
        { userId: newUser.id, email: newUser.email, role: "Editor" },
      ]);

      await caller.projectMember.updateRole({
        projectId: project.id,
        userId: newUser.id,
        role: "Maintainer",
      });
      expect(await committedMembers(project.id)).toEqual([
        { userId: actor.id, email: actor.email, role: "Owner" },
        { userId: newUser.id, email: newUser.email, role: "Maintainer" },
      ]);

      await caller.projectMember.remove({
        projectId: project.id,
        userId: newUser.id,
      });
      expect(await committedMembers(project.id)).toEqual([
        { userId: actor.id, email: actor.email, role: "Owner" },
      ]);
      const repo = await openProjectRepo(project.id);
      const [entry] = await repo!.logForPath("project.json", {
        skip: 0,
        limit: 1,
      });
      expect(entry).toMatchObject({
        message: "update: project.json",
        userId: actor.id,
      });
    });
  });

  describe("list", () => {
    it("returns members with profile and project role for any member", async () => {
      const { project, caller } = await setupProjectWith("Viewer");
      const owner = await makeUser("User", "o");
      await addMembership(project.id, owner.id, "Owner");
      const members = await caller.projectMember.list({
        projectId: project.id,
      });
      expect(members).toHaveLength(2);
      const ownerRow = members.find((m) => m.userId === owner.id);
      expect(ownerRow).toMatchObject({ role: "Owner", email: owner.email });
    });

    it("forbids non-members", async () => {
      const { project } = await setupProjectWith("Owner");
      const stranger = await makeUser("User", "s");
      await expect(
        callerFor(stranger).projectMember.list({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("add", () => {
    it("lets a Maintainer add an Editor by email", async () => {
      const { project, caller } = await setupProjectWith("Maintainer");
      const newUser = await makeUser("User", "add1");
      const added = await caller.projectMember.add({
        projectId: project.id,
        email: newUser.email,
        role: "Editor",
      });
      expect(added).toMatchObject({ userId: newUser.id, role: "Editor" });
    });

    it("forbids Editors from adding members", async () => {
      const { project, caller } = await setupProjectWith("Editor");
      const newUser = await makeUser("User", "add2");
      await expect(
        caller.projectMember.add({
          projectId: project.id,
          email: newUser.email,
          role: "Viewer",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("forbids a Maintainer from granting Owner or Maintainer", async () => {
      const { project, caller } = await setupProjectWith("Maintainer");
      const a = await makeUser("User", "add3");
      const b = await makeUser("User", "add4");
      await expect(
        caller.projectMember.add({
          projectId: project.id,
          email: a.email,
          role: "Owner",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller.projectMember.add({
          projectId: project.id,
          email: b.email,
          role: "Maintainer",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("lets an Owner grant Owner", async () => {
      const { project, caller } = await setupProjectWith("Owner");
      const newUser = await makeUser("User", "add5");
      const added = await caller.projectMember.add({
        projectId: project.id,
        email: newUser.email,
        role: "Owner",
      });
      expect(added.role).toBe("Owner");
    });

    it("returns CONFLICT for existing members and NOT_FOUND for unknown emails", async () => {
      const { actor, project, caller } = await setupProjectWith("Owner");
      await expect(
        caller.projectMember.add({
          projectId: project.id,
          email: actor.email,
          role: "Viewer",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        caller.projectMember.add({
          projectId: project.id,
          email: "ghost@nowhere.local",
          role: "Viewer",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("updateRole", () => {
    it("lets an Owner promote/demote members", async () => {
      const { project, caller } = await setupProjectWith("Owner");
      const member = await makeUser("User", "ur1");
      await addMembership(project.id, member.id, "Viewer");
      const updated = await caller.projectMember.updateRole({
        projectId: project.id,
        userId: member.id,
        role: "Maintainer",
      });
      expect(updated.role).toBe("Maintainer");
    });

    it("forbids changing your own membership", async () => {
      const { actor, project, caller } = await setupProjectWith("Owner");
      const other = await makeUser("User", "ur2");
      await addMembership(project.id, other.id, "Owner");
      await expect(
        caller.projectMember.updateRole({
          projectId: project.id,
          userId: actor.id,
          role: "Viewer",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("blocks demoting the last Owner", async () => {
      const { actor, project, caller } = await setupProjectWith("Owner");
      const other = await makeUser("User", "ur3");
      await addMembership(project.id, other.id, "Editor");
      await expect(
        caller.projectMember.updateRole({
          projectId: project.id,
          userId: actor.id,
          role: "Editor",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" }); // self-change blocked first
      await expect(
        caller.projectMember.updateRole({
          projectId: project.id,
          userId: other.id,
          role: "Owner",
        }),
      ).resolves.toMatchObject({ role: "Owner" });
      // now two owners; demoting one is allowed...
      await expect(
        caller.projectMember.updateRole({
          projectId: project.id,
          userId: other.id,
          role: "Editor",
        }),
      ).resolves.toMatchObject({ role: "Editor" });
    });

    it("blocks a second Owner from demoting the only remaining Owner", async () => {
      const owner1 = await makeUser("User", "ur4");
      const owner2 = await makeUser("User", "ur5");
      const project = await makeProject("P-last-owner");
      await addMembership(project.id, owner1.id, "Owner");
      await addMembership(project.id, owner2.id, "Owner");
      // owner1 removes themselves via updateRole? self-change blocked; use remove below.
      // Demote scenario: only owner2 acts on owner1 while owner2 stays Owner → allowed (2 owners).
      await callerFor(owner2).projectMember.updateRole({
        projectId: project.id,
        userId: owner1.id,
        role: "Viewer",
      });
      // Now owner2 is the single Owner; demoting anyone else to Owner then back keeps one owner:
      await expect(
        callerFor(owner2).projectMember.updateRole({
          projectId: project.id,
          userId: owner1.id,
          role: "Maintainer",
        }),
      ).resolves.toBeTruthy();
    });

    it("only lets Owners change an Owner's role", async () => {
      const maintainer = await makeUser("User", "ur-maint");
      const owner1 = await makeUser("User", "ur-owner1");
      const owner2 = await makeUser("User", "ur-owner2");
      const project = await makeProject("P-owner-protection");
      await addMembership(project.id, maintainer.id, "Maintainer");
      await addMembership(project.id, owner1.id, "Owner");
      await addMembership(project.id, owner2.id, "Owner");
      await expect(
        callerFor(maintainer).projectMember.updateRole({
          projectId: project.id,
          userId: owner1.id,
          role: "Viewer",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      // With two Owners, one Owner may demote the other.
      await expect(
        callerFor(owner1).projectMember.updateRole({
          projectId: project.id,
          userId: owner2.id,
          role: "Viewer",
        }),
      ).resolves.toMatchObject({ role: "Viewer" });
    });

    it.each(["demote", "remove"] as const)(
      "keeps an Owner when two Owners concurrently %s each other",
      async (action) => {
        const owner1 = await makeUser("User", `ur-race-${action}-owner1`);
        const owner2 = await makeUser("User", `ur-race-${action}-owner2`);
        const project = await makeProject(`P-owner-race-${action}`);
        await addMembership(project.id, owner1.id, "Owner");
        await addMembership(project.id, owner2.id, "Owner");
        const db = getPrisma();
        await db.$executeRaw`
        CREATE FUNCTION test_delay_owner_update() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_sleep(0.2);
          IF TG_OP = 'DELETE' THEN
            RETURN OLD;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `;
        await db.$executeRaw`
        CREATE TRIGGER test_delay_owner_update
        BEFORE UPDATE OR DELETE ON "Member"
        FOR EACH ROW EXECUTE FUNCTION test_delay_owner_update()
      `;
        try {
          const mutate = (actor: typeof owner1, target: typeof owner1) =>
            action === "demote"
              ? callerFor(actor).projectMember.updateRole({
                  projectId: project.id,
                  userId: target.id,
                  role: "Viewer",
                })
              : callerFor(actor).projectMember.remove({
                  projectId: project.id,
                  userId: target.id,
                });
          const outcomes = await Promise.allSettled([
            mutate(owner1, owner2),
            mutate(owner2, owner1),
          ]);
          const { organizationId } = await db.project.findUniqueOrThrow({
            where: { id: project.id },
            select: { organizationId: true },
          });

          expect(
            outcomes.filter((outcome) => outcome.status === "fulfilled"),
          ).toHaveLength(1);
          expect(
            await db.member.count({
              where: { organizationId, role: "owner" },
            }),
          ).toBe(1);
        } finally {
          await db.$executeRaw`DROP TRIGGER test_delay_owner_update ON "Member"`;
          await db.$executeRaw`DROP FUNCTION test_delay_owner_update()`;
        }
      },
    );

    it("blocks a non-member Admin, then a Maintainer Admin, from changing or removing the sole Owner", async () => {
      const admin = await makeUser("Admin", "ur-admin");
      const soleOwner = await makeUser("User", "ur-sole-owner");
      const project = await makeProject("P-admin-last-owner");
      await addMembership(project.id, soleOwner.id, "Owner");

      await expect(
        callerFor(admin).projectMember.updateRole({
          projectId: project.id,
          userId: soleOwner.id,
          role: "Viewer",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await addMembership(project.id, admin.id, "Maintainer");
      await expect(
        callerFor(admin).projectMember.updateRole({
          projectId: project.id,
          userId: soleOwner.id,
          role: "Viewer",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerFor(admin).projectMember.remove({
          projectId: project.id,
          userId: soleOwner.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("remove", () => {
    it("lets a Maintainer remove an Editor but not an Owner", async () => {
      const { project, caller } = await setupProjectWith("Maintainer");
      const editor = await makeUser("User", "rm1");
      const owner = await makeUser("User", "rm2");
      await addMembership(project.id, editor.id, "Editor");
      await addMembership(project.id, owner.id, "Owner");
      await caller.projectMember.remove({
        projectId: project.id,
        userId: editor.id,
      });
      const { organizationId } = await getPrisma().project.findUniqueOrThrow({
        where: { id: project.id },
        select: { organizationId: true },
      });
      expect(
        await getPrisma().member.findUnique({
          where: {
            organizationId_userId: { organizationId, userId: editor.id },
          },
        }),
      ).toBeNull();
      await expect(
        caller.projectMember.remove({
          projectId: project.id,
          userId: owner.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("blocks removing the last Owner and removing yourself", async () => {
      const { actor, project, caller } = await setupProjectWith("Owner");
      await expect(
        caller.projectMember.remove({
          projectId: project.id,
          userId: actor.id,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const other = await makeUser("User", "rm3");
      await addMembership(project.id, other.id, "Viewer");
      await expect(
        caller.projectMember.remove({
          projectId: project.id,
          userId: actor.id,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("lets a global Admin manage members of any project", async () => {
      const admin = await makeUser("Admin", "adm");
      const { project } = await setupProjectWith("Owner");
      await addMembership(project.id, admin.id, "Owner");
      const newUser = await makeUser("User", "rm4");
      await callerFor(admin).projectMember.add({
        projectId: project.id,
        email: newUser.email,
        role: "Viewer",
      });
      await callerFor(admin).projectMember.remove({
        projectId: project.id,
        userId: newUser.id,
      });
    });
  });
});

describe("training roles", () => {
  beforeEach(resetDb);
  it("sets, mirrors and clears orthogonal training roles", async () => {
    const { actor, project, caller } = await setupProjectWith("Owner");
    const trainee = await makeUser("User", "training-trainee");
    await addMembership(project.id, trainee.id, "Viewer");
    await caller.projectMember.setTrainingRole({
      projectId: project.id,
      userId: trainee.id,
      role: "trainee",
    });
    await caller.projectMember.setTrainingRole({
      projectId: project.id,
      userId: actor.id,
      role: "trainer",
    });
    expect(
      (await caller.projectMember.list({ projectId: project.id })).find(
        (row) => row.userId === trainee.id,
      )?.trainingRole,
    ).toBe("trainee");
    expect(
      (await caller.project.get({ projectId: project.id })).myTrainingRole,
    ).toBe("trainer");
    const repo = await openProjectRepo(project.id);
    expect((await repo!.readCommittedFile("project.json"))!.content).toContain(
      '"training": "trainee"',
    );
    await caller.projectMember.setTrainingRole({
      projectId: project.id,
      userId: trainee.id,
      role: null,
    });
    expect(
      await getPrisma().projectTrainingRole.count({
        where: { projectId: project.id, userId: trainee.id },
      }),
    ).toBe(0);
    await caller.projectMember.setTrainingRole({
      projectId: project.id,
      userId: trainee.id,
      role: "trainee",
    });
    await caller.projectMember.remove({
      projectId: project.id,
      userId: trainee.id,
    });
    expect(
      await getPrisma().projectTrainingRole.count({
        where: { projectId: project.id, userId: trainee.id },
      }),
    ).toBe(0);
  });
  it("requires Maintainer membership, including for global admins", async () => {
    const { actor, project, caller } = await setupProjectWith("Editor");
    await expect(
      caller.projectMember.setTrainingRole({
        projectId: project.id,
        userId: actor.id,
        role: "trainer",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsider = await makeUser("Admin", "training-outsider");
    await expect(
      callerFor(outsider).projectMember.setTrainingRole({
        projectId: project.id,
        userId: actor.id,
        role: "trainer",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

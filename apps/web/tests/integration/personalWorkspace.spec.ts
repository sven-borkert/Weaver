import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, Project } from "@weaver/db/client";
import { softDeleteProject } from "@weaver/core/services/projects";
import { ensurePersonalWorkspace } from "@weaver/core/services/personalWorkspace";
import { openProjectRepo } from "@weaver/git-store";
import { fromOrganizationRole } from "@weaver/core/roles";
import {
  callerFor,
  getPrisma,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

describe("ensurePersonalWorkspace", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a named, owner-only project flagged as personal, with a repository", async () => {
    const user = await makeUser("User", "pw1");
    const id = await ensurePersonalWorkspace(getPrisma(), user.id);
    expect(id).toBeTruthy();
    const project = await getPrisma().project.findUniqueOrThrow({
      where: { id: id! },
      include: { organization: { include: { members: true } } },
    });
    expect(project.name).toBe("User pw1's workspace");
    expect(project.personalOwnerId).toBe(user.id);
    expect(project.organization.members).toHaveLength(1);
    expect(fromOrganizationRole(project.organization.members[0]!.role)).toBe(
      "Owner",
    );
    expect(await openProjectRepo(id!)).not.toBeNull();
    expect(
      await getPrisma().projectDefaultReviewer.findMany({
        where: { projectId: id! },
      }),
    ).toMatchObject([{ userId: user.id, groupId: null }]);
  });

  it("is idempotent and safe under concurrency", async () => {
    const user = await makeUser("User", "pw2");
    const landings = await Promise.all([
      callerFor(user).account.landingProject(),
      callerFor(user).account.landingProject(),
      callerFor(user).account.landingProject(),
    ]);
    expect(landings[0]?.projectId).toBeTruthy();
    expect(new Set(landings.map(({ projectId }) => projectId)).size).toBe(1);
    expect(
      await getPrisma().project.count({ where: { personalOwnerId: user.id } }),
    ).toBe(1);
    // No orphaned loser: exactly one project has a membership for this user.
    expect(
      await getPrisma().project.count({
        where: { organization: { members: { some: { userId: user.id } } } },
      }),
    ).toBe(1);
  });

  it("publishes ownership before a project becomes a landing destination", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "pw-publish");
    let publish!: (project: Project) => void;
    let resume!: () => void;
    const published = new Promise<Project>((resolve) => (publish = resolve));
    const release = new Promise<void>((resolve) => (resume = resolve));
    type Transaction = (
      run: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number },
    ) => Promise<unknown>;
    const transact = db.$transaction.bind(db) as Transaction;
    const spy = vi
      .spyOn(db, "$transaction")
      .mockImplementation(
        async (
          run: Parameters<Transaction>[0],
          options?: Parameters<Transaction>[1],
        ) => {
          const result = await transact(run, options);
          if (
            typeof result === "object" &&
            result !== null &&
            "organizationId" in result
          ) {
            spy.mockRestore();
            publish(result as Project);
            await release;
          }
          return result;
        },
      );
    const first = callerFor(user).account.landingProject();
    try {
      const project = await Promise.race([
        published,
        first.then(() => {
          throw new Error("No project publication observed");
        }),
      ]);
      const visible = await db.project.findUniqueOrThrow({
        where: { id: project.id },
      });
      expect(visible.personalOwnerId).toBe(user.id);
      await expect(
        softDeleteProject(db, project.id, securityContextFor(user)),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(callerFor(user).account.landingProject()).resolves.toEqual({
        projectId: project.id,
      });
      resume();
      await expect(first).resolves.toEqual({ projectId: project.id });
    } finally {
      resume();
      spy.mockRestore();
      await first.catch(() => undefined);
    }
  });

  it("creates a fresh workspace when the old one was soft-deleted directly in the database", async () => {
    const user = await makeUser("User", "pw3");
    const first = await ensurePersonalWorkspace(getPrisma(), user.id);
    await getPrisma().project.update({
      where: { id: first! },
      data: { deletedAt: new Date() },
    });
    const second = await ensurePersonalWorkspace(getPrisma(), user.id);
    expect(second).not.toBe(first);
    const oldProject = await getPrisma().project.findUniqueOrThrow({
      where: { id: first! },
    });
    expect(oldProject.personalOwnerId).toBeNull();
  });

  it("restores the owner's membership when it was removed from a live workspace", async () => {
    const user = await makeUser("User", "pw4");
    const id = await ensurePersonalWorkspace(getPrisma(), user.id);
    const project = await getPrisma().project.findUniqueOrThrow({
      where: { id: id! },
      select: { organizationId: true },
    });
    await getPrisma().member.deleteMany({
      where: { organizationId: project.organizationId, userId: user.id },
    });
    expect(
      await getPrisma().member.count({
        where: { organizationId: project.organizationId, userId: user.id },
      }),
    ).toBe(0);

    const again = await ensurePersonalWorkspace(getPrisma(), user.id);
    expect(again).toBe(id);
    const member = await getPrisma().member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: project.organizationId,
          userId: user.id,
        },
      },
    });
    expect(member).not.toBeNull();
    expect(fromOrganizationRole(member!.role)).toBe("Owner");
  });

  it("returns null for an unknown user", async () => {
    expect(
      await ensurePersonalWorkspace(
        getPrisma(),
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
  });
});

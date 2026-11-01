import { beforeEach, describe, expect, it } from "vitest";
import {
  createReviewerGroup,
  defaultReviewFor,
  deleteReviewerGroup,
  getReviewDefaults,
  listReviewerGroups,
  renameReviewerGroup,
  resolveImportedReview,
  resolveReviewerTargets,
  setReviewDefaults,
  setReviewerGroupMembers,
} from "@weaver/core/services/reviewerGroups";
import { createDocument } from "@weaver/core/services/documents";
import { createProject } from "@weaver/core/services/projects";
import { removeMember } from "@weaver/core/services/projectMembers";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

type User = Awaited<ReturnType<typeof makeUser>>;

const NOW = "2026-10-07T00:00:00.000Z";

function ctx(user: User) {
  return securityContextFor(user);
}

async function fixture(suffix: string) {
  const db = getPrisma();
  const owner = await makeUser("User", `${suffix}-owner`);
  const editor = await makeUser("User", `${suffix}-editor`);
  const outsider = await makeUser("User", `${suffix}-out`);
  const project = await makeProject(`Review ${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, editor.id, "Editor");
  return { db, owner, editor, outsider, project };
}

describe("reviewer groups and project review defaults", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lets only Owners manage groups", async () => {
    const { db, owner, editor, project } = await fixture("g1");
    await expect(
      createReviewerGroup(
        db,
        { projectId: project.id, name: "Ops", memberIds: [editor.id] },
        ctx(editor),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const group = await createReviewerGroup(
      db,
      { projectId: project.id, name: " Ops ", memberIds: [editor.id] },
      ctx(owner),
    );
    expect(group).toMatchObject({
      name: "Ops",
      members: [{ userId: editor.id }],
    });
    expect(
      await listReviewerGroups(db, { projectId: project.id }, ctx(editor)),
    ).toHaveLength(1);
    await expect(
      renameReviewerGroup(
        db,
        { projectId: project.id, groupId: group.id, name: "Ops 2" },
        ctx(editor),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      deleteReviewerGroup(
        db,
        { projectId: project.id, groupId: group.id },
        ctx(editor),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("hides the project from non-members", async () => {
    const { db, outsider, project } = await fixture("g1b");
    await expect(
      listReviewerGroups(db, { projectId: project.id }, ctx(outsider)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getReviewDefaults(db, { projectId: project.id }, ctx(outsider)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("renames, replaces members and deletes a group", async () => {
    const { db, owner, editor, project } = await fixture("g2a");
    const group = await createReviewerGroup(
      db,
      { projectId: project.id, name: "Ops", memberIds: [editor.id] },
      ctx(owner),
    );
    await renameReviewerGroup(
      db,
      { projectId: project.id, groupId: group.id, name: "Platform" },
      ctx(owner),
    );
    await setReviewerGroupMembers(
      db,
      { projectId: project.id, groupId: group.id, memberIds: [owner.id] },
      ctx(owner),
    );
    const listed = await listReviewerGroups(
      db,
      { projectId: project.id },
      ctx(owner),
    );
    expect(listed).toEqual([
      {
        id: group.id,
        name: "Platform",
        members: [{ userId: owner.id, name: "User g2a-owner" }],
      },
    ]);
    await deleteReviewerGroup(
      db,
      { projectId: project.id, groupId: group.id },
      ctx(owner),
    );
    expect(
      await listReviewerGroups(db, { projectId: project.id }, ctx(owner)),
    ).toEqual([]);
  });

  it("rejects a duplicate name and a non-member", async () => {
    const { db, owner, editor, outsider, project } = await fixture("g2");
    const input = { projectId: project.id, memberIds: [editor.id] };
    await createReviewerGroup(db, { ...input, name: "Ops" }, ctx(owner));
    await expect(
      createReviewerGroup(db, { ...input, name: "Ops" }, ctx(owner)),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { field: "name" } });
    await expect(
      createReviewerGroup(
        db,
        { projectId: project.id, name: "Other", memberIds: [outsider.id] },
        ctx(owner),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "memberIds" },
    });
    const other = await createReviewerGroup(
      db,
      { ...input, name: "Other" },
      ctx(owner),
    );
    await expect(
      renameReviewerGroup(
        db,
        { projectId: project.id, groupId: other.id, name: "Ops" },
        ctx(owner),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { field: "name" } });
    await expect(
      setReviewerGroupMembers(
        db,
        {
          projectId: project.id,
          groupId: other.id,
          memberIds: [outsider.id],
        },
        ctx(owner),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "memberIds" },
    });
  });

  it("validates group names", async () => {
    const { db, owner, project } = await fixture("g2n");
    for (const name of ["   ", "a".repeat(81), "two\nlines"]) {
      await expect(
        createReviewerGroup(
          db,
          { projectId: project.id, name, memberIds: [] },
          ctx(owner),
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { field: "name" },
      });
    }
    await expect(
      createReviewerGroup(
        db,
        { projectId: project.id, name: "a".repeat(80), memberIds: [] },
        ctx(owner),
      ),
    ).resolves.toMatchObject({ members: [] });
  });

  it("limits groups per project", async () => {
    const { db, owner, project } = await fixture("g2l");
    await db.reviewerGroup.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        projectId: project.id,
        name: `Group ${i}`,
      })),
    });
    await expect(
      createReviewerGroup(
        db,
        { projectId: project.id, name: "One too many", memberIds: [] },
        ctx(owner),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("limits the members of a group", async () => {
    const { db, owner, project } = await fixture("g2m");
    const ids = Array.from(
      { length: 201 },
      () => "00000000-0000-4000-8000-000000000000",
    ).map((id, i) => id.slice(0, -4) + String(i).padStart(4, "0"));
    await expect(
      createReviewerGroup(
        db,
        { projectId: project.id, name: "Big", memberIds: ids },
        ctx(owner),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("defaults to the Owners and 12 months", async () => {
    const { db, owner, project } = await fixture("g3");
    const review = await defaultReviewFor(db, project.id, NOW);
    expect(review).toEqual({
      reviewers: [{ type: "user", id: owner.id, name: expect.any(String) }],
      everyMonths: 12,
      since: NOW,
      lastReviewed: null,
      reviewedBy: null,
    });
  });

  it("seeds the creator as default reviewer for new projects", async () => {
    const db = getPrisma();
    const creator = await makeUser("User", "g3c");
    const project = await createProject(db, ctx(creator), { name: "Fresh" });
    const rows = await db.projectDefaultReviewer.findMany({
      where: { projectId: project.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: creator.id, groupId: null });
    const defaults = await getReviewDefaults(
      db,
      { projectId: project.id },
      ctx(creator),
    );
    expect(defaults).toMatchObject({
      everyMonths: 12,
      canManage: true,
      reviewers: [{ type: "user", id: creator.id }],
    });
  });

  it("uses configured defaults", async () => {
    const { db, owner, editor, project } = await fixture("g4");
    const group = await createReviewerGroup(
      db,
      { projectId: project.id, name: "Ops", memberIds: [editor.id] },
      ctx(owner),
    );
    await expect(
      setReviewDefaults(
        db,
        {
          projectId: project.id,
          everyMonths: 6,
          reviewers: [{ type: "group", id: group.id }],
        },
        ctx(editor),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await setReviewDefaults(
      db,
      {
        projectId: project.id,
        everyMonths: 6,
        reviewers: [{ type: "group", id: group.id }],
      },
      ctx(owner),
    );
    const review = await defaultReviewFor(db, project.id, NOW);
    expect(review.everyMonths).toBe(6);
    expect(review.reviewers).toEqual([
      { type: "group", id: group.id, name: "Ops" },
    ]);
    const asEditor = await getReviewDefaults(
      db,
      { projectId: project.id },
      ctx(editor),
    );
    expect(asEditor).toEqual({
      everyMonths: 6,
      reviewers: [{ type: "group", id: group.id, name: "Ops" }],
      canManage: false,
    });
    expect(
      (await getReviewDefaults(db, { projectId: project.id }, ctx(owner)))
        .canManage,
    ).toBe(true);
  });

  it("validates review defaults", async () => {
    const { db, owner, outsider, project } = await fixture("g4v");
    const ok = [{ type: "user" as const, id: owner.id }];
    for (const everyMonths of [0, 121, 1.5]) {
      await expect(
        setReviewDefaults(
          db,
          { projectId: project.id, everyMonths, reviewers: ok },
          ctx(owner),
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { field: "everyMonths" },
      });
    }
    await expect(
      setReviewDefaults(
        db,
        {
          projectId: project.id,
          everyMonths: 12,
          reviewers: [{ type: "user", id: outsider.id }],
        },
        ctx(owner),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "reviewers" },
    });
    // Failed writes leave the previous defaults untouched.
    expect(
      (await getReviewDefaults(db, { projectId: project.id }, ctx(owner)))
        .everyMonths,
    ).toBe(12);
  });

  it("falls back to the Owners when no default resolves", async () => {
    const { db, owner, project } = await fixture("g4f");
    await setReviewDefaults(
      db,
      { projectId: project.id, everyMonths: 3, reviewers: [] },
      ctx(owner),
    );
    const review = await defaultReviewFor(db, project.id, NOW);
    expect(review.everyMonths).toBe(3);
    expect(review.reviewers).toMatchObject([{ type: "user", id: owner.id }]);
  });

  it("rejects unknown reviewer targets", async () => {
    const { db, outsider, project } = await fixture("g4t");
    await expect(
      resolveReviewerTargets(db, project.id, [
        { type: "user", id: outsider.id },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      resolveReviewerTargets(db, project.id, [
        { type: "group", id: "00000000-0000-4000-8000-000000000001" },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("drops a removed member from groups and defaults", async () => {
    const { db, owner, editor, project } = await fixture("g5");
    const group = await createReviewerGroup(
      db,
      { projectId: project.id, name: "Ops", memberIds: [editor.id] },
      ctx(owner),
    );
    await setReviewDefaults(
      db,
      {
        projectId: project.id,
        everyMonths: 12,
        reviewers: [
          { type: "user", id: editor.id },
          { type: "group", id: group.id },
        ],
      },
      ctx(owner),
    );
    const document = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Text.\n"),
        },
      },
      { ...ctx(owner), name: "Owner", email: owner.email },
    );
    const row = await db.documentReviewer.findFirstOrThrow({
      where: { documentId: document.id, type: "user", refId: editor.id },
    });
    expect(row.userId).toBe(editor.id);

    await removeMember(
      db,
      { projectId: project.id, userId: editor.id },
      ctx(owner),
    );

    expect(
      (await listReviewerGroups(db, { projectId: project.id }, ctx(owner)))[0]
        ?.members,
    ).toEqual([]);
    const defaults = await db.projectDefaultReviewer.findMany({
      where: { projectId: project.id },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({ groupId: group.id, userId: null });
    expect(
      await db.documentReviewer.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ userId: null, refId: editor.id });
    const metadata = JSON.parse(
      await withProjectRepo(project.id, (repo) =>
        repo.readFileFromWorktree("project.json"),
      ),
    ) as {
      documentReview: { defaultReviewers: unknown };
      reviewerGroups: { members: string[] }[];
    };
    expect(metadata.reviewerGroups[0]?.members).toEqual([]);
    expect(metadata.documentReview.defaultReviewers).toEqual([
      { type: "group", id: group.id },
    ]);
  });

  it("mirrors groups and defaults into project.json", async () => {
    const { db, owner, editor, project } = await fixture("g6");
    const group = await createReviewerGroup(
      db,
      { projectId: project.id, name: "Ops", memberIds: [editor.id] },
      ctx(owner),
    );
    await setReviewDefaults(
      db,
      {
        projectId: project.id,
        everyMonths: 6,
        reviewers: [{ type: "group", id: group.id }],
      },
      ctx(owner),
    );
    const file = await withProjectRepo(project.id, (repo) =>
      repo.readFileFromWorktree("project.json"),
    );
    const metadata = JSON.parse(file) as {
      documentReview: unknown;
      reviewerGroups: unknown;
    };
    expect(metadata.documentReview).toEqual({
      everyMonths: 6,
      defaultReviewers: [{ type: "group", id: group.id }],
    });
    expect(metadata.reviewerGroups).toEqual([
      { id: group.id, name: "Ops", members: [editor.id] },
    ]);
  });

  it("keeps known imported reviewers and the interval, restarting the clock", async () => {
    const { db, owner, editor, outsider, project } = await fixture("g7");
    const imported = {
      reviewers: [
        { type: "user" as const, id: editor.id, name: "Old Editor Name" },
        { type: "user" as const, id: outsider.id, name: "Stranger" },
      ],
      everyMonths: 9,
      since: "2025-01-01T00:00:00.000Z",
      lastReviewed: "2025-06-01T00:00:00.000Z",
      reviewedBy: { id: editor.id, name: "Old Editor Name" },
    };
    const kept = await resolveImportedReview(db, project.id, imported, NOW);
    expect(kept).toEqual({
      reviewers: [{ type: "user", id: editor.id, name: "User g7-editor" }],
      everyMonths: 9,
      since: NOW,
      lastReviewed: null,
      reviewedBy: null,
    });

    const foreign = await resolveImportedReview(
      db,
      project.id,
      { ...imported, reviewers: imported.reviewers.slice(1) },
      NOW,
    );
    expect(foreign.reviewers).toMatchObject([{ type: "user", id: owner.id }]);
    expect(foreign.everyMonths).toBe(9);
    expect(foreign.since).toBe(NOW);
    expect(foreign.lastReviewed).toBeNull();
    expect(foreign.reviewedBy).toBeNull();

    expect(await resolveImportedReview(db, project.id, null, NOW)).toEqual(
      await defaultReviewFor(db, project.id, NOW),
    );
  });
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";
import { openProjectRepo, withProjectRepo } from "@weaver/git-store";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { readRootFolderMetadataAt } from "@weaver/core/services/folders";
import { upgradeFolderMetadata } from "@weaver/core/services/folderMetadataUpgrade";

type MatrixRole = "Owner" | "Maintainer" | "Editor" | "Viewer" | null;

async function setupProjectWith(role: MatrixRole, suffix: string) {
  const owner = await makeUser("User", `owner-${suffix}`);
  const project = await makeProject(`P-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  const ownerCaller = callerFor(owner);
  if (role === null) {
    const outsider = await makeUser("User", `out-${suffix}`);
    return { project, caller: callerFor(outsider), ownerCaller };
  }
  const actor = await makeUser("User", `${role.toLowerCase()}-${suffix}`);
  await addMembership(project.id, actor.id, role);
  return { project, caller: callerFor(actor), ownerCaller };
}

let knowledgeQueue: FakeJobQueue;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  knowledgeQueue = new FakeJobQueue();
  setJobQueueForTests(knowledgeQueue);
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

describe("folder router", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("root_defaults_do_not_create_a_visible_folder", async () => {
    const { project, caller } = await setupProjectWith(
      "Viewer",
      "root-review-defaults",
    );
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        ".folder.json",
        JSON.stringify({
          name: "Not a folder",
          appearance: { backgroundColor: "#112233" },
          reviewDefaults: { reviewers: [] },
        }),
      );
      await repo.commitAll("fixture: root review defaults", {
        name: "Fixture",
        email: "fixture@local",
        userId: randomUUID(),
      });
    });
    const tree = await caller.folder.tree({ projectId: project.id });
    expect(tree.folders).toEqual([]);
    expect(tree.folderNames).toEqual({});
    expect(tree.folderStamps).toEqual({});
    expect(tree.folderAppearances).toEqual({});
    expect(tree.folderReviewDefaults).toEqual({});
    expect(tree.rootReviewDefaults).toEqual({ reviewers: [] });
    const repo = (await openProjectRepo(project.id))!;
    const rootHead = await repo.resolveHead();
    expect(await readRootFolderMetadataAt(repo, rootHead)).toEqual({
      reviewDefaults: { reviewers: [] },
    });

    await withProjectRepo(project.id, async (repo) => {
      await repo.ensureFolder("guides");
      await repo.ensureFolder("nameless");
      await repo.writeFileAtomic(
        "guides/.folder.json",
        JSON.stringify({
          name: "Guides",
          reviewDefaults: { reviewers: [] },
          appearance: { backgroundColor: "#112233" },
        }),
      );
      await repo.writeFileAtomic(
        "nameless/.folder.json",
        '{"reviewDefaults":{"reviewers":[]}}',
      );
      await repo.writeFileAtomic(".folder.json", "{}");
      await repo.commitAll("fixture: normal and malformed defaults", {
        name: "Fixture",
        email: "fixture@local",
        userId: randomUUID(),
      });
    });
    const updated = await caller.folder.tree({ projectId: project.id });
    expect(updated.folders).toEqual(["guides", "nameless"]);
    expect(updated.folderNames).toEqual({ guides: "Guides" });
    expect(updated.folderAppearances).toEqual({
      guides: { backgroundColor: "#112233" },
    });
    expect(updated.folderReviewDefaults).toEqual({ guides: { reviewers: [] } });
    expect(updated).not.toHaveProperty("rootReviewDefaults");
    expect(await readRootFolderMetadataAt(repo, rootHead)).toEqual({
      reviewDefaults: { reviewers: [] },
    });
    expect(
      await readRootFolderMetadataAt(repo, await repo.resolveHead()),
    ).toEqual({});
  });

  describe("create", () => {
    it("slugifies the name and commits a .gitkeep", async () => {
      const { project, caller } = await setupProjectWith("Editor", "c1");
      const res = await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Getting Started",
      });
      expect(res.path).toEqual(["getting-started"]);
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.listTrackedFiles()).toContain(
        "getting-started/.gitkeep",
      );
    });

    it("stores the display name in .folder.json and returns it from the tree", async () => {
      const { project, caller } = await setupProjectWith("Editor", "c0");
      const res = await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "  Implementation Plans ",
      });
      expect(res.path).toEqual(["implementation-plans"]);
      const repo = (await openProjectRepo(project.id))!;
      const blobs = await repo.readBlobsAt("HEAD", [
        "implementation-plans/.folder.json",
      ]);
      expect(
        JSON.parse(blobs.get("implementation-plans/.folder.json")!),
      ).toMatchObject({ name: "Implementation Plans" });
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.folders).toEqual(["implementation-plans"]);
      expect(tree.folderNames).toEqual({
        "implementation-plans": "Implementation Plans",
      });
    });

    it("records who created a folder and who last renamed or moved it", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Editor",
        "stamps",
      );
      const db = getPrisma();
      const editor = await db.user.findFirstOrThrow({
        where: { email: { contains: "editor-stamps" } },
      });
      const owner = await db.user.findFirstOrThrow({
        where: { email: { contains: "owner-stamps" } },
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Plans",
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Archive",
      });
      const repo = (await openProjectRepo(project.id))!;
      const stored = async (path: string) =>
        JSON.parse(
          (await repo.readBlobsAt("HEAD", [path])).get(path)!,
        ) as Record<string, unknown>;
      const reviewDefaults = {
        reviewers: [{ type: "user", id: editor.id, name: editor.name }],
      };
      const appearance = { backgroundColor: "#112233" };
      await withProjectRepo(project.id, async (repo) => {
        const initial = await stored("plans/.folder.json");
        await repo.writeFileAtomic(
          "plans/.folder.json",
          JSON.stringify({ ...initial, reviewDefaults, appearance }),
        );
        await repo.commitAll("fixture: folder defaults and appearance", {
          name: editor.name ?? "Editor",
          email: editor.email,
          userId: editor.id,
        });
      });
      const created = await stored("plans/.folder.json");
      expect(created).toMatchObject({
        name: "Plans",
        createdBy: { id: editor.id },
        updatedBy: { id: editor.id },
      });
      expect(created.updated).toBe(created.created);
      expect(
        (await caller.folder.tree({ projectId: project.id })).folderStamps
          .plans,
      ).toEqual({
        createdAt: new Date(created.created as string),
        createdBy: { id: editor.id, name: editor.name },
        updatedAt: new Date(created.created as string),
        updatedBy: { id: editor.id, name: editor.name },
      });

      await ownerCaller.folder.rename({
        projectId: project.id,
        path: ["plans"],
        name: "Road Plans",
      });
      await ownerCaller.folder.move({
        projectId: project.id,
        path: ["road-plans"],
        newParentPath: ["archive"],
      });
      const moved = await stored("archive/road-plans/.folder.json");
      expect(moved).toMatchObject({
        name: "Road Plans",
        reviewDefaults,
        appearance,
        created: created.created,
        createdBy: { id: editor.id },
        updatedBy: { id: owner.id },
      });
      expect(
        (await caller.folder.tree({ projectId: project.id }))
          .folderReviewDefaults,
      ).toEqual({ "archive/road-plans": reviewDefaults });
      expect(
        Date.parse(moved.updated as string) >=
          Date.parse(created.created as string),
      ).toBe(true);
    });

    it("backfills stamps for folders without them from Git history", async () => {
      const { project, caller } = await setupProjectWith("Editor", "backfill");
      const db = getPrisma();
      const editor = await db.user.findFirstOrThrow({
        where: { email: { contains: "editor-backfill" } },
      });
      const reviewDefaults = {
        reviewers: [{ type: "user", id: editor.id, name: editor.name }],
      };
      const appearance = { backgroundColor: "#112233" };
      await withProjectRepo(project.id, async (repo) => {
        await repo.ensureFolder("legacy");
        await repo.ensureFolder("named");
        await repo.writeFileAtomic(
          "named/.folder.json",
          JSON.stringify({ name: "Named", reviewDefaults, appearance }),
        );
        await repo.commitAll("create: legacy/", {
          name: editor.name ?? "",
          email: editor.email,
          userId: editor.id,
        });
      });
      await db.project.update({
        where: { id: project.id },
        data: { folderMetadataVersion: 0 },
      });

      expect(await upgradeFolderMetadata(db)).toEqual({
        projects: 1,
        folders: 2,
      });
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.folderNames).toEqual({ legacy: "legacy", named: "Named" });
      expect(tree.folderReviewDefaults).toEqual({ named: reviewDefaults });
      expect(tree.folderAppearances).toEqual({ named: appearance });
      const repo = (await openProjectRepo(project.id))!;
      expect(
        JSON.parse(
          (await repo.readBlobsAt("HEAD", ["named/.folder.json"])).get(
            "named/.folder.json",
          )!,
        ),
      ).toMatchObject({ reviewDefaults, appearance });
      for (const folder of ["legacy", "named"])
        expect(tree.folderStamps[folder]).toMatchObject({
          createdAt: expect.any(Date),
          createdBy: { id: editor.id, name: editor.name },
          updatedBy: { id: editor.id, name: editor.name },
        });
      // The project is current afterwards and is not visited again.
      expect(await upgradeFolderMetadata(db)).toEqual({
        projects: 0,
        folders: 0,
      });
    });

    it("falls back to the slug for folders without metadata and ignores a malformed file", async () => {
      const { project, caller } = await setupProjectWith("Editor", "c0b");
      await withProjectRepo(project.id, async (repo) => {
        await repo.ensureFolder("legacy");
        await repo.ensureFolder("broken");
        await repo.writeFileAtomic("broken/.folder.json", "{not json");
        await repo.commitAll("create: legacy/", {
          name: "t",
          email: "t@local",
          userId: randomUUID(),
        });
      });
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.folders).toEqual(["broken", "legacy"]);
      expect(tree.folderNames).toEqual({});
    });

    it("rejects slugified-sibling collisions with field-pinned CONFLICT", async () => {
      const { project, caller } = await setupProjectWith("Editor", "c2");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Foo Bar",
      });
      await expect(
        caller.folder.create({
          projectId: project.id,
          parentPath: [],
          name: "foo-bar",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", cause: { field: "name" } });
    });

    it("rejects depth beyond 10 with BAD_REQUEST", async () => {
      const { project, caller } = await setupProjectWith("Editor", "c3");
      let parentPath: string[] = [];
      for (let i = 0; i < 10; i++) {
        const result = await caller.folder.create({
          projectId: project.id,
          parentPath,
          name: `d${i}`,
        });
        parentPath = result.path;
      }
      await expect(
        caller.folder.create({
          projectId: project.id,
          parentPath,
          name: "toodeep",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("forbids Viewers and hides projects from non-members", async () => {
      const { project, caller } = await setupProjectWith("Viewer", "c4");
      await expect(
        caller.folder.create({
          projectId: project.id,
          parentPath: [],
          name: "x",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const { project: hiddenProject, caller: outsider } =
        await setupProjectWith(null, "c5");
      await expect(
        outsider.folder.create({
          projectId: hiddenProject.id,
          parentPath: [],
          name: "x",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("does not let a non-member Admin create folders", async () => {
      const admin = await makeUser("Admin", "c6");
      const { project: adminProject } = await setupProjectWith("Viewer", "c7");
      await expect(
        callerFor(admin).folder.create({
          projectId: adminProject.id,
          parentPath: [],
          name: "x",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("tree", () => {
    it("lists directories for Viewers", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Viewer",
        "t1",
      );
      await ownerCaller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "guides",
      });
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.folders).toContain("guides");
      expect(tree.documents).toEqual([]);
    });

    it("does not list the reserved tables root in the documents tree", async () => {
      const { project, caller } = await setupProjectWith("Editor", "fres1");
      await caller.tableFolder.create({
        projectId: project.id,
        parentPath: [],
        name: "Finance",
      });
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.folders).toEqual([]);
    });

    it("carries last-edited metadata for each document", async () => {
      const user = await makeUser("User", "tmeta");
      const project = await makeProject("P-tmeta");
      await addMembership(project.id, user.id, "Editor");
      const caller = callerFor(user);
      await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Meta",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      });
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.documents).toHaveLength(1);
      expect(tree.documents[0]!.lastEditedAt).toBeInstanceOf(Date);
      // Documents show their metadata: creator and last updater.
      expect(tree.documents[0]!.createdBy).toEqual({
        id: user.id,
        name: "User tmeta",
      });
      expect(tree.documents[0]!.lastEditedBy).toEqual({
        id: user.id,
        name: "User tmeta",
      });
    });

    it("carries the review schedule of each document", async () => {
      const user = await makeUser("User", "trev");
      const project = await makeProject("P-trev");
      await addMembership(project.id, user.id, "Owner");
      const caller = callerFor(user);
      const created = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Scheduled",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      });
      const unreviewed = await caller.folder.tree({ projectId: project.id });
      expect(unreviewed.documents[0]!.reviewDueAt).toBeInstanceOf(Date);
      expect(unreviewed.documents[0]!.lastReviewedAt).toBeNull();

      await caller.document.markReviewed({
        projectId: project.id,
        documentId: created.id,
        expectedHeadCommitSha: created.headCommitSha,
      });
      const reviewed = await caller.folder.tree({ projectId: project.id });
      expect(reviewed.documents[0]!.lastReviewedAt).toBeInstanceOf(Date);
    });

    it("carries three index lights per document", async () => {
      const { project, caller } = await setupProjectWith("Viewer", "lights");
      const db = getPrisma();
      const sha = "1".repeat(40);
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await db.document.createMany({
        data: ids.map((id, index) => ({
          id,
          projectId: project.id,
          path: `lights-${index}.md`,
          slug: `lights-${index}`,
          title: `Lights ${index}`,
          excerpt: "",
          headCommitSha: sha,
          lastEditedAt: new Date("2026-09-01T00:00:00.000Z"),
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        })),
      });
      // 0: everything ready. 1: keyword failed. 2: no state at all.
      await db.documentIndexState.createMany({
        data: [
          {
            documentId: ids[0]!,
            projectId: project.id,
            targetSha: sha,
            keywordIndexedSha: sha,
            status: "ready",
          },
          {
            documentId: ids[1]!,
            projectId: project.id,
            targetSha: sha,
            status: "failed",
            failureKind: "validation",
            failureSummary: "Document exceeds keyword indexing limits",
          },
        ],
      });
      const generation = await db.knowledgeGeneration.create({
        data: {
          projectId: project.id,
          configFingerprint: "fp-lights",
          embeddingModel: "test-embedding",
          embeddingDimensions: 1536,
          extractionSchemaVersion: 1,
          promptVersion: "prompt-v1",
          status: "active",
        },
      });
      await db.knowledgeGenerationDocument.create({
        data: {
          generationId: generation.id,
          documentId: ids[0]!,
          projectId: project.id,
          targetSha: sha,
          semanticIndexedSha: sha,
          graphIndexedSha: sha,
          configFingerprint: "fp-lights",
          status: "ready",
        },
      });

      const tree = await caller.folder.tree({ projectId: project.id });
      const byId = new Map(tree.documents.map((d) => [d.id, d.index]));
      expect(byId.get(ids[0]!)).toEqual({
        keyword: "ready",
        semantic: "ready",
        graph: "ready",
        summary: null,
      });
      expect(byId.get(ids[1]!)).toEqual({
        keyword: "failed",
        semantic: "pending",
        graph: "pending",
        summary: "Document exceeds keyword indexing limits",
      });
      expect(byId.get(ids[2]!)).toEqual({
        keyword: "pending",
        semantic: "pending",
        graph: "pending",
        summary: null,
      });
    });

    it("marks semantic and graph unavailable when no generation exists", async () => {
      const { project, caller } = await setupProjectWith("Viewer", "nolights");
      await getPrisma().document.create({
        data: {
          id: randomUUID(),
          projectId: project.id,
          path: "solo.md",
          slug: "solo",
          title: "Solo",
          excerpt: "",
          headCommitSha: "2".repeat(40),
          lastEditedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.documents[0]!.index).toEqual({
        keyword: "pending",
        semantic: "unavailable",
        graph: "unavailable",
        summary: null,
      });
    });
  });

  describe("display name", () => {
    it("rename keeps the slug when only the display name changes and moves when it does not", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dn1");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Plans",
      });
      const repo = (await openProjectRepo(project.id))!;
      const before = await repo.resolveHead();

      const same = await caller.folder.rename({
        projectId: project.id,
        path: ["plans"],
        name: "PLANS",
      });
      expect(same.path).toEqual(["plans"]);
      expect(await repo.resolveHead()).not.toBe(before);
      expect(
        (await caller.folder.tree({ projectId: project.id })).folderNames,
      ).toEqual({ plans: "PLANS" });

      const moved = await caller.folder.rename({
        projectId: project.id,
        path: ["plans"],
        name: "Implementation Plans",
      });
      expect(moved.path).toEqual(["implementation-plans"]);
      const tree = await caller.folder.tree({ projectId: project.id });
      expect(tree.folders).toEqual(["implementation-plans"]);
      expect(tree.folderNames).toEqual({
        "implementation-plans": "Implementation Plans",
      });
      expect(await repo.listTrackedFiles()).not.toContain("plans/.folder.json");
    });

    it("treats a rename to the identical name as a no-op without a commit", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dn3");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Plans",
      });
      const repo = (await openProjectRepo(project.id))!;
      const before = await repo.resolveHead();

      await expect(
        caller.folder.rename({
          projectId: project.id,
          path: ["plans"],
          name: "Plans",
        }),
      ).resolves.toEqual({ path: ["plans"] });
      expect(await repo.resolveHead()).toBe(before);
      expect(
        (await caller.folder.tree({ projectId: project.id })).folderNames,
      ).toEqual({ plans: "Plans" });
    });

    it("deletes a folder whose only files are its markers", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dn2");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Empty Folder",
      });
      await caller.folder.delete({
        projectId: project.id,
        path: ["empty-folder"],
      });
      expect(
        (await caller.folder.tree({ projectId: project.id })).folders,
      ).toEqual([]);
    });
  });

  describe("move", () => {
    it("renames via git mv and rewrites descendant document index rows", async () => {
      const { project, caller } = await setupProjectWith("Editor", "r1");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "old",
      });
      const doc = await caller.document.create({
        projectId: project.id,
        folderPath: ["old"],
        title: "Inside",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: ["old"],
        name: "nested",
      });
      const nested = await caller.document.create({
        projectId: project.id,
        folderPath: ["old", "nested"],
        title: "Nested",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      });
      knowledgeQueue.jobs.length = 0;

      await caller.folder.rename({
        projectId: project.id,
        path: ["old"],
        name: "new",
      });
      const repo = (await openProjectRepo(project.id))!;
      const moveSha = await repo.resolveHead();

      expect(knowledgeQueue.jobs).toEqual(
        [
          { id: doc.id, path: "new/inside.md" },
          { id: nested.id, path: "new/nested/nested.md" },
        ]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(({ id, path }) => ({
            name: "document.search-sync" as const,
            data: {
              projectId: project.id,
              documentId: id,
              sourceCommitSha: moveSha,
              pathAtSha: path,
            },
          })),
      );
      const moved = await caller.document.get({
        projectId: project.id,
        documentId: doc.id,
      });
      expect(moved.path).toBe("new/inside.md");
      // baseCommitSha reflects the move commit — a content-unchanged save auto-resolves later.
      expect(moved.baseCommitSha).not.toBe(doc.headCommitSha);
    });

    it("uses the move commit time for descendant projection updates", async () => {
      const { project, caller } = await setupProjectWith("Editor", "time1");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "old",
      });
      const contentSha = await withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic("old/inside.md", "# Inside\n");
        return repo.commitAll("create: old/inside.md", {
          name: "Editor",
          email: "editor@test.local",
          userId: "11111111-1111-4111-8111-111111111111",
        });
      });
      const document = await getPrisma().document.create({
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          projectId: project.id,
          path: "old/inside.md",
          slug: "inside",
          title: "Inside",
          excerpt: "",
          headCommitSha: contentSha,
          lastEditedById: null,
          lastEditedAt: new Date(0),
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      });

      await caller.folder.rename({
        projectId: project.id,
        path: ["old"],
        name: "new",
      });

      const repo = (await openProjectRepo(project.id))!;
      const moveSha = (await repo.lastCommitForPath("new/inside.md"))!;
      const moved = await getPrisma().document.findUniqueOrThrow({
        where: { id: document.id },
      });
      expect(moved.lastEditedAt).toEqual(await repo.commitDate(moveSha));
    });

    it("treats moving a folder to its current parent as a no-op", async () => {
      const { project, caller } = await setupProjectWith("Editor", "r1");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "a",
      });
      await expect(
        caller.folder.move({
          projectId: project.id,
          path: ["a"],
          newParentPath: [],
        }),
      ).resolves.toEqual({ path: ["a"] });
    });

    it("rejects moving a folder into its own subtree", async () => {
      const { project, caller } = await setupProjectWith("Editor", "r2");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "a",
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: ["a"],
        name: "b",
      });
      await expect(
        caller.folder.move({
          projectId: project.id,
          path: ["a"],
          newParentPath: ["a", "b"],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects an existing destination instead of letting git silently nest the folder", async () => {
      const { project, caller } = await setupProjectWith(
        "Editor",
        "move-collision",
      );
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "source",
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "target",
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: ["target"],
        name: "source",
      });
      await caller.document.create({
        projectId: project.id,
        folderPath: ["source"],
        title: "Inside",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      });
      const repo = (await openProjectRepo(project.id))!;
      const before = {
        head: await repo.resolveHead(),
        files: await repo.listTrackedFiles(),
        rows: await getPrisma().document.findMany({
          where: { projectId: project.id },
          orderBy: { id: "asc" },
        }),
      };

      await expect(
        caller.folder.move({
          projectId: project.id,
          path: ["source"],
          newParentPath: ["target"],
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect({
        head: await repo.resolveHead(),
        files: await repo.listTrackedFiles(),
        rows: await getPrisma().document.findMany({
          where: { projectId: project.id },
          orderBy: { id: "asc" },
        }),
      }).toEqual(before);
    });

    it("rejects a move when its deepest descendant would exceed depth ten", async () => {
      const { project, caller } = await setupProjectWith(
        "Editor",
        "move-depth",
      );
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "source",
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: ["source"],
        name: "child",
      });
      await caller.document.create({
        projectId: project.id,
        folderPath: ["source", "child"],
        title: "Inside",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      });
      let destination: string[] = [];
      for (let i = 0; i < 9; i++) {
        const created = await caller.folder.create({
          projectId: project.id,
          parentPath: destination,
          name: `d${i}`,
        });
        destination = created.path;
      }
      const repo = (await openProjectRepo(project.id))!;
      const before = {
        head: await repo.resolveHead(),
        files: await repo.listTrackedFiles(),
        rows: await getPrisma().document.findMany({
          where: { projectId: project.id },
          orderBy: { id: "asc" },
        }),
      };

      await expect(
        caller.folder.move({
          projectId: project.id,
          path: ["source"],
          newParentPath: destination,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect({
        head: await repo.resolveHead(),
        files: await repo.listTrackedFiles(),
        rows: await getPrisma().document.findMany({
          where: { projectId: project.id },
          orderBy: { id: "asc" },
        }),
      }).toEqual(before);
    });
  });

  describe("delete", () => {
    it("deletes empty folders, refuses folders with documents", async () => {
      const { project, caller } = await setupProjectWith("Editor", "d1");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "empty",
      });
      await caller.folder.delete({
        projectId: project.id,
        path: ["empty"],
      });
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.listTrackedFiles()).not.toContain("empty/.gitkeep");

      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "full",
      });
      await caller.document.create({
        projectId: project.id,
        folderPath: ["full"],
        title: "Doc",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      });
      await expect(
        caller.folder.delete({ projectId: project.id, path: ["full"] }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("refuses a folder with an empty descendant folder", async () => {
      const { project, caller } = await setupProjectWith("Editor", "d0");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "parent",
      });
      await caller.folder.create({
        projectId: project.id,
        parentPath: ["parent"],
        name: "child",
      });

      await expect(
        caller.folder.delete({ projectId: project.id, path: ["parent"] }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.listTrackedFiles()).toContain("parent/child/.gitkeep");
    });

    it("deletes an empty folder", async () => {
      const { project, caller } = await setupProjectWith("Editor", "d1");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "empty",
      });
      await caller.folder.delete({ projectId: project.id, path: ["empty"] });
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.listTrackedFiles()).not.toContain("empty/.gitkeep");
    });
  });
});

it("keeps a committed document-folder move successful after projection failure", async () => {
  await resetDb();
  const { project, caller } = await setupProjectWith(
    "Editor",
    "review-folder-failure",
  );
  await caller.folder.create({
    projectId: project.id,
    parentPath: [],
    name: "Before",
  });
  await caller.document.create({
    projectId: project.id,
    folderPath: ["before"],
    title: "Inside",
    contentJson: { type: "doc", content: [] },
  });
  const transaction = vi
    .spyOn(getPrisma(), "$transaction")
    .mockRejectedValueOnce(new Error("projection unavailable"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      caller.folder.rename({
        projectId: project.id,
        path: ["before"],
        name: "After",
      }),
    ).resolves.toEqual({ path: ["after"] });
  } finally {
    transaction.mockRestore();
    logged.mockRestore();
  }
  const repo = (await openProjectRepo(project.id))!;
  expect(await repo.listTrackedFiles()).toContain("after/inside.md");
  expect(knowledgeQueue.jobs).toContainEqual(
    expect.objectContaining({
      name: "project.reconcile",
      data: { projectId: project.id },
    }),
  );
});

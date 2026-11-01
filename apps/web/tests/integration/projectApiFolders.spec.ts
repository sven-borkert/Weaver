import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  parseFolderMetadata,
  composeFolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import {
  loadFolderIdentityIndex,
  ensureFolderIdentityInRepo,
} from "@weaver/core/projectApi/folderIdentity";
import {
  createFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
} from "@weaver/core/services/folders";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { importArchiveFolders } from "@weaver/core/services/documentImport";
import { upgradeFolderMetadata } from "@weaver/core/services/folderMetadataUpgrade";
import {
  getContentAppearance,
  setContentAppearance,
} from "@weaver/core/services/contentAppearance";
import {
  getFolderReviewDefaults,
  setFolderReviewRecursively,
} from "@weaver/core/services/folderReview";
import { makeMachineFixture } from "./_projectApiHarness";
import { resetDb } from "./_harness";

describe("project API folder identity", () => {
  beforeEach(resetDb);

  it("follows folder and ancestor renames and moves in both scopes", async () => {
    const f = await makeMachineFixture();
    for (const scope of ["documents", "tables"] as const) {
      const initial = await withProjectRepo(f.project.id, async (repo) =>
        loadFolderIdentityIndex(
          repo,
          f.project.id,
          scope,
          await repo.resolveHead(),
        ),
      );
      const entry = initial.entries.find((e) => e.path.join("/") === "audit")!;
      expect(entry.id).toMatch(/^[a-f0-9-]{36}$/);
      await renameFolder(
        f.db,
        { projectId: f.project.id, path: ["audit"], name: "Daily audit" },
        f.actor,
        scope,
      );
      await createFolder(
        f.db,
        { projectId: f.project.id, parentPath: [], name: "Reports" },
        f.actor,
        scope,
      );
      await moveFolder(
        f.db,
        {
          projectId: f.project.id,
          path: ["daily-audit"],
          newParentPath: ["reports"],
        },
        f.actor,
        scope,
      );
      await renameFolder(
        f.db,
        { projectId: f.project.id, path: ["reports"], name: "History" },
        f.actor,
        scope,
      );
      const moved = await withProjectRepo(f.project.id, async (repo) =>
        loadFolderIdentityIndex(
          repo,
          f.project.id,
          scope,
          await repo.resolveHead(),
        ),
      );
      expect(moved.byId.get(entry.id)?.path).toEqual([
        "history",
        "daily-audit",
      ]);
    }
  });

  it("assigns legacy identity once while preserving metadata and commit history", async () => {
    const f = await makeMachineFixture();
    await withProjectRepo(f.project.id, async (repo) => {
      const original = parseFolderMetadata(
        await repo.readFileFromWorktree("audit/.folder.json"),
      )!;
      const { id: _id, ...legacy } = original;
      await repo.writeFileAtomic(
        "audit/.folder.json",
        composeFolderMetadata({
          ...legacy,
          appearance: { backgroundColor: "#112233" },
        }),
      );
      await repo.commitAll("test: legacy metadata", {
        name: f.actor.name,
        email: f.actor.email,
        userId: f.actor.userId,
      });
      const assigned = await ensureFolderIdentityInRepo(
        repo,
        "documents",
        ["audit"],
        f.actor,
      );
      const after = parseFolderMetadata(
        await repo.readFileFromWorktree("audit/.folder.json"),
      )!;
      expect(after).toMatchObject({
        ...legacy,
        appearance: { backgroundColor: "#112233" },
        id: assigned.id,
      });
      const repeated = await ensureFolderIdentityInRepo(
        repo,
        "documents",
        ["audit"],
        f.actor,
      );
      expect(repeated.id).toBe(assigned.id);
      expect(repeated.commitSha).toBe(assigned.commitSha);
    });
  });

  it("does not reuse an identity when an empty folder is recreated at its path", async () => {
    const f = await makeMachineFixture();
    await createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Empty" },
      f.actor,
    );
    const before = await withProjectRepo(
      f.project.id,
      async (repo) =>
        parseFolderMetadata(
          await repo.readFileFromWorktree("empty/.folder.json"),
        )!.id,
    );
    await deleteFolder(
      f.db,
      { projectId: f.project.id, path: ["empty"] },
      f.actor,
    );
    await createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Empty" },
      f.actor,
    );
    const after = await withProjectRepo(
      f.project.id,
      async (repo) =>
        parseFolderMetadata(
          await repo.readFileFromWorktree("empty/.folder.json"),
        )!.id,
    );
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it("refuses duplicate identity maps and excludes roots and private folders", async () => {
    const f = await makeMachineFixture();
    const id = randomUUID();
    await createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Second" },
      f.actor,
    );
    await withProjectRepo(f.project.id, async (repo) => {
      for (const path of ["audit", "second"]) {
        const meta = parseFolderMetadata(
          await repo.readFileFromWorktree(`${path}/.folder.json`),
        )!;
        await repo.writeFileAtomic(
          `${path}/.folder.json`,
          composeFolderMetadata({ ...meta, id }),
        );
      }
      await repo.writeFileAtomic(
        ".folder.json",
        JSON.stringify({ id, name: "Root" }),
      );
      await repo.writeFileAtomic(
        ".weaver-icons/.folder.json",
        JSON.stringify({ id: randomUUID(), name: "Icons" }),
      );
      await repo.commitAll("test: ambiguous folders", {
        name: f.actor.name,
        email: f.actor.email,
        userId: f.actor.userId,
      });
      const index = await loadFolderIdentityIndex(
        repo,
        f.project.id,
        "documents",
        await repo.resolveHead(),
      );
      expect(index.byId.has(id)).toBe(false);
      expect(index.invalidIds.has(id)).toBe(true);
      expect(
        index.entries.some(
          (e) =>
            e.path.length === 0 ||
            e.path[0] === "tables" ||
            e.path[0] === ".weaver-icons",
        ),
      ).toBe(false);
    });
  });

  it("retains identity through appearance, review defaults, and stamp upgrades", async () => {
    const f = await makeMachineFixture();
    const initial = await withProjectRepo(
      f.project.id,
      async (repo) =>
        parseFolderMetadata(
          await repo.readFileFromWorktree("audit/.folder.json"),
        )!.id,
    );
    const target = {
      kind: "folder" as const,
      projectId: f.project.id,
      scope: "documents" as const,
      path: ["audit"],
    };
    const appearance = await getContentAppearance(f.db, target, f.actor);
    await setContentAppearance(
      f.db,
      {
        target,
        expectedRevision: appearance.revision,
        patch: { backgroundColor: "#112233" },
      },
      f.actor,
    );
    const defaults = await getFolderReviewDefaults(
      f.db,
      { projectId: f.project.id, path: ["audit"] },
      f.actor,
    );
    await setFolderReviewRecursively(
      f.db,
      {
        projectId: f.project.id,
        path: ["audit"],
        reviewers: [],
        expectedHeadCommitSha: defaults.baseProjectCommitSha,
      },
      f.actor,
    );
    await withProjectRepo(f.project.id, async (repo) => {
      const meta = parseFolderMetadata(
        await repo.readFileFromWorktree("audit/.folder.json"),
      )!;
      await repo.writeFileAtomic(
        "audit/.folder.json",
        composeFolderMetadata({ ...meta, created: null, createdBy: null }),
      );
      await repo.commitAll("test: missing legacy stamps", {
        name: f.actor.name,
        email: f.actor.email,
        userId: f.actor.userId,
      });
    });
    await f.db.project.update({
      where: { id: f.project.id },
      data: { folderMetadataVersion: 0 },
    });
    await upgradeFolderMetadata(f.db);
    const final = await withProjectRepo(f.project.id, async (repo) =>
      parseFolderMetadata(
        await repo.readFileFromWorktree("audit/.folder.json"),
      )!,
    );
    expect(final.id).toBe(initial);
    expect(final.appearance).toEqual({ backgroundColor: "#112233" });
    expect(final.created).toBeTruthy();
  });

  it("allocates destination identities for imported folders and preserves existing ones", async () => {
    const f = await makeMachineFixture();
    const foreignId = randomUUID();
    const initial = await withProjectRepo(
      f.project.id,
      async (repo) =>
        parseFolderMetadata(
          await repo.readFileFromWorktree("audit/.folder.json"),
        )!.id,
    );
    const meta = {
      id: foreignId,
      name: "Imported",
      created: null,
      createdBy: null,
      updated: null,
      updatedBy: null,
    };
    await importArchiveFolders(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        folderNames: { imported: "Imported" },
        folderMetadata: { imported: meta },
      },
      f.actor,
    );
    const imported = await withProjectRepo(
      f.project.id,
      async (repo) =>
        parseFolderMetadata(
          await repo.readFileFromWorktree("imported/.folder.json"),
        )!.id,
    );
    expect(imported).toBeTruthy();
    expect(imported).not.toBe(foreignId);
    await importArchiveFolders(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        folderNames: { audit: "Other" },
        folderMetadata: {
          audit: { ...meta, name: "Other" },
          additional: { ...meta, name: "Additional" },
        },
      },
      f.actor,
    );
    const after = await withProjectRepo(
      f.project.id,
      async (repo) =>
        parseFolderMetadata(
          await repo.readFileFromWorktree("audit/.folder.json"),
        )!.id,
    );
    expect(after).toBe(initial);
  });
});

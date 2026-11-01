import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { parseDocumentFile } from "@weaver/core/documents/frontmatter";
import {
  writeDocumentInRepo,
  getHistory,
  resolveAttribution,
  rebuildIndex,
} from "@weaver/core/services/documents";
import {
  writeTableInRepo,
  getTableHistory,
  rebuildTableIndex,
} from "@weaver/core/services/tables";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import {
  makeMachineFixture,
  seedProjectMachineKey,
} from "./_projectApiHarness";
import { resetDb } from "./_harness";
import { renameFolder } from "@weaver/core/services/folders";
import { getRecentContent } from "@weaver/core/services/dashboard/content";
import { listDashboardActivity } from "@weaver/core/services/dashboard/activity";

describe("project API content attribution", () => {
  beforeEach(resetDb);

  it("writes a machine document without a user identity and retains its authorship after rebuild", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, [], { name: "Nightly audit" });
    const actor = {
      kind: "projectApiKey" as const,
      projectId: f.project.id,
      keyId: key.keyId,
      name: "Nightly audit",
      email: f.owner.email,
    };
    const operationId = `project-api:${randomUUID()}`;
    const saved = await withProjectRepo(f.project.id, (repo) =>
      writeDocumentInRepo(
        f.db,
        repo,
        f.project.id,
        {
          kind: "update",
          documentId: f.document.id,
          baseCommitSha: f.document.headCommitSha,
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("Published audit\n"),
          },
          changeSummary: "Machine audit",
        },
        actor,
        {
          operation: "update",
          operationId,
          apiRequestHash: "a".repeat(64),
          apiOperation: "document.replace",
        },
      ),
    );
    const row = await f.db.document.findUniqueOrThrow({
      where: { id: f.document.id },
    });
    expect(row).toMatchObject({
      lastEditedById: null,
      lastEditedByProjectKeyId: key.keyId,
      lastEditedByName: "Nightly audit",
    });
    await withProjectRepo(f.project.id, async (repo) => {
      const file = parseDocumentFile(
        await repo.readFileFromWorktree(saved.path),
        "markdown",
      );
      expect(file.meta.updatedBy).toEqual({ id: null, name: "Nightly audit" });
      const [entry] = await repo.logForPath(saved.path, { skip: 0, limit: 1 });
      expect(entry).toMatchObject({
        userId: null,
        projectKeyId: key.keyId,
        apiRequestHash: "a".repeat(64),
        apiOperation: "document.replace",
        operationId,
      });
      expect((await repo.logSince(null, { limit: 1 }))[0]).toMatchObject({
        userId: null,
        projectKeyId: key.keyId,
      });
    });
    await f.db.projectApiKey.update({
      where: { id: key.keyId },
      data: { name: "Renamed key", revokedAt: new Date() },
    });
    await rebuildIndex(f.db, { projectId: f.project.id }, f.actor);
    const rebuilt = await f.db.document.findUniqueOrThrow({
      where: { id: f.document.id },
    });
    expect(rebuilt).toMatchObject({
      lastEditedById: null,
      lastEditedByProjectKeyId: key.keyId,
      lastEditedByName: "Nightly audit",
    });
    const history = await getHistory(
      f.db,
      {
        projectId: f.project.id,
        documentId: f.document.id,
        offset: 0,
        limit: 10,
      },
      f.actor,
    );
    expect(history.entries[0]).toMatchObject({
      userId: null,
      projectKeyId: key.keyId,
      userName: "Nightly audit",
    });
    const recent = await getRecentContent(f.db, f.actor, {
      projectId: f.project.id,
    });
    expect(
      recent.items.find((item) => item.id === f.document.id),
    ).toMatchObject({ editorName: "Nightly audit", isOwnChange: false });
    const activity = await listDashboardActivity(f.db, f.actor, {
      projectId: f.project.id,
      audience: "projects",
      view: "others",
    });
    expect(
      activity.items.some((item) => item.editorName === "Nightly audit"),
    ).toBe(true);
    await renameFolder(
      f.db,
      { projectId: f.project.id, path: ["audit"], name: "Reports" },
      f.actor,
    );
    expect(
      await f.db.document.findUniqueOrThrow({ where: { id: f.document.id } }),
    ).toMatchObject({
      lastEditedById: f.owner.id,
      lastEditedByProjectKeyId: null,
      path: "reports/latest-audit.md",
    });
  });

  it("writes and rebuilds a machine table without a user foreign key", async () => {
    const f = await makeMachineFixture();
    const key = await seedProjectMachineKey(f, [], { name: "Nightly audit" });
    const actor = {
      kind: "projectApiKey" as const,
      projectId: f.project.id,
      keyId: key.keyId,
      name: "Nightly audit",
      email: f.owner.email,
    };
    await withProjectRepo(f.project.id, (repo) =>
      writeTableInRepo(
        f.db,
        repo,
        f.project.id,
        {
          kind: "update",
          tableId: f.table.id,
          baseCommitSha: f.table.headCommitSha,
          columns: f.table.columns,
          rows: [...f.table.rows, { id: randomUUID(), cells: {} }],
        },
        actor,
        {
          operation: "update",
          apiRequestHash: "b".repeat(64),
          apiOperation: "table.rows.append",
        },
      ),
    );
    expect(
      await f.db.dataTable.findUniqueOrThrow({ where: { id: f.table.id } }),
    ).toMatchObject({
      lastEditedById: null,
      lastEditedByProjectKeyId: key.keyId,
      lastEditedByName: "Nightly audit",
    });
    await rebuildTableIndex(f.db, { projectId: f.project.id }, f.actor);
    expect(
      await f.db.dataTable.findUniqueOrThrow({ where: { id: f.table.id } }),
    ).toMatchObject({
      lastEditedById: null,
      lastEditedByProjectKeyId: key.keyId,
      lastEditedByName: "Nightly audit",
    });
    const history = await getTableHistory(
      f.db,
      { projectId: f.project.id, tableId: f.table.id, offset: 0, limit: 10 },
      f.actor,
    );
    expect(history.entries[0]).toMatchObject({
      userId: null,
      projectKeyId: key.keyId,
      userName: "Nightly audit",
    });
    await renameFolder(
      f.db,
      { projectId: f.project.id, path: ["audit"], name: "Reports" },
      f.actor,
      "tables",
    );
    expect(
      await f.db.dataTable.findUniqueOrThrow({ where: { id: f.table.id } }),
    ).toMatchObject({
      lastEditedById: f.owner.id,
      lastEditedByProjectKeyId: null,
      path: "tables/reports/audit-results.table",
    });
  });

  it("does not attribute machine trailers to users by a matching email", async () => {
    const f = await makeMachineFixture();
    const keyId = randomUUID();
    const entries = [
      {
        authorEmail: f.owner.email,
        authorName: "Machine",
        userId: null,
        projectKeyId: keyId,
        trustedAuthor: true,
      },
      {
        authorEmail: f.owner.email,
        authorName: "Forged",
        userId: f.owner.id,
        projectKeyId: keyId,
        trustedAuthor: false,
      },
    ];
    expect(await resolveAttribution(f.db, entries)).toEqual([
      {
        kind: "projectApiKey",
        id: null,
        keyId,
        name: "Machine",
        email: f.owner.email,
      },
      null,
    ]);
  });

  it("does not accept a machine author claim embedded in a user commit message", async () => {
    const f = await makeMachineFixture();
    await withProjectRepo(f.project.id, async (repo) => {
      await repo.writeFileAtomic("notice.txt", "Notice");
      await repo.commitAll(`Notice\n\nWeaver-Project-Key-Id: ${randomUUID()}`, {
        name: f.actor.name,
        email: f.actor.email,
        userId: f.owner.id,
      });
      const [entry] = await repo.logForPath("notice.txt", {
        skip: 0,
        limit: 1,
      });
      expect(entry?.projectKeyId ?? null).toBeNull();
      expect(entry?.userId).toBe(f.owner.id);
    });
  });

  it("reads committed documents and tables without projections or nested locks", async () => {
    const { readMachineDocumentSnapshot, readMachineTableSnapshot } =
      await import("@weaver/core/projectApi/snapshots");
    const f = await makeMachineFixture();
    await f.db.document.delete({ where: { id: f.document.id } });
    await f.db.dataTable.delete({ where: { id: f.table.id } });
    await withProjectRepo(f.project.id, async (repo) => {
      expect(
        await readMachineDocumentSnapshot(
          f.db,
          repo,
          f.project.id,
          f.document.id,
        ),
      ).toMatchObject({
        id: f.document.id,
        path: f.document.path,
        revision: f.document.headCommitSha,
        markdown: expect.stringContaining("Original audit result"),
      });
      expect(
        await readMachineTableSnapshot(f.db, repo, f.project.id, f.table.id),
      ).toMatchObject({
        id: f.table.id,
        path: f.table.path,
        revision: f.table.headCommitSha,
      });
      await expect(
        readMachineDocumentSnapshot(f.db, repo, f.project.id, randomUUID()),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const original = await repo.readFileFromWorktree(f.document.path);
      await repo.writeFileAtomic("audit/duplicate.md", original);
      await repo.commitAll("test: duplicate canonical ID", {
        name: f.actor.name,
        email: f.actor.email,
        userId: f.owner.id,
      });
      await expect(
        readMachineDocumentSnapshot(f.db, repo, f.project.id, f.document.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});

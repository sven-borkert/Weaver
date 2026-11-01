import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { queryProjectMachineContent } from "@weaver/core/projectApi/queries";
import {
  makeMachineFixture,
  seedProjectMachineKey,
} from "./_projectApiHarness";
import { resetDb } from "./_harness";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { loadFolderIdentityIndex } from "@weaver/core/projectApi/folderIdentity";
import { createDocument } from "@weaver/core/services/documents";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
describe("project machine read policy", () => {
  beforeEach(resetDb);
  it("keeps noncanonical private Markdown files outside document-root grants", async () => {
    const f = await makeMachineFixture();
    const privateId = randomUUID();
    await withProjectRepo(f.project.id, async (repo) => {
      const file = await repo.readFileFromWorktree(f.document.path);
      await repo.writeFileAtomic(
        ".private.md",
        file.replace(f.document.id, privateId),
      );
      await repo.commitAll("Private metadata", {
        name: f.actor.name,
        email: f.actor.email,
        userId: f.actor.userId,
      });
    });
    const k = await seedProjectMachineKey(f, [
      { kind: "documentFolder", targetId: null, root: true, actions: ["read"] },
    ]);
    await expect(
      queryProjectMachineContent(f.db, k.context, {
        kind: "document.get",
        id: privateId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("includes future descendants, excludes siblings and binds cursors to key, policy and HEAD", async () => {
    const f = await makeMachineFixture();
    const folderId = await withProjectRepo(
      f.project.id,
      async (repo) =>
        (
          await loadFolderIdentityIndex(
            repo,
            f.project.id,
            "documents",
            await repo.resolveHead(),
          )
        ).entries.find((e) => e.path.join("/") === f.documentFolder.join("/"))!
          .id,
    );
    const grants = [
      {
        kind: "documentFolder" as const,
        targetId: folderId,
        root: false,
        actions: ["read" as const],
      },
    ];
    const k = await seedProjectMachineKey(f, grants);
    await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Tomorrow",
        folderPath: f.documentFolder,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Future audit"),
        },
      },
      f.actor,
    );
    const page = await queryProjectMachineContent(f.db, k.context, {
      kind: "documents",
      limit: 1,
    });
    expect(page.nextCursor).toBeTypeOf("string");
    const cursor = page.nextCursor!;
    const second = await queryProjectMachineContent(f.db, k.context, {
      kind: "documents",
      limit: 1,
      cursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items?.[0]?.id).not.toBe(page.items?.[0]?.id);
    const other = await seedProjectMachineKey(f, grants);
    await expect(
      queryProjectMachineContent(f.db, other.context, {
        kind: "documents",
        limit: 1,
        cursor,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await f.db.projectApiKey.update({
      where: { id: k.keyId },
      data: { policyVersion: { increment: 1 } },
    });
    await expect(
      queryProjectMachineContent(f.db, k.context, {
        kind: "documents",
        limit: 1,
        cursor,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("allows write-only HEAD and hides bodies and unrelated resources", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["update"],
      },
    ]);
    const head = await queryProjectMachineContent(f.db, k.context, {
      kind: "document.head",
      id: f.document.id,
    });
    expect(head).toEqual({ revision: f.document.headCommitSha });
    await expect(
      queryProjectMachineContent(f.db, k.context, {
        kind: "document.get",
        id: f.document.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      queryProjectMachineContent(f.db, k.context, {
        kind: "table.head",
        id: f.table.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await queryProjectMachineContent(f.db, k.context, {
        kind: "documents",
        limit: 50,
      }),
    ).toMatchObject({ items: [] });
  });
  it("filters pages before counting and rejects foreign or tampered cursors", async () => {
    const f = await makeMachineFixture();
    const grants = [
      {
        kind: "documentFolder" as const,
        targetId: null,
        root: true,
        actions: ["read" as const],
      },
    ];
    const k = await seedProjectMachineKey(f, grants);
    const page = await queryProjectMachineContent(f.db, k.context, {
      kind: "documents",
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items?.[0]).toMatchObject({ id: f.document.id });
    await expect(
      queryProjectMachineContent(f.db, k.context, {
        kind: "documents",
        limit: 1,
        cursor: "invalid",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await f.db.projectApiKey.update({
      where: { id: k.keyId },
      data: { revokedAt: new Date() },
    });
    await expect(
      queryProjectMachineContent(f.db, k.context, {
        kind: "documents",
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

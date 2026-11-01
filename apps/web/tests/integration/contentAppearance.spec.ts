import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";
import { classifyDeletedPath } from "@weaver/core/documents/recovery";
import type { NextRequest } from "next/server";
import { getSessionUser } from "~/server/auth";
import { getTree as getTableTree } from "@weaver/core/services/tableFolders";
import { readAppearanceAsset } from "@weaver/core/services/appearanceAssets";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  createDocument,
  deleteDocument,
  getDocument,
  rebuildIndex,
  restoreDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import {
  createTable,
  deleteTable,
  restoreTable,
  getTable,
  rebuildTableIndex,
  saveTable,
} from "@weaver/core/services/tables";
import {
  createFolder,
  getTree,
  renameFolder,
} from "@weaver/core/services/folders";
import { setDocumentReview } from "@weaver/core/services/documentReview";
import { readProjectImage } from "@weaver/core/services/documentImages";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import {
  parseSchemaFile,
  serializeSchemaFile,
} from "@weaver/core/tables/jsonl";
import type { AppearanceTarget } from "@weaver/core/appearance/metadata";
import * as repoServices from "@weaver/core/services/projectRepo";
import { simpleGit } from "simple-git";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0RkAAAAASUVORK5CYII=",
  "base64",
);
const imageIcon = {
  type: "image" as const,
  digest: createHash("sha256").update(png).digest("hex"),
  extension: "png" as const,
};
const style = {
  backgroundColor: "#abcdef",
  icon: { type: "emoji" as const, value: "🌲" },
};
const body = (text: string) => parseDocumentBody(`${text}\n`);

async function fixture(role: "Editor" | "Maintainer" = "Editor") {
  const db = getPrisma();
  const editor = await makeUser("User", "appearance-editor");
  const viewer = await makeUser("User", "appearance-viewer");
  const outsider = await makeUser("Admin", "appearance-outsider");
  const project = await makeProject("Appearance");
  await addMembership(project.id, editor.id, role);
  await addMembership(project.id, viewer.id, "Viewer");
  const actor = {
    ...securityContextFor(editor),
    name: "Editor",
    email: editor.email,
  };
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Doc",
      content: { kind: "markdown", contentJson: body("Original") },
    },
    actor,
  );
  const table = await createTable(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Table",
      columns: [],
      rows: [],
    },
    actor,
  );
  const target: AppearanceTarget = {
    projectId: project.id,
    kind: "document",
    id: doc.id,
  };
  return { db, editor, viewer, outsider, project, actor, doc, table, target };
}

async function plantStyle(f: Awaited<ReturnType<typeof fixture>>) {
  await withProjectRepo(f.project.id, async (repo) => {
    const { meta, body } = parseDocumentFile(
      await repo.readFileFromWorktree(f.doc.path),
      "markdown",
    );
    await repo.writeFileAtomic(
      f.doc.path,
      composeDocumentFile({ ...meta, appearance: style }, body, "markdown"),
    );
    const schema = parseSchemaFile(
      await repo.readFileFromWorktree(`${f.table.path}/schema.json`),
    );
    await repo.writeFileAtomic(
      `${f.table.path}/schema.json`,
      serializeSchemaFile({ ...schema, appearance: style }),
    );
    await repo.commitAll("test: style content", {
      userId: f.editor.id,
      name: "Editor",
      email: f.editor.email,
    });
  });
}

function api(user: Awaited<ReturnType<typeof makeUser>>) {
  return callerFor(user).appearance;
}

async function services() {
  return import("@weaver/core/services/contentAppearance");
}

describe("content appearance", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.mocked(getSessionUser).mockResolvedValue(null);
  });

  it("editor_updates_and_viewer_reads_appearance", async () => {
    const f = await fixture();
    const before = await f.db.document.findUniqueOrThrow({
      where: { id: f.doc.id },
    });
    const editorApi = api(f.editor);
    const current = await editorApi.get({ target: f.target });
    expect(current).toMatchObject({ appearance: null, canEdit: true });
    const result = await editorApi.set({
      target: f.target,
      expectedRevision: current.revision,
      patch: {
        backgroundColor: "#ABCDEF",
        icon: { type: "emoji", value: "🌲" },
      },
    });
    expect(await api(f.viewer).get({ target: f.target })).toEqual({
      appearance: style,
      revision: result.revision,
      canEdit: false,
    });
    await expect(
      api(f.viewer).set({
        target: f.target,
        expectedRevision: result.revision,
        patch: { icon: null },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      api(f.outsider).get({ target: f.target }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const after = await f.db.document.findUniqueOrThrow({
      where: { id: f.doc.id },
    });
    expect(after).toMatchObject({
      appearance: style,
      updatedAt: before.updatedAt,
      createdAt: before.createdAt,
      reviewSince: before.reviewSince,
      reviewDueAt: before.reviewDueAt,
    });
    await editorApi.set({
      target: f.target,
      expectedRevision: result.revision,
      patch: { icon: null },
    });
    expect((await editorApi.get({ target: f.target })).appearance).toEqual({
      backgroundColor: "#abcdef",
    });
  });

  it("rejects_stale_revision_before_asset_write", async () => {
    const f = await fixture();
    const a = api(f.editor);
    const original = await a.get({ target: f.target });
    const updated = await a.set({
      target: f.target,
      expectedRevision: original.revision,
      patch: style,
    });
    const { setContentAppearance } = await services();
    await expect(
      setContentAppearance(
        f.db,
        { target: f.target, expectedRevision: original.revision, patch: {} },
        f.actor,
        { bytes: png },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await withProjectRepo(f.project.id, async (repo) => {
      expect(await repo.resolveHead()).toBe(updated.headCommitSha);
      expect(
        (await repo.listTrackedFiles()).filter((p) =>
          p.startsWith(".weaver-icons/"),
        ),
      ).toEqual([]);
    });
  });

  it.each([false, true])(
    "failed_commit_rolls_back_image_and_metadata (staged=%s)",
    async (staged) => {
      const f = await fixture();
      const current = await api(f.editor).get({ target: f.target });
      const original = await withProjectRepo(f.project.id, async (repo) => ({
        head: await repo.resolveHead(),
        file: await repo.readFileFromWorktree(f.doc.path),
        dir: repo.dir,
      }));
      const withRepo = repoServices.withProjectRepo;
      const spy = vi
        .spyOn(repoServices, "withProjectRepo")
        .mockImplementationOnce((id, fn) =>
          withRepo(id, async (repo) => {
            repo.commitAll = async () => {
              if (staged) await simpleGit(repo.dir).raw(["add", "-f", "-A"]);
              throw new Error("injected commit failure");
            };
            return fn(repo);
          }),
        );
      try {
        const { setContentAppearance } = await services();
        await expect(
          setContentAppearance(
            f.db,
            {
              target: f.target,
              expectedRevision: current.revision,
              patch: style,
            },
            f.actor,
            { bytes: png },
          ),
        ).rejects.toThrow("injected commit failure");
        expect(await readFile(join(original.dir, f.doc.path), "utf8")).toBe(
          original.file,
        );
        await expect(
          readFile(join(original.dir, `.weaver-icons/${imageIcon.digest}.png`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await simpleGit(original.dir).raw(["status", "--porcelain"]),
        ).toBe("");
        expect((await simpleGit(original.dir).revparse(["HEAD"])).trim()).toBe(
          original.head,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("content_merge_preserves_latest_table_appearance", async () => {
    const f = await fixture();
    const old = await getTable(
      f.db,
      { projectId: f.project.id, tableId: f.table.id },
      f.actor,
    );
    await plantStyle(f);
    await saveTable(
      f.db,
      {
        projectId: f.project.id,
        tableId: f.table.id,
        baseCommitSha: old.baseCommitSha,
        title: "Changed",
        columns: [],
        rows: [],
      },
      f.actor,
    );
    const schema = await withProjectRepo(f.project.id, async (repo) =>
      parseSchemaFile(
        await repo.readFileFromWorktree("tables/changed.table/schema.json"),
      ),
    );
    expect(schema.appearance).toEqual(style);
    expect(
      (await f.db.dataTable.findUniqueOrThrow({ where: { id: f.table.id } }))
        .appearance,
    ).toEqual(style);
  });

  it("review_and_restore_keep_current_appearance", async () => {
    const f = await fixture("Maintainer");
    await plantStyle(f);
    let current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: f.doc.id },
      f.actor,
    );
    await setDocumentReview(
      f.db,
      {
        projectId: f.project.id,
        documentId: f.doc.id,
        expectedHeadCommitSha: current.baseCommitSha,
        everyMonths: 6,
      },
      f.actor,
    );
    current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: f.doc.id },
      f.actor,
    );
    const saved = await saveDocument(
      f.db,
      {
        projectId: f.project.id,
        documentId: f.doc.id,
        baseCommitSha: current.baseCommitSha,
        content: { kind: "markdown", contentJson: body("Changed") },
        changeSummary: "",
      },
      f.actor,
    );
    await restoreDocument(
      f.db,
      {
        projectId: f.project.id,
        documentId: f.doc.id,
        sha: f.doc.headCommitSha,
        expectedHeadCommitSha: saved.headCommitSha,
      },
      f.actor,
    );
    const file = await withProjectRepo(f.project.id, async (repo) =>
      parseDocumentFile(
        await repo.readFileFromWorktree(f.doc.path),
        "markdown",
      ),
    );
    expect(file.meta.appearance).toEqual(style);
    expect(file.body).toBe("Original\n");
    expect(file.meta.review?.everyMonths).toBe(6);
    expect(
      (await f.db.document.findUniqueOrThrow({ where: { id: f.doc.id } }))
        .appearance,
    ).toEqual(style);
  });

  it("rebuild_recovers_deleted_appearance_projection", async () => {
    const f = await fixture("Maintainer");
    await plantStyle(f);
    await f.db.document.delete({ where: { id: f.doc.id } });
    await f.db.dataTable.delete({ where: { id: f.table.id } });
    await rebuildIndex(f.db, { projectId: f.project.id }, f.actor);
    await rebuildTableIndex(f.db, { projectId: f.project.id }, f.actor);
    expect(
      (await f.db.document.findUniqueOrThrow({ where: { id: f.doc.id } }))
        .appearance,
    ).toEqual(style);
    expect(
      (await f.db.dataTable.findUniqueOrThrow({ where: { id: f.table.id } }))
        .appearance,
    ).toEqual(style);
  });

  it("icon_root_is_never_a_content_folder", async () => {
    const f = await fixture();
    expect(classifyDeletedPath(".weaver-icons/hidden.md")).toBeNull();
    await withProjectRepo(f.project.id, async (repo) => {
      await repo.writeBinaryFileAtomic(
        `.weaver-icons/${imageIcon.digest}.png`,
        png,
      );
      await repo.commitAll("test: icon", {
        userId: f.editor.id,
        name: "Editor",
        email: f.editor.email,
      });
    });
    expect(
      (await getTree(f.db, { projectId: f.project.id }, f.actor)).folders,
    ).not.toContain(".weaver-icons");
    expect(
      await readProjectImage(
        f.db,
        {
          projectId: f.project.id,
          segments: [".weaver-icons", `${imageIcon.digest}.png`],
        },
        f.actor,
      ),
    ).toBeNull();
    await expect(
      createFolder(
        f.db,
        {
          projectId: f.project.id,
          parentPath: [".weaver-icons"],
          name: "Hidden",
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("commits uploaded image and metadata once, deduplicates assets, and gates cached reads", async () => {
    const f = await fixture();
    const { setContentAppearance } = await services();
    const current = await api(f.editor).get({ target: f.target });
    const before = await withProjectRepo(f.project.id, (repo) =>
      simpleGit(repo.dir).raw(["rev-list", "--count", "HEAD"]),
    );
    const result = await setContentAppearance(
      f.db,
      { target: f.target, expectedRevision: current.revision, patch: style },
      f.actor,
      { bytes: png },
    );
    await withProjectRepo(f.project.id, async (repo) => {
      expect(
        Number(await simpleGit(repo.dir).raw(["rev-list", "--count", "HEAD"])),
      ).toBe(Number(before) + 1);
      expect(
        await simpleGit(repo.dir).raw([
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          result.headCommitSha,
        ]),
      ).toContain(`.weaver-icons/${imageIcon.digest}.png`);
      expect(
        parseDocumentFile(
          await repo.showFileAt(result.headCommitSha, f.doc.path),
          "markdown",
        ).meta.appearance,
      ).toEqual({ ...style, icon: imageIcon });
    });
    const served = await readAppearanceAsset(
      f.db,
      { projectId: f.project.id, icon: imageIcon },
      securityContextFor(f.viewer),
    );
    expect(served && "bytes" in served ? served.bytes : null).toEqual(png);
    const etag = `"${served!.blobSha}"`;
    expect(
      await readAppearanceAsset(
        f.db,
        { projectId: f.project.id, icon: imageIcon, ifNoneMatch: etag },
        securityContextFor(f.viewer),
      ),
    ).toEqual({ notModified: true, blobSha: served!.blobSha });
    await expect(
      readAppearanceAsset(
        f.db,
        { projectId: f.project.id, icon: imageIcon, ifNoneMatch: etag },
        securityContextFor(f.outsider),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const next = await api(f.editor).set({
      target: f.target,
      expectedRevision: result.revision,
      patch: { backgroundColor: null },
    });
    expect((await api(f.editor).get({ target: f.target })).appearance).toEqual({
      icon: imageIcon,
    });
    await api(f.editor).set({
      target: f.target,
      expectedRevision: next.revision,
      patch: { icon: null },
    });
    expect(
      await readAppearanceAsset(
        f.db,
        { projectId: f.project.id, icon: imageIcon, at: result.headCommitSha },
        f.actor,
      ),
    ).not.toBeNull();
  });

  it("guards selected image references at the item revision", async () => {
    const f = await fixture();
    await withProjectRepo(f.project.id, async (repo) => {
      await repo.writeBinaryFileAtomic(
        `.weaver-icons/${imageIcon.digest}.png`,
        png,
      );
      await repo.commitAll("test: unrelated icon", {
        userId: f.editor.id,
        name: "Editor",
        email: f.editor.email,
      });
    });
    await expect(
      api(f.editor).set({
        target: f.target,
        expectedRevision: f.doc.headCommitSha,
        patch: { icon: imageIcon },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each(["document", "table"] as const)(
    "upload repairs a missing asset with a reusable %s revision",
    async (kind) => {
      const f = await fixture();
      const target: AppearanceTarget = {
        projectId: f.project.id,
        kind,
        id: kind === "document" ? f.doc.id : f.table.id,
      };
      await withProjectRepo(f.project.id, async (repo) => {
        if (kind === "document") {
          const file = parseDocumentFile(
            await repo.readFileFromWorktree(f.doc.path),
            "markdown",
          );
          await repo.writeFileAtomic(
            f.doc.path,
            composeDocumentFile(
              { ...file.meta, appearance: { icon: imageIcon } },
              file.body,
              "markdown",
            ),
          );
        } else {
          const path = `${f.table.path}/schema.json`;
          const schema = parseSchemaFile(await repo.readFileFromWorktree(path));
          await repo.writeFileAtomic(
            path,
            serializeSchemaFile({ ...schema, appearance: { icon: imageIcon } }),
          );
        }
        await repo.commitAll("test: missing icon reference", {
          userId: f.editor.id,
          name: "Editor",
          email: f.editor.email,
        });
      });
      const current = await api(f.editor).get({ target });
      const { setContentAppearance } = await services();
      const repaired = await setContentAppearance(
        f.db,
        { target, expectedRevision: current.revision, patch: {} },
        f.actor,
        { bytes: png },
      );
      expect(
        await readAppearanceAsset(
          f.db,
          { projectId: f.project.id, icon: imageIcon },
          f.actor,
        ),
      ).not.toBeNull();
      const afterRepair = await api(f.editor).get({ target });
      expect(repaired.headCommitSha).not.toBe(current.revision);
      expect(repaired.revision).toBe(current.revision);
      expect(repaired.revision).toBe(afterRepair.revision);
      await api(f.editor).set({
        target,
        expectedRevision: repaired.revision,
        patch: { backgroundColor: "#abcdef" },
      });
      expect((await api(f.editor).get({ target })).appearance).toEqual({
        icon: imageIcon,
        backgroundColor: "#abcdef",
      });
    },
  );

  it("folder appearance is captured with the tree and guarded by project HEAD", async () => {
    const f = await fixture();
    const folder = await createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Folder" },
      f.actor,
    );
    const target: AppearanceTarget = {
      projectId: f.project.id,
      kind: "folder",
      scope: "documents",
      path: folder.path,
    };
    const current = await api(f.editor).get({ target });
    const changed = await api(f.editor).set({
      target,
      expectedRevision: current.revision,
      patch: style,
    });
    expect(
      (await getTree(f.db, { projectId: f.project.id }, f.actor))
        .folderAppearances,
    ).toEqual({ folder: style });
    await expect(
      api(f.editor).set({
        target,
        expectedRevision: current.revision,
        patch: { icon: null },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await renameFolder(
      f.db,
      { projectId: f.project.id, path: folder.path, name: "Renamed" },
      f.actor,
    );
    expect(
      (await getTree(f.db, { projectId: f.project.id }, f.actor))
        .folderAppearances,
    ).toEqual({ renamed: style });
    await expect(
      api(f.editor).get({ target: { ...target, path: [] } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const tableTarget: AppearanceTarget = {
      projectId: f.project.id,
      kind: "table",
      id: f.table.id,
    };
    await api(f.editor).set({
      target: tableTarget,
      expectedRevision: f.table.headCommitSha,
      patch: style,
    });
    expect(
      (await getTableTree(f.db, { projectId: f.project.id }, f.actor)).tables[0]
        ?.appearance,
    ).toEqual(style);
    const rootTarget: AppearanceTarget = {
      projectId: f.project.id,
      kind: "folder",
      scope: "tables",
      path: [],
    };
    const root = await api(f.editor).get({ target: rootTarget });
    await api(f.editor).set({
      target: rootTarget,
      expectedRevision: root.revision,
      patch: style,
    });
    expect(
      (await getTableTree(f.db, { projectId: f.project.id }, f.actor))
        .folderAppearances,
    ).toEqual({ "": style });
    expect(
      Object.hasOwn(
        (await getTree(f.db, { projectId: f.project.id }, f.actor))
          .folderAppearances,
        "",
      ),
    ).toBe(false);
    expect(changed.revision).toMatch(/^[a-f0-9]{40}$/);
  });

  it("upload route bounds the request and icon route rechecks membership before 304", async () => {
    const f = await fixture();
    const { POST } =
      await import("~/app/api/projects/[projectId]/appearance/route");
    const { GET } =
      await import("~/app/api/projects/[projectId]/icons/[filename]/route");
    const session = (user: typeof f.editor) => ({
      ...user,
      name: "Reader",
      sessionId: user.id,
      mustChangePassword: false,
    });
    const makeRequest = (form: FormData) =>
      new Request(
        "http://localhost:3000/api/projects/" + f.project.id + "/appearance",
        {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
          body: form,
        },
      ) as NextRequest;
    vi.mocked(getSessionUser).mockResolvedValue(session(f.editor));
    const form = new FormData();
    form.set("target", JSON.stringify(f.target));
    form.set("expectedRevision", f.doc.headCommitSha);
    form.set("patch", JSON.stringify({ backgroundColor: "#ABCDEF" }));
    form.set("file", new File([png], "icon.png", { type: "image/png" }));
    expect(
      (
        await POST(makeRequest(form), {
          params: Promise.resolve({ projectId: f.project.id }),
        })
      ).status,
    ).toBe(201);
    const url = `http://localhost:3000/api/projects/${f.project.id}/icons/${imageIcon.digest}.png`;
    const params = {
      params: Promise.resolve({
        projectId: f.project.id,
        filename: `${imageIcon.digest}.png`,
      }),
    };
    vi.mocked(getSessionUser).mockResolvedValue(session(f.viewer));
    const first = await GET(new Request(url) as NextRequest, params);
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(png);
    const request = () =>
      new Request(url, {
        headers: { "if-none-match": first.headers.get("etag")! },
      }) as NextRequest;
    expect((await GET(request(), params)).status).toBe(304);
    expect(
      (await GET(new Request(url + "?at=") as NextRequest, params)).status,
    ).toBe(404);
    vi.mocked(getSessionUser).mockResolvedValue(session(f.outsider));
    expect((await GET(request(), params)).status).toBe(404);
    const unread = makeRequest(form);
    Object.defineProperty(unread, "body", {
      get: () => {
        throw new Error("body read before authorization");
      },
    });
    expect(
      (
        await POST(unread, {
          params: Promise.resolve({ projectId: f.project.id }),
        })
      ).status,
    ).toBe(404);
    vi.mocked(getSessionUser).mockResolvedValue(session(f.editor));
    const oversized = makeRequest(form);
    oversized.headers.set("content-length", String(3 * 1024 * 1024));
    expect(
      (
        await POST(oversized, {
          params: Promise.resolve({ projectId: f.project.id }),
        })
      ).status,
    ).toBe(413);
  });
  it.each(["document", "table"] as const)(
    "deleted %s recovery retains appearance",
    async (kind) => {
      const f = await fixture();
      await plantStyle(f);
      if (kind === "document")
        await deleteDocument(
          f.db,
          { projectId: f.project.id, documentId: f.doc.id },
          f.actor,
        );
      else
        await deleteTable(
          f.db,
          {
            projectId: f.project.id,
            tableId: f.table.id,
            expectedHeadCommitSha: (
              await getTable(
                f.db,
                { projectId: f.project.id, tableId: f.table.id },
                f.actor,
              )
            ).baseCommitSha,
          },
          f.actor,
        );
      const id = kind === "document" ? f.doc.id : f.table.id;
      const item = (
        await listDeletedContent(
          f.db,
          { projectId: f.project.id, limit: 5 },
          f.actor,
        )
      ).items.find((item) => item.id === id)!;
      const result = await applyMcpOperation(f.db, f.actor, {
        idempotencyKey: `appearance-recover-${kind}`,
        toolName: "restore_content",
        summary: "Recover appearance",
        operation: {
          kind: "content.restore",
          projectId: f.project.id,
          resourceType: kind,
          resourceId: id,
          mode: "deleted",
          sourceSha: item.sourceSha,
          deletedAtSha: item.deletedAtSha,
        },
      });
      expect(
        (
          await api(f.editor).get({
            target: { projectId: f.project.id, kind, id },
          })
        ).appearance,
      ).toEqual(style);
      expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
    },
  );

  it("table content restore keeps current appearance", async () => {
    const f = await fixture();
    await plantStyle(f);
    const current = await getTable(
      f.db,
      { projectId: f.project.id, tableId: f.table.id },
      f.actor,
    );
    await restoreTable(
      f.db,
      {
        projectId: f.project.id,
        tableId: f.table.id,
        sha: f.table.headCommitSha,
        expectedHeadCommitSha: current.baseCommitSha,
      },
      f.actor,
    );
    expect(
      (
        await api(f.editor).get({
          target: { projectId: f.project.id, kind: "table", id: f.table.id },
        })
      ).appearance,
    ).toEqual(style);
  });

  it("rejects invalid and oversized icon bytes without publishing assets", async () => {
    const f = await fixture();
    const { setContentAppearance } = await services();
    for (const bytes of [
      Buffer.from("<svg/>"),
      Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
    ]) {
      await expect(
        setContentAppearance(
          f.db,
          {
            target: f.target,
            expectedRevision: f.doc.headCommitSha,
            patch: {},
          },
          f.actor,
          { bytes },
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { field: "icon" },
      });
    }
    await expect(
      api(f.editor).set({
        target: f.target,
        expectedRevision: f.doc.headCommitSha,
        patch: { backgroundColor: "transparent" },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: { field: "backgroundColor" },
    });
    await withProjectRepo(f.project.id, async (repo) =>
      expect(
        (await repo.listTrackedFiles()).filter((path) =>
          path.startsWith(".weaver-icons/"),
        ),
      ).toEqual([]),
    );
  });
  it.each(["document", "table"] as const)(
    "post-commit %s projection failure retains accepted Git appearance",
    async (kind) => {
      const f = await fixture("Maintainer");
      const target: AppearanceTarget = {
        projectId: f.project.id,
        kind,
        id: kind === "document" ? f.doc.id : f.table.id,
      };
      const current = await api(f.editor).get({ target });
      const transaction = vi
        .spyOn(f.db, "$transaction")
        .mockRejectedValueOnce(new Error("injected projection failure"));
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const result = await api(f.editor).set({
          target,
          expectedRevision: current.revision,
          patch: style,
        });
        expect(await api(f.editor).get({ target })).toMatchObject({
          appearance: style,
          revision: result.revision,
        });
        await withProjectRepo(f.project.id, async (repo) =>
          expect(await repo.resolveHead()).toBe(result.headCommitSha),
        );
      } finally {
        transaction.mockRestore();
        diagnostic.mockRestore();
      }
      if (kind === "document")
        await rebuildIndex(f.db, { projectId: f.project.id }, f.actor);
      else await rebuildTableIndex(f.db, { projectId: f.project.id }, f.actor);
      const row =
        kind === "document"
          ? await f.db.document.findUniqueOrThrow({ where: { id: f.doc.id } })
          : await f.db.dataTable.findUniqueOrThrow({
              where: { id: f.table.id },
            });
      expect(row.appearance).toEqual(style);
    },
  );
});

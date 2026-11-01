import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentAtSnapshot,
  moveDocument,
  rebuildIndex,
  restoreDocument,
  saveDocument,
  writeDocumentInRepo,
} from "@weaver/core/services/documents";
import { parseDocumentFile } from "@weaver/core/documents/frontmatter";
import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import {
  markDocumentReviewed,
  setDocumentReview,
} from "@weaver/core/services/documentReview";
import { createFolder, getTree } from "@weaver/core/services/folders";
import { openProjectRepo, repoDir } from "@weaver/git-store";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  readDocumentFile,
  createDocumentArchive,
} from "@weaver/core/services/documentDownload";
import {
  readProjectImage,
  storeDocumentImage,
} from "@weaver/core/services/documentImages";
import {
  importDocumentFile,
  importDocumentArchiveEntry,
} from "@weaver/core/services/documentImport";
import { loadDocumentIndexSource } from "@weaver/core/services/knowledgeSources";
import { chunkDocumentSource } from "@weaver/core/knowledge/chunkDocument";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { applyOperationInRepo } from "@weaver/core/services/contentOperations";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

const BODY = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const AUTHOR = { name: "Editor", email: "editor@test.local" };

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export async function fixture(suffix: string) {
  const editor = await makeUser("User", `editor-${suffix}`);
  const viewer = await makeUser("User", `viewer-${suffix}`);
  const maintainer = await makeUser("User", `maintainer-${suffix}`);
  const project = await makeProject(`Python ${suffix}`);
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, maintainer.id, "Maintainer");
  await addMembership(project.id, viewer.id, "Viewer");
  const as = (user: typeof editor) => ({
    ...securityContextFor(user),
    ...AUTHOR,
    email: user.email,
  });
  return {
    project,
    actor: as(editor),
    maintainerActor: as(maintainer),
    viewerActor: as(viewer),
    editor,
  };
}

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  setJobQueueForTests(new FakeJobQueue());
  await resetDb();
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

describe("Document.kind", () => {
  it("projects markdown by default and survives rebuild", async () => {
    const db = getPrisma();
    const { project, actor, maintainerActor } = await fixture("kind");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Plain",
        content: { kind: "markdown", contentJson: BODY("Body") },
      },
      actor,
    );
    expect(
      (await db.document.findUniqueOrThrow({ where: { id: doc.id } })).kind,
    ).toBe("markdown");
    await rebuildIndex(db, { projectId: project.id }, maintainerActor);
    const tree = await getTree(db, { projectId: project.id }, actor);
    expect(tree.documents.find((d) => d.id === doc.id)?.documentKind).toBe(
      "markdown",
    );
  });
});

const SCRIPT =
  "#!/usr/bin/env python3\nimport sys\n\n\ndef main():\n    print(sys.argv)\n";

describe("python documents in the write tail", () => {
  it("creates, reads, updates and moves a python document", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor } = await fixture("write");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "deploy_prod",
        content: { kind: "python", text: SCRIPT },
      },
      actor,
    );
    expect(doc.path).toBe("deploy-prod.py");
    const row = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.kind).toBe("python");
    expect(row.excerpt).toBe(
      "#!/usr/bin/env python3 import sys def main(): print(sys.argv)",
    );

    const read = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      viewerActor,
    );
    expect(read.kind).toBe("python");
    expect(read.content).toEqual({ kind: "python", text: SCRIPT });

    const repo = (await openProjectRepo(project.id))!;
    const stored = await repo.showFileAt(read.baseCommitSha, "deploy-prod.py");
    expect(stored.startsWith("#!/usr/bin/env python3\n# weaver\n# id: ")).toBe(
      true,
    );
    expect(stored).toContain('\n# title: "deploy_prod"\n');
    expect(
      stored.endsWith(
        "# /weaver\n\nimport sys\n\n\ndef main():\n    print(sys.argv)\n",
      ),
    ).toBe(true);

    const saved = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: read.baseCommitSha,
        content: { kind: "python", text: "print('v2')\r\n" },
        changeSummary: "",
      },
      actor,
    );
    const again = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(again.content).toEqual({ kind: "python", text: "print('v2')\n" });
    expect(again.baseCommitSha).toBe(saved.headCommitSha);

    const snapshot = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(snapshot.kind).toBe("python");
    expect(snapshot.markdown).toBe("print('v2')\n");

    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Scripts" },
      actor,
    );
    const moved = await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["scripts"] },
      actor,
    );
    expect(moved.path).toBe("scripts/deploy-prod.py");
    expect(
      (
        await getDocument(
          db,
          { projectId: project.id, documentId: doc.id },
          actor,
        )
      ).content,
    ).toEqual({ kind: "python", text: "print('v2')\n" });
  });

  it("rejects content of the wrong kind, binary text and stale heads", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("reject");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "tool",
        content: { kind: "python", text: "pass\n" },
      },
      actor,
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    await expect(
      saveDocument(
        db,
        {
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: read.baseCommitSha,
          content: { kind: "markdown", contentJson: BODY("x") },
          changeSummary: "",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      saveDocument(
        db,
        {
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: read.baseCommitSha,
          content: { kind: "python", text: "a\0b" },
          changeSummary: "",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: read.baseCommitSha,
        content: { kind: "python", text: "x = 1\n" },
        changeSummary: "",
      },
      actor,
    );
    await expect(
      saveDocument(
        db,
        {
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: read.baseCommitSha,
          content: { kind: "python", text: "x = 2\n" },
          changeSummary: "",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps one slug per project across kinds", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("slug");
    await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Setup",
        content: { kind: "markdown", contentJson: BODY("x") },
      },
      actor,
    );
    const py = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "setup",
        content: { kind: "python", text: "pass\n" },
      },
      actor,
    );
    expect(py.path).toBe("setup-2.py");
  });
});

async function unzip(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return JSZip.loadAsync(Buffer.concat(chunks));
}

describe("python downloads and serving", () => {
  it("downloads the file under its title with a python MIME type", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor } = await fixture("download");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "deploy_prod",
        content: { kind: "python", text: "pass\n" },
      },
      actor,
    );
    const file = await readDocumentFile(
      db,
      { projectId: project.id, documentId: doc.id },
      viewerActor,
    );
    expect(file.fileName).toBe("deploy_prod.py");
    expect(file.mimeType).toBe("text/x-python");
    expect(file.bytes.toString("utf8")).toContain("# weaver\n");
    const zip = await unzip(
      (
        await createDocumentArchive(
          db,
          { projectId: project.id, documentId: doc.id },
          viewerActor,
        )
      ).stream,
    );
    expect(Object.keys(zip.files)).toEqual(["deploy-prod.py"]);
  });

  it("never serves a python file as an image", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("image");
    await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "tool",
        content: { kind: "python", text: "pass\n" },
      },
      actor,
    );
    expect(
      await readProjectImage(
        db,
        { projectId: project.id, segments: ["tool.py"] },
        actor,
      ),
    ).toBeNull();
  });
});

describe("importDocumentFile", () => {
  it("imports a .py as a python document and a .md as markdown", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("import");
    const py = await importDocumentFile(
      db,
      {
        projectId: project.id,
        folderPath: [],
        fileName: "deploy_prod.py",
        text: "print(1)\r\n",
      },
      actor,
    );
    expect(py).toMatchObject({ title: "deploy_prod", path: "deploy-prod.py" });
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: py.id },
      actor,
    );
    expect(read.content).toEqual({ kind: "python", text: "print(1)\n" });
    expect(read.review).not.toBeNull();

    const md = await importDocumentFile(
      db,
      {
        projectId: project.id,
        folderPath: [],
        fileName: "Notes.md",
        text: "# Notes\n\nhello\n",
      },
      actor,
    );
    expect(md.path).toBe("notes.md");
  });

  it("strips a re-uploaded header, keeps known reviewers and restarts the clock", async () => {
    const db = getPrisma();
    const { project, actor, maintainerActor, editor } =
      await fixture("reupload");
    const first = await importDocumentFile(
      db,
      {
        projectId: project.id,
        folderPath: [],
        fileName: "a.py",
        text: "pass\n",
      },
      actor,
    );
    const assigned = await setDocumentReview(
      db,
      {
        projectId: project.id,
        documentId: first.id,
        expectedHeadCommitSha: first.headCommitSha,
        reviewers: [{ type: "user", id: editor.id }],
        everyMonths: 9,
      },
      maintainerActor,
    );
    await markDocumentReviewed(
      db,
      {
        projectId: project.id,
        documentId: first.id,
        expectedHeadCommitSha: assigned.headCommitSha,
      },
      actor,
    );
    const file = await readDocumentFile(
      db,
      { projectId: project.id, documentId: first.id },
      actor,
    );
    const second = await importDocumentFile(
      db,
      {
        projectId: project.id,
        folderPath: [],
        fileName: "copy.py",
        text: file.bytes.toString("utf8"),
      },
      actor,
    );
    expect(second.title).toBe("a");
    expect(second.id).not.toBe(first.id);
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: second.id },
      actor,
    );
    expect(read.content).toEqual({ kind: "python", text: "pass\n" });
    expect(read.review?.reviewers.map((reviewer) => reviewer.id)).toEqual([
      editor.id,
    ]);
    expect(read.review?.everyMonths).toBe(9);
    expect(read.review?.lastReviewedAt).toBeNull();
  });

  it("refuses unknown extensions and binary content", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("refuse");
    await expect(
      importDocumentFile(
        db,
        {
          projectId: project.id,
          folderPath: [],
          fileName: "x.exe",
          text: "MZ",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: expect.objectContaining({ reason: "UNSUPPORTED_FILE" }),
    });
    await expect(
      importDocumentFile(
        db,
        {
          projectId: project.id,
          folderPath: [],
          fileName: "x.py",
          text: "a\0b",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: expect.objectContaining({ reason: "UNSUPPORTED_FILE" }),
    });
  });
});

describe("importDocumentArchiveEntry with python", () => {
  it("creates a python document from a ZIP entry and refuses to replace a markdown one", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("zip");
    const created = await importDocumentArchiveEntry(
      db,
      {
        projectId: project.id,
        folderPath: [],
        folderNames: {},
        kind: "python",
        fileName: "run.py",
        text: "print('zip')\n",
        images: [],
        target: { mode: "create" },
      },
      actor,
    );
    expect(created.path).toBe("run.py");
    await expect(
      importDocumentArchiveEntry(
        db,
        {
          projectId: project.id,
          folderPath: [],
          folderNames: {},
          kind: "python",
          fileName: "notes.md",
          text: "pass\n",
          images: [],
          target: { mode: "create" },
        },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: expect.objectContaining({
        field: "fileName",
        reason: "UNSUPPORTED_FILE",
      }),
    });
    const md = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Readme",
        content: { kind: "markdown", contentJson: BODY("x") },
      },
      actor,
    );
    await expect(
      importDocumentArchiveEntry(
        db,
        {
          projectId: project.id,
          folderPath: [],
          folderNames: {},
          kind: "python",
          fileName: "readme.py",
          text: "pass\n",
          images: [],
          target: {
            mode: "replace",
            documentId: md.id,
            expectedHeadCommitSha: (
              await db.document.findUniqueOrThrow({ where: { id: md.id } })
            ).headCommitSha,
          },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("python knowledge source", () => {
  it("loads the body by kind and chunks it by definition", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("index");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "svc",
        content: { kind: "python", text: "import os\n\ndef a():\n    pass\n" },
      },
      actor,
    );
    const source = await loadDocumentIndexSource(
      knowledgeSystemContextForTests(),
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        sourceCommitSha: doc.headCommitSha,
        pathAtSha: doc.path,
      },
    );
    expect(source).toEqual({
      title: "svc",
      kind: "python",
      body: "import os\n\ndef a():\n    pass\n",
    });
    const chunks = chunkDocumentSource({
      documentId: doc.id,
      sourceCommitSha: doc.headCommitSha,
      source: source!,
      maxChars: 9000,
      overlapChars: 0,
    });
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ["svc"],
      ["svc", "def a"],
    ]);
  });
});

describe("content operations on python documents", () => {
  it("edits and patches raw text", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("ops");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "ops",
        content: { kind: "python", text: "x = 1\ny = 2\n" },
      },
      actor,
    );
    const edited = await withProjectRepo(project.id, (repo) =>
      applyOperationInRepo(
        db,
        repo,
        {
          kind: "document.edit",
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: doc.headCommitSha,
          markdown: "# ops\n\nx = 10\ny = 2\n",
        },
        actor,
        { table: null, summary: "bump x", operationId: "op-1" },
      ),
    );
    let read = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(read.content).toEqual({
      kind: "python",
      text: "# ops\n\nx = 10\ny = 2\n",
    });
    await withProjectRepo(project.id, (repo) =>
      applyOperationInRepo(
        db,
        repo,
        {
          kind: "document.patch",
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: edited.commitSha,
          actions: [
            { action: "replace_text", find: "y = 2", replace: "y = 3" },
          ],
        },
        actor,
        { table: null, summary: "bump y", operationId: "op-2" },
      ),
    );
    read = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(read.content).toEqual({
      kind: "python",
      text: "# ops\n\nx = 10\ny = 3\n",
    });
  });
});

describe("python documents in images, history, recovery and review", () => {
  const create = async (
    f: Awaited<ReturnType<typeof fixture>>,
    title: string,
    text: string,
  ) =>
    createDocument(
      getPrisma(),
      {
        projectId: f.project.id,
        folderPath: [],
        title,
        content: { kind: "python", text },
      },
      f.actor,
    );
  const storedFile = async (projectId: string, path: string) =>
    parseDocumentFile(
      (await (await openProjectRepo(projectId))!.readCommittedFile(path))!
        .content,
      "python",
    );

  it("refuses image uploads and assets for a python document", async () => {
    const db = getPrisma();
    const f = await fixture("images");
    const doc = await create(f, "script", "pass\n");
    await expect(
      storeDocumentImage(
        db,
        {
          projectId: f.project.id,
          documentId: doc.id,
          fileName: "shot.png",
          bytes: PNG_1X1,
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      withProjectRepo(f.project.id, (repo) =>
        writeDocumentInRepo(
          db,
          repo,
          f.project.id,
          {
            kind: "create",
            id: randomUUID(),
            folderPath: [],
            title: "other",
            content: { kind: "python", text: "pass\n" },
            createdAt: new Date().toISOString(),
            assets: [{ name: "shot.png", bytes: PNG_1X1 }],
          },
          f.actor,
          { operation: "create" },
        ),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const repo = (await openProjectRepo(f.project.id))!;
    expect(
      (await repo.listTrackedFiles()).filter((file) =>
        file.includes(".assets"),
      ),
    ).toEqual([]);
    await expect(
      lstat(join(repoDir(f.project.id), "script.assets")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-projects the python kind on rebuild", async () => {
    const db = getPrisma();
    const f = await fixture("rebuild");
    const doc = await create(f, "tool", SCRIPT);
    await db.document.update({
      where: { id: doc.id },
      data: { kind: "markdown" },
    });
    await rebuildIndex(db, { projectId: f.project.id }, f.maintainerActor);
    expect(
      await db.document.findUniqueOrThrow({
        where: { id: doc.id },
        select: { kind: true, path: true },
      }),
    ).toEqual({ kind: "python", path: "tool.py" });

    await db.document.delete({ where: { id: doc.id } });
    await rebuildIndex(db, { projectId: f.project.id }, f.maintainerActor);
    expect(
      (await db.document.findUniqueOrThrow({ where: { id: doc.id } })).kind,
    ).toBe("python");
    expect(
      (
        await getDocument(
          db,
          { projectId: f.project.id, documentId: doc.id },
          f.actor,
        )
      ).content,
    ).toEqual({ kind: "python", text: SCRIPT });
  });

  it("re-slugs the .py file on a title change and keeps the body", async () => {
    const db = getPrisma();
    const f = await fixture("rename");
    const doc = await create(f, "old name", SCRIPT);
    expect(doc.path).toBe("old-name.py");
    const bodyBefore = (await storedFile(f.project.id, "old-name.py")).body;
    await saveDocument(
      db,
      {
        projectId: f.project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        title: "New Name",
        content: { kind: "python", text: SCRIPT },
        changeSummary: "",
      },
      f.actor,
    );
    const read = await getDocument(
      db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    expect(read.title).toBe("New Name");
    expect(read.content).toEqual({ kind: "python", text: SCRIPT });
    const tracked = await (await openProjectRepo(
      f.project.id,
    ))!.listTrackedFiles();
    expect(tracked).toContain("new-name.py");
    expect(tracked).not.toContain("old-name.py");
    expect(tracked.filter((file) => file.includes(".assets"))).toEqual([]);
    expect((await storedFile(f.project.id, "new-name.py")).body).toBe(
      bodyBefore,
    );
  });

  it("restores an earlier python version", async () => {
    const db = getPrisma();
    const f = await fixture("restore");
    const v1 = await create(f, "versions", "x = 1\n");
    const v2 = await saveDocument(
      db,
      {
        projectId: f.project.id,
        documentId: v1.id,
        baseCommitSha: v1.headCommitSha,
        content: { kind: "python", text: "x = 2\n" },
        changeSummary: "",
      },
      f.actor,
    );
    await restoreDocument(
      db,
      {
        projectId: f.project.id,
        documentId: v1.id,
        sha: v1.headCommitSha,
        expectedHeadCommitSha: v2.headCommitSha,
      },
      f.actor,
    );
    expect(
      (
        await getDocument(
          db,
          { projectId: f.project.id, documentId: v1.id },
          f.actor,
        )
      ).content,
    ).toEqual({ kind: "python", text: "x = 1\n" });
    expect((await storedFile(f.project.id, "versions.py")).body).toBe(
      "x = 1\n",
    );
  });

  it("recovers a deleted python document with its id and text", async () => {
    const db = getPrisma();
    const f = await fixture("recover");
    const doc = await create(f, "gone", SCRIPT);
    await deleteDocument(
      db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    const [item] = (
      await listDeletedContent(
        db,
        { projectId: f.project.id, limit: 5 },
        f.actor,
      )
    ).items;
    expect(item?.id).toBe(doc.id);
    await withProjectRepo(f.project.id, (repo) =>
      applyOperationInRepo(
        db,
        repo,
        {
          kind: "content.restore",
          projectId: f.project.id,
          resourceType: "document",
          resourceId: doc.id,
          mode: "deleted",
          sourceSha: item!.sourceSha,
          deletedAtSha: item!.deletedAtSha,
        },
        f.actor,
        { table: null, summary: "recover", operationId: "op-recover" },
      ),
    );
    const back = await getDocument(
      db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    expect(back.id).toBe(doc.id);
    expect(back.kind).toBe("python");
    expect(back.content).toEqual({ kind: "python", text: SCRIPT });
    const row = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    // Recovery never reuses a path from history, so the slug may be suffixed.
    expect(row.kind).toBe("python");
    expect(row.path).toMatch(/^gone(-\d+)?\.py$/);
    expect((await storedFile(f.project.id, row.path)).meta.id).toBe(doc.id);
  });

  it("updates the review header without touching the body", async () => {
    const db = getPrisma();
    const f = await fixture("review");
    const doc = await create(f, "reviewed", SCRIPT);
    const bodyBefore = (await storedFile(f.project.id, "reviewed.py")).body;
    const assigned = await setDocumentReview(
      db,
      {
        projectId: f.project.id,
        documentId: doc.id,
        expectedHeadCommitSha: doc.headCommitSha,
        reviewers: [{ type: "user", id: f.editor.id }],
        everyMonths: 4,
      },
      f.maintainerActor,
    );
    let stored = await storedFile(f.project.id, "reviewed.py");
    expect(stored.body).toBe(bodyBefore);
    expect(stored.meta.review?.reviewers.map((ref) => ref.id)).toEqual([
      f.editor.id,
    ]);
    expect(stored.meta.review?.everyMonths).toBe(4);
    expect(stored.meta.review?.lastReviewed).toBeNull();

    await markDocumentReviewed(
      db,
      {
        projectId: f.project.id,
        documentId: doc.id,
        expectedHeadCommitSha: assigned.headCommitSha,
      },
      f.actor,
    );
    stored = await storedFile(f.project.id, "reviewed.py");
    expect(stored.body).toBe(bodyBefore);
    expect(stored.meta.review?.lastReviewed).not.toBeNull();
    expect(stored.meta.review?.reviewedBy?.id).toBe(f.editor.id);
    expect(
      (
        await getDocument(
          db,
          { projectId: f.project.id, documentId: doc.id },
          f.actor,
        )
      ).content,
    ).toEqual({ kind: "python", text: SCRIPT });
  });
});

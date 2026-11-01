import type { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import { openProjectRepo } from "@weaver/git-store";
import {
  createDocumentArchive,
  createFolderArchive,
  readDocumentFile,
} from "@weaver/core/services/documentDownload";
import {
  createDocument,
  moveDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import { createFolder } from "@weaver/core/services/folders";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const AUTHOR = { name: "Editor", email: "editor@test.local" };

const BODY = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

async function fixture(suffix: string) {
  const editor = await makeUser("User", `editor-${suffix}`);
  const viewer = await makeUser("User", `viewer-${suffix}`);
  const outsider = await makeUser("User", `out-${suffix}`);
  const admin = await makeUser("Admin", `admin-${suffix}`);
  const project = await makeProject(`Download ${suffix}`);
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  const as = (user: typeof editor) => ({
    ...securityContextFor(user),
    ...AUTHOR,
    email: user.email,
  });
  return {
    project,
    actor: as(editor),
    viewerActor: as(viewer),
    outsiderActor: as(outsider),
    adminActor: as(admin),
  };
}

async function committedBytes(projectId: string, path: string) {
  const repo = (await openProjectRepo(projectId))!;
  const blob = await repo.readCommittedBlobAt(
    await repo.resolveHead(),
    path,
    2_000_000,
  );
  return blob!.bytes;
}

async function unzip(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return JSZip.loadAsync(Buffer.concat(chunks));
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

describe("readDocumentFile", () => {
  it("returns the committed file byte for byte to a Viewer", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor } = await fixture("file");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Plän & Notes",
        content: { kind: "markdown", contentJson: BODY("Body with ümlaut") },
      },
      actor,
    );

    const file = await readDocumentFile(
      db,
      { projectId: project.id, documentId: doc.id },
      viewerActor,
    );

    expect(file.fileName).toBe(`${doc.slug}.md`);
    expect(
      file.bytes.equals(await committedBytes(project.id, `${doc.slug}.md`)),
    ).toBe(true);
    expect(file.bytes.toString("utf8")).toContain("<!-- weaver");
    expect(file.bytes.toString("utf8")).toContain("Body with ümlaut");
  });

  it("follows the document after a save and a move", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor } = await fixture("moved");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Plan",
        content: { kind: "markdown", contentJson: BODY("first") },
      },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        title: "Plan",
        content: { kind: "markdown", contentJson: BODY("second") },
        baseCommitSha: doc.headCommitSha,
        changeSummary: "edit",
      },
      actor,
    );
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Notes" },
      actor,
    );
    await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["notes"] },
      actor,
    );

    const file = await readDocumentFile(
      db,
      { projectId: project.id, documentId: doc.id },
      viewerActor,
    );

    expect(file.fileName).toBe("plan.md");
    expect(
      file.bytes.equals(await committedBytes(project.id, "notes/plan.md")),
    ).toBe(true);
    expect(file.bytes.toString("utf8")).toContain("second");
  });

  it("hides the document from a non-member, a global Admin included", async () => {
    const db = getPrisma();
    const { project, actor, outsiderActor, adminActor } =
      await fixture("hidden");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Plan",
        content: { kind: "markdown", contentJson: BODY("secret") },
      },
      actor,
    );
    const input = { projectId: project.id, documentId: doc.id };

    await expect(
      readDocumentFile(db, input, outsiderActor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readDocumentFile(db, input, adminActor)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      readDocumentFile(
        db,
        {
          projectId: project.id,
          documentId: "00000000-0000-4000-8000-000000000000",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("createFolderArchive", () => {
  async function filledProject(suffix: string) {
    const db = getPrisma();
    const context = await fixture(suffix);
    const { project, actor } = context;
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Notes" },
      actor,
    );
    await createFolder(
      db,
      { projectId: project.id, parentPath: ["notes"], name: "Empty" },
      actor,
    );
    await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Readme",
        content: { kind: "markdown", contentJson: BODY("root") },
      },
      actor,
    );
    const plan = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: ["notes"],
        title: "Plan",
        content: { kind: "markdown", contentJson: BODY("plan") },
      },
      actor,
    );
    await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: plan.id,
        fileName: "chart.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    return { db, ...context };
  }

  it("zips a folder's documents and images for a Viewer", async () => {
    const { db, project, viewerActor } = await filledProject("zip");

    const archive = await createFolderArchive(
      db,
      { projectId: project.id, folderPath: ["notes"] },
      viewerActor,
    );
    const zip = await unzip(archive.stream);

    expect(archive.fileName).toBe("notes.zip");
    expect(Object.keys(zip.files).sort()).toEqual([
      "notes/",
      "notes/.folder.json",
      "notes/empty/",
      "notes/empty/.folder.json",
      "notes/plan.assets/",
      "notes/plan.assets/chart.png",
      "notes/plan.md",
    ]);
    const plan = await zip.file("notes/plan.md")!.async("nodebuffer");
    expect(plan.equals(await committedBytes(project.id, "notes/plan.md"))).toBe(
      true,
    );
    const chart = await zip
      .file("notes/plan.assets/chart.png")!
      .async("nodebuffer");
    expect(chart.equals(PNG_1X1)).toBe(true);
  });

  it("zips the project root under the project's name with folder metadata", async () => {
    const { db, project, viewerActor } = await filledProject("root");

    const archive = await createFolderArchive(
      db,
      { projectId: project.id, folderPath: [] },
      viewerActor,
    );
    const zip = await unzip(archive.stream);

    expect(archive.fileName).toBe("download-root.zip");
    expect(
      Object.keys(zip.files)
        .filter((name) => !name.endsWith("/"))
        .sort(),
    ).toEqual([
      "download-root/notes/.folder.json",
      "download-root/notes/empty/.folder.json",
      "download-root/notes/plan.assets/chart.png",
      "download-root/notes/plan.md",
      "download-root/readme.md",
    ]);
  });

  it("hides folders from non-members and reports absent folders", async () => {
    const { db, project, viewerActor, outsiderActor, adminActor } =
      await filledProject("deny");
    const input = { projectId: project.id, folderPath: ["notes"] };

    await expect(
      createFolderArchive(db, input, outsiderActor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createFolderArchive(db, input, adminActor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createFolderArchive(
        db,
        { projectId: project.id, folderPath: ["missing"] },
        viewerActor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createFolderArchive(
        db,
        { projectId: project.id, folderPath: ["tables"] },
        viewerActor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("createDocumentArchive", () => {
  it("holds the document and its images at the archive root for a Viewer", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor } = await fixture("doczip");
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Notes" },
      actor,
    );
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: ["notes"],
        title: "Plan",
        content: { kind: "markdown", contentJson: BODY("Body") },
      },
      actor,
    );
    await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "pixel.png",
        bytes: PNG_1X1,
      },
      actor,
    );

    const archive = await createDocumentArchive(
      db,
      { projectId: project.id, documentId: doc.id },
      viewerActor,
    );
    const zip = await unzip(archive.stream);
    const files = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();

    expect(archive.fileName).toBe("plan.zip");
    expect(files).toEqual(["plan.assets/pixel.png", "plan.md"]);
    expect(
      (await zip.file("plan.md")!.async("nodebuffer")).equals(
        await committedBytes(project.id, "notes/plan.md"),
      ),
    ).toBe(true);
    expect(
      (await zip.file("plan.assets/pixel.png")!.async("nodebuffer")).equals(
        PNG_1X1,
      ),
    ).toBe(true);
  });

  it("hides the document from a non-member", async () => {
    const db = getPrisma();
    const { project, actor, outsiderActor } = await fixture("doczip-out");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Secret",
        content: { kind: "markdown", contentJson: BODY("Body") },
      },
      actor,
    );

    await expect(
      createDocumentArchive(
        db,
        { projectId: project.id, documentId: doc.id },
        outsiderActor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

it("shared_icon_export_includes_only_referenced_assets_once", async () => {
  const { setContentAppearance } =
    await import("@weaver/core/services/contentAppearance");
  const { imageIconFromBytes } =
    await import("@weaver/core/services/appearanceAssets");
  const { iconAssetPath } = await import("@weaver/core/appearance/icons");
  const { project, actor } = await fixture("icon-closure");
  const db = getPrisma();
  await createFolder(
    db,
    { projectId: project.id, parentPath: [], name: "Notes" },
    actor,
  );
  for (const [title, folderPath, bytes] of [
    ["One", ["notes"], PNG_1X1],
    ["Two", ["notes"], PNG_1X1],
    ["Shared Outside", [], PNG_1X1],
    ["Outside", [], Buffer.concat([PNG_1X1, Buffer.from("other")])],
  ] as const) {
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [...folderPath],
        title,
        content: { kind: "markdown", contentJson: BODY("text") },
      },
      actor,
    );
    await setContentAppearance(
      db,
      {
        target: { projectId: project.id, kind: "document", id: doc.id },
        expectedRevision: doc.headCommitSha,
        patch: {},
      },
      actor,
      { bytes },
    );
  }
  const zip = await unzip(
    (
      await createFolderArchive(
        db,
        { projectId: project.id, folderPath: ["notes"] },
        actor,
      )
    ).stream,
  );
  expect(
    Object.keys(zip.files).filter(
      (path) => path.startsWith(".weaver-icons/") && !path.endsWith("/"),
    ),
  ).toEqual([iconAssetPath(imageIconFromBytes(PNG_1X1))]);
  expect(zip.file("notes/.folder.json")).not.toBeNull();
});

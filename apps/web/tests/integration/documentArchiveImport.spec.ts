import {
  composeFolderMetadata,
  newFolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
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
import { openProjectRepo, repoDir } from "@weaver/git-store";
import {
  createDocument,
  restoreDocument,
} from "@weaver/core/services/documents";
import { createDocumentArchive } from "@weaver/core/services/documentDownload";
import {
  importDocumentFile,
  importDocumentArchiveEntry,
} from "@weaver/core/services/documentImport";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import { getTree } from "@weaver/core/services/folders";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const BODY = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

async function fixture(suffix: string) {
  const editor = await makeUser("User", `editor-${suffix}`);
  const viewer = await makeUser("User", `viewer-${suffix}`);
  const project = await makeProject(`Import ${suffix}`);
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  const as = (user: typeof editor) => ({
    ...securityContextFor(user),
    name: "Editor",
    email: user.email,
  });
  return { project, actor: as(editor), viewerActor: as(viewer) };
}

async function tracked(projectId: string): Promise<string[]> {
  const repo = (await openProjectRepo(projectId))!;
  return (await repo.listTrackedFiles()).sort();
}

async function committed(projectId: string, path: string): Promise<Buffer> {
  const repo = (await openProjectRepo(projectId))!;
  const blob = await repo.readCommittedBlobAt(
    await repo.resolveHead(),
    path,
    2_000_000,
  );
  return blob!.bytes;
}

const MARKDOWN = [
  "<!-- weaver",
  "id: 11111111-1111-4111-8111-111111111111",
  "created: 2026-01-01T00:00:00.000Z",
  "updated: 2026-01-01T00:00:00.000Z",
  "-->",
  "",
  "# Trip Report",
  "",
  "Before the picture.",
  "",
  "![Pixel](trip-report.assets/pixel.png)",
  "",
].join("\n");

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

describe("importDocumentArchiveEntry", () => {
  it("rejects a stale replacement before deleting assets or writing content", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("stale-replace");
    const input = {
      projectId: project.id,
      folderPath: [],
      folderNames: {},
      kind: "markdown" as const,
      fileName: "trip-report.md",
      text: MARKDOWN,
      images: [{ name: "pixel.png", bytes: PNG_1X1 }],
      target: { mode: "create" as const },
    };
    const first = await importDocumentArchiveEntry(db, input, actor);
    const second = await importDocumentArchiveEntry(
      db,
      {
        ...input,
        text: "# Changed\n\nNew body",
        images: [],
        target: {
          mode: "replace",
          documentId: first.id,
          expectedHeadCommitSha: first.headCommitSha,
        },
      },
      actor,
    );
    await expect(
      importDocumentArchiveEntry(
        db,
        {
          ...input,
          target: {
            mode: "replace",
            documentId: first.id,
            expectedHeadCommitSha: first.headCommitSha,
          },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await committed(project.id, second.path)).toString()).toContain(
      "New body",
    );
    expect(await tracked(project.id)).not.toContain("changed.assets/pixel.png");
  });

  it("restores historical images deleted by a replacement across slug changes", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("restore-images");
    const input = {
      projectId: project.id,
      folderPath: [],
      folderNames: {},
      kind: "markdown" as const,
      fileName: "trip-report.md",
      text: MARKDOWN,
      images: [{ name: "pixel.png", bytes: PNG_1X1 }],
      target: { mode: "create" as const },
    };
    const first = await importDocumentArchiveEntry(db, input, actor);
    const second = await importDocumentArchiveEntry(
      db,
      {
        ...input,
        text: "# Changed\n\nNew body",
        images: [],
        target: {
          mode: "replace",
          documentId: first.id,
          expectedHeadCommitSha: first.headCommitSha,
        },
      },
      actor,
    );
    const restored = await restoreDocument(
      db,
      {
        projectId: project.id,
        documentId: first.id,
        sha: first.headCommitSha,
        expectedHeadCommitSha: second.headCommitSha,
      },
      actor,
    );
    expect((await committed(project.id, restored.path)).toString()).toContain(
      "trip-report.assets/pixel.png",
    );
    expect(await committed(project.id, "trip-report.assets/pixel.png")).toEqual(
      PNG_1X1,
    );
  });

  it("zip_replace_keeps_existing_review", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor } = await fixture("review-defaults");
    const reviewer = {
      type: "user" as const,
      id: viewerActor.userId,
      name: "User viewer-review-defaults",
    };
    const store = async (id: string, name: string) =>
      withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic(
          "guides/.folder.json",
          composeFolderMetadata({
            ...newFolderMetadata(
              "Guides",
              { id: actor.userId, name: "Editor" },
              new Date(),
            ),
            reviewDefaults: { reviewers: [{ type: "user", id, name }] },
          }),
        );
        await repo.commitAll("test: ZIP destination defaults", {
          userId: actor.userId,
          name: "Editor",
          email: actor.email,
        });
      });
    await store(reviewer.id, reviewer.name);
    const entry = {
      projectId: project.id,
      folderPath: ["guides", "new"],
      folderNames: { "guides/new": "New" },
      folderMetadata: {
        "guides/new": {
          ...newFolderMetadata(
            "New",
            { id: actor.userId, name: "Editor" },
            new Date(),
          ),
          reviewDefaults: {
            reviewers: [
              {
                type: "user" as const,
                id: actor.userId,
                name: "Source editor",
              },
            ],
          },
        },
      },
      fileName: "notes.md",
      kind: "markdown" as const,
      text: "# Notes\n\nOriginal\n",
      images: [],
    };
    const created = await importDocumentArchiveEntry(
      db,
      { ...entry, target: { mode: "create" } },
      actor,
    );
    const before = parseDocumentFile(
      (await committed(project.id, created.path)).toString("utf8"),
      "markdown",
    ).meta.review!;
    expect(before.reviewers).toEqual([reviewer]);
    expect(before.everyMonths).toBe(12);
    const persistedFolder = JSON.parse(
      (await committed(project.id, "guides/new/.folder.json")).toString("utf8"),
    ) as Record<string, unknown>;
    expect(persistedFolder).not.toHaveProperty("reviewDefaults");
    await store(actor.userId, "User editor-review-defaults");
    const later = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: ["guides", "new"],
        title: "Later",
        content: {
          kind: "markdown",
          contentJson: BODY("Created after ZIP import"),
        },
      },
      actor,
    );
    expect(
      parseDocumentFile(
        (await committed(project.id, later.path)).toString("utf8"),
        "markdown",
      ).meta.review?.reviewers,
    ).toEqual([
      { type: "user", id: actor.userId, name: "User editor-review-defaults" },
    ]);
    const foreign = composeDocumentFile(
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Notes",
        created: "2020-01-01T00:00:00.000Z",
        createdBy: null,
        updated: "2020-01-01T00:00:00.000Z",
        updatedBy: null,
        review: {
          reviewers: [],
          everyMonths: 1,
          since: "2020-01-01T00:00:00.000Z",
          lastReviewed: null,
          reviewedBy: null,
        },
      },
      "Replacement\n",
      "markdown",
    );
    const replaced = await importDocumentArchiveEntry(
      db,
      {
        ...entry,
        text: foreign,
        target: {
          mode: "replace",
          documentId: created.id,
          expectedHeadCommitSha: (
            await db.document.findUniqueOrThrow({ where: { id: created.id } })
          ).headCommitSha,
        },
      },
      actor,
    );
    const after = parseDocumentFile(
      (await committed(project.id, replaced.path)).toString("utf8"),
      "markdown",
    );
    expect(after.meta.review).toEqual(before);
    expect(after.body).toContain("Replacement");
  });

  it("creates the document with its images and working links", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("create");

    const result = await importDocumentArchiveEntry(
      db,
      {
        projectId: project.id,
        folderPath: [],
        folderNames: {},
        fileName: "trip-report.md",
        kind: "markdown" as const,
        text: MARKDOWN,
        images: [
          { name: "pixel.png", bytes: PNG_1X1 },
          { name: "unused.png", bytes: PNG_1X1 },
        ],
        target: { mode: "create" },
      },
      actor,
    );

    expect(result.title).toBe("Trip Report");
    expect(result.id).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(result.path).toBe("trip-report.md");
    const files = await tracked(project.id);
    expect(files).toContain("trip-report.assets/pixel.png");
    expect(files.some((file) => file.endsWith("unused.png"))).toBe(false);
    expect(
      (await committed(project.id, "trip-report.assets/pixel.png")).equals(
        PNG_1X1,
      ),
    ).toBe(true);
    expect((await committed(project.id, result.path)).toString()).toContain(
      "![Pixel](trip-report.assets/pixel.png)",
    );
  });

  it("keeps image widths and assets through a ZIP export and import", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("width");
    const sized = MARKDOWN.replace(
      "![Pixel](trip-report.assets/pixel.png)",
      '<img src="trip-report.assets/pixel.png" alt="Pixel &amp; co" title="One" width="120">',
    );
    const input = {
      projectId: project.id,
      folderPath: [] as string[],
      folderNames: {},
      fileName: "trip-report.md",
      target: { mode: "create" as const },
    };
    const first = await importDocumentArchiveEntry(
      db,
      {
        ...input,
        kind: "markdown" as const,
        text: sized,
        images: [{ name: "pixel.png", bytes: PNG_1X1 }],
      },
      actor,
    );
    const tag = (slug: string) =>
      `<img src="${slug}.assets/pixel.png" alt="Pixel &amp; co" title="One" width="120">`;
    expect((await committed(project.id, first.path)).toString()).toContain(
      tag("trip-report"),
    );

    const archive = await createDocumentArchive(
      db,
      { projectId: project.id, documentId: first.id },
      actor,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(chunk as Buffer);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    const exported = await zip.file("trip-report.md")!.async("string");
    expect(exported).toContain(tag("trip-report"));

    const copy = await importDocumentArchiveEntry(
      db,
      {
        ...input,
        kind: "markdown" as const,
        text: exported,
        images: [
          {
            name: "pixel.png",
            bytes: await zip
              .file("trip-report.assets/pixel.png")!
              .async("nodebuffer"),
          },
        ],
      },
      actor,
    );
    expect(copy.slug).toBe("trip-report-2");
    expect((await committed(project.id, copy.path)).toString()).toContain(
      tag("trip-report-2"),
    );
    expect(
      (await committed(project.id, "trip-report-2.assets/pixel.png")).equals(
        PNG_1X1,
      ),
    ).toBe(true);
  });

  it("re-slugs a copy and rewrites its image links", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("copy");
    const input = {
      projectId: project.id,
      folderPath: [] as string[],
      folderNames: {},
      fileName: "trip-report.md",
      kind: "markdown" as const,
      text: MARKDOWN,
      images: [{ name: "pixel.png", bytes: PNG_1X1 }],
      target: { mode: "create" as const },
    };
    await importDocumentArchiveEntry(db, input, actor);

    const copy = await importDocumentArchiveEntry(db, input, actor);

    expect(copy.slug).toBe("trip-report-2");
    expect((await committed(project.id, copy.path)).toString()).toContain(
      "![Pixel](trip-report-2.assets/pixel.png)",
    );
    expect(await tracked(project.id)).toContain(
      "trip-report-2.assets/pixel.png",
    );
  });

  it("creates missing folders with their display names", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("folders");

    const result = await importDocumentArchiveEntry(
      db,
      {
        projectId: project.id,
        folderPath: ["field-notes", "2026"],
        folderNames: {
          "field-notes": "Field Notes",
          "field-notes/2026": "2026",
        },
        fileName: "trip-report.md",
        kind: "markdown" as const,
        text: MARKDOWN,
        images: [{ name: "pixel.png", bytes: PNG_1X1 }],
        target: { mode: "create" },
      },
      actor,
    );

    expect(result.path).toBe("field-notes/2026/trip-report.md");
    const tree = await getTree(db, { projectId: project.id }, actor);
    expect(tree.folderNames["field-notes"]).toBe("Field Notes");
    expect(await tracked(project.id)).toContain(
      "field-notes/2026/trip-report.assets/pixel.png",
    );

    const second = await importDocumentArchiveEntry(
      db,
      {
        projectId: project.id,
        folderPath: ["field-notes", "2026"],
        folderNames: {},
        fileName: "other.md",
        kind: "markdown" as const,
        text: "# Other\n\nText.\n",
        images: [],
        target: { mode: "create" },
      },
      actor,
    );
    expect(second.path).toBe("field-notes/2026/other.md");
  });

  it("replaces an existing document, keeping its id and dropping stale images", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("replace");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Plan",
        content: { kind: "markdown", contentJson: BODY("Old body") },
      },
      actor,
    );
    await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "old.png",
        bytes: PNG_1X1,
      },
      actor,
    );

    const result = await importDocumentArchiveEntry(
      db,
      {
        projectId: project.id,
        folderPath: [],
        folderNames: {},
        fileName: "export.md",
        kind: "markdown" as const,
        text: "# Plan v2\n\nNew body.\n\n![New](export.assets/new.png)\n",
        images: [{ name: "new.png", bytes: PNG_1X1 }],
        target: {
          mode: "replace",
          documentId: doc.id,
          expectedHeadCommitSha: (
            await db.document.findUniqueOrThrow({ where: { id: doc.id } })
          ).headCommitSha,
        },
      },
      actor,
    );

    expect(result.id).toBe(doc.id);
    expect(result.title).toBe("Plan v2");
    expect(result.headCommitSha).not.toBe(doc.headCommitSha);
    const files = await tracked(project.id);
    expect(files).toContain("plan-v2.md");
    expect(files).toContain("plan-v2.assets/new.png");
    expect(files.some((file) => file.endsWith("old.png"))).toBe(false);
    expect(files).not.toContain("plan.md");
    const text = (await committed(project.id, "plan-v2.md")).toString();
    expect(text).toContain("New body.");
    expect(text).toContain("![New](plan-v2.assets/new.png)");
  });

  it("keeps the slug and the still-used image on a same-title replace", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("replace-same");
    const first = await importDocumentArchiveEntry(
      db,
      {
        projectId: project.id,
        folderPath: [],
        folderNames: {},
        fileName: "trip-report.md",
        kind: "markdown" as const,
        text: MARKDOWN,
        images: [{ name: "pixel.png", bytes: PNG_1X1 }],
        target: { mode: "create" },
      },
      actor,
    );

    const again = await importDocumentArchiveEntry(
      db,
      {
        projectId: project.id,
        folderPath: [],
        folderNames: {},
        fileName: "trip-report.md",
        kind: "markdown" as const,
        text: MARKDOWN.replace("Before", "Well before"),
        images: [{ name: "pixel.png", bytes: PNG_1X1 }],
        target: {
          mode: "replace",
          documentId: first.id,
          expectedHeadCommitSha: (
            await db.document.findUniqueOrThrow({ where: { id: first.id } })
          ).headCommitSha,
        },
      },
      actor,
    );

    expect(again.id).toBe(first.id);
    expect(again.path).toBe("trip-report.md");
    expect(
      (await tracked(project.id)).filter((f) => f.includes(".assets/")),
    ).toEqual(["trip-report.assets/pixel.png"]);
    expect((await committed(project.id, again.path)).toString()).toContain(
      "Well before the picture.",
    );
  });

  it("refuses a replace target outside the project", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("replace-missing");

    await expect(
      importDocumentArchiveEntry(
        db,
        {
          projectId: project.id,
          folderPath: [],
          folderNames: {},
          fileName: "x.md",
          kind: "markdown" as const,
          text: "# X\n",
          images: [],
          target: {
            mode: "replace",
            expectedHeadCommitSha: "a".repeat(40),
            documentId: "22222222-2222-4222-8222-222222222222",
          },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a file that is not an image and creates nothing", async () => {
    const db = getPrisma();
    const { project, actor } = await fixture("badimage");
    await expect(
      importDocumentArchiveEntry(
        db,
        {
          projectId: project.id,
          folderPath: ["new-folder"],
          folderNames: {},
          fileName: "trip-report.md",
          kind: "markdown" as const,
          text: MARKDOWN,
          images: [{ name: "pixel.png", bytes: Buffer.from("not an image") }],
          target: { mode: "create" },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (await tracked(project.id)).filter(
        (file) => file.startsWith("new-folder/") || file.endsWith(".md"),
      ),
    ).toEqual([]);
  });

  it("refuses a Viewer", async () => {
    const db = getPrisma();
    const { project, viewerActor } = await fixture("viewer");

    await expect(
      importDocumentArchiveEntry(
        db,
        {
          projectId: project.id,
          folderPath: [],
          folderNames: {},
          fileName: "x.md",
          kind: "markdown" as const,
          text: "# X\n",
          images: [],
          target: { mode: "create" },
        },
        viewerActor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

it("plain_markdown_missing_icon_warns_and_falls_back", async () => {
  const { project, actor } = await fixture("missing-icon");
  const appearance = {
    backgroundColor: "#123456",
    icon: { type: "image", digest: "a".repeat(64), extension: "png" },
  };
  const markdown = MARKDOWN.replace(
    "-->",
    `appearance: ${JSON.stringify(appearance)}\n-->`,
  );
  const imported = await importDocumentFile(
    getPrisma(),
    { projectId: project.id, folderPath: [], fileName: "x.md", text: markdown },
    actor,
  );
  expect(imported).toMatchObject({
    warnings: [expect.stringContaining("icon")],
  });
  expect((await committed(project.id, imported.path)).toString()).toContain(
    JSON.stringify(appearance),
  );
});

it("tampered_icon_digest_rejected_without_commit", async () => {
  const { project, actor } = await fixture("tampered-icon");
  await createDocument(
    getPrisma(),
    {
      projectId: project.id,
      folderPath: [],
      title: "Existing",
      content: { kind: "markdown", contentJson: BODY("existing") },
    },
    actor,
  );
  const repo = (await openProjectRepo(project.id))!;
  const head = await repo.resolveHead();
  const icon = {
    type: "image" as const,
    digest: "a".repeat(64),
    extension: "png" as const,
  };
  await expect(
    importDocumentArchiveEntry(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: ["new"],
        folderNames: {},
        fileName: "x.md",
        kind: "markdown" as const,
        text: MARKDOWN.replace(
          "-->",
          `appearance: ${JSON.stringify({ icon })}\n-->`,
        ),
        images: [],
        target: { mode: "create" },
        iconAssets: [{ ...icon, bytes: PNG_1X1 }],
      },
      actor,
    ),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await repo.resolveHead()).toBe(head);
  expect(await tracked(project.id)).not.toContain("new/.folder.json");
});

it("empty_styled_folder_roundtrips", async () => {
  const { POST } =
    await import("~/app/api/projects/[projectId]/documents/import/route");
  const { getSessionUser } = await import("~/server/auth");
  const { imageIconFromBytes } =
    await import("@weaver/core/services/appearanceAssets");
  const { createFolderArchive } =
    await import("@weaver/core/services/documentDownload");
  const { project, actor } = await fixture("empty-style");
  vi.mocked(getSessionUser).mockResolvedValue({
    id: actor.userId,
    role: "User",
    name: actor.name,
    email: actor.email,
    sessionId: actor.credentialId,
    mustChangePassword: false,
  });
  const icon = imageIconFromBytes(PNG_1X1);
  const appearance = { backgroundColor: "#123456", icon };
  const form = new FormData();
  form.set("mode", "folders");
  form.set("folderPath", "[]");
  form.set("folderNames", "{}");
  form.set(
    "folderMetadata",
    JSON.stringify({ empty: { name: "Empty Styled", appearance } }),
  );
  form.append("icon", new File([PNG_1X1], `${icon.digest}.${icon.extension}`));
  const req = new Request(
    `http://localhost:3000/api/projects/${project.id}/documents/import`,
    {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-length": "5000" },
      body: form,
    },
  );
  const { NextRequest } = await import("next/server");
  const response = await POST(new NextRequest(req), {
    params: Promise.resolve({ projectId: project.id }),
  });
  expect(response.status).toBe(201);
  const tree = await getTree(getPrisma(), { projectId: project.id }, actor);
  expect(tree.folderNames.empty).toBe("Empty Styled");
  expect(tree.folderAppearances.empty).toEqual(appearance);
  const stream = (
    await createFolderArchive(
      getPrisma(),
      { projectId: project.id, folderPath: ["empty"] },
      actor,
    )
  ).stream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  expect(
    JSON.parse(await zip.file("empty/.folder.json")!.async("string")),
  ).toMatchObject({ name: "Empty Styled", appearance });
  expect(
    zip.file(`.weaver-icons/${icon.digest}.${icon.extension}`),
  ).not.toBeNull();
  const { importArchiveFolders } =
    await import("@weaver/core/services/documentImport");
  const before = await (await openProjectRepo(project.id))!.resolveHead();
  await importArchiveFolders(
    getPrisma(),
    {
      projectId: project.id,
      folderPath: [],
      folderNames: {},
      folderMetadata: {
        empty: JSON.parse(
          await zip.file("empty/.folder.json")!.async("string"),
        ),
      },
    },
    actor,
  );
  expect(await (await openProjectRepo(project.id))!.resolveHead()).toBe(before);
  const destinationProject = await makeProject("Empty folder destination");
  await addMembership(destinationProject.id, actor.userId, "Editor");
  const copied = await importArchiveFolders(
    getPrisma(),
    {
      projectId: destinationProject.id,
      folderPath: [],
      folderNames: {},
      iconAssets: [
        {
          ...icon,
          bytes: await zip
            .file(`.weaver-icons/${icon.digest}.${icon.extension}`)!
            .async("uint8array"),
        },
      ],
      folderMetadata: {
        "copy/empty": JSON.parse(
          await zip.file("empty/.folder.json")!.async("string"),
        ),
      },
    },
    actor,
  );
  expect(copied.folders).toEqual(["copy/empty"]);
  expect(
    (await getTree(getPrisma(), { projectId: destinationProject.id }, actor))
      .folderAppearances["copy/empty"],
  ).toEqual(appearance);
  const copiedRepo = (await openProjectRepo(destinationProject.id))!;
  expect(
    await copiedRepo.lastCommitForPath(
      `.weaver-icons/${icon.digest}.${icon.extension}`,
    ),
  ).toBe(copied.headCommitSha);
});

it("archive copies retain appearance and replacements keep destination appearance and unrelated folder metadata", async () => {
  const { imageIconFromBytes } =
    await import("@weaver/core/services/appearanceAssets");
  const { getDocument } = await import("@weaver/core/services/documents");
  const { importArchiveFolders } =
    await import("@weaver/core/services/documentImport");
  const { project, actor } = await fixture("preserve-style");
  const db = getPrisma();
  const icon = imageIconFromBytes(PNG_1X1);
  const source = { backgroundColor: "#123456", icon };
  const destination = {
    backgroundColor: "#abcdef",
    icon: { type: "emoji" as const, value: "🌲" },
  };
  const metadata = {
    name: "Existing Name",
    created: null,
    createdBy: null,
    updated: null,
    updatedBy: null,
    appearance: destination,
  };
  await importArchiveFolders(
    db,
    {
      projectId: project.id,
      folderPath: [],
      folderNames: {},
      folderMetadata: { existing: metadata },
    },
    actor,
  );
  const beforeFolder = await committed(project.id, "existing/.folder.json");
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: ["existing"],
      title: "Destination",
      content: { kind: "markdown", contentJson: BODY("old") },
      appearance: destination,
    },
    actor,
  );
  const input = {
    projectId: project.id,
    folderPath: ["existing"],
    folderNames: {},
    folderMetadata: {
      existing: { ...metadata, name: "Changed", appearance: source },
    },
    fileName: "trip-report.md",
    kind: "markdown" as const,
    text: MARKDOWN.replace("-->", `appearance: ${JSON.stringify(source)}\n-->`),
    images: [],
    iconAssets: [
      { digest: icon.digest, extension: icon.extension, bytes: PNG_1X1 },
    ],
  };
  const copy = await importDocumentArchiveEntry(
    db,
    { ...input, target: { mode: "create" } },
    actor,
  );
  expect(
    (
      await getDocument(
        db,
        { projectId: project.id, documentId: copy.id },
        actor,
      )
    ).appearance,
  ).toEqual(source);
  const repo = (await openProjectRepo(project.id))!;
  expect(
    await repo.lastCommitForPath(
      `.weaver-icons/${icon.digest}.${icon.extension}`,
    ),
  ).toBe(copy.headCommitSha);
  await importDocumentArchiveEntry(
    db,
    {
      ...input,
      target: {
        mode: "replace",
        documentId: doc.id,
        expectedHeadCommitSha: (
          await db.document.findUniqueOrThrow({ where: { id: doc.id } })
        ).headCommitSha,
      },
    },
    actor,
  );
  expect(
    (
      await getDocument(
        db,
        { projectId: project.id, documentId: doc.id },
        actor,
      )
    ).appearance,
  ).toEqual(destination);
  expect(await committed(project.id, "existing/.folder.json")).toEqual(
    beforeFolder,
  );
});

it.each([false, true])(
  "rolls back archive icons, folders and document before commit (staged=%s)",
  async (staged) => {
    const { simpleGit } = await import("simple-git");
    const { imageIconFromBytes } =
      await import("@weaver/core/services/appearanceAssets");
    const repoServices = await import("@weaver/core/services/projectRepo");
    const { project, actor } = await fixture(`rollback-${staged}`);
    const db = getPrisma();
    await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Existing",
        content: { kind: "markdown", contentJson: BODY("existing") },
      },
      actor,
    );
    const repo = (await openProjectRepo(project.id))!;
    const head = await repo.resolveHead();
    const icon = imageIconFromBytes(PNG_1X1);
    const withRepo = repoServices.withProjectRepo;
    const spy = vi
      .spyOn(repoServices, "withProjectRepo")
      .mockImplementationOnce((id, fn) =>
        withRepo(id, async (writer) => {
          writer.commitAll = async () => {
            if (staged) await simpleGit(writer.dir).raw(["add", "-f", "-A"]);
            throw new Error("injected commit failure");
          };
          return fn(writer);
        }),
      );
    try {
      await expect(
        importDocumentArchiveEntry(
          db,
          {
            projectId: project.id,
            folderPath: ["new"],
            folderNames: {},
            fileName: "trip-report.md",
            kind: "markdown" as const,
            text: MARKDOWN.replace(
              "-->",
              `appearance: ${JSON.stringify({ icon })}\n-->`,
            ),
            images: [],
            iconAssets: [{ ...icon, bytes: PNG_1X1 }],
            target: { mode: "create" },
          },
          actor,
        ),
      ).rejects.toThrow("injected commit failure");
      expect(await repo.resolveHead()).toBe(head);
      expect(
        await simpleGit(repoDir(project.id)).raw(["status", "--porcelain"]),
      ).toBe("");
      expect(
        await db.document.count({ where: { projectId: project.id } }),
      ).toBe(1);
      expect(
        (await getTree(db, { projectId: project.id }, actor)).folders,
      ).not.toContain("new");
    } finally {
      spy.mockRestore();
    }
  },
);

it.each(["create", "archive"] as const)(
  "retains committed content and icons after %s enqueue failure",
  async (mode) => {
    const { simpleGit } = await import("simple-git");
    const { imageIconFromBytes, readAppearanceAsset } =
      await import("@weaver/core/services/appearanceAssets");
    const { getDocument } = await import("@weaver/core/services/documents");
    const knowledge =
      await import("@weaver/core/services/knowledgeReconciliation");
    const { project, actor } = await fixture(`accepted-${mode}`);
    const db = getPrisma();
    await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Existing",
        content: { kind: "markdown", contentJson: BODY("existing") },
      },
      actor,
    );
    const repo = (await openProjectRepo(project.id))!;
    const head = await repo.resolveHead();
    const icon = imageIconFromBytes(PNG_1X1);
    const appearance = { icon };
    const spy = vi
      .spyOn(knowledge, "enqueueDocumentChanged")
      .mockRejectedValueOnce(new Error("injected post-commit enqueue failure"));
    try {
      const write =
        mode === "create"
          ? createDocument(
              db,
              {
                projectId: project.id,
                folderPath: [],
                title: "Accepted",
                content: { kind: "markdown", contentJson: BODY("accepted") },
                appearance,
                iconAssets: [{ ...icon, bytes: PNG_1X1 }],
              },
              actor,
            )
          : importDocumentArchiveEntry(
              db,
              {
                projectId: project.id,
                folderPath: ["new"],
                folderNames: {},
                fileName: "accepted.md",
                kind: "markdown" as const,
                text: MARKDOWN.replace("Trip Report", "Accepted").replace(
                  "-->",
                  `appearance: ${JSON.stringify(appearance)}\n-->`,
                ),
                images: [],
                iconAssets: [{ ...icon, bytes: PNG_1X1 }],
                target: { mode: "create" },
              },
              actor,
            );
      await expect(write).rejects.toThrow(
        "injected post-commit enqueue failure",
      );
      const acceptedHead = await repo.resolveHead();
      expect(acceptedHead).not.toBe(head);
      expect(
        await simpleGit(repoDir(project.id)).raw([
          "rev-list",
          "--count",
          `${head}..HEAD`,
        ]),
      ).toBe("1\n");
      expect(
        await simpleGit(repoDir(project.id)).raw(["status", "--porcelain"]),
      ).toBe("");
      const row = await db.document.findFirstOrThrow({
        where: { projectId: project.id, title: "Accepted" },
      });
      const document = await getDocument(
        db,
        { projectId: project.id, documentId: row.id },
        actor,
      );
      expect(document.appearance).toEqual(appearance);
      expect(document.baseCommitSha).toBe(acceptedHead);
      expect(
        await repo.lastCommitForPath(`.weaver-icons/${icon.digest}.png`),
      ).toBe(acceptedHead);
      const asset = await readAppearanceAsset(
        db,
        { projectId: project.id, icon, at: acceptedHead },
        actor,
      );
      expect(asset && "bytes" in asset ? asset.bytes : null).toEqual(PNG_1X1);
      if (mode === "archive")
        expect(
          (await getTree(db, { projectId: project.id }, actor)).folders,
        ).toContain("new");
    } finally {
      spy.mockRestore();
    }
  },
);

describe("imported page properties", () => {
  const header = (properties: unknown) =>
    [
      "<!-- weaver",
      "id: 22222222-2222-4222-8222-222222222222",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      `properties: ${JSON.stringify(properties)}`,
      "-->",
      "",
      "# Props",
      "",
      "Body.",
      "",
    ].join("\n");
  const entry = (
    projectId: string,
    text: string,
    target: Parameters<typeof importDocumentArchiveEntry>[1]["target"],
    fileName = "props.md",
  ) => ({
    projectId,
    folderPath: [],
    folderNames: {},
    kind: "markdown" as const,
    fileName,
    text,
    images: [],
    target,
  });
  const propsOf = async (projectId: string, path: string) =>
    parseDocumentFile((await committed(projectId, path)).toString(), "markdown")
      .meta;

  it("maps YAML type, tags, summary and aliases and ignores the source type", async () => {
    const { project, actor } = await fixture("yaml-props");
    const yaml = (type: string) =>
      [
        "---",
        "title: Yaml Page",
        `type: ${type}`,
        'summary: "A short summary"',
        "tags: [alpha, beta]",
        "aliases:",
        "  - gamma",
        "  - alpha",
        "source: ignored",
        "---",
        "",
        "Body.",
        "",
      ].join("\n");
    const ok = await importDocumentArchiveEntry(
      getPrisma(),
      entry(project.id, yaml("entity"), { mode: "create" }),
      actor,
    );
    expect((await propsOf(project.id, ok.path)).properties).toEqual({
      type: "entity",
      summary: "A short summary",
      tags: ["alpha", "beta", "gamma"],
    });
    const src = await importDocumentFile(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        fileName: "second.md",
        text: yaml("Source").replace("Yaml Page", "Second"),
      },
      actor,
    );
    const meta = (await propsOf(project.id, src.path)).properties;
    expect(meta?.type).toBeUndefined();
    expect(meta?.summary).toBe("A short summary");
  }, 30_000);

  it("ignores reviewExempt and sources from a Weaver header and gives a normal review block", async () => {
    const { project, actor } = await fixture("hdr-props");
    const text = header({
      type: "concept",
      tags: ["t"],
      reviewExempt: true,
      sources: [{ kind: "url", url: "https://example.test/a" }],
    });
    const viaZip = await importDocumentArchiveEntry(
      getPrisma(),
      entry(project.id, text, { mode: "create" }),
      actor,
    );
    const viaFile = await importDocumentFile(
      getPrisma(),
      { projectId: project.id, folderPath: [], fileName: "p2.md", text },
      actor,
    );
    for (const doc of [viaZip, viaFile]) {
      const meta = await propsOf(project.id, doc.path);
      expect(meta.properties).toEqual({ type: "concept", tags: ["t"] });
      expect(meta.review).not.toBeNull();
      expect(
        await getPrisma().document.findUniqueOrThrow({
          where: { id: doc.id },
        }),
      ).toMatchObject({ reviewExempt: false });
    }
  }, 30_000);

  it("keeps the target's own properties on replace unless the import names mappable ones", async () => {
    const { project, actor } = await fixture("replace-props");
    const db = getPrisma();
    const first = await importDocumentArchiveEntry(
      db,
      entry(
        project.id,
        header({ type: "entity", summary: "keep me", tags: ["x"] }),
        { mode: "create" },
      ),
      actor,
    );
    const plain = await importDocumentArchiveEntry(
      db,
      entry(project.id, "# Props\n\nNew body.\n", {
        mode: "replace",
        documentId: first.id,
        expectedHeadCommitSha: first.headCommitSha,
      }),
      actor,
    );
    expect((await propsOf(project.id, plain.path)).properties).toEqual({
      type: "entity",
      summary: "keep me",
      tags: ["x"],
    });
    const named = await importDocumentArchiveEntry(
      db,
      entry(
        project.id,
        header({ summary: "new summary", reviewExempt: true }),
        {
          mode: "replace",
          documentId: first.id,
          expectedHeadCommitSha: plain.headCommitSha,
        },
      ),
      actor,
    );
    const meta = await propsOf(project.id, named.path);
    expect(meta.properties).toEqual({
      type: "entity",
      summary: "new summary",
      tags: ["x"],
    });
  }, 30_000);

  it("exports the stored properties line in the downloaded archive", async () => {
    const { project, actor } = await fixture("export-props");
    const created = await createDocument(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Exported",
        content: { kind: "markdown", contentJson: BODY("x") },
        properties: { type: "topic", tags: ["e"] },
      },
      actor,
    );
    const { stream } = await createDocumentArchive(
      getPrisma(),
      { projectId: project.id, documentId: created.id },
      actor,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    const md = Object.keys(zip.files).find((name) => name.endsWith(".md"))!;
    const text = await zip.files[md]!.async("string");
    expect(parseDocumentFile(text, "markdown").meta.properties).toEqual({
      type: "topic",
      tags: ["e"],
    });
  }, 30_000);
});

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildDocx,
  PNG_SIGNATURE,
} from "@weaver/artifact-readers/testing/docxFixture";
import { imageReference } from "@weaver/core/documents/imageReferences";
import { assetsPrefixForSlug } from "@weaver/core/documents/images";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { deleteBlob, openUploadSink } from "@weaver/core/ingestion/blobStore";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { createConversation } from "@weaver/core/services/assistantConversations";
import {
  acceptProposal,
  createProposal,
} from "@weaver/core/services/assistantProposals";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import { createArtifactNotebookRunner } from "@weaver/core/services/artifactNotebookJobs";
import { finalizeArtifactUpload } from "@weaver/core/services/artifacts";
import { getDocumentAtSnapshot } from "@weaver/core/services/documents";
import {
  checkImageReferences,
  resolveImageReferences,
} from "@weaver/core/services/documentImageImports";
import { importDocumentFile } from "@weaver/core/services/documentImport";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import { repoDir } from "@weaver/git-store";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const dataDir = process.env.WEAVER_DATA_DIR!;
const png = (marker: number) =>
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, marker]);
const notebookImage = png(1);
const fileImage = png(2);
const notebookAsset = createHash("sha256").update(notebookImage).digest("hex");

type User = Awaited<ReturnType<typeof makeUser>>;

function writer(user: User) {
  return {
    ...createApiKeySecurityContext({
      userId: user.id,
      globalRole: user.role,
      keyId: `key-${user.id}`,
      permissions: { mcp: ["use"], content: ["read", "write"] },
      projectIds: [],
    }),
    name: "Writer",
    email: user.email,
  };
}

async function upload(
  projectId: string,
  user: User,
  filename: string,
  bytes: Buffer,
) {
  const uploadId = randomUUID();
  const sink = await openUploadSink(dataDir, projectId, uploadId, {
    minFreeBytes: 0,
  });
  await sink.write(bytes);
  const { digest, byteSize } = await sink.finish();
  return (
    await finalizeArtifactUpload(
      getPrisma(),
      securityContextFor(user),
      {
        projectId,
        files: [
          {
            uploadId,
            filename,
            contentDigest: digest,
            byteSize,
            replace: false,
          },
        ],
      },
      { dataDir },
    )
  ).artifacts[0]!;
}

/** A prepared notebook whose one page holds one image. */
async function preparedNotebook(projectId: string, user: User) {
  const notebook = await upload(
    projectId,
    user,
    "Ops.onepkg",
    Buffer.from("notebook"),
  );
  const run = createArtifactNotebookRunner({
    db: getPrisma(),
    dataDir,
    runNotebookParser: async ({ outputDir }) => {
      await mkdir(path.join(outputDir, "pages"), { recursive: true });
      await mkdir(path.join(outputDir, "assets"), { recursive: true });
      await writeFile(
        path.join(outputDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          sections: [
            {
              id: "section",
              title: "Section",
              path: [],
              pages: [{ id: "page", title: "Page", level: 0, text: "Shot" }],
              warnings: [],
              content: "parsed",
            },
          ],
          assets: [
            {
              id: notebookAsset,
              byteSize: notebookImage.length,
              contentType: "image/png",
            },
          ],
          warnings: [],
        }),
      );
      await writeFile(
        path.join(outputDir, "pages/page.json"),
        JSON.stringify({
          id: "page",
          sectionId: "section",
          title: "Page",
          level: 0,
          blocks: [{ kind: "image", assetId: notebookAsset, alt: "Shot" }],
          warnings: [],
        }),
      );
      await writeFile(
        path.join(outputDir, "assets", notebookAsset),
        notebookImage,
      );
    },
  });
  await run(
    {
      projectId,
      artifactId: notebook.id,
      contentDigest: notebook.contentDigest,
    },
    { jobId: "test", retryCount: 0, signal: new AbortController().signal },
  );
  return notebook;
}

async function fixture(suffix: string) {
  const db = getPrisma();
  const user = await makeUser("User", `images-${suffix}`);
  const project = await makeProject(`Images ${suffix}`);
  await addMembership(project.id, user.id, "Editor");
  const notebook = await preparedNotebook(project.id, user);
  const file = await upload(project.id, user, "diagram.png", fileImage);
  return { db, user, project, notebook, file, actor: writer(user) };
}

async function committed(projectId: string, relPath: string) {
  return readFile(path.join(repoDir(projectId), relPath));
}

describe("importing images into documents", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  it("copies OneNote and Files images into a new document's assets", async () => {
    const { db, project, notebook, file, actor } = await fixture("create");
    const noteRef = imageReference(notebook.id, notebookAsset);
    const fileRef = imageReference(file.id);
    const result = await applyMcpOperation(db, actor, {
      idempotencyKey: "images-create-0001",
      toolName: "create_document",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        markdown: `Step one:\n\n![Shot](${noteRef})\n\nDiagram:\n\n![Diagram](${fileRef})\n\nAgain:\n\n![Shot](${noteRef})\n`,
      },
      summary: "Import with images",
    });
    const read = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: result.resourceId! },
      actor,
    );
    expect(read.markdown).not.toContain("weaver-image:");
    expect(read.markdown.match(/runbook\.assets\/image\.png/g)).toHaveLength(2);
    expect(read.markdown).toContain("runbook.assets/image-2.png");
    expect(await committed(project.id, "runbook.assets/image.png")).toEqual(
      notebookImage,
    );
    expect(await committed(project.id, "runbook.assets/image-2.png")).toEqual(
      fileImage,
    );
  });

  it("copies a reference written as an img tag and keeps its width", async () => {
    const { db, project, file, actor } = await fixture("width");
    const result = await applyMcpOperation(db, actor, {
      idempotencyKey: "images-width-0001",
      toolName: "create_document",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Sized",
        markdown: `Diagram:\n\n<img src="${imageReference(file.id)}" alt="Diagram &amp; notes" width="300">\n`,
      },
      summary: "Import a sized image",
    });
    const read = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: result.resourceId! },
      actor,
    );
    expect(read.markdown).toBe(
      'Diagram:\n\n<img src="sized.assets/image.png" alt="Diagram &amp; notes" width="300">\n',
    );
    expect(await committed(project.id, "sized.assets/image.png")).toEqual(
      fileImage,
    );
  });

  it("adds images to an existing document without overwriting its images", async () => {
    const { db, project, notebook, file, actor } = await fixture("update");
    const created = await applyMcpOperation(db, actor, {
      idempotencyKey: "images-update-0001",
      toolName: "create_document",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        markdown: `![Diagram](${imageReference(file.id)})\n`,
      },
      summary: "Create",
    });
    const before = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: created.resourceId! },
      actor,
    );
    await applyMcpOperation(db, actor, {
      idempotencyKey: "images-update-0002",
      toolName: "patch_document",
      operation: {
        kind: "document.patch",
        projectId: project.id,
        documentId: created.resourceId!,
        baseCommitSha: before.baseCommitSha,
        actions: [
          {
            action: "append",
            text: `![Shot](${imageReference(notebook.id, notebookAsset)})`,
          },
        ],
      },
      summary: "Add a screenshot",
    });
    const after = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: created.resourceId! },
      actor,
    );
    expect(after.markdown).toContain("guide.assets/image.png");
    expect(after.markdown).toContain("guide.assets/image-2.png");
    expect(await committed(project.id, "guide.assets/image.png")).toEqual(
      fileImage,
    );
    expect(await committed(project.id, "guide.assets/image-2.png")).toEqual(
      notebookImage,
    );
  });

  it("rejects references to files that are not readable images of this project", async () => {
    const { db, user, project, notebook, actor } = await fixture("invalid");
    const other = await makeProject("Images elsewhere");
    await addMembership(other.id, user.id, "Editor");
    const foreign = await upload(other.id, user, "foreign.png", fileImage);
    const text = await upload(project.id, user, "notes.txt", Buffer.from("x"));
    const attempt = (key: string, src: string) =>
      applyMcpOperation(db, actor, {
        idempotencyKey: key,
        toolName: "create_document",
        operation: {
          kind: "document.create",
          projectId: project.id,
          folderPath: [],
          title: `Doc ${key}`,
          markdown: `![x](${src})\n`,
        },
        summary: "Create",
      });
    for (const [key, src, message] of [
      ["foreign-0001", imageReference(foreign.id), "not in this project"],
      ["text-00001", imageReference(text.id), "not a PNG"],
      [
        "asset-0001",
        imageReference(notebook.id, "b".repeat(64)),
        "not an image of this notebook",
      ],
      ["malformed-01", "weaver-image:nope", "not a valid reference"],
    ] as const)
      await expect(attempt(key, src)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining(message),
      });
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      0,
    );
  });

  it("checks image references for a preview without reading their bytes", async () => {
    const { db, project, notebook, file, actor } = await fixture("check");
    const markdown =
      `![Shot](${imageReference(notebook.id, notebookAsset)})\n\n` +
      `![Diagram](${imageReference(file.id)})\n`;
    await deleteBlob(dataDir, project.id, file.contentDigest);
    expect(
      await checkImageReferences(db, actor, {
        projectId: project.id,
        contentJson: parseDocumentBody(markdown),
      }),
    ).toEqual({ images: 2 });
    await expect(
      resolveImageReferences(db, actor, {
        projectId: project.id,
        contentJson: parseDocumentBody(markdown),
        assetsSlug: "doc",
        takenNames: new Set(),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("no longer stored"),
    });
    await expect(
      checkImageReferences(db, actor, {
        projectId: project.id,
        contentJson: parseDocumentBody("![x](weaver-image:nope)\n"),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("not a valid reference"),
    });
  });

  it("copies image references when a Markdown file is imported", async () => {
    const { db, user, project, notebook, file } = await fixture("import");
    const imported = await importDocumentFile(
      db,
      {
        projectId: project.id,
        folderPath: [],
        fileName: "page.md",
        text:
          `# Imported page\n\n![Shot](${imageReference(notebook.id, notebookAsset)})\n\n` +
          `![Diagram](${imageReference(file.id)})\n`,
      },
      { ...securityContextFor(user), name: "Editor", email: user.email },
    );
    expect(
      await committed(project.id, "imported-page.assets/image.png"),
    ).toEqual(notebookImage);
    expect(
      await committed(project.id, "imported-page.assets/image-2.png"),
    ).toEqual(fileImage);
    const read = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: imported.id },
      securityContextFor(user),
    );
    expect(read.markdown).toContain("(imported-page.assets/image.png)");
    expect(read.markdown).toContain("(imported-page.assets/image-2.png)");
    expect(read.markdown).not.toContain("weaver-image:");
  });

  it("lists the images on the proposal card and copies them on acceptance", async () => {
    const { db, user, project, notebook } = await fixture("proposal");
    const actor = {
      ...securityContextFor(user),
      name: "Editor",
      email: user.email,
    };
    const conversation = await createConversation(db, actor, {});
    const { run } = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "import",
      scope: { kind: "project", projectId: project.id },
    });
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Import a page with a screenshot",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Imported page",
        markdown: `![Shot](${imageReference(notebook.id, notebookAsset)})\n`,
      },
    });
    expect(
      (proposal.preview as { lines: Array<{ text: string }> }).lines.map(
        (line) => line.text,
      ),
    ).toContain("Images: 1 copied into the document");
    await acceptProposal(db, actor, proposal.id);
    expect(
      await committed(project.id, "imported-page.assets/image.png"),
    ).toEqual(notebookImage);
  });
});

const SUITE_MAX_FILE_BYTES = process.env.WEAVER_INGESTION_MAX_FILE_BYTES!;

describe("importing images from Word files", () => {
  // The suite-wide 1024-byte upload cap is below any real .docx.
  beforeAll(() => {
    vi.stubEnv("WEAVER_INGESTION_MAX_FILE_BYTES", "1048576");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    expect(process.env.WEAVER_INGESTION_MAX_FILE_BYTES).toBe(
      SUITE_MAX_FILE_BYTES,
    );
  });
  beforeEach(async () => {
    await resetDb();
  });

  const shot = Buffer.concat([PNG_SIGNATURE, Buffer.from("word-shot")]);
  const imageId = createHash("sha256").update(shot).digest("hex");

  async function wordFixture(suffix: string) {
    const user = await makeUser("User", `word-images-${suffix}`);
    const project = await makeProject(`Word images ${suffix}`);
    await addMembership(project.id, user.id, "Editor");
    const docx = await buildDocx({
      images: { rId1: { target: "media/image1.png", bytes: shot } },
      body: [{ type: "paragraph", image: { relId: "rId1", alt: "Menu" } }],
    });
    const artifact = await upload(
      project.id,
      user,
      "manual.docx",
      Buffer.from(docx),
    );
    return { db: getPrisma(), project, artifact, actor: writer(user) };
  }

  const bodyWith = (src: string) => parseDocumentBody(`![Menu](${src})\n`);

  it("copies an image out of a Word file", async () => {
    const { db, project, artifact, actor } = await wordFixture("copy");
    const contentJson = bodyWith(imageReference(artifact.id, imageId));
    expect(
      await checkImageReferences(db, actor, {
        projectId: project.id,
        contentJson,
      }),
    ).toEqual({ images: 1 });
    const resolved = await resolveImageReferences(db, actor, {
      projectId: project.id,
      contentJson,
      assetsSlug: "doc",
      takenNames: new Set(),
    });
    expect(resolved.assets).toHaveLength(1);
    const asset = resolved.assets[0]!;
    expect(Buffer.from(asset.bytes)).toEqual(shot);
    expect(asset.name.endsWith(".png")).toBe(true);
    const rewritten: string[] = [];
    const walk = (node: {
      type?: string;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    }) => {
      if (node.type === "image") rewritten.push(String(node.attrs?.src));
      for (const child of node.content ?? []) walk(child as typeof node);
    };
    walk(resolved.contentJson);
    expect(rewritten).toEqual([`${assetsPrefixForSlug("doc")}${asset.name}`]);
  });

  it("rejects a Word image reference that is not in the file", async () => {
    const { db, project, artifact, actor } = await wordFixture("missing");
    const contentJson = bodyWith(imageReference(artifact.id, "0".repeat(64)));
    const rejection = {
      code: "BAD_REQUEST",
      details: { field: "markdown" },
      message: expect.stringMatching(/ is not an image of this Word file$/),
    };
    await expect(
      checkImageReferences(db, actor, { projectId: project.id, contentJson }),
    ).rejects.toMatchObject(rejection);
    await expect(
      resolveImageReferences(db, actor, {
        projectId: project.id,
        contentJson,
        assetsSlug: "doc",
        takenNames: new Set(),
      }),
    ).rejects.toMatchObject(rejection);
  });

  it("reports a Word file whose content is no longer stored", async () => {
    const { db, project, artifact, actor } = await wordFixture("gone");
    const contentJson = bodyWith(imageReference(artifact.id, imageId));
    await deleteBlob(dataDir, project.id, artifact.contentDigest);
    const rejection = {
      code: "BAD_REQUEST",
      message: expect.stringMatching(/ is no longer stored$/),
    };
    await expect(
      checkImageReferences(db, actor, { projectId: project.id, contentJson }),
    ).rejects.toMatchObject(rejection);
    await expect(
      resolveImageReferences(db, actor, {
        projectId: project.id,
        contentJson,
        assetsSlug: "doc",
        takenNames: new Set(),
      }),
    ).rejects.toMatchObject(rejection);
  });

  it("says a picture may exceed the image size limit when the file has one that does", async () => {
    const user = await makeUser("User", "word-images-oversized");
    const project = await makeProject("Word images oversized");
    await addMembership(project.id, user.id, "Editor");
    const large = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(2048, 7)]);
    const largeId = createHash("sha256").update(large).digest("hex");
    const artifact = await upload(
      project.id,
      user,
      "large.docx",
      Buffer.from(
        await buildDocx({
          images: {
            rId1: { target: "media/image1.png", bytes: shot },
            rId2: { target: "media/image2.png", bytes: large },
          },
        }),
      ),
    );
    const check = (...ids: string[]) =>
      checkImageReferences(getPrisma(), writer(user), {
        projectId: project.id,
        contentJson: parseDocumentBody(
          ids
            .map((id) => `![x](${imageReference(artifact.id, id)})\n`)
            .join("\n"),
        ),
      });
    const previous = process.env.WEAVER_DOCUMENT_IMAGE_MAX_BYTES;
    vi.stubEnv("WEAVER_DOCUMENT_IMAGE_MAX_BYTES", "1024");
    try {
      expect(await check(imageId)).toEqual({ images: 1 });
      for (const id of [largeId, "0".repeat(64)])
        await expect(check(imageId, id)).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringMatching(
            / is not an image of this Word file, or exceeds the document image size limit$/,
          ),
        });
    } finally {
      vi.stubEnv("WEAVER_DOCUMENT_IMAGE_MAX_BYTES", previous);
    }
    expect(await check(imageId, largeId)).toEqual({ images: 2 });
  });

  it("says so when a Word file has too many pictures to search", async () => {
    const user = await makeUser("User", "word-images-many");
    const project = await makeProject("Word images many");
    await addMembership(project.id, user.id, "Editor");
    const extraParts: Record<string, Uint8Array> = {};
    for (let index = 0; index < 500; index += 1)
      extraParts[`word/media/a${String(index).padStart(3, "0")}.png`] =
        Buffer.concat([PNG_SIGNATURE, Buffer.from(`filler-${index}`)]);
    extraParts["word/media/z.png"] = shot;
    const artifact = await upload(
      project.id,
      user,
      "many.docx",
      Buffer.from(await buildDocx({ extraParts })),
    );
    await expect(
      checkImageReferences(getPrisma(), writer(user), {
        projectId: project.id,
        contentJson: bodyWith(imageReference(artifact.id, imageId)),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(
        / could not be located: this Word file has too many or too large pictures$/,
      ),
    });
  });

  it("copies two different images out of the same Word file", async () => {
    const user = await makeUser("User", "word-images-two");
    const project = await makeProject("Word images two");
    await addMembership(project.id, user.id, "Editor");
    const other = Buffer.concat([PNG_SIGNATURE, Buffer.from("second-shot")]);
    const otherId = createHash("sha256").update(other).digest("hex");
    const docx = await buildDocx({
      images: {
        rId1: { target: "media/image1.png", bytes: shot },
        rId2: { target: "media/image2.png", bytes: other },
      },
    });
    const artifact = await upload(
      project.id,
      user,
      "two.docx",
      Buffer.from(docx),
    );
    const resolved = await resolveImageReferences(getPrisma(), writer(user), {
      projectId: project.id,
      contentJson: parseDocumentBody(
        `![A](${imageReference(artifact.id, imageId)})\n\n![B](${imageReference(artifact.id, otherId)})\n`,
      ),
      assetsSlug: "doc",
      takenNames: new Set(),
    });
    expect(resolved.assets.map((asset) => Buffer.from(asset.bytes))).toEqual([
      shot,
      other,
    ]);
  });
});

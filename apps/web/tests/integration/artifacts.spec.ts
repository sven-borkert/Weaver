import { randomUUID } from "node:crypto";
import { readdir, rm, utimes, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blobExists,
  openUploadSink,
  promoteUpload,
} from "@weaver/core/ingestion/blobStore";
import { blobPath, tmpDir } from "@weaver/core/ingestion/paths";
import {
  isBlobReferenced,
  referencedDigests,
  retainedBytes,
} from "@weaver/core/ingestion/blobReferences";
import { sweepAbandonedUploads } from "@weaver/core/jobs/ingestionHandlers";
import {
  createUploadBatch,
  deleteBatch,
  registerUploadedFile,
} from "@weaver/core/services/ingestion";
import {
  deleteArtifact,
  finalizeArtifactUpload,
  getArtifact,
  listArtifacts,
  openArtifactStream,
  renameArtifact,
} from "@weaver/core/services/artifacts";
import { getSessionUser, type SessionUser } from "~/server/auth";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";

const DIGEST_A = "a".repeat(64);
const DATA_DIR = process.env.WEAVER_DATA_DIR!;

async function stage(projectId: string, content: string) {
  const uploadId = randomUUID();
  const sink = await openUploadSink(DATA_DIR, projectId, uploadId, {
    minFreeBytes: 0,
  });
  await sink.write(new TextEncoder().encode(content));
  const { digest, byteSize } = await sink.finish();
  return { uploadId, contentDigest: digest, byteSize };
}

async function storeBlob(projectId: string, content: string) {
  const { uploadId, contentDigest, byteSize } = await stage(projectId, content);
  await promoteUpload(DATA_DIR, projectId, uploadId, contentDigest);
  return { digest: contentDigest, byteSize };
}

async function tmpEntries(projectId: string): Promise<string[]> {
  try {
    return await readdir(tmpDir(DATA_DIR, projectId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function ageBlob(projectId: string, digest: string) {
  const old = new Date(Date.now() - 3 * 3_600_000);
  await utimes(blobPath(DATA_DIR, projectId, digest), old, old);
}

describe("Artifact schema", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects a second artifact with the same filename key in one project", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "schema");
    const project = await makeProject("Artifact schema");
    const data = {
      projectId: project.id,
      filename: "Report.docx",
      filenameKey: "report.docx",
      contentDigest: DIGEST_A,
      byteSize: 10,
      contentType: "application/octet-stream",
      uploadedById: user.id,
    };
    await db.artifact.create({ data });
    await expect(
      db.artifact.create({ data: { ...data, filename: "report.DOCX" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps the artifact when its uploader is deleted", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "schema-gone");
    const project = await makeProject("Artifact uploader");
    const artifact = await db.artifact.create({
      data: {
        projectId: project.id,
        filename: "a.txt",
        filenameKey: "a.txt",
        contentDigest: DIGEST_A,
        byteSize: 1,
        contentType: "text/plain",
        uploadedById: user.id,
      },
    });
    await db.user.delete({ where: { id: user.id } });
    const kept = await db.artifact.findUnique({ where: { id: artifact.id } });
    expect(kept?.uploadedById).toBeNull();
  });
});

describe("blob references shared with Imports", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("counts artifact digests as referenced and as retained bytes", async () => {
    const db = getPrisma();
    const project = await makeProject("Refs");
    const blob = await storeBlob(project.id, "referenced");
    await db.artifact.create({
      data: {
        projectId: project.id,
        filename: "r.txt",
        filenameKey: "r.txt",
        contentDigest: blob.digest,
        byteSize: blob.byteSize,
        contentType: "text/plain",
      },
    });
    expect(await isBlobReferenced(db, project.id, blob.digest)).toBe(true);
    expect(
      await referencedDigests(db, project.id, [blob.digest, "f".repeat(64)]),
    ).toEqual(new Set([blob.digest]));
    expect(await retainedBytes(db, project.id, [])).toBe(BigInt(blob.byteSize));
    expect(
      await retainedBytes(db, project.id, [
        { digest: blob.digest, byteSize: blob.byteSize },
        { digest: "e".repeat(64), byteSize: 5 },
      ]),
    ).toBe(BigInt(blob.byteSize + 5));
  });

  it("keeps an artifact's blob in the orphan sweep and removes an unreferenced one", async () => {
    const db = getPrisma();
    const project = await makeProject("Sweep");
    const kept = await storeBlob(project.id, "kept");
    const orphan = await storeBlob(project.id, "orphan");
    await db.artifact.create({
      data: {
        projectId: project.id,
        filename: "kept.txt",
        filenameKey: "kept.txt",
        contentDigest: kept.digest,
        byteSize: kept.byteSize,
        contentType: "text/plain",
      },
    });
    await ageBlob(project.id, kept.digest);
    await ageBlob(project.id, orphan.digest);

    await sweepAbandonedUploads(db, { dataDir: DATA_DIR, ttlMinutes: 60 });

    expect(await blobExists(DATA_DIR, project.id, kept.digest)).toBe(true);
    expect(await blobExists(DATA_DIR, project.id, orphan.digest)).toBe(false);
  });

  it("keeps a blob an artifact still references when its import batch is deleted", async () => {
    const db = getPrisma();
    const project = await makeProject("Shared digest");
    const member = await makeUser("User", "shared-digest");
    await addMembership(project.id, member.id, "Editor");
    const actor = securityContextFor(member);
    const blob = await storeBlob(project.id, "shared with artifact");

    const { batchId } = await createUploadBatch(db, actor, {
      projectId: project.id,
      origin: "upload",
    });
    await registerUploadedFile(db, actor, {
      batchId,
      fileName: "import.txt",
      mimeType: "text/plain",
      byteSize: blob.byteSize,
      contentDigest: blob.digest,
    });
    await db.artifact.create({
      data: {
        projectId: project.id,
        filename: "kept-artifact.txt",
        filenameKey: "kept-artifact.txt",
        contentDigest: blob.digest,
        byteSize: blob.byteSize,
        contentType: "text/plain",
      },
    });

    const result = await deleteBatch(
      db,
      actor,
      { batchId },
      { dataDir: DATA_DIR },
    );

    expect(result.deletedBlobs).toBe(0);
    expect(await blobExists(DATA_DIR, project.id, blob.digest)).toBe(true);
  });
});

async function members(suffix: string) {
  const project = await makeProject(`Artifacts ${suffix}`);
  const editor = await makeUser("User", `ed-${suffix}`);
  const viewer = await makeUser("User", `vw-${suffix}`);
  const outsider = await makeUser("User", `out-${suffix}`);
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  return {
    project,
    editor: securityContextFor(editor),
    viewer: securityContextFor(viewer),
    outsider: securityContextFor(outsider),
  };
}

const OPTIONS = { dataDir: DATA_DIR };

describe("artifact service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("stores, lists, reads and deletes a file", async () => {
    const db = getPrisma();
    const { project, editor, viewer } = await members("crud");
    const staged = await stage(project.id, "hello");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "Hello.txt", replace: false }],
      },
      OPTIONS,
    );
    expect(artifacts[0]).toMatchObject({
      filename: "Hello.txt",
      contentType: "text/plain",
      byteSize: 5,
    });

    const listed = await listArtifacts(db, viewer, {
      projectId: project.id,
      page: 1,
      pageSize: 25,
      search: "hel",
      sort: "filename",
      dir: "asc",
    });
    expect(listed.total).toBe(1);

    const read = await openArtifactStream(
      db,
      viewer,
      { projectId: project.id, artifactId: artifacts[0]!.id },
      { dataDir: DATA_DIR, maxBytes: 1024 },
    );
    expect(read.size).toBe(5);
    expect(await new Response(read.body).text()).toBe("hello");

    const removed = await deleteArtifact(
      db,
      editor,
      { projectId: project.id, artifactId: artifacts[0]!.id },
      OPTIONS,
    );
    expect(removed.deletedBlob).toBe(true);
    expect(await blobExists(DATA_DIR, project.id, staged.contentDigest)).toBe(
      false,
    );
  });

  it("refuses an existing name without replace, case-insensitively, and stores nothing", async () => {
    const db = getPrisma();
    const { project, editor } = await members("conflict");
    const first = await stage(project.id, "one");
    await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...first, filename: "Plan.md", replace: false }],
      },
      OPTIONS,
    );
    const second = await stage(project.id, "two");
    const other = await stage(project.id, "three");
    await expect(
      finalizeArtifactUpload(
        db,
        editor,
        {
          projectId: project.id,
          files: [
            { ...other, filename: "new.md", replace: false },
            { ...second, filename: "plan.MD", replace: false },
          ],
        },
        OPTIONS,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { conflicts: ["plan.MD"] },
    });
    expect(await db.artifact.count({ where: { projectId: project.id } })).toBe(
      1,
    );
  });

  it("stores a filename whose extension names an Object property", async () => {
    const db = getPrisma();
    const { project, editor } = await members("proto");
    const staged = await stage(project.id, "plain bytes");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "report.constructor", replace: false }],
      },
      OPTIONS,
    );
    expect(artifacts[0]).toMatchObject({
      filename: "report.constructor",
      contentType: "application/octet-stream",
    });
  });

  it("rejects a byte size that is negative, non-integer, or over the column limit", async () => {
    const db = getPrisma();
    const { project, editor } = await members("badsize");
    const staged = await stage(project.id, "x");
    for (const byteSize of [-1, 1.5, 2_147_483_648]) {
      await expect(
        finalizeArtifactUpload(
          db,
          editor,
          {
            projectId: project.id,
            files: [
              { ...staged, byteSize, filename: "bad.txt", replace: false },
            ],
          },
          OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await db.artifact.count({ where: { projectId: project.id } })).toBe(
      0,
    );
  });

  it("replaces content, keeps the id and the original filename, and unlinks the old blob", async () => {
    const db = getPrisma();
    const { project, editor } = await members("replace");
    const first = await stage(project.id, "old");
    const created = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...first, filename: "Plan.md", replace: false }],
      },
      OPTIONS,
    );
    const second = await stage(project.id, "new content");
    const replaced = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...second, filename: "plan.md", replace: true }],
      },
      OPTIONS,
    );
    expect(replaced.artifacts[0]).toMatchObject({
      id: created.artifacts[0]!.id,
      filename: "Plan.md",
      byteSize: 11,
    });
    expect(await blobExists(DATA_DIR, project.id, first.contentDigest)).toBe(
      false,
    );
    expect(await blobExists(DATA_DIR, project.id, second.contentDigest)).toBe(
      true,
    );
  });

  it("keeps a blob that another artifact still references", async () => {
    const db = getPrisma();
    const { project, editor } = await members("shared");
    const a = await stage(project.id, "same");
    const b = await stage(project.id, "same");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [
          { ...a, filename: "a.txt", replace: false },
          { ...b, filename: "b.txt", replace: false },
        ],
      },
      OPTIONS,
    );
    const removed = await deleteArtifact(
      db,
      editor,
      { projectId: project.id, artifactId: artifacts[0]!.id },
      OPTIONS,
    );
    expect(removed.deletedBlob).toBe(false);
    expect(await blobExists(DATA_DIR, project.id, a.contentDigest)).toBe(true);
  });

  it("rejects a rename whose recognized format contradicts the blob", async () => {
    const db = getPrisma();
    const { project, editor } = await members("rename-magic");
    const staged = await stage(project.id, "plain bytes");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "blob.bin", replace: false }],
      },
      OPTIONS,
    );
    await expect(
      renameArtifact(db, editor, {
        projectId: project.id,
        artifactId: artifacts[0]!.id,
        filename: "fake.pdf",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (
        await getArtifact(db, editor, {
          projectId: project.id,
          artifactId: artifacts[0]!.id,
        })
      ).filename,
    ).toBe("blob.bin");
  });

  it("renames, re-derives the content type, and refuses a taken name", async () => {
    const db = getPrisma();
    const { project, editor } = await members("rename");
    const one = await stage(project.id, "{}");
    const two = await stage(project.id, "x");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [
          { ...one, filename: "data.txt", replace: false },
          { ...two, filename: "taken.txt", replace: false },
        ],
      },
      OPTIONS,
    );
    const renamed = await renameArtifact(db, editor, {
      projectId: project.id,
      artifactId: artifacts[0]!.id,
      filename: "data.json",
    });
    expect(renamed).toMatchObject({
      filename: "data.json",
      contentType: "application/json",
    });
    await expect(
      renameArtifact(db, editor, {
        projectId: project.id,
        artifactId: artifacts[0]!.id,
        filename: "TAKEN.txt",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      renameArtifact(db, editor, {
        projectId: "not-a-uuid",
        artifactId: artifacts[0]!.id,
        filename: "elsewhere.txt",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      renameArtifact(db, editor, {
        projectId: project.id,
        artifactId: "not-a-uuid",
        filename: "elsewhere.txt",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces roles: viewer reads, only editor writes, outsider sees nothing", async () => {
    const db = getPrisma();
    const { project, editor, viewer, outsider } = await members("roles");
    const staged = await stage(project.id, "r");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "r.txt", replace: false }],
      },
      OPTIONS,
    );
    const id = { projectId: project.id, artifactId: artifacts[0]!.id };
    await expect(getArtifact(db, viewer, id)).resolves.toMatchObject({
      filename: "r.txt",
    });
    await expect(deleteArtifact(db, viewer, id, OPTIONS)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await expect(
      renameArtifact(db, viewer, { ...id, filename: "x.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getArtifact(db, outsider, id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      listArtifacts(db, outsider, {
        projectId: project.id,
        page: 1,
        pageSize: 25,
        sort: "filename",
        dir: "asc",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects an upload that would exceed the shared project quota", async () => {
    const db = getPrisma();
    const { project, editor } = await members("quota");
    const staged = await stage(project.id, "0123456789");
    await expect(
      finalizeArtifactUpload(
        db,
        editor,
        {
          projectId: project.id,
          files: [{ ...staged, filename: "big.txt", replace: false }],
        },
        { dataDir: DATA_DIR, projectQuotaBytes: 5 },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db.artifact.count()).toBe(0);
  });

  it("reports missing bytes instead of failing with a filesystem error", async () => {
    const db = getPrisma();
    const { project, editor } = await members("bytes");
    const artifact = await db.artifact.create({
      data: {
        projectId: project.id,
        filename: "gone.txt",
        filenameKey: "gone.txt",
        contentDigest: "d".repeat(64),
        byteSize: 1,
        contentType: "text/plain",
      },
    });
    await expect(
      openArtifactStream(
        db,
        editor,
        { projectId: project.id, artifactId: artifact.id },
        { dataDir: DATA_DIR, maxBytes: 1024 },
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "file content is no longer stored",
    });
  });

  it("reports stored bytes whose digest no longer matches as missing", async () => {
    const db = getPrisma();
    const { project, editor } = await members("tampered");
    const staged = await stage(project.id, "original bytes");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "orig.txt", replace: false }],
      },
      OPTIONS,
    );
    await writeFile(
      blobPath(DATA_DIR, project.id, staged.contentDigest),
      "different bytes entirely, of another length",
    );

    await expect(
      openArtifactStream(
        db,
        editor,
        { projectId: project.id, artifactId: artifacts[0]!.id },
        { dataDir: DATA_DIR, maxBytes: 1024 },
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "file content is no longer stored",
    });
  });

  it("fails the stream at its end when same-length bytes no longer match the digest", async () => {
    const db = getPrisma();
    const { project, editor } = await members("tampered-len");
    const staged = await stage(project.id, "original bytes");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "orig.txt", replace: false }],
      },
      OPTIONS,
    );
    await writeFile(
      blobPath(DATA_DIR, project.id, staged.contentDigest),
      "tampered bytes",
    );

    const opened = await openArtifactStream(
      db,
      editor,
      { projectId: project.id, artifactId: artifacts[0]!.id },
      { dataDir: DATA_DIR, maxBytes: 1024 },
    );
    expect(opened.size).toBe(staged.byteSize);
    await expect(new Response(opened.body).text()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "file content is no longer stored",
    });
  });

  it("refuses a file above the read limit before streaming", async () => {
    const db = getPrisma();
    const { project, editor } = await members("limit");
    const staged = await stage(project.id, "twelve bytes");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "big.txt", replace: false }],
      },
      OPTIONS,
    );
    await expect(
      openArtifactStream(
        db,
        editor,
        { projectId: project.id, artifactId: artifacts[0]!.id },
        { dataDir: DATA_DIR, maxBytes: 5 },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("artifact router", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists with defaults, renames and deletes through tRPC with core error mapping", async () => {
    const db = getPrisma();
    const project = await makeProject("Router");
    const editorUser = await makeUser("User", "router-ed");
    const viewerUser = await makeUser("User", "router-vw");
    await addMembership(project.id, editorUser.id, "Editor");
    await addMembership(project.id, viewerUser.id, "Viewer");
    const staged = await stage(project.id, "router");
    await finalizeArtifactUpload(
      db,
      securityContextFor(editorUser),
      {
        projectId: project.id,
        files: [{ ...staged, filename: "r.txt", replace: false }],
      },
      OPTIONS,
    );

    const viewer = callerFor(viewerUser);
    const listed = await viewer.artifact.list({ projectId: project.id });
    expect(listed.items.map((item) => item.filename)).toEqual(["r.txt"]);
    await expect(
      viewer.artifact.delete({
        projectId: project.id,
        artifactId: listed.items[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const editor = callerFor(editorUser);
    const renamed = await editor.artifact.rename({
      projectId: project.id,
      artifactId: listed.items[0]!.id,
      filename: "renamed.txt",
    });
    expect(renamed.filename).toBe("renamed.txt");
    await editor.artifact.delete({
      projectId: project.id,
      artifactId: renamed.id,
    });
    expect((await viewer.artifact.list({ projectId: project.id })).total).toBe(
      0,
    );
  });
});

async function sessionCookieFor(email: string): Promise<string> {
  const response = await testAuth().api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    asResponse: true,
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  expect(cookie).toMatch(/session_token=/);
  return cookie!;
}

async function resolveTestSession(
  headers: Headers,
): Promise<SessionUser | null> {
  const session = await testAuth().api.getSession({ headers });
  if (!session || session.user.banned) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === "Admin" ? "Admin" : "User",
    sessionId: session.session.id,
    mustChangePassword: session.user.mustChangePassword === true,
  };
}

type ArtifactUploadRoute = (
  req: Request,
  ctx: { params: Promise<{ projectId: string }> },
) => Promise<Response>;

function artifactForm(
  projectId: string,
  files: File[],
  replace: string[] = [],
) {
  const form = new FormData();
  form.set("projectId", projectId);
  for (const name of replace) form.append("replace", name);
  for (const file of files) form.append("file", file);
  return form;
}

function uploadCall(
  projectId: string,
  body: FormData,
  cookie?: string,
  origin: string | null = "http://localhost:3000",
) {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  return [
    new Request(`http://localhost:3000/api/projects/${projectId}/artifacts`, {
      method: "POST",
      headers,
      body,
    }),
    { params: Promise.resolve({ projectId }) },
  ] as const;
}

type DownloadRoute = (
  req: Request,
  ctx: { params: Promise<{ projectId: string; artifactId: string }> },
) => Promise<Response>;

describe("GET /api/projects/{projectId}/artifacts/{artifactId}/download", () => {
  let route: DownloadRoute;
  beforeEach(async () => {
    await resetDb();
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
    route = (
      await import("~/app/api/projects/[projectId]/artifacts/[artifactId]/download/route")
    ).GET as unknown as DownloadRoute;
  });
  afterEach(() => {
    vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null));
  });

  const call = (
    projectId: string,
    artifactId: string,
    cookie?: string,
    extra: Record<string, string> = {},
  ) =>
    [
      new Request(
        `http://localhost:3000/api/projects/${projectId}/artifacts/${artifactId}/download`,
        {
          headers: { ...(cookie ? { cookie } : {}), ...extra },
        },
      ),
      { params: Promise.resolve({ projectId, artifactId }) },
    ] as const;

  it("HEAD returns metadata without exhausting download slots", async () => {
    const db = getPrisma();
    const { project, editor } = await members("head");
    const viewer = await makeUser("User", "head-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    const staged = await stage(project.id, "head bytes");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "head.txt", replace: false }],
      },
      OPTIONS,
    );
    const cookie = await sessionCookieFor(viewer.email);
    const routeModule =
      await import("~/app/api/projects/[projectId]/artifacts/[artifactId]/download/route");
    const head = (routeModule as unknown as { HEAD?: DownloadRoute }).HEAD;
    expect(head).toBeTypeOf("function");
    for (let i = 0; i < 6; i++) {
      const response = await head!(
        ...call(project.id, artifacts[0]!.id, cookie),
      );
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(response.headers.get("content-length")).toBe("10");
    }
    const response = await route(...call(project.id, artifacts[0]!.id, cookie));
    expect(await response.text()).toBe("head bytes");
  });

  it("serves the bytes to a Viewer as an attachment with safe headers and an etag", async () => {
    const db = getPrisma();
    const { project, editor } = await members("dl");
    const viewerUser = await makeUser("User", "dl-viewer");
    await addMembership(project.id, viewerUser.id, "Viewer");
    const staged = await stage(project.id, "download me");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "Bericht.pdf.txt", replace: false }],
      },
      OPTIONS,
    );
    const cookie = await sessionCookieFor(viewerUser.email);

    const response = await route(...call(project.id, artifacts[0]!.id, cookie));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("download me");
    expect(response.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    const etag = response.headers.get("etag")!;
    expect(etag).toBe(`"${staged.contentDigest}"`);

    const cached = await route(
      ...call(project.id, artifacts[0]!.id, cookie, { "if-none-match": etag }),
    );
    expect(cached.status).toBe(304);
  });

  it("answers 404 to outsiders and unknown ids, 401 to anonymous", async () => {
    const db = getPrisma();
    const { project, editor } = await members("dl-acc");
    const outsiderUser = await makeUser("User", "dl-out");
    const staged = await stage(project.id, "secret");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "s.txt", replace: false }],
      },
      OPTIONS,
    );
    expect((await route(...call(project.id, artifacts[0]!.id))).status).toBe(
      401,
    );
    const cookie = await sessionCookieFor(outsiderUser.email);
    expect(
      (await route(...call(project.id, artifacts[0]!.id, cookie))).status,
    ).toBe(404);
    expect(
      (await route(...call(project.id, "not-a-uuid", cookie))).status,
    ).toBe(404);
  });

  it("answers 304 from the stored digest without touching the blob", async () => {
    const db = getPrisma();
    const { project, editor } = await members("dl-304");
    const editorUser = await db.user.findFirstOrThrow({
      where: { id: editor.userId },
    });
    const staged = await stage(project.id, "cached bytes");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "c.txt", replace: false }],
      },
      OPTIONS,
    );
    await rm(blobPath(DATA_DIR, project.id, staged.contentDigest));
    const cookie = await sessionCookieFor(editorUser.email);

    const cached = await route(
      ...call(project.id, artifacts[0]!.id, cookie, {
        "if-none-match": `"${staged.contentDigest}"`,
      }),
    );
    expect(cached.status).toBe(304);
    expect(
      (await route(...call(project.id, artifacts[0]!.id, cookie))).status,
    ).toBe(404);
  });

  it("streams a multi-chunk body byte-equal with an exact content-length", async () => {
    const db = getPrisma();
    const { project, editor } = await members("dl-stream");
    const editorUser = await db.user.findFirstOrThrow({
      where: { id: editor.userId },
    });
    const content = "x".repeat(3 * 1024 * 1024 + 7);
    const staged = await stage(project.id, content);
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "large.bin", replace: false }],
      },
      OPTIONS,
    );
    const cookie = await sessionCookieFor(editorUser.email);

    const response = await route(...call(project.id, artifacts[0]!.id, cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(content.length));
    expect(response.body).toBeInstanceOf(ReadableStream);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(content.length);
    expect(bytes.equals(Buffer.from(content))).toBe(true);
  });

  it("releases downloads aborted while the blob is opening", async () => {
    const { project, editor } = await members("dl-preabort");
    const user = await getPrisma().user.findUniqueOrThrow({
      where: { id: editor.userId },
    });
    const cookie = await sessionCookieFor(user.email);
    const staged = await stage(project.id, "aborted");
    const { artifacts } = await finalizeArtifactUpload(
      getPrisma(),
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "abort.txt", replace: false }],
      },
      OPTIONS,
    );
    const service = await import("@weaver/core/services/artifacts");
    const original = service.openArtifactStream;
    for (let index = 0; index < 5; index++) {
      const abort = new AbortController();
      const spy = vi
        .spyOn(service, "openArtifactStream")
        .mockImplementationOnce(async (...args) => {
          const opened = await original(...args);
          abort.abort();
          return opened;
        });
      try {
        const [request, ctx] = call(project.id, artifacts[0]!.id, cookie);
        const response = await route(
          new Request(request, { signal: abort.signal }),
          ctx,
        );
        expect(response.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    }
    const response = await route(...call(project.id, artifacts[0]!.id, cookie));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("aborted");
  });

  it("caps in-flight downloads per user and frees the slot once a body is drained or cancelled", async () => {
    const db = getPrisma();
    const { project, editor } = await members("dl-cap");
    const editorUser = await db.user.findFirstOrThrow({
      where: { id: editor.userId },
    });
    const staged = await stage(project.id, "capped");
    const { artifacts } = await finalizeArtifactUpload(
      db,
      editor,
      {
        projectId: project.id,
        files: [{ ...staged, filename: "cap.txt", replace: false }],
      },
      OPTIONS,
    );
    const cookie = await sessionCookieFor(editorUser.email);
    const open = () => route(...call(project.id, artifacts[0]!.id, cookie));

    const held = await Promise.all([open(), open(), open(), open()]);
    expect(held.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    const fifth = await open();
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("retry-after")).toBe("15");

    expect(await held[0]!.text()).toBe("capped");
    const afterDrain = await open();
    expect(afterDrain.status).toBe(200);
    expect((await open()).status).toBe(429);

    await afterDrain.body!.cancel();
    for (const response of held.slice(1)) await response.body!.cancel();
    const afterCancel = await open();
    expect(afterCancel.status).toBe(200);
    expect(await afterCancel.text()).toBe("capped");
  });
});

describe("POST /api/projects/{projectId}/artifacts", () => {
  let route: ArtifactUploadRoute;

  beforeEach(async () => {
    await resetDb();
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
    route = (await import("~/app/api/projects/[projectId]/artifacts/route"))
      .POST as unknown as ArtifactUploadRoute;
  });
  afterEach(() => {
    vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null));
  });

  it("stores several files of any type for an Editor", async () => {
    const db = getPrisma();
    const project = await makeProject("Upload ok");
    const editor = await makeUser("User", "up-ed");
    await addMembership(project.id, editor.id, "Editor");
    const cookie = await sessionCookieFor(editor.email);
    const response = await route(
      ...uploadCall(
        project.id,
        artifactForm(project.id, [
          new File(['{"a":1}'], "data.json", { type: "application/json" }),
          new File(["plain"], "notes.unknownext"),
        ]),
        cookie,
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      artifacts: Array<{ filename: string; contentType: string }>;
    };
    expect(body.artifacts.map((a) => [a.filename, a.contentType])).toEqual([
      ["data.json", "application/json"],
      ["notes.unknownext", "application/octet-stream"],
    ]);
    expect(await db.artifact.count({ where: { projectId: project.id } })).toBe(
      2,
    );
  });

  it("answers 409 with the conflicting names and replaces only when told to", async () => {
    const project = await makeProject("Upload replace");
    const editor = await makeUser("User", "up-rep");
    await addMembership(project.id, editor.id, "Editor");
    const cookie = await sessionCookieFor(editor.email);
    const file = () => new File(["v1"], "plan.md", { type: "text/markdown" });
    expect(
      (
        await route(
          ...uploadCall(project.id, artifactForm(project.id, [file()]), cookie),
        )
      ).status,
    ).toBe(201);

    const conflict = await route(
      ...uploadCall(project.id, artifactForm(project.id, [file()]), cookie),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ conflicts: ["plan.md"] });

    const replaced = await route(
      ...uploadCall(
        project.id,
        artifactForm(
          project.id,
          [new File(["v2 longer"], "plan.md")],
          ["plan.md"],
        ),
        cookie,
      ),
    );
    expect(replaced.status).toBe(201);
  });

  it("rejects bytes that contradict the extension and leaves nothing staged", async () => {
    const db = getPrisma();
    const project = await makeProject("Upload sniff");
    const editor = await makeUser("User", "up-sniff");
    await addMembership(project.id, editor.id, "Editor");
    const cookie = await sessionCookieFor(editor.email);
    const response = await route(
      ...uploadCall(
        project.id,
        artifactForm(project.id, [
          new File(["not a zip at all, just text"], "fake.docx"),
        ]),
        cookie,
      ),
    );
    expect(response.status).toBe(415);
    expect(await db.artifact.count()).toBe(0);
    expect(await tmpEntries(project.id)).toEqual([]);
  });

  it("refuses viewers, outsiders, anonymous and cross-origin requests, and a mismatched projectId", async () => {
    const project = await makeProject("Upload access");
    const other = await makeProject("Upload other");
    const editor = await makeUser("User", "up-acc-ed");
    const viewer = await makeUser("User", "up-acc-vw");
    const outsider = await makeUser("User", "up-acc-out");
    await addMembership(project.id, editor.id, "Editor");
    await addMembership(other.id, editor.id, "Editor");
    await addMembership(project.id, viewer.id, "Viewer");
    const form = () => artifactForm(project.id, [new File(["x"], "x.txt")]);
    expect((await route(...uploadCall(project.id, form()))).status).toBe(401);
    expect(
      (
        await route(
          ...uploadCall(
            project.id,
            form(),
            await sessionCookieFor(viewer.email),
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await route(
          ...uploadCall(
            project.id,
            form(),
            await sessionCookieFor(outsider.email),
          ),
        )
      ).status,
    ).toBe(404);
    const editorCookie = await sessionCookieFor(editor.email);
    expect(
      (
        await route(
          ...uploadCall(
            project.id,
            form(),
            editorCookie,
            "https://evil.example",
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (await route(...uploadCall(other.id, form(), editorCookie))).status,
    ).toBe(400);
  });
});

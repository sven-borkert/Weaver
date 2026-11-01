import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  symlink,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { reserveUpload } from "@weaver/core/ingestion/uploadReservations";
import { retainedBytes } from "@weaver/core/ingestion/blobReferences";
import { openUploadSink } from "@weaver/core/ingestion/blobStore";
import { blobPath } from "@weaver/core/ingestion/paths";
import {
  NOTEBOOK_RETRY_COOLDOWN_MS,
  type NotebookManifest,
} from "@weaver/core/artifacts/notebookSchema";
import { notebookClaimDir } from "@weaver/core/artifacts/notebookStorage";
import { withProjectIngestionLifecycleLock } from "@weaver/core/services/ingestion";
import {
  finalizeArtifactUpload,
  deleteArtifact,
  renameArtifact,
} from "@weaver/core/services/artifacts";
import {
  getArtifactNotebook,
  prepareArtifactNotebook,
  listArtifactNotebookPages,
  readArtifactNotebookPage,
  readArtifactNotebookAsset,
} from "@weaver/core/services/artifactNotebooks";
import {
  createArtifactNotebookRunner,
  reconcileArtifactNotebooks,
} from "@weaver/core/services/artifactNotebookJobs";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const dataDir = process.env.WEAVER_DATA_DIR!;
const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
/** Backdates the failure so a retry is outside the cooldown. */
async function coolDown(db: ReturnType<typeof getPrisma>, artifactId: string) {
  await db.artifactNotebook.update({
    where: { artifactId },
    data: {
      updatedAt: new Date(Date.now() - NOTEBOOK_RETRY_COOLDOWN_MS - 60_000),
    },
  });
}
const assetId = createHash("sha256").update(image).digest("hex");
async function snapshot({ outputDir }: { outputDir: string }) {
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
          path: ["Notebook"],
          pages: [
            { id: "page", title: "A page", level: 0, text: "Grüße needle" },
          ],
          warnings: [],
          content: "parsed",
        },
      ],
      assets: [
        { id: assetId, byteSize: image.length, contentType: "image/png" },
      ],
      warnings: [],
    }),
  );
  await writeFile(
    path.join(outputDir, "pages/page.json"),
    JSON.stringify({
      id: "page",
      sectionId: "section",
      title: "A page",
      level: 0,
      blocks: [
        { kind: "text", text: "Grüße needle" },
        { kind: "image", assetId, alt: "A picture" },
      ],
      warnings: [],
    }),
  );
  await writeFile(path.join(outputDir, "assets", assetId), image);
}
async function fixture() {
  const db = getPrisma();
  const editor = await makeUser("User", "notebook-editor");
  const viewer = await makeUser("User", "notebook-viewer");
  const outsider = await makeUser("Admin", "notebook-outsider");
  const project = await makeProject("Notebook");
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  const actor = securityContextFor(editor);
  async function upload(content = "original") {
    const uploadId = randomUUID();
    const sink = await openUploadSink(dataDir, project.id, uploadId, {
      minFreeBytes: 0,
    });
    await sink.write(Buffer.from(content));
    const { digest, byteSize } = await sink.finish();
    return (
      await finalizeArtifactUpload(
        db,
        actor,
        {
          projectId: project.id,
          files: [
            {
              uploadId,
              filename: "Notebook.onepkg",
              contentDigest: digest,
              byteSize,
              replace: true,
            },
          ],
        },
        { dataDir },
      )
    ).artifacts[0]!;
  }
  const queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  const artifact = await upload();
  const input = { projectId: project.id, artifactId: artifact.id };
  const run = createArtifactNotebookRunner({
    db,
    dataDir,
    runNotebookParser: snapshot,
  });
  const delivery = {
    jobId: "test",
    retryCount: 0,
    signal: new AbortController().signal,
  };
  const payload = { ...input, contentDigest: artifact.contentDigest };
  return {
    db,
    actor,
    viewer: securityContextFor(viewer),
    outsider: securityContextFor(outsider),
    project,
    artifact,
    input,
    queue,
    run,
    delivery,
    payload,
    upload,
  };
}

describe("Durable artifact notebooks", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));
  it("returns a committed replacement and cleans old blobs when enqueue fails", async () => {
    const f = await fixture();
    class UnavailableQueue extends FakeJobQueue {
      override async send(): Promise<string | null> {
        throw new Error("queue unavailable");
      }
    }
    setJobQueueForTests(new UnavailableQueue());
    const replacement = await f.upload("replacement during outage");
    expect(replacement.id).toBe(f.artifact.id);
    expect(replacement.contentDigest).not.toBe(f.artifact.contentDigest);
    expect(
      await f.db.artifactNotebook.findUnique({
        where: { artifactId: replacement.id },
      }),
    ).toMatchObject({
      status: "queued",
      contentDigest: replacement.contentDigest,
    });
    await expect(
      stat(blobPath(dataDir, f.project.id, f.artifact.contentDigest)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails preparation without publishing a snapshot above the quota", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    const run = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: snapshot,
      projectQuotaBytes: 10,
    });
    await run(f.payload, f.delivery);
    expect(
      await f.db.artifactNotebook.findUnique({
        where: { artifactId: f.artifact.id },
      }),
    ).toMatchObject({
      status: "failed",
      error: "quota_exceeded",
      snapshotBytes: 0n,
    });
    expect(await retainedBytes(f.db, f.project.id, [])).toBe(
      BigInt(f.artifact.byteSize),
    );
  });

  it("leaves capacity reserved by an active upload available to that upload", async () => {
    const f = await fixture();
    const quota = 10000;
    const reservation = await reserveUpload(f.db, {
      userId: f.actor.userId,
      projectId: f.project.id,
      declaredBytes: quota - f.artifact.byteSize,
      quotaBytes: quota,
    });
    try {
      await prepareArtifactNotebook(f.db, f.viewer, f.input);
      const run = createArtifactNotebookRunner({
        db: f.db,
        dataDir,
        runNotebookParser: snapshot,
        projectQuotaBytes: quota,
      });
      await run(f.payload, f.delivery);
      expect(
        await f.db.artifactNotebook.findUnique({
          where: { artifactId: f.artifact.id },
        }),
      ).toMatchObject({
        status: "failed",
        error: "quota_exceeded",
        snapshotBytes: 0n,
      });
    } finally {
      await reservation.release();
    }
  });

  it("queues preparation on upload, prepares once and rejects invisible resources before reading state", async () => {
    const f = await fixture();
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "queued",
    );
    expect(
      await f.db.artifactNotebook.findUnique({
        where: { artifactId: f.artifact.id },
      }),
    ).toMatchObject({ requestedById: f.actor.userId, finishedAt: null });
    const states = await Promise.all([
      prepareArtifactNotebook(f.db, f.viewer, f.input),
      prepareArtifactNotebook(f.db, f.viewer, f.input),
    ]);
    expect(states.map((s) => s.status)).toEqual(["queued", "queued"]);
    expect(
      f.queue.jobs.filter((j) => j.name === "artifact.notebook.prepare"),
    ).toHaveLength(1);
    await expect(
      getArtifactNotebook(f.db, f.outsider, f.input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("publishes validated pages, search and images and gates every read on revision", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    await f.run(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "ready",
    );
    const input = { ...f.input, contentDigest: f.artifact.contentDigest };
    expect(
      await listArtifactNotebookPages(f.db, f.viewer, {
        ...input,
        query: "NEEDLE",
      }),
    ).toMatchObject({
      total: 1,
      items: [{ id: "page", sectionId: "section" }],
    });
    expect(
      await listArtifactNotebookPages(f.db, f.viewer, {
        ...input,
        query: "NEEDLE",
        matchCase: true,
      }),
    ).toMatchObject({ total: 0 });
    expect(
      (
        await readArtifactNotebookPage(f.db, f.viewer, {
          ...input,
          pageId: "page",
        })
      ).blocks[0],
    ).toEqual({ kind: "text", text: "Grüße needle" });
    expect(
      (await readArtifactNotebookAsset(f.db, f.viewer, { ...input, assetId }))
        .bytes,
    ).toEqual(image);
    await expect(
      readArtifactNotebookPage(f.db, f.outsider, { ...input, pageId: "page" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      readArtifactNotebookPage(f.db, f.viewer, {
        ...input,
        pageId: "../manifest",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await f.upload("replacement");
    await expect(
      readArtifactNotebookPage(f.db, f.viewer, { ...input, pageId: "page" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "queued",
    );
  });
  it("fences an in-flight parser after replacement", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    const run = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: async (args) => {
        await snapshot(args);
        await f.upload("new bytes");
        await prepareArtifactNotebook(f.db, f.viewer, f.input);
      },
    });
    await run(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "queued",
    );
    const state = await f.db.artifactNotebook.findUniqueOrThrow({
      where: { artifactId: f.artifact.id },
    });
    expect(state.contentDigest).not.toBe(f.artifact.contentDigest);
  });
  it("persists a safe failed state for invalid output and supports explicit retry", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    const run = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: async () => {
        throw new Error("secret source content");
      },
    });
    await run(f.payload, f.delivery);
    expect(await getArtifactNotebook(f.db, f.viewer, f.input)).toMatchObject({
      status: "failed",
      error: "parse_failed",
    });
    // The fake queue keeps completed jobs and would dedupe the singleton key.
    f.queue.jobs.splice(0);
    // Inside the cooldown a retry is refused, says when it is allowed, and
    // queues nothing.
    const refused = await prepareArtifactNotebook(f.db, f.viewer, {
      ...f.input,
      retry: true,
    });
    expect(refused).toMatchObject({
      status: "failed",
      error: "parse_failed",
      retryRefused: true,
    });
    expect(Date.parse(refused.retryAllowedAt!)).toBeGreaterThan(Date.now());
    expect(f.queue.jobs).toHaveLength(0);
    expect(
      await prepareArtifactNotebook(f.db, f.viewer, {
        ...f.input,
        retry: true,
      }),
    ).toMatchObject({ status: "failed", retryRefused: true });
    await coolDown(f.db, f.artifact.id);
    expect(
      (await getArtifactNotebook(f.db, f.viewer, f.input)).retryAllowedAt,
    ).toBeNull();
    const accepted = await prepareArtifactNotebook(f.db, f.viewer, {
      ...f.input,
      retry: true,
    });
    expect(accepted).toMatchObject({
      status: "queued",
      retryRefused: false,
      retryAllowedAt: null,
    });
    expect(f.queue.jobs).toHaveLength(1);
    await f.run(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "ready",
    );
  });
  it("answers a current notebook without waiting for the lifecycle lock", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    await f.run(f.payload, f.delivery);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withProjectIngestionLifecycleLock(
      f.db,
      f.project.id,
      async () => {
        entered();
        await held;
      },
    );
    await holding;
    try {
      const overview = await Promise.race([
        prepareArtifactNotebook(f.db, f.viewer, f.input),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("prepare waited for the lifecycle lock")),
            5_000,
          ),
        ),
      ]);
      expect(overview.status).toBe("ready");
      expect(overview.sections).toHaveLength(1);
    } finally {
      release();
      await holder;
    }
  });
  it("counts a ready snapshot against the project's retained bytes", async () => {
    const f = await fixture();
    expect(await retainedBytes(f.db, f.project.id, [])).toBe(
      BigInt(f.artifact.byteSize),
    );
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    await f.run(f.payload, f.delivery);
    const state = await f.db.artifactNotebook.findUniqueOrThrow({
      where: { artifactId: f.artifact.id },
    });
    expect(state.status).toBe("ready");
    expect(state.snapshotBytes).toBeGreaterThan(0n);
    expect(await retainedBytes(f.db, f.project.id, [])).toBe(
      BigInt(f.artifact.byteSize) + state.snapshotBytes,
    );
    // An explicitly empty exclusion list (the upload path) must not throw.
    expect(
      await retainedBytes(
        f.db,
        f.project.id,
        [{ digest: "e".repeat(64), byteSize: 5 }],
        [],
      ),
    ).toBe(BigInt(f.artifact.byteSize) + state.snapshotBytes + 5n);
    // A replaced artifact's notebook is excluded the way its old blob is.
    expect(await retainedBytes(f.db, f.project.id, [], [f.artifact.id])).toBe(
      0n,
    );
    // A lost snapshot no longer counts.
    const dir = notebookClaimDir(
      dataDir,
      f.project.id,
      f.artifact.id,
      state.contentDigest,
      state.parserVersion,
      state.claimToken!,
    );
    await rm(path.join(dir, "manifest.json"));
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "failed",
    );
    expect(await retainedBytes(f.db, f.project.id, [])).toBe(
      BigInt(f.artifact.byteSize),
    );
  });
  it("isolates a failing re-dispatch so the other rows and the sweep still run", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    const uploadId = randomUUID();
    const sink = await openUploadSink(dataDir, f.project.id, uploadId, {
      minFreeBytes: 0,
    });
    await sink.write(Buffer.from("second notebook"));
    const staged = await sink.finish();
    const second = (
      await finalizeArtifactUpload(
        f.db,
        f.actor,
        {
          projectId: f.project.id,
          files: [
            {
              uploadId,
              filename: "Second.onepkg",
              contentDigest: staged.digest,
              byteSize: staged.byteSize,
              replace: false,
            },
          ],
        },
        { dataDir },
      )
    ).artifacts[0]!;
    await prepareArtifactNotebook(f.db, f.viewer, {
      projectId: f.project.id,
      artifactId: second.id,
    });
    const junk = path.join(
      dataDir,
      "notebooks",
      f.project.id,
      f.artifact.id,
      "junk",
    );
    await mkdir(junk, { recursive: true });
    class ThrowingQueue extends FakeJobQueue {
      override async send(
        ...args: Parameters<FakeJobQueue["send"]>
      ): Promise<string | null> {
        if ((args[1] as { artifactId?: string }).artifactId === f.artifact.id)
          throw new Error("publication failed");
        return super.send(...args);
      }
    }
    const queue = new ThrowingQueue();
    setJobQueueForTests(queue);
    await expect(
      reconcileArtifactNotebooks(f.db, { dataDir }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === 1 &&
        (error.errors[0] as Error).message === "publication failed",
    );
    expect(
      queue.jobs.filter((job) => job.name === "artifact.notebook.prepare"),
    ).toEqual([
      {
        name: "artifact.notebook.prepare",
        data: {
          projectId: f.project.id,
          artifactId: second.id,
          contentDigest: second.contentDigest,
        },
      },
    ]);
    expect(await readdir(path.dirname(junk)).catch(() => [])).toEqual([]);
  });
  it("rejects symlinked parser output and never publishes an empty manifest", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    const run = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: async (args) => {
        await snapshot(args);
        await symlink("/etc/passwd", path.join(args.outputDir, "outside"));
      },
    });
    await run(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "failed",
    );
    await coolDown(f.db, f.artifact.id);
    await prepareArtifactNotebook(f.db, f.viewer, { ...f.input, retry: true });
    const empty = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: async ({ outputDir }) => {
        await writeFile(
          path.join(outputDir, "manifest.json"),
          JSON.stringify({
            schemaVersion: 2,
            sections: [],
            assets: [],
            warnings: [],
          }),
        );
      },
    });
    await empty(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "failed",
    );
  });
  it("claims duplicate deliveries once and requeues cancellation without publishing", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    let started = 0;
    const cancelled = new AbortController();
    const run = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: async (args) => {
        started++;
        await snapshot(args);
        cancelled.abort();
      },
    });
    await Promise.all([
      run(f.payload, { ...f.delivery, signal: cancelled.signal }),
      run(f.payload, { ...f.delivery, signal: cancelled.signal }),
    ]);
    expect(started).toBe(1);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "queued",
    );
    await f.run(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "ready",
    );
  });
  it("blocks reads after membership revocation and project soft deletion", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    await f.run(f.payload, f.delivery);
    const input = { ...f.input, contentDigest: f.artifact.contentDigest };
    await f.db.member.deleteMany({ where: { userId: f.viewer.userId } });
    await expect(
      readArtifactNotebookAsset(f.db, f.viewer, { ...input, assetId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.db.project.update({
      where: { id: f.project.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      listArtifactNotebookPages(f.db, f.actor, input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await reconcileArtifactNotebooks(f.db, { dataDir });
    expect(await f.db.artifactNotebook.count()).toBe(0);
  });
  it("fails damaged source bytes before the parser and recovers missing snapshot files", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    await writeFile(
      blobPath(dataDir, f.project.id, f.artifact.contentDigest),
      "damaged",
    );
    await f.run(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "failed",
    );
    await writeFile(
      blobPath(dataDir, f.project.id, f.artifact.contentDigest),
      "original",
    );
    await coolDown(f.db, f.artifact.id);
    await prepareArtifactNotebook(f.db, f.viewer, { ...f.input, retry: true });
    await f.run(f.payload, f.delivery);
    const state = await f.db.artifactNotebook.findUniqueOrThrow({
      where: { artifactId: f.artifact.id },
    });
    const dir = notebookClaimDir(
      dataDir,
      f.project.id,
      f.artifact.id,
      state.contentDigest,
      state.parserVersion,
      state.claimToken!,
    );
    await rm(path.join(dir, "pages/page.json"));
    await expect(
      readArtifactNotebookPage(f.db, f.viewer, {
        ...f.input,
        contentDigest: f.artifact.contentDigest,
        pageId: "page",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await getArtifactNotebook(f.db, f.viewer, f.input)).toMatchObject({
      status: "failed",
      error: "snapshot_unavailable",
      retryAllowedAt: null,
    });
    // A lost cache is exempt from the retry cooldown: no backdating needed.
    expect(
      await prepareArtifactNotebook(f.db, f.viewer, {
        ...f.input,
        retry: true,
      }),
    ).toMatchObject({
      status: "queued",
      retryRefused: false,
      retryAllowedAt: null,
    });
    await f.run(f.payload, f.delivery);
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "ready",
    );
  });
  it("cleans deleted snapshots and recovers abandoned claims", async () => {
    const f = await fixture();
    await prepareArtifactNotebook(f.db, f.viewer, f.input);
    await f.db.artifactNotebook.update({
      where: { artifactId: f.artifact.id },
      data: {
        status: "running",
        claimToken: randomUUID(),
        startedAt: new Date(0),
      },
    });
    await reconcileArtifactNotebooks(f.db, { dataDir });
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "queued",
    );
    await f.run(f.payload, f.delivery);
    await deleteArtifact(f.db, f.actor, f.input, { dataDir });
    await reconcileArtifactNotebooks(f.db, { dataDir });
    expect(await f.db.artifactNotebook.count()).toBe(0);
    const root = path.join(dataDir, "notebooks", f.project.id, f.artifact.id);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });
  it("records the published snapshot's page and section counts", async () => {
    const f = await fixture();
    const run = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: async (args) => {
        await snapshot(args);
        const file = path.join(args.outputDir, "manifest.json");
        const parsed = JSON.parse(
          await readFile(file, "utf8"),
        ) as NotebookManifest;
        parsed.sections.push(
          {
            id: "empty",
            title: "Empty",
            path: [],
            pages: [],
            warnings: [],
            content: "empty",
          },
          {
            id: "broken",
            title: "Broken",
            path: [],
            pages: [],
            warnings: [],
            content: "unreadable",
          },
        );
        await writeFile(file, JSON.stringify(parsed));
      },
    });
    await run(f.payload, f.delivery);
    const row = await f.db.artifactNotebook.findUniqueOrThrow({
      where: { artifactId: f.artifact.id },
    });
    expect(row).toMatchObject({
      status: "ready",
      sectionCount: 3,
      pageCount: 1,
      emptySectionCount: 1,
      unreadableSectionCount: 1,
    });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });
  it("removes every notebook file as soon as the file is deleted", async () => {
    const f = await fixture();
    await f.run(f.payload, f.delivery);
    const projectDir = path.join(dataDir, "notebooks", f.project.id);
    expect(await exists(path.join(projectDir, f.artifact.id))).toBe(true);
    await deleteArtifact(f.db, f.actor, f.input, { dataDir });
    expect(await exists(projectDir)).toBe(false);
  });
  it("removes a replaced snapshot as soon as the new version is uploaded", async () => {
    const f = await fixture();
    await f.run(f.payload, f.delivery);
    const artifactDir = path.join(
      dataDir,
      "notebooks",
      f.project.id,
      f.artifact.id,
    );
    expect(await exists(artifactDir)).toBe(true);
    const replaced = await f.upload("replacement");
    expect(await exists(artifactDir)).toBe(false);
    expect(
      f.queue.jobs.filter(
        (job) =>
          job.name === "artifact.notebook.prepare" &&
          (job.data as { contentDigest: string }).contentDigest ===
            replaced.contentDigest,
      ),
    ).toHaveLength(1);
  });
  it("prunes the directories of a build whose file is deleted while it runs", async () => {
    const f = await fixture();
    const run = createArtifactNotebookRunner({
      db: f.db,
      dataDir,
      runNotebookParser: async (args) => {
        await snapshot(args);
        await deleteArtifact(f.db, f.actor, f.input, { dataDir });
      },
    });
    await run(f.payload, f.delivery);
    expect(await exists(path.join(dataDir, "notebooks", f.project.id))).toBe(
      false,
    );
  });
  it("drops preparation when renamed away and queues it when renamed back", async () => {
    const f = await fixture();
    await f.run(f.payload, f.delivery);
    await renameArtifact(f.db, f.actor, {
      ...f.input,
      filename: "Notebook.bin",
    });
    expect(await f.db.artifactNotebook.count()).toBe(0);
    expect(await exists(path.join(dataDir, "notebooks", f.project.id))).toBe(
      false,
    );
    // The earlier job already ran; only the rename's own request remains.
    f.queue.jobs.splice(0);
    await renameArtifact(f.db, f.actor, {
      ...f.input,
      filename: "Notebook.onepkg",
    });
    expect((await getArtifactNotebook(f.db, f.viewer, f.input)).status).toBe(
      "queued",
    );
    expect(f.queue.jobs).toHaveLength(1);
  });
  it("reconciliation queues unprepared notebooks and rebuilds older parser versions", async () => {
    const f = await fixture();
    await f.db.artifactNotebook.deleteMany();
    await reconcileArtifactNotebooks(f.db, { dataDir });
    expect(
      await f.db.artifactNotebook.findUniqueOrThrow({
        where: { artifactId: f.artifact.id },
      }),
    ).toMatchObject({ status: "queued", requestedById: null });
    await f.run(f.payload, f.delivery);
    await f.db.artifactNotebook.update({
      where: { artifactId: f.artifact.id },
      data: { parserVersion: 1 },
    });
    await reconcileArtifactNotebooks(f.db, { dataDir });
    expect(
      await f.db.artifactNotebook.findUniqueOrThrow({
        where: { artifactId: f.artifact.id },
      }),
    ).toMatchObject({ status: "queued", sectionCount: null });
    expect(await exists(path.join(dataDir, "notebooks", f.project.id))).toBe(
      false,
    );
  });
});

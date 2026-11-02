import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withProjectRepo } from "@weaver/git-store";
import { openUploadSink } from "@weaver/core/ingestion/blobStore";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { DEFAULT_INGESTION_SETTINGS } from "@weaver/core/ingestion/settings";
import {
  deleteArtifact,
  finalizeArtifactUpload,
  renameArtifact,
} from "@weaver/core/services/artifacts";
import {
  deleteBatch,
  getBatch,
  getFile,
  listBatches,
  retryFile,
  updateDraft,
} from "@weaver/core/services/ingestion";
import {
  acceptDraft,
  rejectDraft,
} from "@weaver/core/services/ingestionAccept";
import { rebuildTableIndex } from "@weaver/core/services/tables";
import {
  addFileInputs,
  confirmInput,
  processInputs,
  removeInput,
  retryInput,
  unlinkInputArtifact,
} from "@weaver/core/services/wikiInputs";
import {
  enableWiki,
  wikiWriteGuardsFor,
} from "@weaver/core/services/wikiSettings";
import { runWikiTick } from "@weaver/core/services/wikiTick";
import { createIngestionParseRunner } from "@weaver/ingestion/parseStage";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const LONG = 20_000;
const DATA_DIR = process.env.WEAVER_DATA_DIR!;
const OPTIONS = { dataDir: DATA_DIR, maxFileBytes: 52_428_800 };

async function fixture() {
  const db = getPrisma();
  const owner = await makeUser("User", "bridge-owner");
  const editor = await makeUser("User", "bridge-editor");
  const other = await makeUser("User", "bridge-other");
  const project = await makeProject("Wiki bridge");
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, other.id, "Editor");
  const ownerContext = securityContextFor(owner);
  await enableWiki(db, ownerContext, {
    projectId: project.id,
    expectedRevision: 0,
  });
  const queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  return {
    db,
    queue,
    project,
    projectId: project.id,
    ownerContext,
    editorContext: securityContextFor(editor),
    otherContext: securityContextFor(other),
    editorActor: {
      ...securityContextFor(editor),
      name: null,
      email: editor.email,
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function upload(
  f: Fixture,
  filename: string,
  content: string | Uint8Array,
  actor = f.editorContext,
) {
  const uploadId = randomUUID();
  const sink = await openUploadSink(DATA_DIR, f.projectId, uploadId, {
    minFreeBytes: 0,
  });
  await sink.write(
    typeof content === "string" ? new TextEncoder().encode(content) : content,
  );
  const { digest, byteSize } = await sink.finish();
  const { artifacts } = await finalizeArtifactUpload(
    f.db,
    actor,
    {
      projectId: f.projectId,
      files: [
        {
          uploadId,
          contentDigest: digest,
          byteSize,
          filename,
          replace: false,
        },
      ],
    },
    { dataDir: DATA_DIR },
  );
  return artifacts[0]!;
}

async function parseAll(f: Fixture): Promise<void> {
  const runner = createIngestionParseRunner({
    db: f.db,
    dataDir: DATA_DIR,
    ring: null,
    maxOcrPages: 0,
    maxFileBytes: OPTIONS.maxFileBytes,
    loadSettings: async () => DEFAULT_INGESTION_SETTINGS,
  });
  const jobs = f.queue.jobs.filter((job) => job.name === "ingestion.parse");
  for (const job of jobs)
    await runner(
      job.data as never,
      {
        jobId: randomUUID(),
        retryCount: 0,
        signal: new AbortController().signal,
      } as never,
    );
}

async function addAndProcess(f: Fixture, filename: string, content: string) {
  const artifact = await upload(f, filename, content);
  const [item] = await addFileInputs(
    f.db,
    f.editorContext,
    { projectId: f.projectId, artifactIds: [artifact.id] },
    OPTIONS,
  );
  const { runId } = await processInputs(f.db, f.editorContext, {
    projectId: f.projectId,
    itemIds: [item!.id],
  });
  return { artifact, itemId: item!.id, runId };
}

const itemOf = (f: Fixture, id: string) =>
  f.db.wikiInputItem.findUniqueOrThrow({
    where: { id },
    include: { ingestionFile: { include: { draft: true } } },
  });

describe("file inputs", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  it(
    "accepts only the caller's own uploads of a supported type",
    async () => {
      const f = await fixture();
      const png = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const image = await upload(f, "photo.png", png);
      await expect(
        addFileInputs(
          f.db,
          f.editorContext,
          { projectId: f.projectId, artifactIds: [image.id] },
          OPTIONS,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason: "UNSUPPORTED_TYPE" },
      });
      const zipNamedPdf = await upload(f, "fake.pdf", "not a pdf at all");
      await expect(
        addFileInputs(
          f.db,
          f.editorContext,
          { projectId: f.projectId, artifactIds: [zipNamedPdf.id] },
          OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const mine = await upload(f, "mine.md", "# Mine\n");
      await expect(
        addFileInputs(
          f.db,
          f.otherContext,
          { projectId: f.projectId, artifactIds: [mine.id] },
          OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
    LONG,
  );

  it(
    "a Markdown file parses, stops at ready, and the tick writes the source",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await addAndProcess(
        f,
        "minutes.md",
        "# Minutes\n\nWe decided things.\n",
      );
      expect(f.db.wikiRun).toBeDefined();
      const before = await itemOf(f, itemId);
      expect(before.ingestionFile).toMatchObject({ status: "pending" });
      await runWikiTick(f.db);
      expect((await itemOf(f, itemId)).status).toBe("preparing");
      await parseAll(f);
      const parsed = await itemOf(f, itemId);
      expect(parsed.ingestionFile?.status).toBe("ready");
      expect(f.queue.jobs.some((job) => job.name === "ingestion.analyze")).toBe(
        false,
      );
      await runWikiTick(f.db);
      const done = await itemOf(f, itemId);
      expect(done.status).toBe("ready");
      expect(done.ingestionFile?.status).toBe("accepted");
      expect(done.ingestionFile?.draft).toMatchObject({
        markdown: null,
        acceptedResourceId: done.sourceDocumentId,
      });
      const page = await f.db.document.findUniqueOrThrow({
        where: { id: done.sourceDocumentId! },
      });
      expect(page).toMatchObject({
        title: "Source: minutes.md",
        wikiSourceItemId: itemId,
        wikiType: "source",
        reviewExempt: true,
      });
      const message = await withProjectRepo(f.projectId, (repo) =>
        simpleGit(repo.dir).show(["-s", "--format=%B", page.headCommitSha]),
      );
      expect(message).toContain(
        `Weaver-Operation-Id: ingestion:${before.ingestionFileId}`,
      );
      expect(message).toContain(`Weaver-Wiki-Input-Id: ${itemId}`);
      expect(
        (await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } })).status,
      ).toBe("queued");
    },
    LONG,
  );

  it(
    "a CSV becomes a source table in a table folder recorded on first use; a rebuild keeps the link",
    async () => {
      const f = await fixture();
      const { itemId } = await addAndProcess(f, "figures.csv", "a,b\n1,2\n");
      await parseAll(f);
      await runWikiTick(f.db);
      const done = await itemOf(f, itemId);
      expect(done.errorMessage).toBeNull();
      expect(done.status).toBe("ready");
      const table = await f.db.dataTable.findUniqueOrThrow({
        where: { id: done.sourceTableId! },
      });
      expect(table.wikiSourceItemId).toBe(itemId);
      expect(table.title).toBe("Source: figures.csv");
      expect(table.path.startsWith("tables/wiki-sources/")).toBe(true);
      const settings = await f.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: f.projectId },
      });
      expect(settings.sourceTablesFolderId).not.toBeNull();
      expect(
        (await wikiWriteGuardsFor(f.db, f.projectId)).sourceFoldersUnresolved,
      ).toBe(false);
      await rebuildTableIndex(f.db, { projectId: f.projectId }, f.ownerContext);
      expect(
        (await f.db.dataTable.findUniqueOrThrow({ where: { id: table.id } }))
          .wikiSourceItemId,
      ).toBe(itemId);
    },
    LONG,
  );

  it(
    "resume: a live source never creates a second IngestionFile",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await addAndProcess(f, "a.md", "# A\n\nbody\n");
      await parseAll(f);
      await runWikiTick(f.db);
      await f.db.wikiRun.update({
        where: { id: runId },
        data: { status: "failed", endedAt: new Date() },
      });
      await f.db.wikiInputItem.update({
        where: { id: itemId },
        data: { status: "queued", runId: null },
      });
      const files = await f.db.ingestionFile.count();
      await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      expect(await f.db.ingestionFile.count()).toBe(files);
      await runWikiTick(f.db);
      expect((await itemOf(f, itemId)).status).toBe("ready");
    },
    LONG,
  );

  it(
    "a parse failure marks the item failed with the reason; Retry parses again",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await addAndProcess(f, "blank.md", "   \n");
      await parseAll(f);
      await runWikiTick(f.db);
      const failed = await itemOf(f, itemId);
      expect(failed).toMatchObject({
        status: "failed",
        errorCode: "PARSE_FAILED",
      });
      expect(failed.errorMessage).toMatch(/no text/i);
      expect(
        (await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } })).status,
      ).toBe("stopped");
      f.queue.jobs.length = 0;
      await retryInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId,
      });
      await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      expect((await itemOf(f, itemId)).ingestionFile?.status).toBe("pending");
      expect(f.queue.jobs.map((job) => job.name)).toContain("ingestion.parse");
    },
    LONG,
  );

  it(
    "the 75-minute limit fails an unparsed item and retires its file",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await addAndProcess(f, "slow.md", "# Slow\n");
      await f.db.wikiRun.update({
        where: { id: runId },
        data: { startedAt: new Date(Date.now() - 76 * 60_000) },
      });
      await runWikiTick(f.db);
      const item = await itemOf(f, itemId);
      expect(item).toMatchObject({
        status: "failed",
        errorCode: "PREPARE_TIMEOUT",
      });
      expect(item.ingestionFile?.status).toBe("rejected");
      // A late parser delivery is fenced by the terminal status.
      await parseAll(f);
      expect((await itemOf(f, itemId)).ingestionFile?.status).toBe("rejected");
      // Retry replaces the retired file.
      await retryInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId,
      });
      await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      const again = await itemOf(f, itemId);
      expect(again.ingestionFile?.status).toBe("pending");
      expect(again.ingestionFileId).not.toBe(item.ingestionFileId);
    },
    LONG,
  );

  it(
    "Remove clears the parked draft and makes the file terminal",
    async () => {
      const f = await fixture();
      const { itemId } = await addAndProcess(f, "x.md", "# X\n\nbody\n");
      await parseAll(f);
      const parked = await itemOf(f, itemId);
      await removeInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId,
      });
      const file = await f.db.ingestionFile.findUniqueOrThrow({
        where: { id: parked.ingestionFileId! },
        include: { draft: true },
      });
      expect(file.status).toBe("rejected");
      expect(file.draft?.markdown).toBeNull();
      const before = await withProjectRepo(f.projectId, (repo) =>
        repo.resolveHead(),
      );
      await runWikiTick(f.db);
      expect(
        await withProjectRepo(f.projectId, (repo) => repo.resolveHead()),
      ).toBe(before);
    },
    LONG,
  );
});

describe("secret scanner on files", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  const SECRET = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");

  it(
    "a draft hit holds with the file ready and Confirm is digest-bound",
    async () => {
      const f = await fixture();
      const { itemId } = await addAndProcess(
        f,
        "keys.md",
        `# K\n\n${SECRET}\n`,
      );
      await parseAll(f);
      await runWikiTick(f.db);
      const held = await itemOf(f, itemId);
      expect(held.status).toBe("held");
      expect(held.ingestionFile?.status).toBe("ready");
      expect(held.ingestionFile?.draft?.markdown).toContain(SECRET);
      expect(JSON.stringify(held.heldHits)).not.toContain(SECRET);
      expect(held.title).toBe("keys.md");
      await confirmInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId,
        expectedDigest: held.heldDigest!,
      });
      await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      await runWikiTick(f.db);
      expect((await itemOf(f, itemId)).status).toBe("ready");
    },
    LONG,
  );

  it(
    "a table cell holds, naming only its position",
    async () => {
      const f = await fixture();
      const { itemId } = await addAndProcess(f, "t.csv", `a,b\n1,${SECRET}\n`);
      await parseAll(f);
      await runWikiTick(f.db);
      const held = await itemOf(f, itemId);
      expect(held.status).toBe("held");
      expect(held.heldHits).toEqual([
        { kind: "github_token", location: "table row 1, column 2" },
      ]);
    },
    LONG,
  );

  it(
    "a file name with a secret: neutral title and a position-only hit",
    async () => {
      const f = await fixture();
      const name = `${SECRET}.md`;
      const { itemId } = await addAndProcess(f, name, "# Plain\n\nbody\n");
      const added = await itemOf(f, itemId);
      expect(added.title).toMatch(/^File \d{4}-\d{2}-\d{2}$/);
      await parseAll(f);
      await runWikiTick(f.db);
      const held = await itemOf(f, itemId);
      expect(held.status).toBe("held");
      expect(held.heldHits).toEqual([
        { kind: "github_token", location: "file, line 1" },
      ]);
      expect(JSON.stringify(held.heldHits)).not.toContain(SECRET);
      await confirmInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId,
        expectedDigest: held.heldDigest!,
      });
      await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      await runWikiTick(f.db);
      const done = await itemOf(f, itemId);
      const page = await f.db.document.findUniqueOrThrow({
        where: { id: done.sourceDocumentId! },
      });
      expect(page.title).not.toContain(SECRET);
      expect(page.path).not.toContain("ghp");
    },
    LONG,
  );
});

describe("Imports isolation", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  it(
    "hides wiki batches and refuses every Imports action",
    async () => {
      const f = await fixture();
      const { itemId } = await addAndProcess(f, "h.md", "# H\n\nbody\n");
      await parseAll(f);
      const { ingestionFileId, ingestionFile } = await itemOf(f, itemId);
      const fileId = ingestionFileId!;
      const batchId = ingestionFile!.batchId;
      const actor = f.editorContext;
      expect(
        (await listBatches(f.db, actor, { projectId: f.projectId })).items,
      ).toEqual([]);
      const notFound = { code: "NOT_FOUND" };
      await expect(getBatch(f.db, actor, { batchId })).rejects.toMatchObject(
        notFound,
      );
      await expect(getFile(f.db, actor, { fileId })).rejects.toMatchObject(
        notFound,
      );
      await expect(
        deleteBatch(f.db, actor, { batchId }, { dataDir: DATA_DIR }),
      ).rejects.toMatchObject(notFound);
      await expect(retryFile(f.db, actor, { fileId })).rejects.toMatchObject(
        notFound,
      );
      await expect(
        updateDraft(f.db, actor, {
          fileId,
          proposedTitle: "T",
          proposedFolderPath: "",
          proposedTags: [],
        }),
      ).rejects.toMatchObject(notFound);
      await expect(
        acceptDraft(f.db, f.editorActor, { fileId, expectedRevision: 0 }),
      ).rejects.toMatchObject(notFound);
      await expect(rejectDraft(f.db, actor, { fileId })).rejects.toMatchObject(
        notFound,
      );
      expect(
        (await f.db.ingestionFile.findUniqueOrThrow({ where: { id: fileId } }))
          .status,
      ).toBe("ready");
    },
    LONG,
  );
});

describe("recovery of a wiki-origin ingestion id", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  it(
    "a forged ingestion commit is a CONFLICT and writes nothing",
    async () => {
      const f = await fixture();
      const { itemId } = await addAndProcess(f, "f.md", "# F\n\nbody\n");
      await parseAll(f);
      const { ingestionFileId } = await itemOf(f, itemId);
      await withProjectRepo(f.projectId, async (repo) => {
        const git = simpleGit(repo.dir);
        await git
          .addConfig("user.name", "Forger")
          .addConfig("user.email", "forger@example.com");
        await writeFile(join(repo.dir, "forged.md"), "x");
        await git.add("forged.md");
        await git.commit(
          `forged\n\nWeaver-Operation-Id: ingestion:${ingestionFileId}`,
        );
      });
      await runWikiTick(f.db);
      const item = await itemOf(f, itemId);
      expect(item.status).toBe("failed");
      expect(await f.db.document.count({ where: { wikiType: "source" } })).toBe(
        0,
      );
    },
    LONG,
  );
});

describe("artifact protection", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  const replace = async (f: Fixture, filename: string) => {
    const uploadId = randomUUID();
    const sink = await openUploadSink(DATA_DIR, f.projectId, uploadId, {
      minFreeBytes: 0,
    });
    await sink.write(new TextEncoder().encode("replacement"));
    const { digest, byteSize } = await sink.finish();
    return finalizeArtifactUpload(
      f.db,
      f.editorContext,
      {
        projectId: f.projectId,
        files: [
          {
            uploadId,
            contentDigest: digest,
            byteSize,
            filename,
            replace: true,
          },
        ],
      },
      { dataDir: DATA_DIR },
    );
  };

  it(
    "refuses replace and delete while a live item references it; rename stays allowed",
    async () => {
      const f = await fixture();
      const artifact = await upload(f, "keep.md", "# Keep\n");
      const [item] = await addFileInputs(
        f.db,
        f.editorContext,
        { projectId: f.projectId, artifactIds: [artifact.id] },
        OPTIONS,
      );
      const protectedError = {
        code: "CONFLICT",
        details: { reason: "SOURCE_PROTECTED" },
      };
      await expect(replace(f, "keep.md")).rejects.toMatchObject(protectedError);
      await expect(
        deleteArtifact(
          f.db,
          f.editorContext,
          { projectId: f.projectId, artifactId: artifact.id },
          { dataDir: DATA_DIR },
        ),
      ).rejects.toMatchObject(protectedError);
      await renameArtifact(f.db, f.editorContext, {
        projectId: f.projectId,
        artifactId: artifact.id,
        filename: "renamed.md",
      });
      await removeInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId: item!.id,
      });
      await deleteArtifact(
        f.db,
        f.editorContext,
        { projectId: f.projectId, artifactId: artifact.id },
        { dataDir: DATA_DIR },
      );
    },
    LONG,
  );

  it(
    "a failed item does not protect; Owner unlink lifts it, Editor may not",
    async () => {
      const f = await fixture();
      const artifact = await upload(f, "one.md", "# One\n");
      const [item] = await addFileInputs(
        f.db,
        f.editorContext,
        { projectId: f.projectId, artifactIds: [artifact.id] },
        OPTIONS,
      );
      const input = { projectId: f.projectId, itemId: item!.id };
      await expect(
        unlinkInputArtifact(f.db, f.editorContext, input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await unlinkInputArtifact(f.db, f.ownerContext, input);
      await expect(
        deleteArtifact(
          f.db,
          f.editorContext,
          { projectId: f.projectId, artifactId: artifact.id },
          { dataDir: DATA_DIR },
        ),
      ).resolves.toBeDefined();

      const second = await upload(f, "two.md", "# Two\n");
      const [failed] = await addFileInputs(
        f.db,
        f.editorContext,
        { projectId: f.projectId, artifactIds: [second.id] },
        OPTIONS,
      );
      await f.db.wikiInputItem.update({
        where: { id: failed!.id },
        data: { status: "failed" },
      });
      await expect(replace(f, "two.md")).resolves.toBeDefined();
    },
    LONG,
  );
});

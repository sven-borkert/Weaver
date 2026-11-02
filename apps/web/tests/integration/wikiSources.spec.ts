import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as diagnosticWriter from "@weaver/core/diagnostics/writer";
import { withProjectRepo } from "@weaver/git-store";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { rebuildIndex } from "@weaver/core/services/documents";
import { applyWikiOperation } from "@weaver/core/services/wikiOperations";
import {
  addTextInput,
  confirmInput,
  processInputs,
  removeInput,
} from "@weaver/core/services/wikiInputs";
import {
  disableWiki,
  enableWiki,
  getWikiSettings,
  revokeAgent,
  wikiWriteGuardsFor,
} from "@weaver/core/services/wikiSettings";
import {
  sourceTitle,
  writeTextSource,
} from "@weaver/core/services/wikiSourceWriter";
import { runWikiTick } from "@weaver/core/services/wikiTick";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const LONG = 20_000;

async function fixture() {
  const db = getPrisma();
  const owner = await makeUser("User", "src-owner");
  const editor = await makeUser("User", "src-editor");
  const project = await makeProject("Wiki sources");
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, editor.id, "Editor");
  const ownerContext = securityContextFor(owner);
  await enableWiki(db, ownerContext, {
    projectId: project.id,
    expectedRevision: 0,
  });
  return {
    db,
    owner,
    editor,
    project,
    projectId: project.id,
    ownerContext,
    editorContext: securityContextFor(editor),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function head(f: Fixture): Promise<string> {
  return withProjectRepo(f.projectId, (repo) => repo.resolveHead());
}

async function revision(f: Fixture): Promise<number> {
  return (await getWikiSettings(f.db, f.ownerContext, f.projectId)).revision;
}

async function process1(f: Fixture, text = "Body text", title?: string) {
  const item = await addTextInput(f.db, f.editorContext, {
    projectId: f.projectId,
    text,
    ...(title === undefined ? {} : { title }),
  });
  const { runId } = await processInputs(f.db, f.editorContext, {
    projectId: f.projectId,
    itemIds: [item.id],
  });
  return { itemId: item.id, runId };
}

async function item(f: Fixture, id: string) {
  return f.db.wikiInputItem.findUniqueOrThrow({ where: { id } });
}

/** Collects what the diagnostic writer is handed, as text. */
function captureDiagnostics(into: string[]): () => void {
  const spy = vi
    .spyOn(diagnosticWriter, "emitDiagnostic")
    .mockImplementation((input) => {
      into.push(JSON.stringify(input));
      return null;
    });
  return () => spy.mockRestore();
}

async function commitMessage(f: Fixture, sha: string): Promise<string> {
  return withProjectRepo(f.projectId, async (repo) => {
    const log = await simpleGit(repo.dir).show(["-s", "--format=%B", sha]);
    return log;
  });
}

describe("sourceTitle", () => {
  it.each([
    ["minutes.pdf", "Source: minutes.pdf"],
    ["\u200b\u202e  ", "Source: untitled"],
    ["", "Source: untitled"],
    ["\u202eevil\u202c.pdf", "Source: evil.pdf"],
    ["a\r\nb\u2028c", "Source: a b c"],
  ])("%j becomes %j", (name, title) => {
    expect(sourceTitle(name)).toBe(title);
  });

  it("stays a valid bounded title", () => {
    expect([...sourceTitle("x".repeat(400))].length).toBeLessThanOrEqual(200);
  });
});

describe("text source writer", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  it(
    "creates the page in the recorded folder as the agent, linked before indexing",
    async () => {
      const f = await fixture();
      const queue = new FakeJobQueue();
      setJobQueueForTests(queue);
      const { itemId, runId } = await process1(f, "# Heading\n\nBody", "Notes");
      await runWikiTick(f.db);
      const after = await item(f, itemId);
      expect(after.status).toBe("ready");
      expect(after.text).toBe("# Heading\n\nBody");
      const document = await f.db.document.findUniqueOrThrow({
        where: { id: after.sourceDocumentId! },
      });
      expect(document).toMatchObject({
        title: "Source: Notes",
        wikiSourceItemId: itemId,
        wikiType: "source",
        reviewExempt: true,
        reviewDueAt: null,
        lastEditedById: null,
        lastEditedByMachineKind: "wikiAgent",
      });
      const settings = await f.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: f.projectId },
      });
      expect(document.path.startsWith("wiki/sources/")).toBe(true);
      expect(document.lastEditedByMachineId).toBe(settings.agentId);
      const message = await commitMessage(f, document.headCommitSha);
      expect(message).toContain(`Weaver-Wiki-Agent-Id: ${settings.agentId}`);
      expect(message).toContain(`Weaver-Wiki-Input-Id: ${itemId}`);
      expect(message).toContain(`Weaver-Operation-Id: wiki-input:${itemId}`);
      expect(message).toContain(`Weaver-Run-Id: ${runId}`);
      expect(message).toMatch(/Weaver-Wiki-Request-Hash: [0-9a-f]{64}/);
      expect(message).not.toContain("Weaver-User-Id");
      expect(
        queue.jobs.some(
          (job) =>
            job.name === "document.search-sync" &&
            (job.data as { documentId: string }).documentId === document.id,
        ),
      ).toBe(true);
      // Every item ready: the run moves on and is dispatched in the same tick.
      expect(
        (await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } })).status,
      ).toBe("queued");
      expect(queue.jobs).toContainEqual({ name: "wiki.run", data: { runId } });
    },
    LONG,
  );

  it(
    "two items with one title get distinct slugs, and an empty title a fallback",
    async () => {
      const f = await fixture();
      const a = await process1(f, "one", "Same");
      await runWikiTick(f.db);
      await f.db.wikiRun.updateMany({
        where: { id: a.runId },
        data: { status: "failed", endedAt: new Date() },
      });
      const b = await process1(f, "two", "Same");
      await runWikiTick(f.db);
      const [first, second] = await Promise.all([
        item(f, a.itemId),
        item(f, b.itemId),
      ]);
      const pages = await f.db.document.findMany({
        where: {
          id: { in: [first.sourceDocumentId!, second.sourceDocumentId!] },
        },
        select: { title: true, slug: true },
      });
      expect(pages.map((page) => page.title)).toEqual([
        "Source: Same",
        "Source: Same",
      ]);
      expect(pages.map((page) => page.slug).sort()).toEqual([
        "source-same",
        "source-same-2",
      ]);
    },
    LONG,
  );

  it(
    "refuses image markup and fails the item, not the tick",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await process1(f);
      await f.db.wikiInputItem.update({
        where: { id: itemId },
        data: { text: "<img src=x>" },
      });
      const before = await head(f);
      await runWikiTick(f.db);
      expect(await item(f, itemId)).toMatchObject({
        status: "failed",
        errorCode: "SOURCE_HAS_IMAGES",
      });
      expect(await head(f)).toBe(before);
      expect(
        (await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } })).status,
      ).toBe("stopped");
    },
    LONG,
  );

  it(
    "the agent cannot mint a writer's operation ids",
    async () => {
      const f = await fixture();
      const settings = await f.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: f.projectId },
      });
      const runId = randomUUID();
      for (const operationId of [
        `wiki-input:${randomUUID()}`,
        `wiki-revert:${randomUUID()}:0001`,
        `ingestion:${randomUUID()}`,
        `wiki-bootstrap:${randomUUID()}:0001`,
      ])
        await expect(
          applyWikiOperation(f.db, {
            run: {
              agentId: settings.agentId!,
              projectId: f.projectId,
              runId,
              assertLive: async () => undefined,
            },
            guards: () => wikiWriteGuardsFor(f.db, f.projectId),
            operation: {
              kind: "document.create",
              projectId: f.projectId,
              folderPath: [],
              title: "Minted",
              markdown: "x",
            },
            operationId,
          }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
    LONG,
  );
});

describe("preparing-phase fence", () => {
  beforeEach(resetDb);

  const direct = async (f: Fixture, itemId: string, runId: string) => {
    const run = await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } });
    return writeTextSource(f.db, run, {
      id: itemId,
      title: "T",
      text: "body",
      textDigest: "d".repeat(64),
    });
  };
  const closed = { code: "CONFLICT", details: { reason: "WIKI_FENCE_CLOSED" } };

  it.each([
    [
      "the feature is disabled",
      (f: Fixture) =>
        f.db.projectWikiSettings.update({
          where: { projectId: f.projectId },
          data: { enabled: false },
        }),
    ],
    [
      "the agent is revoked",
      (f: Fixture) =>
        f.db.wikiAgent.updateMany({
          where: { projectId: f.projectId },
          data: { revokedAt: new Date() },
        }),
    ],
    [
      "the project is deleted",
      (f: Fixture) =>
        f.db.project.update({
          where: { id: f.projectId },
          data: { deletedAt: new Date() },
        }),
    ],
    [
      "the run ended",
      (f: Fixture) =>
        f.db.wikiRun.updateMany({
          data: { status: "cancelled", endedAt: new Date() },
        }),
    ],
    [
      "the item left preparing",
      (f: Fixture) =>
        f.db.wikiInputItem.updateMany({ data: { status: "ready" } }),
    ],
  ])(
    "no commit when %s",
    async (_label, close) => {
      const f = await fixture();
      const { itemId, runId } = await process1(f);
      const before = await head(f);
      await close(f);
      await expect(direct(f, itemId, runId)).rejects.toMatchObject(closed);
      expect(await head(f)).toBe(before);
      expect(await f.db.document.count({ where: { wikiType: "source" } })).toBe(
        0,
      );
    },
    LONG,
  );

  it(
    "a fence closing at the last moment still stops the commit",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await process1(f);
      const before = await head(f);
      // The lock queues the write behind this; the fence re-checks once it is inside.
      const blocker = withProjectRepo(f.projectId, async () => {
        await removeInput(f.db, f.editorContext, {
          projectId: f.projectId,
          itemId,
        });
      });
      await expect(direct(f, itemId, runId)).rejects.toMatchObject(closed);
      await blocker;
      expect(await head(f)).toBe(before);
      expect(await item(f, itemId)).toMatchObject({
        status: "removed",
        text: null,
      });
    },
    LONG,
  );

  it(
    "Remove and disable during preparing leave known states and no later commit",
    async () => {
      const f = await fixture();
      const removed = await process1(f, "removed text");
      const kept = await addTextInput(f.db, f.editorContext, {
        projectId: f.projectId,
        text: "kept text",
      });
      await removeInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId: removed.itemId,
      });
      const before = await head(f);
      await runWikiTick(f.db);
      expect(await head(f)).toBe(before);
      expect(
        (await f.db.wikiRun.findUniqueOrThrow({ where: { id: removed.runId } }))
          .status,
      ).toBe("stopped");

      const second = await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: [kept.id],
      });
      await disableWiki(f.db, f.ownerContext, {
        projectId: f.projectId,
        expectedRevision: await revision(f),
      });
      await runWikiTick(f.db);
      expect(await head(f)).toBe(before);
      expect(await item(f, kept.id)).toMatchObject({
        status: "queued",
        text: "kept text",
      });
      expect(
        (await f.db.wikiRun.findUniqueOrThrow({ where: { id: second.runId } }))
          .status,
      ).toBe("cancelled");
    },
    LONG,
  );

  it(
    "revoke during preparing leaves the item queued and commits nothing",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(f);
      const before = await head(f);
      await revokeAgent(f.db, f.ownerContext, {
        projectId: f.projectId,
        expectedRevision: await revision(f),
      });
      await runWikiTick(f.db);
      expect(await head(f)).toBe(before);
      expect((await item(f, itemId)).status).toBe("queued");
    },
    LONG,
  );
});

describe("resume and recovery", () => {
  beforeEach(resetDb);

  const endRun = (f: Fixture, runId: string) =>
    f.db.wikiRun.update({
      where: { id: runId },
      data: { status: "failed", endedAt: new Date() },
    });

  it(
    "a live source skips preparation; Process commits nothing new",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await process1(f);
      await runWikiTick(f.db);
      const first = await item(f, itemId);
      await endRun(f, runId);
      await f.db.wikiInputItem.update({
        where: { id: itemId },
        data: { status: "queued", runId: null },
      });
      const before = await head(f);
      const { runId: next } = await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      await runWikiTick(f.db);
      expect(await head(f)).toBe(before);
      const again = await item(f, itemId);
      expect(again).toMatchObject({
        status: "ready",
        runId: next,
        sourceDocumentId: first.sourceDocumentId,
      });
      expect(again.text).toBe("Body text");
    },
    LONG,
  );

  it(
    "commit then crash before the projection: the next tick repairs the row with its link",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(f);
      await runWikiTick(f.db);
      const written = await item(f, itemId);
      const sha = await head(f);
      await f.db.document.delete({ where: { id: written.sourceDocumentId! } });
      await f.db.wikiInputItem.update({
        where: { id: itemId },
        data: { status: "preparing" },
      });
      await f.db.wikiRun.updateMany({
        data: { status: "preparing", queuedAt: null },
      });
      await runWikiTick(f.db);
      expect(await head(f)).toBe(sha);
      const repaired = await f.db.document.findUniqueOrThrow({
        where: { id: written.sourceDocumentId! },
      });
      expect(repaired.wikiSourceItemId).toBe(itemId);
      expect((await item(f, itemId)).status).toBe("ready");
    },
    LONG,
  );

  it(
    "delete the row and rebuild: the guard still refuses the agent",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await process1(f);
      await runWikiTick(f.db);
      const { sourceDocumentId } = await item(f, itemId);
      await f.db.document.delete({ where: { id: sourceDocumentId! } });
      await rebuildIndex(f.db, { projectId: f.projectId }, f.ownerContext);
      const rebuilt = await f.db.document.findUniqueOrThrow({
        where: { id: sourceDocumentId! },
      });
      expect(rebuilt.wikiSourceItemId).toBe(itemId);
      const settings = await f.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: f.projectId },
      });
      await expect(
        applyWikiOperation(f.db, {
          run: {
            agentId: settings.agentId!,
            projectId: f.projectId,
            runId,
            assertLive: async () => undefined,
          },
          guards: () => wikiWriteGuardsFor(f.db, f.projectId),
          operation: {
            kind: "document.patch",
            projectId: f.projectId,
            documentId: sourceDocumentId!,
            baseCommitSha: rebuilt.headCommitSha,
            actions: [{ action: "append", text: "more" }],
          },
          operationId: `wiki-run:${runId}:0001`,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
    LONG,
  );

  it(
    "a forged commit under the item's id is a CONFLICT, not a recovery",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(f);
      await withProjectRepo(f.projectId, async (repo) => {
        const git = simpleGit(repo.dir);
        await writeFile(join(repo.dir, "forged.md"), "x");
        await git.add("forged.md");
        await git
          .addConfig("user.name", "Forger")
          .addConfig("user.email", "forger@example.com");
        await git.commit(`forged\n\nWeaver-Operation-Id: wiki-input:${itemId}`);
      });
      await runWikiTick(f.db);
      expect(await item(f, itemId)).toMatchObject({ status: "failed" });
      expect(await f.db.document.count({ where: { wikiType: "source" } })).toBe(
        0,
      );
    },
    LONG,
  );

  it(
    "a source page a human deleted fails visibly instead of pointing at nothing",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await process1(f);
      await runWikiTick(f.db);
      const { sourceDocumentId } = await item(f, itemId);
      const row = await f.db.document.findUniqueOrThrow({
        where: { id: sourceDocumentId! },
      });
      await withProjectRepo(f.projectId, async (repo) => {
        const git = simpleGit(repo.dir);
        await git.rm(row.path);
        await git
          .addConfig("user.name", "Human")
          .addConfig("user.email", "human@example.com");
        await git.commit("delete");
      });
      await f.db.document.delete({ where: { id: row.id } });
      await f.db.wikiRun.update({
        where: { id: runId },
        data: { status: "failed", endedAt: new Date() },
      });
      await f.db.wikiInputItem.update({
        where: { id: itemId },
        data: { status: "queued", runId: null },
      });
      await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      await runWikiTick(f.db);
      expect(await item(f, itemId)).toMatchObject({
        status: "failed",
        errorCode: "SOURCE_DELETED",
      });
    },
    LONG,
  );

  it(
    "a hard project delete and a user delete succeed with a linked source",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(f);
      await runWikiTick(f.db);
      await f.db.user.delete({ where: { id: f.editor.id } });
      expect((await item(f, itemId)).createdById).toBeNull();
      await f.db.project.delete({ where: { id: f.projectId } });
      expect(await f.db.wikiInputItem.count()).toBe(0);
    },
    LONG,
  );

  it(
    "an item with a linked page cannot be deleted while the page exists",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(f);
      await runWikiTick(f.db);
      await expect(
        f.db.wikiInputItem.delete({ where: { id: itemId } }),
      ).rejects.toThrow();
    },
    LONG,
  );
});

describe("source folder recreation", () => {
  beforeEach(resetDb);

  async function removeFolder(f: Fixture, rel: string) {
    await withProjectRepo(f.projectId, async (repo) => {
      const git = simpleGit(repo.dir);
      await git.rm(["-r", "--ignore-unmatch", rel]);
      await rm(join(repo.dir, rel), { recursive: true, force: true });
      await git
        .addConfig("user.name", "Human")
        .addConfig("user.email", "human@example.com");
      await git.commit("remove folder");
    });
  }

  it(
    "a deleted folder is recreated, recorded, and clears the unresolved state",
    async () => {
      const f = await fixture();
      const before = await f.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: f.projectId },
      });
      await removeFolder(f, "wiki/sources");
      expect(
        (await wikiWriteGuardsFor(f.db, f.projectId)).sourceFoldersUnresolved,
      ).toBe(true);
      const { itemId } = await process1(f);
      await runWikiTick(f.db);
      const written = await item(f, itemId);
      expect(written.status).toBe("ready");
      const after = await f.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: f.projectId },
      });
      expect(after.sourcesFolderId).not.toBe(before.sourcesFolderId);
      expect(after.revision).toBe(before.revision);
      const guards = await wikiWriteGuardsFor(f.db, f.projectId);
      expect(guards.sourceFoldersUnresolved).toBe(false);
      const page = await f.db.document.findUniqueOrThrow({
        where: { id: written.sourceDocumentId! },
      });
      expect(guards.sourceFolderPaths).toContain(
        page.path.split("/").slice(0, -1).join("/"),
      );
    },
    LONG,
  );

  it(
    "a duplicated folder id gets a fresh folder, never the ambiguous one",
    async () => {
      const f = await fixture();
      await withProjectRepo(f.projectId, async (repo) => {
        const git = simpleGit(repo.dir);
        await mkdir(join(repo.dir, "copy"), { recursive: true });
        const { readFile } = await import("node:fs/promises");
        await writeFile(
          join(repo.dir, "copy", ".folder.json"),
          await readFile(join(repo.dir, "wiki/sources/.folder.json")),
        );
        await git.add("copy/.folder.json");
        await git
          .addConfig("user.name", "Human")
          .addConfig("user.email", "human@example.com");
        await git.commit("duplicate folder id");
      });
      const { itemId } = await process1(f);
      await runWikiTick(f.db);
      const written = await item(f, itemId);
      expect(written.status).toBe("ready");
      const page = await f.db.document.findUniqueOrThrow({
        where: { id: written.sourceDocumentId! },
      });
      expect(page.path.startsWith("wiki/sources-2/")).toBe(true);
      expect(
        (await wikiWriteGuardsFor(f.db, f.projectId)).sourceFoldersUnresolved,
      ).toBe(false);
    },
    LONG,
  );
});

describe("secret hold", () => {
  beforeEach(resetDb);

  const SECRET = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");

  it(
    "holds on a hit, reports no value, and Confirm releases exactly that content",
    async () => {
      const f = await fixture();
      const { itemId, runId } = await process1(f, `key ${SECRET}`);
      const before = await head(f);
      await runWikiTick(f.db);
      const held = await item(f, itemId);
      expect(held.status).toBe("held");
      expect(JSON.stringify(held.heldHits)).not.toContain(SECRET);
      expect(held.heldHits).toEqual([
        { kind: "github_token", location: "note, line 1" },
      ]);
      expect(await head(f)).toBe(before);
      expect(
        (await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } })).status,
      ).toBe("stopped");

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
      expect((await item(f, itemId)).status).toBe("ready");
      expect(await head(f)).not.toBe(before);
    },
    LONG,
  );

  it(
    "a changed text after Confirm is scanned again",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(f, `key ${SECRET}`);
      await runWikiTick(f.db);
      const held = await item(f, itemId);
      await confirmInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId,
        expectedDigest: held.heldDigest!,
      });
      await f.db.wikiInputItem.update({
        where: { id: itemId },
        data: { text: `other ${SECRET}` },
      });
      await processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      });
      await runWikiTick(f.db);
      expect((await item(f, itemId)).status).toBe("held");
    },
    LONG,
  );

  it(
    "a secret in a supplied title never reaches the page, the commit or the row",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(f, "plain body", `Notes ${SECRET}`);
      expect((await item(f, itemId)).title).toMatch(/^Note \d{4}-\d{2}-\d{2}$/);
      await runWikiTick(f.db);
      const written = await item(f, itemId);
      expect(written.status).toBe("ready");
      const page = await f.db.document.findUniqueOrThrow({
        where: { id: written.sourceDocumentId! },
      });
      expect(page.title).toBe(`Source: ${written.title}`);
      expect(await commitMessage(f, page.headCommitSha)).not.toContain(SECRET);
    },
    LONG,
  );

  it(
    "a held note's title goes neutral, stays so after Confirm, and leaks nowhere",
    async () => {
      const f = await fixture();
      const { itemId } = await process1(
        f,
        `clean first line\n\nkey ${SECRET}`,
        "Payroll password rotation",
      );
      const emitted: string[] = [];
      const stop = captureDiagnostics(emitted);
      try {
        await runWikiTick(f.db);
      } finally {
        stop();
      }
      const held = await item(f, itemId);
      expect(held.status).toBe("held");
      expect(held.title).toMatch(/^Note \d{4}-\d{2}-\d{2}$/);
      expect(held.outcomeNote ?? "").not.toContain("Payroll");
      expect(held.errorMessage ?? "").not.toContain("Payroll");
      // Guards against a vacuous pass: the hold event itself was captured.
      expect(emitted.join("\n")).toContain("wiki.input.held");
      expect(emitted.join("\n")).not.toContain("Payroll");
      expect(emitted.join("\n")).not.toContain("clean first line");

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
      const written = await item(f, itemId);
      expect(written.status).toBe("ready");
      expect(written.title).toBe(held.title);
      const page = await f.db.document.findUniqueOrThrow({
        where: { id: written.sourceDocumentId! },
      });
      expect(page.title).toBe(`Source: ${held.title}`);
      expect(page.title).not.toContain("Payroll");
    },
    LONG,
  );
});

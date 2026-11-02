import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { withProjectRepo } from "@weaver/git-store";
import { upgradeDocumentHeaders } from "@weaver/core/services/documentHeaderUpgrade";
import {
  markDocumentReviewed,
  setDocumentReview,
} from "@weaver/core/services/documentReview";
import { contentOperationSchema } from "@weaver/core/services/contentOperations";
import { setDocumentProperties } from "@weaver/core/services/documentProperties";
import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";
import {
  deleteDocument,
  writeDocumentInRepo,
} from "@weaver/core/services/documents";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const PARA = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const PROPERTIES = {
  type: "entity",
  summary: "A person",
  tags: ["people"],
  sources: [{ kind: "url" as const, url: "https://example.test/a" }],
};

async function setup(suffix: string) {
  const db = getPrisma();
  const owner = await makeUser("User", `wp-${suffix}`);
  const project = await makeProject(`WP-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  const security = securityContextFor(owner);
  const actor = { ...security, name: null, email: owner.email };
  return { db, owner, project, actor, caller: callerFor(owner) };
}

const read = (projectId: string, path: string) =>
  withProjectRepo(projectId, (repo) => repo.readFileFromWorktree(path));

async function injectProperties(
  s: Awaited<ReturnType<typeof setup>>,
  path: string,
  properties: unknown,
) {
  const parsed = parseDocumentFile(await read(s.project.id, path), "markdown");
  const file = composeDocumentFile(
    { ...parsed.meta, properties: properties as never },
    parsed.body,
    "markdown",
  );
  await withProjectRepo(s.project.id, async (repo) => {
    await repo.writeFileAtomic(path, file);
    await repo.commitAll("external: add properties", {
      name: null,
      email: s.owner.email,
      userId: s.owner.id,
    });
  });
  await s.caller.document.rebuildIndex({ projectId: s.project.id });
  return file;
}

const propertiesLine = (file: string) =>
  file.split("\n").find((line) => line.startsWith("properties: "));

describe("wiki page properties", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  it("projects a pulled properties line and keeps it through save, move, review and restore", async () => {
    const s = await setup("carry");
    const created = await s.caller.document.create({
      projectId: s.project.id,
      folderPath: [],
      title: "Ada",
      contentJson: PARA("v1"),
    });
    await injectProperties(s, created.path, PROPERTIES);
    const row = await s.db.document.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row).toMatchObject({
      wikiType: "entity",
      wikiSummary: "A person",
      wikiTags: ["people"],
      wikiSources: PROPERTIES.sources,
      reviewExempt: false,
      wikiSourceItemId: null,
    });
    const line = propertiesLine(await read(s.project.id, created.path))!;
    expect(line).toBeTruthy();

    let current = await s.caller.document.get({
      projectId: s.project.id,
      documentId: created.id,
    });
    const saved = await s.caller.document.update({
      projectId: s.project.id,
      documentId: created.id,
      baseCommitSha: current.baseCommitSha,
      content: { kind: "markdown", contentJson: PARA("v2") },
      changeSummary: "second",
    });
    expect(propertiesLine(await read(s.project.id, saved.path))).toBe(line);

    await s.caller.folder.create({
      projectId: s.project.id,
      parentPath: [],
      name: "g",
    });
    const moved = await s.caller.document.move({
      projectId: s.project.id,
      documentId: created.id,
      folderPath: ["g"],
    });
    expect(propertiesLine(await read(s.project.id, moved.path))).toBe(line);

    current = await s.caller.document.get({
      projectId: s.project.id,
      documentId: created.id,
    });
    await markDocumentReviewed(
      s.db,
      {
        projectId: s.project.id,
        documentId: created.id,
        expectedHeadCommitSha: current.baseCommitSha,
      },
      s.actor,
    );
    expect(propertiesLine(await read(s.project.id, moved.path))).toBe(line);

    current = await s.caller.document.get({
      projectId: s.project.id,
      documentId: created.id,
    });
    await s.caller.document.restore({
      projectId: s.project.id,
      documentId: created.id,
      sha: created.headCommitSha,
      expectedHeadCommitSha: current.baseCommitSha,
    });
    expect(propertiesLine(await read(s.project.id, moved.path))).toBe(line);
    const after = await s.db.document.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.wikiType).toBe("entity");
  });

  it("reads a malformed or reserved properties line without granting anything", async () => {
    const s = await setup("bad");
    const created = await s.caller.document.create({
      projectId: s.project.id,
      folderPath: [],
      title: "Bad",
      contentJson: PARA("x"),
    });
    await injectProperties(s, created.path, {
      type: "source",
      summary: "y".repeat(500),
      reviewExempt: false,
    });
    const row = await s.db.document.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row).toMatchObject({
      wikiType: "source",
      wikiSummary: null,
      reviewExempt: false,
      wikiSourceItemId: null,
    });
  });

  it("gives reviewExempt pages no review block on create, backfill and recovery", async () => {
    const s = await setup("exempt");
    const created = await withProjectRepo(s.project.id, (repo) =>
      writeDocumentInRepo(
        s.db,
        repo,
        s.project.id,
        {
          kind: "create",
          id: randomUUID(),
          folderPath: [],
          title: "Exempt",
          content: { kind: "markdown", contentJson: PARA("body") },
          createdAt: new Date().toISOString(),
          properties: { type: "summary", reviewExempt: true },
        },
        s.actor,
        { operation: "create" },
      ),
    );
    const file = await read(s.project.id, created.path);
    expect(file).not.toMatch(/^(reviewers|reviewEvery|reviewSince): /m);
    expect(file).toContain("properties: ");
    const row = await s.db.document.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row).toMatchObject({
      reviewExempt: true,
      reviewEveryMonths: null,
      reviewDueAt: null,
    });

    expect(await upgradeDocumentHeaders(s.db)).toEqual({
      projects: 0,
      documents: 0,
    });
    expect(await read(s.project.id, created.path)).toBe(file);

    await deleteDocument(
      s.db,
      { projectId: s.project.id, documentId: created.id },
      s.actor,
    );
    const item = (
      await listDeletedContent(
        s.db,
        { projectId: s.project.id, limit: 5 },
        s.actor,
      )
    ).items.find((candidate) => candidate.id === created.id)!;
    const recovered = await applyMcpOperation(s.db, s.actor, {
      idempotencyKey: "wp-recover",
      toolName: "restore_content",
      summary: "Recover",
      operation: {
        kind: "content.restore",
        projectId: s.project.id,
        resourceType: "document",
        resourceId: created.id,
        mode: "deleted",
        sourceSha: item.sourceSha,
        deletedAtSha: item.deletedAtSha,
      },
    });
    const back = await read(s.project.id, recovered.path);
    expect(back).not.toMatch(/^(reviewers|reviewEvery|reviewSince): /m);
    expect(propertiesLine(back)).toBe(propertiesLine(file));
    expect(
      await s.db.document.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ reviewExempt: true, reviewDueAt: null });
  });

  describe("writer", () => {
    const patch = (
      s: Awaited<ReturnType<typeof setup>>,
      doc: { id: string; baseCommitSha: string },
      key: string,
      properties: unknown,
    ) =>
      applyMcpOperation(s.db, s.actor, {
        idempotencyKey: key,
        toolName: "patch_document",
        summary: "Properties",
        operation: contentOperationSchema.parse({
          kind: "document.patch",
          projectId: s.project.id,
          documentId: doc.id,
          baseCommitSha: doc.baseCommitSha,
          actions: [],
          properties,
        }),
      });

    async function page(s: Awaited<ReturnType<typeof setup>>, title = "Ada") {
      const created = await s.caller.document.create({
        projectId: s.project.id,
        folderPath: [],
        title,
        contentJson: PARA("v1"),
      });
      return {
        id: created.id,
        path: created.path,
        baseCommitSha: created.headCommitSha,
      };
    }

    it("commits a properties-only patch, replaces named fields and clears on null", async () => {
      const s = await setup("patch");
      const doc = await page(s);
      const first = await patch(s, doc, "wp-patch-1", {
        type: " entity ",
        summary: "A person",
        tags: ["a", "b"],
      });
      const row = () =>
        s.db.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(await row()).toMatchObject({
        wikiType: "entity",
        wikiSummary: "A person",
        wikiTags: ["a", "b"],
        reviewExempt: false,
      });
      await patch(
        s,
        { id: doc.id, baseCommitSha: first.commitSha },
        "wp-patch-2",
        {
          summary: null,
          tags: ["c"],
        },
      );
      expect(await row()).toMatchObject({
        wikiType: "entity",
        wikiSummary: null,
        wikiTags: ["c"],
      });
      const file = await read(s.project.id, doc.path);
      expect(file).toContain("properties: ");
      expect(parseDocumentFile(file, "markdown").meta.properties).toEqual({
        type: "entity",
        tags: ["c"],
      });
    }, 30_000);

    it("refuses the reserved type in every spelling and any reviewExempt", async () => {
      const s = await setup("reserved");
      for (const type of ["source", "Source", " SOURCE ", "ｓｏｕｒｃｅ"])
        await expect(
          s.caller.document.create({
            projectId: s.project.id,
            folderPath: [],
            title: `T ${type.length}`,
            contentJson: PARA("x"),
            properties: { type },
          }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        s.caller.document.create({
          projectId: s.project.id,
          folderPath: [],
          title: "Exempt",
          contentJson: PARA("x"),
          properties: { reviewExempt: true } as never,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(
        contentOperationSchema.safeParse({
          kind: "document.create",
          projectId: s.project.id,
          folderPath: [],
          title: "T",
          markdown: "x",
          properties: { reviewExempt: true },
        }).success,
      ).toBe(false);
      expect(
        contentOperationSchema.safeParse({
          kind: "document.create",
          projectId: s.project.id,
          folderPath: [],
          title: "T",
          markdown: "x",
          properties: {
            sources: [{ kind: "url", url: "javascript:alert(1)" }],
          },
        }).success,
      ).toBe(false);
      // The metadata override cannot smuggle properties in either.
      expect(
        contentOperationSchema.safeParse({
          kind: "document.create",
          projectId: s.project.id,
          folderPath: [],
          title: "T",
          markdown: "x",
          metadata: { properties: { type: "x" } },
        }).success,
      ).toBe(false);
    }, 30_000);

    it("keeps reserved fields through user writes and refuses changing a source type", async () => {
      const s = await setup("keep");
      const doc = await page(s);
      await injectProperties(s, doc.path, {
        type: "source",
        reviewExempt: true,
        summary: "s",
      });
      const head = await withProjectRepo(s.project.id, (repo) =>
        repo.lastCommitForPath(doc.path),
      );
      const base = { id: doc.id, baseCommitSha: head! };
      await expect(
        patch(s, base, "wp-keep-1", { type: "note" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        patch(s, base, "wp-keep-2", { type: null }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await patch(s, base, "wp-keep-3", { summary: "changed", tags: ["t"] });
      expect(
        parseDocumentFile(await read(s.project.id, doc.path), "markdown").meta
          .properties,
      ).toEqual({
        type: "source",
        summary: "changed",
        tags: ["t"],
        reviewExempt: true,
      });
      // A body save through the editor keeps them as well.
      const current = await s.caller.document.get({
        projectId: s.project.id,
        documentId: doc.id,
      });
      await s.caller.document.update({
        projectId: s.project.id,
        documentId: doc.id,
        baseCommitSha: current.baseCommitSha,
        content: { kind: "markdown", contentJson: PARA("v2") },
        changeSummary: "edit",
        properties: { tags: ["u"] },
      });
      expect(
        parseDocumentFile(await read(s.project.id, doc.path), "markdown").meta
          .properties,
      ).toMatchObject({ type: "source", reviewExempt: true, tags: ["u"] });
    }, 30_000);

    it("sets properties without touching the body and refuses stale heads and viewers", async () => {
      const s = await setup("set");
      const doc = await page(s);
      const viewer = await makeUser("User", "wp-set-viewer");
      await addMembership(s.project.id, viewer.id, "Viewer");
      const before = parseDocumentFile(
        await read(s.project.id, doc.path),
        "markdown",
      );
      const result = await s.caller.document.setProperties({
        projectId: s.project.id,
        documentId: doc.id,
        expectedHeadCommitSha: doc.baseCommitSha,
        properties: { type: "concept", tags: ["x"] },
      });
      const after = parseDocumentFile(
        await read(s.project.id, doc.path),
        "markdown",
      );
      expect(after.body).toBe(before.body);
      expect(after.meta.properties).toEqual({ type: "concept", tags: ["x"] });
      expect(after.meta.review).toEqual(before.meta.review);
      expect(
        await s.db.document.findUniqueOrThrow({ where: { id: doc.id } }),
      ).toMatchObject({
        wikiType: "concept",
        headCommitSha: result.headCommitSha,
      });
      await expect(
        s.caller.document.setProperties({
          projectId: s.project.id,
          documentId: doc.id,
          expectedHeadCommitSha: doc.baseCommitSha,
          properties: { type: "topic" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        setDocumentProperties(
          s.db,
          {
            projectId: s.project.id,
            documentId: doc.id,
            expectedHeadCommitSha: result.headCommitSha,
            properties: { type: "topic" },
          },
          { ...securityContextFor(viewer), name: null, email: viewer.email },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }, 30_000);

    it("clears reviewExempt when a human sets review settings", async () => {
      const s = await setup("clear");
      const exempt = await withProjectRepo(s.project.id, (repo) =>
        writeDocumentInRepo(
          s.db,
          repo,
          s.project.id,
          {
            kind: "create",
            id: randomUUID(),
            folderPath: [],
            title: "Exempt",
            content: { kind: "markdown", contentJson: PARA("body") },
            createdAt: new Date().toISOString(),
            properties: { type: "summary", reviewExempt: true },
          },
          s.actor,
          { operation: "create" },
        ),
      );
      await setDocumentReview(
        s.db,
        {
          projectId: s.project.id,
          documentId: exempt.id,
          expectedHeadCommitSha: exempt.headCommitSha,
          everyMonths: 6,
        },
        s.actor,
      );
      const file = await read(s.project.id, exempt.path);
      const meta = parseDocumentFile(file, "markdown").meta;
      expect(meta.properties).toEqual({ type: "summary" });
      expect(meta.review?.everyMonths).toBe(6);
      expect(
        await s.db.document.findUniqueOrThrow({ where: { id: exempt.id } }),
      ).toMatchObject({
        reviewExempt: false,
        wikiType: "summary",
        reviewEveryMonths: 6,
      });
    }, 30_000);

    it("resolves source ids inside the project only and shows the rest as unavailable", async () => {
      const s = await setup("src");
      const other = await makeProject("WP-src-other");
      await addMembership(other.id, s.owner.id, "Owner");
      const near = await page(s, "Near");
      const far = await s.caller.document.create({
        projectId: other.id,
        folderPath: [],
        title: "Far secret title",
        contentJson: PARA("x"),
      });
      const doc = await page(s, "Holder");
      await s.caller.document.setProperties({
        projectId: s.project.id,
        documentId: doc.id,
        expectedHeadCommitSha: doc.baseCommitSha,
        properties: {
          sources: [
            { kind: "document", id: near.id },
            { kind: "document", id: far.id },
            { kind: "url", url: "https://example.test/x" },
            { kind: "table", id: randomUUID() },
          ],
        },
      });
      const got = await s.caller.document.get({
        projectId: s.project.id,
        documentId: doc.id,
      });
      expect(got.properties?.sources).toEqual([
        { kind: "document", id: near.id, available: true, title: "Near" },
        { kind: "document", id: far.id, available: false },
        { kind: "url", url: "https://example.test/x" },
        expect.objectContaining({ kind: "table", available: false }),
      ]);
      expect(JSON.stringify(got.properties)).not.toContain("Far secret");
      await expect(
        s.caller.document.setProperties({
          projectId: s.project.id,
          documentId: doc.id,
          expectedHeadCommitSha: (got as { baseCommitSha: string })
            .baseCommitSha,
          properties: { sources: [{ kind: "url", url: "ftp://x.test/a" }] },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }, 30_000);

    it("filters the list by type and tag and returns summaries on request", async () => {
      const s = await setup("list");
      const a = await page(s, "Alpha");
      const b = await page(s, "Beta");
      await page(s, "Gamma");
      await s.caller.document.setProperties({
        projectId: s.project.id,
        documentId: a.id,
        expectedHeadCommitSha: a.baseCommitSha,
        properties: { type: "Entity", summary: "first", tags: ["red"] },
      });
      await s.caller.document.setProperties({
        projectId: s.project.id,
        documentId: b.id,
        expectedHeadCommitSha: b.baseCommitSha,
        properties: { type: "concept", tags: ["red", "blue"] },
      });
      const list = (extra: object) =>
        s.caller.document.list({
          projectId: s.project.id,
          ...extra,
        } as never);
      expect(
        (await list({ type: "entity" })).items.map((i) => i.title),
      ).toEqual(["Alpha"]);
      expect(
        (await list({ tag: "red", sort: "title", dir: "asc" })).items.map(
          (i) => i.title,
        ),
      ).toEqual(["Alpha", "Beta"]);
      expect((await list({ tag: "blue" })).total).toBe(1);
      const withSummary = await list({ type: "entity", includeSummary: true });
      expect(withSummary.items[0]).toMatchObject({
        wikiType: "Entity",
        wikiSummary: "first",
      });
      expect((await list({ type: "entity" })).items[0]).not.toHaveProperty(
        "wikiSummary",
      );
    }, 30_000);

    it("pages the index grouped by type with untyped last, links the overview", async () => {
      const s = await setup("index");
      const make = async (title: string, properties?: object) => {
        const doc = await page(s, title);
        if (properties)
          await s.caller.document.setProperties({
            projectId: s.project.id,
            documentId: doc.id,
            expectedHeadCommitSha: doc.baseCommitSha,
            properties,
          });
        return doc;
      };
      const overview = await make("Home", { type: "overview" });
      await make("Zed", { type: "entity", summary: "last entity" });
      await make("Ada", { type: "Entity" });
      await make("Plain");
      await make("Digest", { type: "summary" });
      await s.db.projectWikiSettings.create({
        data: { projectId: s.project.id, overviewDocumentId: overview.id },
      });

      const first = await s.caller.document.pageIndex({
        projectId: s.project.id,
        limit: 3,
      });
      expect(first.pages.map((p) => [p.type, p.title])).toEqual([
        ["Entity", "Ada"],
        ["entity", "Zed"],
        ["overview", "Home"],
      ]);
      expect(first.overview).toEqual({ id: overview.id, title: "Home" });
      expect(first.nextCursor).not.toBeNull();
      const second = await s.caller.document.pageIndex({
        projectId: s.project.id,
        limit: 3,
        cursor: first.nextCursor!,
      });
      expect(second.pages.map((p) => [p.type, p.title])).toEqual([
        ["summary", "Digest"],
        [null, "Plain"],
      ]);
      expect(second.nextCursor).toBeNull();
      await expect(
        s.caller.document.pageIndex({
          projectId: s.project.id,
          cursor: "not-a-cursor",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const stranger = await makeUser("User", "wp-index-stranger");
      await expect(
        callerFor(stranger).document.pageIndex({ projectId: s.project.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }, 30_000);
  });
});

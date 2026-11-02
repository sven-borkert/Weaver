import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { withProjectRepo } from "@weaver/git-store";
import { upgradeDocumentHeaders } from "@weaver/core/services/documentHeaderUpgrade";
import { markDocumentReviewed } from "@weaver/core/services/documentReview";
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
});

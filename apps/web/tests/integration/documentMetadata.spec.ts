import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { createConversation } from "@weaver/core/services/assistantConversations";
import { createProposal } from "@weaver/core/services/assistantProposals";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import { upgradeDocumentHeaders } from "@weaver/core/services/documentHeaderUpgrade";
import {
  createDocument,
  getDocument,
  getDocumentAtSnapshot,
  listDocuments,
  rebuildIndex,
  saveDocument,
} from "@weaver/core/services/documents";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
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

type User = Awaited<ReturnType<typeof makeUser>>;

function editor(user: User, name: string) {
  return { ...securityContextFor(user), name, email: user.email };
}

function mcpWriter(user: User, name: string) {
  return {
    ...createApiKeySecurityContext({
      userId: user.id,
      globalRole: user.role,
      keyId: `key-${user.id}`,
      permissions: { mcp: ["use"], content: ["read", "write"] },
      projectIds: [],
    }),
    name,
    email: user.email,
  };
}

async function fixture(suffix: string) {
  const db = getPrisma();
  const ada = await makeUser("User", `${suffix}-ada`);
  const bob = await makeUser("User", `${suffix}-bob`);
  const outsider = await makeUser("User", `${suffix}-out`);
  const project = await makeProject(`Metadata ${suffix}`);
  await addMembership(project.id, ada.id, "Editor");
  await addMembership(project.id, bob.id, "Editor");
  return { db, ada, bob, outsider, project };
}

async function fileAt(projectId: string, path: string) {
  return withProjectRepo(projectId, (repo) => repo.readFileFromWorktree(path));
}

async function headBody(projectId: string) {
  return simpleGit(repoDir(projectId)).raw(["log", "-1", "--format=%B"]);
}

describe("document authorship metadata", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  it("records the creator and keeps them when someone else updates the document", async () => {
    const { db, ada, bob, project } = await fixture("defaults");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Runbook",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("First.\n"),
        },
      },
      editor(ada, "Ada Lovelace"),
    );
    const file = await fileAt(project.id, created.path);
    expect(file).toContain(
      `createdBy: {"id":"${ada.id}","name":"Ada Lovelace"}`,
    );
    expect(file).toContain(
      `updatedBy: {"id":"${ada.id}","name":"Ada Lovelace"}`,
    );

    const first = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      editor(bob, "Bob"),
    );
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: created.id,
        baseCommitSha: first.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Second.\n"),
        },
        changeSummary: "",
      },
      editor(bob, "Bob Builder"),
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      editor(bob, "Bob"),
    );
    expect(read.createdAt).toEqual(first.createdAt);
    // The creator's current account name wins over the name stored in Git.
    expect(read.createdBy).toEqual({ id: ada.id, name: "User defaults-ada" });
    expect(read.updatedBy).toEqual({ id: bob.id, name: "User defaults-bob" });
    expect(read.updatedAt.getTime()).toBeGreaterThanOrEqual(
      read.createdAt.getTime(),
    );

    const listed = await listDocuments(
      db,
      {
        projectId: project.id,
        page: 1,
        pageSize: 10,
        sort: "createdAt",
        dir: "asc",
      },
      editor(ada, "Ada"),
    );
    expect(listed.items[0]).toMatchObject({
      createdBy: { id: ada.id },
      updatedBy: { id: bob.id },
    });
  });

  it("lets an MCP import backdate a document and name an author outside Weaver", async () => {
    const { db, ada, project } = await fixture("import");
    const actor = mcpWriter(ada, "Ada");
    const result = await applyMcpOperation(db, actor, {
      idempotencyKey: "import-old-0001",
      toolName: "create_document",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Truncate alert tables",
        markdown: "Truncate the tables.\n",
        metadata: {
          created: "2020-03-11T10:00:00+01:00",
          createdBy: { name: "Sven Borkert" },
          updated: "2020-03-12T08:30:00Z",
        },
      },
      summary: "Import an old runbook",
    });
    const read = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: result.resourceId! },
      actor,
    );
    expect(read.metadata).toEqual({
      createdAt: new Date("2020-03-11T09:00:00.000Z"),
      createdBy: { id: null, name: "Sven Borkert" },
      updatedAt: new Date("2020-03-12T08:30:00.000Z"),
      updatedBy: { id: ada.id, name: "User import-ada" },
    });
    // Git still records who really wrote it, and what they set by hand.
    const body = await headBody(project.id);
    expect(body).toContain(`Weaver-User-Id: ${ada.id}`);
    expect(body).toContain(
      "Weaver-Metadata-Override: created,createdBy,updated",
    );

    const row = await db.document.findUniqueOrThrow({
      where: { id: result.resourceId! },
    });
    expect(row).toMatchObject({
      createdAt: new Date("2020-03-11T09:00:00.000Z"),
      createdById: null,
      createdByName: "Sven Borkert",
      updatedById: ada.id,
    });
    // Recent activity still sees the import happen now.
    expect(row.lastEditedAt.getTime()).toBeGreaterThan(
      Date.now() - 60 * 60 * 1000,
    );
  });

  it("rejects future dates, reversed dates and authors who are not project members", async () => {
    const { db, ada, bob, outsider, project } = await fixture("invalid");
    const actor = mcpWriter(ada, "Ada");
    const attempt = (key: string, metadata: object) =>
      applyMcpOperation(db, actor, {
        idempotencyKey: key,
        toolName: "create_document",
        operation: {
          kind: "document.create",
          projectId: project.id,
          folderPath: [],
          title: `Doc ${key}`,
          markdown: "Body\n",
          metadata,
        },
        summary: "Create",
      });
    await expect(
      attempt("future-0001", { created: "2999-01-01T00:00:00Z" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "metadata.created" },
    });
    await expect(
      attempt("reverse-0001", {
        created: "2021-01-01T00:00:00Z",
        updated: "2020-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "metadata.updated" },
    });
    await expect(
      attempt("outsider-0001", { createdBy: { userId: outsider.id } }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "metadata.createdBy" },
    });
    await expect(
      attempt("badname-0001", { createdBy: { name: "Two\nlines" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const member = await attempt("member-0001", {
      createdBy: { userId: bob.id },
    });
    const row = await db.document.findUniqueOrThrow({
      where: { id: member.resourceId! },
    });
    expect(row).toMatchObject({
      createdById: bob.id,
      createdByName: "User invalid-bob",
    });
  });

  it("changes only the metadata with a metadata-only patch", async () => {
    const { db, ada, project } = await fixture("patch");
    const actor = mcpWriter(ada, "Ada");
    const created = await applyMcpOperation(db, actor, {
      idempotencyKey: "patch-create-0001",
      toolName: "create_document",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Notes",
        markdown: "Keep this body.\n",
      },
      summary: "Create",
    });
    const before = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: created.resourceId! },
      actor,
    );
    await applyMcpOperation(db, actor, {
      idempotencyKey: "patch-meta-0001",
      toolName: "patch_document",
      operation: {
        kind: "document.patch",
        projectId: project.id,
        documentId: created.resourceId!,
        baseCommitSha: before.baseCommitSha,
        actions: [],
        metadata: { created: "2019-05-01T00:00:00Z" },
      },
      summary: "Backdate",
    });
    const after = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: created.resourceId! },
      actor,
    );
    expect(after.markdown).toBe(before.markdown);
    expect(after.metadata.createdAt).toEqual(
      new Date("2019-05-01T00:00:00.000Z"),
    );
    expect(after.metadata.createdBy).toEqual(before.metadata.createdBy);
  });

  it("shows metadata on the proposal card and refuses invalid metadata when proposed", async () => {
    const { db, ada, outsider, project } = await fixture("proposal");
    const actor = editor(ada, "Ada");
    const conversation = await createConversation(db, actor, {});
    const { run } = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "import",
      scope: { kind: "project", projectId: project.id },
    });
    const operation = {
      kind: "document.create" as const,
      projectId: project.id,
      folderPath: [],
      title: "Old runbook",
      markdown: "Body\n",
    };
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Import an old runbook",
      operation: {
        ...operation,
        metadata: {
          created: "2020-03-11T09:00:00Z",
          createdBy: { name: "Sven Borkert" },
        },
      },
    });
    const lines = (proposal.preview as { lines: Array<{ text: string }> })
      .lines;
    expect(lines.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        "Created: 2020-03-11T09:00:00.000Z",
        "Created by: Sven Borkert",
      ]),
    );
    await expect(
      createProposal(db, actor, {
        conversationId: conversation.id,
        runId: run.id,
        summary: "Attribute to an outsider",
        operation: {
          ...operation,
          title: "Other",
          metadata: { createdBy: { userId: outsider.id } },
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("backfills authors of older documents from Git history in one system commit", async () => {
    const { db, ada, bob, project } = await fixture("backfill");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Legacy",
        content: { kind: "markdown", contentJson: parseDocumentBody("Old.\n") },
      },
      editor(ada, "Ada"),
    );
    const legacy = (updated: string, body: string) =>
      composeDocumentFile(
        {
          id: created.id,
          title: "Legacy",
          created: "2026-01-01T00:00:00.000Z",
          createdBy: null,
          updated,
          updatedBy: null,
          review: null,
        },
        body,
        "markdown",
      );
    // Rewrite history's shape: the file as Weaver wrote it before authorship.
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        created.path,
        legacy("2026-01-01T00:00:00.000Z", "Old.\n"),
      );
      await repo.commitAll("update: legacy", {
        name: "Ada",
        email: ada.email,
        userId: ada.id,
      });
      await repo.writeFileAtomic(
        created.path,
        legacy("2026-02-01T00:00:00.000Z", "Newer.\n"),
      );
      await repo.commitAll("update: legacy", {
        name: "Bob",
        email: bob.email,
        userId: bob.id,
      });
    });
    // The projection as it was before authorship existed.
    await db.document.update({
      where: { id: created.id },
      data: { createdByName: null, updatedByName: null },
    });

    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 1,
    });
    const file = await fileAt(project.id, created.path);
    expect(file).toContain(
      `createdBy: {"id":"${ada.id}","name":"User backfill-ada"}`,
    );
    expect(file).toContain(
      `updatedBy: {"id":"${bob.id}","name":"User backfill-bob"}`,
    );
    expect(file).toContain("updated: 2026-02-01T00:00:00.000Z");
    expect(file).toContain("Newer.");
    expect(await headBody(project.id)).toContain(
      "chore: upgrade document headers",
    );
    expect(
      await db.document.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({
      createdById: ada.id,
      createdByName: "User backfill-ada",
      updatedById: bob.id,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  async function stripReview(
    projectId: string,
    path: string,
    ada: User,
    message = "test: strip review block",
  ) {
    await withProjectRepo(projectId, async (repo) => {
      const text = await repo.readFileFromWorktree(path);
      await repo.writeFileAtomic(
        path,
        text.replace(/reviewers: [\s\S]*?(?=-->)/, ""),
      );
      await repo.commitAll(message, {
        userId: ada.id,
        email: ada.email,
        name: "Ada",
      });
    });
  }

  async function headSha(projectId: string) {
    return (await simpleGit(repoDir(projectId)).revparse(["HEAD"])).trim();
  }

  async function ownerFixture(suffix: string) {
    const base = await fixture(suffix);
    const owner = await makeUser("User", `${suffix}-owner`);
    await addMembership(base.project.id, owner.id, "Owner");
    return { ...base, owner };
  }

  const newDoc = (
    db: ReturnType<typeof getPrisma>,
    projectId: string,
    ada: User,
    title: string,
  ) =>
    createDocument(
      db,
      {
        projectId,
        folderPath: [],
        title,
        content: { kind: "markdown", contentJson: parseDocumentBody("x") },
      },
      editor(ada, "Ada"),
    );

  it("adds review metadata to documents that lack it", async () => {
    const { db, ada, owner, project } = await ownerFixture("rev-upgrade");
    const doc = await newDoc(db, project.id, ada, "Old");
    await stripReview(project.id, doc.path, ada);
    await db.project.update({
      where: { id: project.id },
      data: { documentHeaderVersion: 2 },
    });
    await db.document.update({
      where: { id: doc.id },
      data: {
        reviewEveryMonths: null,
        reviewSince: null,
        reviewDueAt: null,
      },
    });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 1,
    });
    expect(await headBody(project.id)).toContain(
      "chore: add document review metadata",
    );
    const file = await fileAt(project.id, doc.path);
    expect(file).toMatch(/reviewEvery: 12\nreviewSince: \S+\n-->/);
    expect(file).toContain(`"id":"${owner.id}"`);
    const row = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.reviewDueAt).not.toBeNull();
    expect(row.reviewEveryMonths).toBe(12);
    expect(
      await db.documentReviewer.findMany({ where: { documentId: doc.id } }),
    ).toMatchObject([{ type: "user", refId: owner.id }]);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: project.id } }))
        .documentHeaderVersion,
    ).toBe(3);
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("upgrades a legacy document and a review-less one in one commit with one reviewSince", async () => {
    const { db, ada, project } = await ownerFixture("rev-mixed");
    const legacyDoc = await newDoc(db, project.id, ada, "Legacy");
    const plain = await newDoc(db, project.id, ada, "Plain");
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        legacyDoc.path,
        `---\nid: ${legacyDoc.id}\ntitle: "Legacy"\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\n\nx\n`,
      );
      await repo.commitAll("update: old format", {
        name: "Ada",
        email: ada.email,
        userId: ada.id,
      });
    });
    await stripReview(project.id, plain.path, ada);
    await db.project.update({
      where: { id: project.id },
      data: { documentHeaderVersion: 2 },
    });

    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 2,
    });
    expect(await headBody(project.id)).toContain(
      "chore: upgrade document headers",
    );
    const since = [legacyDoc, plain].map(
      async (doc) =>
        /reviewEvery: 12\nreviewSince: (\S+)\n-->/.exec(
          await fileAt(project.id, doc.path),
        )?.[1],
    );
    const [first, second] = await Promise.all(since);
    expect(first).toBeDefined();
    expect(first).toBe(second);
    for (const doc of [legacyDoc, plain])
      expect(
        (await db.document.findUniqueOrThrow({ where: { id: doc.id } }))
          .reviewEveryMonths,
      ).toBe(12);
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("leaves documents that already have a review block byte-identical", async () => {
    const { db, ada, owner, project } = await ownerFixture("rev-keep");
    const fresh = await newDoc(db, project.id, ada, "Fresh");
    const reviewed = await newDoc(db, project.id, ada, "Reviewed");
    const lacking = await newDoc(db, project.id, ada, "Lacking");
    const author = { id: ada.id, name: "Ada" };
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        reviewed.path,
        composeDocumentFile(
          {
            id: reviewed.id,
            title: "Reviewed",
            created: "2026-01-01T00:00:00.000Z",
            createdBy: author,
            updated: "2026-01-02T00:00:00.000Z",
            updatedBy: author,
            review: {
              reviewers: [{ type: "user", id: owner.id, name: "Owner" }],
              everyMonths: 6,
              since: "2026-01-01T00:00:00.000Z",
              lastReviewed: "2026-03-01T00:00:00.000Z",
              reviewedBy: author,
            },
          },
          "x",
          "markdown",
        ),
      );
      await repo.commitAll("update: reviewed", {
        name: "Ada",
        email: ada.email,
        userId: ada.id,
      });
    });
    const maintainer = await makeUser("User", "rev-keep-maint");
    await addMembership(project.id, maintainer.id, "Maintainer");
    await rebuildIndex(
      db,
      { projectId: project.id },
      securityContextFor(maintainer),
    );
    await stripReview(project.id, lacking.path, ada);
    await db.project.update({
      where: { id: project.id },
      data: { documentHeaderVersion: 2 },
    });
    const before = {
      fresh: await fileAt(project.id, fresh.path),
      reviewed: await fileAt(project.id, reviewed.path),
    };

    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 1,
    });
    expect(await fileAt(project.id, fresh.path)).toBe(before.fresh);
    expect(await fileAt(project.id, reviewed.path)).toBe(before.reviewed);
    expect(await fileAt(project.id, lacking.path)).toMatch(/reviewEvery: 12/);
    expect(
      await db.document.findUniqueOrThrow({ where: { id: reviewed.id } }),
    ).toMatchObject({
      reviewEveryMonths: 6,
      lastReviewedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("repairs review columns that lag behind a current file without a commit", async () => {
    const { db, ada, owner, project } = await ownerFixture("rev-lag");
    const doc = await newDoc(db, project.id, ada, "Lagging");
    await db.documentReviewer.deleteMany({ where: { documentId: doc.id } });
    await db.document.update({
      where: { id: doc.id },
      data: {
        reviewEveryMonths: null,
        reviewSince: null,
        reviewDueAt: null,
      },
    });
    const head = await headSha(project.id);

    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 0,
    });
    expect(await headSha(project.id)).toBe(head);
    expect(
      await db.document.findUniqueOrThrow({ where: { id: doc.id } }),
    ).toMatchObject({ reviewEveryMonths: 12 });
    expect(
      await db.documentReviewer.findMany({ where: { documentId: doc.id } }),
    ).toMatchObject([{ type: "user", refId: owner.id }]);
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("drains an unparseable document after the others are upgraded", async () => {
    const { db, ada, owner, project } = await ownerFixture("rev-drain");
    const broken = await newDoc(db, project.id, ada, "Broken");
    const plain = await newDoc(db, project.id, ada, "Plain");
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(broken.path, "not a weaver document\n");
      await repo.commitAll("update: broken by hand", {
        name: "Ada",
        email: ada.email,
        userId: ada.id,
      });
    });
    await stripReview(project.id, plain.path, ada);
    await db.document.updateMany({
      where: { id: { in: [broken.id, plain.id] } },
      data: { reviewEveryMonths: null, reviewSince: null, reviewDueAt: null },
    });

    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 1,
    });
    const plainFile = await fileAt(project.id, plain.path);
    const plainSince = /reviewSince: (\S+)\n/.exec(plainFile)?.[1];
    expect(plainSince).toBeDefined();
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 0,
    });
    const plainRow = await db.document.findUniqueOrThrow({
      where: { id: plain.id },
    });
    expect(plainRow.reviewEveryMonths).toBe(12);
    expect(plainRow.reviewSince).toEqual(new Date(plainSince!));
    expect(plainRow.reviewDueAt).toEqual(new Date(plainSince!));
    expect(
      await db.documentReviewer.findMany({ where: { documentId: plain.id } }),
    ).toMatchObject([{ type: "user", refId: owner.id }]);
    expect(
      await db.document.findUniqueOrThrow({ where: { id: broken.id } }),
    ).toMatchObject({ reviewEveryMonths: 12 });
    expect(
      (await db.document.findUniqueOrThrow({ where: { id: broken.id } }))
        .reviewDueAt,
    ).not.toBeNull();
    expect(await fileAt(project.id, broken.path)).toBe(
      "not a weaver document\n",
    );
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("drains an orphan row and leaves the sibling's projection equal to its file", async () => {
    const { db, ada, project } = await ownerFixture("rev-orphan");
    const doc = await newDoc(db, project.id, ada, "Foreign id");
    const sibling = await newDoc(db, project.id, ada, "Sibling");
    // The file at the row's path now belongs to another document id.
    await withProjectRepo(project.id, async (repo) => {
      const { meta, body } = parseDocumentFile(
        await repo.readFileFromWorktree(doc.path),
        "markdown",
      );
      await repo.writeFileAtomic(
        doc.path,
        composeDocumentFile(
          { ...meta, id: "11111111-1111-4111-8111-111111111111" },
          body,
          "markdown",
        ),
      );
      await repo.commitAll("test: file carries another id", {
        userId: ada.id,
        email: ada.email,
        name: "Ada",
      });
    });
    await db.document.updateMany({
      where: { id: { in: [doc.id, sibling.id] } },
      data: { reviewEveryMonths: null, reviewSince: null, reviewDueAt: null },
    });
    const head = await headSha(project.id);

    await upgradeDocumentHeaders(db);
    await upgradeDocumentHeaders(db);
    expect(await headSha(project.id)).toBe(head);
    const orphan = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(orphan.reviewEveryMonths).toBe(12);
    expect(orphan.reviewSince).not.toBeNull();
    expect(orphan.reviewDueAt).toEqual(orphan.reviewSince);
    const { meta } = parseDocumentFile(
      await fileAt(project.id, sibling.path),
      "markdown",
    );
    expect(
      await db.document.findUniqueOrThrow({ where: { id: sibling.id } }),
    ).toMatchObject({
      reviewEveryMonths: meta.review!.everyMonths,
      reviewSince: new Date(meta.review!.since),
    });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("drains a row whose file parses but is rejected as a projection candidate", async () => {
    const { db, ada, project } = await ownerFixture("rev-badtitle");
    const doc = await newDoc(db, project.id, ada, "Too long soon");
    await withProjectRepo(project.id, async (repo) => {
      const { meta, body } = parseDocumentFile(
        await repo.readFileFromWorktree(doc.path),
        "markdown",
      );
      await repo.writeFileAtomic(
        doc.path,
        composeDocumentFile(
          { ...meta, title: "x".repeat(201) },
          body,
          "markdown",
        ),
      );
      await repo.commitAll("test: title over the limit", {
        userId: ada.id,
        email: ada.email,
        name: "Ada",
      });
    });
    await db.documentReviewer.deleteMany({ where: { documentId: doc.id } });
    await db.document.update({
      where: { id: doc.id },
      data: { reviewEveryMonths: null, reviewSince: null, reviewDueAt: null },
    });
    const head = await headSha(project.id);

    await upgradeDocumentHeaders(db);
    await upgradeDocumentHeaders(db);
    expect(await headSha(project.id)).toBe(head);
    expect(
      await db.document.findUniqueOrThrow({ where: { id: doc.id } }),
    ).toMatchObject({ reviewEveryMonths: 12 });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("finishes a project with more documents than the per-pass cap over several passes", async () => {
    const { db, ada, project } = await ownerFixture("rev-cap");
    const docs = [];
    for (const title of ["A", "B", "C", "D", "E"]) {
      const doc = await newDoc(db, project.id, ada, title);
      docs.push(doc);
    }
    for (const doc of docs) await stripReview(project.id, doc.path, ada);
    await db.project.update({
      where: { id: project.id },
      data: { documentHeaderVersion: 2 },
    });
    const version = async () =>
      (await db.project.findUniqueOrThrow({ where: { id: project.id } }))
        .documentHeaderVersion;
    const commits = async () =>
      Number(
        (
          await simpleGit(repoDir(project.id)).raw([
            "rev-list",
            "--count",
            "HEAD",
          ])
        ).trim(),
      );
    let count = await commits();

    for (const [expected, current] of [
      [2, false],
      [2, false],
      [1, true],
    ] as const) {
      expect(
        await upgradeDocumentHeaders(db, { documentsPerProject: 2 }),
      ).toEqual({ projects: 1, documents: expected });
      expect(await commits()).toBe(++count);
      expect(await version()).toBe(current ? 3 : 2);
    }
    expect(
      await upgradeDocumentHeaders(db, { documentsPerProject: 2 }),
    ).toEqual({ projects: 0, documents: 0 });
    expect(await commits()).toBe(count);
    for (const doc of docs)
      expect(await fileAt(project.id, doc.path)).toMatch(/reviewEvery: 12/);
  });

  it("converts YAML frontmatter files to the hidden header with a title heading", async () => {
    const { db, ada, project } = await fixture("convert");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Setup (v2) *draft*",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Body text.\n"),
        },
      },
      editor(ada, "Ada"),
    );
    const yaml =
      `---\nid: ${created.id}\ntitle: "Setup (v2) *draft*"\n` +
      `created: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\n\nBody text.\n`;
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(created.path, yaml);
      await repo.commitAll("update: old format", {
        name: "Ada",
        email: ada.email,
        userId: ada.id,
      });
    });
    await db.project.update({
      where: { id: project.id },
      data: { documentHeaderVersion: 1 },
    });

    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 1,
    });
    const file = await fileAt(project.id, created.path);
    const since = /reviewSince: (\S+)\n/.exec(file)?.[1];
    expect(file).toBe(
      `<!-- weaver\nid: ${created.id}\ncreated: 2026-01-01T00:00:00.000Z\n` +
        `createdBy: {"id":"${ada.id}","name":"User convert-ada"}\n` +
        `updated: 2026-01-02T00:00:00.000Z\n` +
        `updatedBy: {"id":"${ada.id}","name":"User convert-ada"}\n` +
        `reviewers: []\nreviewEvery: 12\nreviewSince: ${since}\n-->\n\n` +
        `# Setup (v2) \\*draft\\*\n\nBody text.\n`,
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      editor(ada, "Ada"),
    );
    expect(read.title).toBe("Setup (v2) *draft*");
    expect(
      await db.project.findUniqueOrThrow({ where: { id: project.id } }),
    ).toMatchObject({ documentHeaderVersion: 3 });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("stops reselecting a project whose stale rows cannot be repaired", async () => {
    const { db, ada, project } = await fixture("stuck");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Broken",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Body.\n"),
        },
      },
      editor(ada, "Ada"),
    );
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(created.path, "not a weaver document\n");
      await repo.commitAll("update: broken by hand", {
        name: "Ada",
        email: ada.email,
        userId: ada.id,
      });
    });
    await db.document.update({
      where: { id: created.id },
      data: { createdByName: null, updatedByName: null },
    });

    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 1,
      documents: 0,
    });
    expect(
      await db.document.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({
      createdById: null,
      createdByName: "Unknown author",
      updatedById: null,
      updatedByName: "Unknown author",
    });
    expect(await upgradeDocumentHeaders(db)).toEqual({
      projects: 0,
      documents: 0,
    });
  });

  it("keeps an author's name but no link when the file names an unknown user", async () => {
    const { db, ada, project } = await fixture("unknown");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Pulled",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Body.\n"),
        },
      },
      editor(ada, "Ada"),
    );
    const stranger = "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b";
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        created.path,
        composeDocumentFile(
          {
            id: created.id,
            title: "Pulled",
            created: "2026-01-01T00:00:00.000Z",
            createdBy: { id: stranger, name: "Remote Author" },
            updated: "2026-01-02T00:00:00.000Z",
            updatedBy: { id: stranger, name: "Remote Author" },
            review: null,
          },
          "Body.\n",
          "markdown",
        ),
      );
      await repo.commitAll("update: pulled", {
        name: "Ada",
        email: ada.email,
        userId: ada.id,
      });
    });
    const maintainer = await makeUser("User", "unknown-maint");
    await addMembership(project.id, maintainer.id, "Maintainer");
    await rebuildIndex(
      db,
      { projectId: project.id },
      securityContextFor(maintainer),
    );
    expect(
      await db.document.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({
      createdById: null,
      createdByName: "Remote Author",
      updatedById: null,
    });
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      editor(ada, "Ada"),
    );
    expect(read.createdBy).toEqual({ id: null, name: "Remote Author" });
  });
});

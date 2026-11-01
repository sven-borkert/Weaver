import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { repoDir } from "@weaver/git-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import {
  composeFolderMetadata,
  composeRootFolderMetadata,
  newFolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import type { ReviewerRef } from "@weaver/core/documents/review";
import { receiveTransferredDocument } from "@weaver/core/services/remoteInstances/receive";
import { buildAcceptOperation } from "@weaver/core/services/ingestionAccept";
import { addMonthsUtc } from "@weaver/core/documents/review";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  importDocumentArchiveEntry,
  importDocumentFile,
} from "@weaver/core/services/documentImport";
import {
  createDocument,
  deleteDocument,
  documentMetadataColumns,
  getDocument,
  moveDocument,
  rebuildIndex,
  restoreDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";
import { createFolder } from "@weaver/core/services/folders";
import {
  countDocumentsToReview,
  isReviewerAnywhere,
  listDocumentsToReview,
  listRecentlyReviewed,
  markDocumentReviewed,
  reviewPermissions,
  setDocumentReview,
} from "@weaver/core/services/documentReview";
import { addMember, removeMember } from "@weaver/core/services/projectMembers";
import { setUserMembership } from "@weaver/core/services/users";
import {
  createReviewerGroup,
  setReviewDefaults,
  setReviewerGroupMembers,
} from "@weaver/core/services/reviewerGroups";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import * as projectRepo from "@weaver/core/services/projectRepo";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

type User = Awaited<ReturnType<typeof makeUser>>;

const body = (text: string) => parseDocumentBody(`${text}\n`);

function actorFor(user: User, name: string) {
  return { ...securityContextFor(user), name, email: user.email };
}

async function fixture(suffix: string) {
  const db = getPrisma();
  const owner = {
    ...(await makeUser("User", `${suffix}-owner`)),
    name: `User ${suffix}-owner`,
  };
  const ada = {
    ...(await makeUser("User", `${suffix}-ada`)),
    name: `User ${suffix}-ada`,
  };
  const vic = {
    ...(await makeUser("User", `${suffix}-vic`)),
    name: `User ${suffix}-vic`,
  };
  const project = await makeProject(`Review ${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, ada.id, "Editor");
  await addMembership(project.id, vic.id, "Viewer");
  return {
    db,
    owner,
    ada,
    vic,
    project,
    adaActor: actorFor(ada, "Ada"),
    vicActor: actorFor(vic, "Vic"),
  };
}

async function fileAt(projectId: string, path: string) {
  return withProjectRepo(projectId, (repo) => repo.readFileFromWorktree(path));
}

const reviewLines = (file: string) =>
  file
    .split("\n")
    .filter((line) =>
      /^(reviewers|reviewEvery|reviewSince|lastReviewed|reviewedBy): /.test(
        line,
      ),
    );

describe("document review through the write paths", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  async function storeDefaults(
    f: Awaited<ReturnType<typeof fixture>>,
    path: string[],
    reviewers: ReviewerRef[],
  ) {
    await withProjectRepo(f.project.id, async (repo) => {
      const metadata = path.length
        ? composeFolderMetadata({
            ...newFolderMetadata(
              path.at(-1)!,
              { id: f.ada.id, name: "Ada" },
              new Date(),
            ),
            reviewDefaults: { reviewers },
          })
        : composeRootFolderMetadata({ reviewDefaults: { reviewers } });
      await repo.writeFileAtomic([...path, ".folder.json"].join("/"), metadata);
      await repo.commitAll("test: folder defaults", {
        name: "Ada",
        email: f.ada.email,
        userId: f.ada.id,
      });
    });
  }

  it("all_create_entrypoints_materialize_nearest_folder_reviewers", async () => {
    const f = await fixture("folder-entrypoints");
    await setReviewDefaults(
      f.db,
      {
        projectId: f.project.id,
        everyMonths: 7,
        reviewers: [{ type: "user", id: f.owner.id }],
      },
      actorFor(f.owner, "Owner"),
    );
    const reviewers: ReviewerRef[] = [
      { type: "user", id: f.ada.id, name: f.ada.name! },
    ];
    await storeDefaults(
      f,
      [],
      [{ type: "user", id: f.vic.id, name: f.vic.name! }],
    );
    await storeDefaults(f, ["guides"], reviewers);
    await createFolder(
      f.db,
      { projectId: f.project.id, parentPath: ["guides"], name: "Nested" },
      f.adaActor,
    );
    const ui = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: ["guides", "nested"],
        title: "UI",
        content: { kind: "markdown", contentJson: body("ui") },
      },
      f.adaActor,
    );
    const mcpActor = createApiKeySecurityContext({
      userId: f.ada.id,
      globalRole: f.ada.role,
      keyId: "folder-key",
      permissions: { mcp: ["use"], content: ["read", "write"] },
      projectIds: [f.project.id],
    });
    const mcp = await applyMcpOperation(
      f.db,
      { ...mcpActor, name: "Ada", email: f.ada.email },
      {
        toolName: "create_document",
        idempotencyKey: "folder-defaults-mcp",
        summary: "Create",
        operation: {
          kind: "document.create",
          projectId: f.project.id,
          folderPath: ["guides", "nested"],
          title: "MCP",
          markdown: "mcp",
        },
      },
    );
    const draft = buildAcceptOperation(f.project.id, {
      targetKind: "document",
      proposedTitle: "Draft",
      proposedFolderPath: "guides/nested",
      markdown: "draft",
      columns: null,
      rows: null,
      links: [],
    });
    const accepted = await applyMcpOperation(
      f.db,
      { ...mcpActor, name: "Ada", email: f.ada.email },
      {
        toolName: "create_document",
        idempotencyKey: "folder-defaults-draft",
        summary: "Accept draft",
        operation: draft,
      },
    );
    const remote = await receiveTransferredDocument(
      f.db,
      f.adaActor,
      {
        fromClientId: null,
        projectId: f.project.id,
        folderPath: ["guides", "nested"],
        title: "Remote",
        markdown: "remote",
        assetsSlug: "remote",
        images: [],
      },
      { maxImageBytes: 1000 },
    );
    for (const path of [ui.path, mcp.path, accepted.path, remote.path]) {
      const review = parseDocumentFile(
        await fileAt(f.project.id, path!),
        "markdown",
      ).meta.review!;
      expect(review.reviewers).toEqual(reviewers);
      expect(review.everyMonths).toBe(7);
    }
    const root = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        title: "Root",
        content: { kind: "markdown", contentJson: body("root") },
      },
      f.adaActor,
    );
    expect(
      parseDocumentFile(await fileAt(f.project.id, root.path), "markdown").meta
        .review!.reviewers,
    ).toEqual([{ type: "user", id: f.vic.id, name: f.vic.name! }]);
  });

  it("concurrent_create_and_assignment_use_lock_order", async () => {
    const f = await fixture("folder-lock");
    await storeDefaults(
      f,
      ["guides"],
      [{ type: "user", id: f.owner.id, name: f.owner.name! }],
    );
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const assignment = withProjectRepo(f.project.id, async (repo) => {
      entered();
      await barrier;
      await repo.writeFileAtomic(
        "guides/.folder.json",
        composeFolderMetadata({
          ...newFolderMetadata(
            "Guides",
            { id: f.ada.id, name: "Ada" },
            new Date(),
          ),
          reviewDefaults: {
            reviewers: [{ type: "user", id: f.ada.id, name: f.ada.name! }],
          },
        }),
      );
      return repo.commitAll("test: serialized assignment", {
        name: "Ada",
        email: f.ada.email,
        userId: f.ada.id,
      });
    });
    await locked;
    const queuedWriter = vi.spyOn(projectRepo, "withProjectRepo");
    const creation = createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: ["guides"],
        title: "Concurrent",
        content: { kind: "markdown", contentJson: body("concurrent") },
      },
      f.adaActor,
    );
    try {
      await vi.waitFor(() =>
        expect(queuedWriter).toHaveBeenCalledWith(
          f.project.id,
          expect.any(Function),
        ),
      );
      release();
      await assignment;
    } finally {
      release();
      await Promise.allSettled([assignment, creation]);
      queuedWriter.mockRestore();
    }
    const doc = await creation;
    expect(
      parseDocumentFile(await fileAt(f.project.id, doc.path), "markdown").meta
        .review!.reviewers,
    ).toEqual([{ type: "user", id: f.ada.id, name: f.ada.name! }]);
    await withProjectRepo(f.project.id, async (repo) =>
      expect(await repo.isAncestor(await assignment, doc.headCommitSha)).toBe(
        true,
      ),
    );
  });

  it.each([
    { reviewers: [] },
    {
      reviewers: [
        {
          type: "user" as const,
          id: "99999999-9999-4999-8999-999999999999",
          name: "Gone",
        },
      ],
    },
  ])(
    "uses Owner fallback for explicit empty or ineffective folder defaults: %j",
    async ({ reviewers }) => {
      const f = await fixture("folder-empty");
      await setReviewDefaults(
        f.db,
        {
          projectId: f.project.id,
          everyMonths: 5,
          reviewers: [{ type: "user", id: f.ada.id }],
        },
        actorFor(f.owner, "Owner"),
      );
      await storeDefaults(f, [], reviewers);
      const doc = await createDocument(
        f.db,
        {
          projectId: f.project.id,
          folderPath: [],
          title: "Fallback",
          content: { kind: "markdown", contentJson: body("fallback") },
        },
        f.adaActor,
      );
      expect(
        parseDocumentFile(await fileAt(f.project.id, doc.path), "markdown").meta
          .review,
      ).toMatchObject({
        reviewers: [{ type: "user", id: f.owner.id, name: f.owner.name! }],
        everyMonths: 5,
      });
    },
  );

  it("resolves folder groups at use time and falls back when none remain effective", async () => {
    const f = await fixture("folder-group");
    const group = await createReviewerGroup(
      f.db,
      { projectId: f.project.id, name: "Editors", memberIds: [f.ada.id] },
      actorFor(f.owner, "Owner"),
    );
    await storeDefaults(
      f,
      [],
      [{ type: "group", id: group.id, name: "Old group name" }],
    );
    const create = (title: string) =>
      createDocument(
        f.db,
        {
          projectId: f.project.id,
          folderPath: [],
          title,
          content: { kind: "markdown", contentJson: body(title) },
        },
        f.adaActor,
      );
    const first = await create("Effective group");
    expect(
      parseDocumentFile(await fileAt(f.project.id, first.path), "markdown").meta
        .review!.reviewers,
    ).toEqual([{ type: "group", id: group.id, name: "Editors" }]);
    await setReviewerGroupMembers(
      f.db,
      { projectId: f.project.id, groupId: group.id, memberIds: [] },
      actorFor(f.owner, "Owner"),
    );
    const second = await create("Empty group");
    expect(
      parseDocumentFile(await fileAt(f.project.id, second.path), "markdown")
        .meta.review!.reviewers,
    ).toEqual([{ type: "user", id: f.owner.id, name: f.owner.name }]);
  });

  it("import_unknown_reviewers_uses_destination_default", async () => {
    const f = await fixture("folder-import-unknown");
    await storeDefaults(
      f,
      [],
      [{ type: "user", id: f.ada.id, name: "Old Ada name" }],
    );
    const result = await importWithReview(f, {
      reviewers: [
        {
          type: "user",
          id: "99999999-9999-4999-8999-999999999999",
          name: "Foreign",
        },
      ],
      everyMonths: 3,
      since: "2020-01-01T00:00:00.000Z",
      lastReviewed: "2020-02-01T00:00:00.000Z",
      reviewedBy: { id: f.owner.id, name: "Owner" },
    });
    expect(result.read.review!.reviewers).toEqual([
      { type: "user", id: f.ada.id, name: f.ada.name!, resolved: true },
    ]);
    expectClockStartedAtImport(result, 3);
  });

  it("import_known_reviewers_keeps_source_interval", async () => {
    const f = await fixture("folder-import-known");
    await storeDefaults(
      f,
      [],
      [{ type: "user", id: f.ada.id, name: f.ada.name! }],
    );
    const result = await importWithReview(f, {
      reviewers: [{ type: "user", id: f.vic.id, name: "Old Vic" }],
      everyMonths: 2,
      since: "2020-01-01T00:00:00.000Z",
      lastReviewed: "2020-02-01T00:00:00.000Z",
      reviewedBy: { id: f.owner.id, name: "Owner" },
    });
    expect(result.read.review!.reviewers).toEqual([
      { type: "user", id: f.vic.id, name: f.vic.name!, resolved: true },
    ]);
    expectClockStartedAtImport(result, 2);
  });

  it("moved_document_keeps_reviewers", async () => {
    const f = await fixture("folder-move");
    await storeDefaults(
      f,
      ["destination"],
      [{ type: "user", id: f.ada.id, name: f.ada.name! }],
    );
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        title: "Moving defaults",
        content: { kind: "markdown", contentJson: body("move") },
      },
      f.adaActor,
    );
    const before = reviewLines(await fileAt(f.project.id, doc.path));
    const moved = await moveDocument(
      f.db,
      {
        projectId: f.project.id,
        documentId: doc.id,
        folderPath: ["destination"],
      },
      f.adaActor,
    );
    expect(reviewLines(await fileAt(f.project.id, moved.path))).toEqual(before);
  });

  it("gives a new document the project defaults", async () => {
    const { db, owner, project, adaActor } = await fixture("defaults");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "A",
        content: { kind: "markdown", contentJson: body("Text") },
      },
      adaActor,
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      adaActor,
    );
    expect(read.review).toMatchObject({
      reviewers: [{ type: "user", id: owner.id, resolved: true }],
      everyMonths: 12,
      lastReviewedAt: null,
      reviewedBy: null,
    });
    expect(read.review!.since.toISOString()).toBe(read.createdAt.toISOString());
    expect(read.review!.dueAt.toISOString()).toBe(
      read.review!.since.toISOString(),
    );
    const row = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
      include: { reviewers: true },
    });
    expect(row.reviewEveryMonths).toBe(12);
    expect(row.reviewSince).toEqual(read.review!.since);
    expect(row.lastReviewedAt).toBeNull();
    expect(row.reviewedById).toBeNull();
    expect(row.reviewedByName).toBeNull();
    expect(row.reviewDueAt).toEqual(read.review!.dueAt);
    expect(row.reviewers).toMatchObject([
      { type: "user", refId: owner.id, userId: owner.id, groupId: null },
    ]);
    const file = await fileAt(project.id, doc.path);
    expect(reviewLines(file)).toHaveLength(3);
    expect(file).toContain(`reviewEvery: 12\n`);
  });

  it("keeps the review block when content is saved", async () => {
    const { db, project, adaActor } = await fixture("save");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Saved",
        content: { kind: "markdown", contentJson: body("One") },
      },
      adaActor,
    );
    const before = await fileAt(project.id, doc.path);
    const saved = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: body("Two") },
        changeSummary: "",
      },
      adaActor,
    );
    const after = await fileAt(project.id, saved.path);
    expect(reviewLines(before).length).toBeGreaterThan(0);
    expect(reviewLines(after)).toEqual(reviewLines(before));
    expect(after).not.toBe(before);
    expect(after).toContain("Two");
    const row = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
      include: { reviewers: true },
    });
    expect(row.reviewEveryMonths).toBe(12);
    expect(row.reviewers).toHaveLength(1);
  });

  it("keeps the review block across a restore and a move that re-slugs", async () => {
    const { db, ada, project, adaActor } = await fixture("restore");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Moving",
        content: { kind: "markdown", contentJson: body("One") },
      },
      adaActor,
    );
    const original = reviewLines(await fileAt(project.id, doc.path));
    const saved = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: body("Two") },
        changeSummary: "",
      },
      adaActor,
    );
    const restored = await restoreDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        sha: doc.headCommitSha,
        expectedHeadCommitSha: saved.headCommitSha,
      },
      adaActor,
    );
    const restoredFile = await fileAt(project.id, restored.path);
    expect(restoredFile).toContain("One");
    expect(reviewLines(restoredFile)).toEqual(original);

    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Guides" },
      adaActor,
    );
    // A stray assets directory at the target forces the move to re-slug.
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeBinaryFileAtomic(
        `guides/${restored.slug}.assets/x.png`,
        new Uint8Array([1, 2, 3]),
      );
      await repo.commitAll(
        "stray assets",
        { name: "Ada", email: "ada@test.local", userId: ada.id },
        {},
      );
    });
    const moved = await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["guides"] },
      adaActor,
    );
    expect(moved.slug).not.toBe(restored.slug);
    const movedFile = await fileAt(project.id, moved.path);
    expect(reviewLines(movedFile)).toEqual(original);
    const row = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
      include: { reviewers: true },
    });
    expect(row.path).toBe(moved.path);
    expect(row.reviewEveryMonths).toBe(12);
    expect(row.reviewers).toHaveLength(1);
  });

  it("fills a plain Markdown import from the defaults", async () => {
    const { db, owner, project, adaActor } = await fixture("plain");
    const before = Date.now();
    const imported = await importDocumentFile(
      db,
      {
        projectId: project.id,
        folderPath: [],
        fileName: "t.md",
        text: "# T\n\nx\n",
      },
      adaActor,
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: imported.id },
      adaActor,
    );
    expect(read.review).toMatchObject({
      reviewers: [{ type: "user", id: owner.id, resolved: true }],
      everyMonths: 12,
      lastReviewedAt: null,
      reviewedBy: null,
    });
    const since = read.review!.since.getTime();
    expect(since).toBeGreaterThanOrEqual(before - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("projects a due date from now when a pulled header is dated in the future", async () => {
    const { db } = await fixture("clamp");
    const header = (since: string, lastReviewed: string | null) => ({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Pulled",
      created: "2025-01-01T00:00:00.000Z",
      createdBy: null,
      updated: "2025-01-01T00:00:00.000Z",
      updatedBy: null,
      review: {
        reviewers: [],
        everyMonths: 3,
        since,
        lastReviewed,
        reviewedBy: null,
      },
    });
    const before = Date.now();
    const [future, sinceOnly] = await documentMetadataColumns(db, [
      header("2025-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"),
      header("2099-01-01T00:00:00.000Z", null),
    ]);
    const limit = addMonthsUtc(new Date().toISOString(), 3).getTime();
    expect(future!.reviewDueAt!.getTime()).toBeGreaterThan(before);
    expect(future!.reviewDueAt!.getTime()).toBeLessThanOrEqual(limit);
    expect(sinceOnly!.reviewDueAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(sinceOnly!.reviewDueAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(future!.lastReviewedAt!.toISOString()).toBe(
      "2099-01-01T00:00:00.000Z",
    );
    expect(sinceOnly!.reviewSince!.toISOString()).toBe(
      "2099-01-01T00:00:00.000Z",
    );
  });

  it("repairs future unreviewed due dates in UTC without changing other review metadata", async () => {
    const { db, owner, project } = await fixture("due-migration");
    const past = new Date("2025-01-01T00:00:00.000Z");
    const future = new Date("2099-01-01T00:00:00.000Z");
    const cases = [
      { slug: "future", since: future, due: future, reviewed: null },
      { slug: "past", since: past, due: past, reviewed: null },
      { slug: "clamped", since: future, due: past, reviewed: null },
      { slug: "reviewed", since: past, due: future, reviewed: past },
      { slug: "no-review", since: null, due: null, reviewed: null },
    ];
    await db.document.createMany({
      data: cases.map(({ slug, since, due, reviewed }) => ({
        id: randomUUID(),
        projectId: project.id,
        path: `${slug}.md`,
        slug,
        title: slug,
        excerpt: "",
        headCommitSha: "a".repeat(40),
        lastEditedAt: past,
        createdAt: past,
        updatedAt: past,
        reviewEveryMonths: since ? 12 : null,
        reviewSince: since,
        reviewDueAt: due,
        lastReviewedAt: reviewed,
        reviewedByName: reviewed ? "Reviewer" : null,
      })),
    });
    const beforeRows = await db.document.findMany({ orderBy: { slug: "asc" } });
    const sql = await readFile(
      new URL(
        "../../../../packages/db/prisma/migrations/20261008110000_review_due_future_clamp/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const before = Date.now();
    const changed = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
      return tx.$executeRawUnsafe(sql);
    });
    const afterRows = await db.document.findMany({ orderBy: { slug: "asc" } });
    const repaired = afterRows.find((row) => row.slug === "future")!;
    expect(repaired.reviewDueAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(repaired.reviewDueAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(changed).toBe(1);
    expect(afterRows).toEqual(
      beforeRows.map((row) =>
        row.slug === "future"
          ? { ...row, reviewDueAt: repaired.reviewDueAt }
          : row,
      ),
    );
    expect(await countDocumentsToReview(db, securityContextFor(owner))).toBe(3);
    expect(await db.$executeRawUnsafe(sql)).toBe(0);
  });

  async function importWithReview(
    f: Awaited<ReturnType<typeof fixture>>,
    review: {
      reviewers: { type: "user"; id: string; name: string }[];
      everyMonths: number;
      since: string;
      lastReviewed: string | null;
      reviewedBy: { id: string; name: string } | null;
    },
  ) {
    const markdown = composeDocumentFile(
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Carried",
        created: "2025-01-01T00:00:00.000Z",
        createdBy: null,
        updated: "2025-01-01T00:00:00.000Z",
        updatedBy: null,
        review,
      },
      "Body\n",
      "markdown",
    );
    const before = Date.now();
    const imported = await importDocumentFile(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        fileName: "carried.md",
        text: markdown,
      },
      f.adaActor,
    );
    const read = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: imported.id },
      f.adaActor,
    );
    const row = await f.db.document.findUniqueOrThrow({
      where: { id: imported.id },
      include: { reviewers: true },
    });
    const file = await fileAt(f.project.id, imported.path);
    return { before, read, row, file };
  }

  function expectClockStartedAtImport(
    result: Awaited<ReturnType<typeof importWithReview>>,
    months: number,
  ) {
    const { before, read, row, file } = result;
    const lines = reviewLines(file);
    expect(lines.some((l) => l.startsWith("lastReviewed: "))).toBe(false);
    expect(lines.some((l) => l.startsWith("reviewedBy: "))).toBe(false);
    expect(lines).toContain(`reviewEvery: ${months}`);
    const since = read.review!.since.getTime();
    expect(since).toBeGreaterThanOrEqual(before - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() + 1000);
    expect(lines).toContain(`reviewSince: ${read.review!.since.toISOString()}`);
    expect(read.review).toMatchObject({
      everyMonths: months,
      lastReviewedAt: null,
      reviewedBy: null,
    });
    const dueMs = since;
    expect(read.review!.dueAt.getTime()).toBe(dueMs);
    expect(dueMs).toBeLessThanOrEqual(Date.now());
    expect(row.reviewEveryMonths).toBe(months);
    expect(row.reviewSince?.getTime()).toBe(since);
    expect(row.lastReviewedAt).toBeNull();
    expect(row.reviewedById).toBeNull();
    expect(row.reviewedByName).toBeNull();
    expect(row.reviewDueAt?.getTime()).toBe(dueMs);
  }

  it("keeps an imported file's known reviewers and interval and starts the clock at import", async () => {
    const f = await fixture("kept");
    const result = await importWithReview(f, {
      reviewers: [{ type: "user", id: f.ada.id, name: "Old Ada" }],
      everyMonths: 3,
      since: "2025-01-01T00:00:00.000Z",
      lastReviewed: "2025-06-01T00:00:00.000Z",
      reviewedBy: { id: f.ada.id, name: "Old Ada" },
    });
    expect(result.read.review!.reviewers).toMatchObject([
      { type: "user", id: f.ada.id, resolved: true },
    ]);
    expect(result.row.reviewers.map((r) => r.refId)).toEqual([f.ada.id]);
    expectClockStartedAtImport(result, 3);
  });

  it("uses the project defaults for reviewers unknown here but keeps the interval", async () => {
    const f = await fixture("unknown");
    const result = await importWithReview(f, {
      reviewers: [
        {
          type: "user",
          id: "99999999-9999-4999-8999-999999999999",
          name: "Gone",
        },
      ],
      everyMonths: 3,
      since: "2025-01-01T00:00:00.000Z",
      lastReviewed: "2025-06-01T00:00:00.000Z",
      reviewedBy: { id: f.ada.id, name: "Ada" },
    });
    expect(result.read.review!.reviewers).toMatchObject([
      { type: "user", id: f.owner.id, resolved: true },
    ]);
    expect(result.row.reviewers.map((r) => r.refId)).toEqual([f.owner.id]);
    expectClockStartedAtImport(result, 3);
  });

  it("ignores a last review dated in the future", async () => {
    const f = await fixture("future");
    const result = await importWithReview(f, {
      reviewers: [{ type: "user", id: f.ada.id, name: "Ada" }],
      everyMonths: 3,
      since: "2025-01-01T00:00:00.000Z",
      lastReviewed: "2099-01-01T00:00:00.000Z",
      reviewedBy: { id: f.ada.id, name: "Ada" },
    });
    expect(result.row.reviewers.map((r) => r.refId)).toEqual([f.ada.id]);
    expectClockStartedAtImport(result, 3);
  });

  it("gives plain Markdown without a review block the project defaults", async () => {
    const f = await fixture("plain");
    const imported = await importDocumentFile(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        fileName: "plain.md",
        text: "# Plain\n\nText\n",
      },
      f.adaActor,
    );
    const read = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: imported.id },
      f.adaActor,
    );
    expect(read.review).toMatchObject({
      reviewers: [{ type: "user", id: f.owner.id, resolved: true }],
      everyMonths: 12,
      lastReviewedAt: null,
      reviewedBy: null,
    });
    const lines = reviewLines(await fileAt(f.project.id, imported.path));
    expect(lines).toContain("reviewEvery: 12");
  });

  it("applies the defaults to a created ZIP document and keeps the existing block on a replace", async () => {
    const { db, owner, project, adaActor } = await fixture("zip");
    const entry = (markdown: string, target: object) => ({
      projectId: project.id,
      folderPath: [],
      folderNames: {},
      fileName: "plan.md",
      kind: "markdown" as const,
      text: markdown,
      images: [],
      target: target as { mode: "create" },
    });
    const created = await importDocumentArchiveEntry(
      db,
      entry("# Plan\n\nv1\n", { mode: "create" }),
      adaActor,
    );
    const createdRead = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      adaActor,
    );
    expect(createdRead.review).toMatchObject({
      reviewers: [{ type: "user", id: owner.id }],
      everyMonths: 12,
    });
    await markDocumentReviewed(
      db,
      {
        projectId: project.id,
        documentId: created.id,
        expectedHeadCommitSha: createdRead.baseCommitSha,
      },
      actorFor(owner, "Owner"),
    );
    const before = reviewLines(await fileAt(project.id, created.path));
    expect(before.some((l) => l.startsWith("lastReviewed: "))).toBe(true);

    const foreign = composeDocumentFile(
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Plan",
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
      "v2\n",
      "markdown",
    );
    const replaced = await importDocumentArchiveEntry(
      db,
      entry(foreign, {
        mode: "replace",
        documentId: created.id,
        expectedHeadCommitSha: (
          await db.document.findUniqueOrThrow({ where: { id: created.id } })
        ).headCommitSha,
      }),
      adaActor,
    );
    expect(replaced.id).toBe(created.id);
    const file = await fileAt(project.id, replaced.path);
    expect(file).toContain("v2");
    expect(reviewLines(file)).toEqual(before);
  });

  it("rebuildIndex restores review columns and reviewer rows", async () => {
    const { db, owner, project, adaActor } = await fixture("rebuild");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Rebuilt",
        content: { kind: "markdown", contentJson: body("Text") },
      },
      adaActor,
    );
    const expected = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
    });
    await db.documentReviewer.deleteMany({ where: { documentId: doc.id } });
    await db.document.update({
      where: { id: doc.id },
      data: {
        reviewEveryMonths: null,
        reviewSince: null,
        lastReviewedAt: null,
        reviewedById: null,
        reviewedByName: null,
        reviewDueAt: null,
      },
    });
    const report = await rebuildIndex(
      db,
      { projectId: project.id },
      actorFor(owner, "Owner"),
    );
    expect(report.skipped).toEqual([]);
    const row = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
      include: { reviewers: true },
    });
    expect(row.reviewEveryMonths).toBe(12);
    expect(row.reviewSince).toEqual(expected.reviewSince);
    expect(row.reviewDueAt).toEqual(expected.reviewDueAt);
    expect(row.reviewers).toMatchObject([
      { type: "user", refId: owner.id, userId: owner.id },
    ]);
  });

  it("rebuildIndex restores the last review so the document is listed as recently reviewed again", async () => {
    const { db, owner, project, adaActor } = await fixture("rebuild-reviewed");
    const ownerActor = actorFor(owner, "Olive Owner");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Reviewed then rebuilt",
        content: { kind: "markdown", contentJson: body("Text") },
      },
      adaActor,
    );
    await markDocumentReviewed(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        expectedHeadCommitSha: doc.headCommitSha,
      },
      ownerActor,
    );
    const expected = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(expected.lastReviewedAt).not.toBeNull();
    await db.document.update({
      where: { id: doc.id },
      data: {
        lastReviewedAt: null,
        reviewedById: null,
        reviewedByName: null,
        reviewDueAt: null,
      },
    });
    expect((await listRecentlyReviewed(db, {}, ownerActor)).items).toEqual([]);
    await rebuildIndex(db, { projectId: project.id }, ownerActor);
    const row = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.lastReviewedAt).toEqual(expected.lastReviewedAt);
    expect(row.reviewedById).toBe(owner.id);
    expect(row.reviewedByName).toBe("Olive Owner");
    expect(row.reviewDueAt).toEqual(expected.reviewDueAt);
    expect(
      (await listRecentlyReviewed(db, {}, ownerActor)).items,
    ).toMatchObject([{ id: doc.id, reviewedBy: { id: owner.id } }]);
  });

  it("rebuildIndex leaves null columns and no reviewer rows for a file without a review block", async () => {
    const { db, owner, ada, project, adaActor } = await fixture("legacy");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Old",
        content: { kind: "markdown", contentJson: body("Text") },
      },
      adaActor,
    );
    await withProjectRepo(project.id, async (repo) => {
      const current = await repo.readFileFromWorktree(doc.path);
      const stripped = current
        .split("\n")
        .filter((line) => !/^(reviewers|reviewEvery|reviewSince): /.test(line))
        .join("\n");
      await repo.writeFileAtomic(doc.path, stripped);
      await repo.commitAll(
        "drop review block",
        { name: "Ada", email: "ada@test.local", userId: ada.id },
        {},
      );
    });
    await rebuildIndex(db, { projectId: project.id }, actorFor(owner, "Owner"));
    const row = await db.document.findUniqueOrThrow({
      where: { id: doc.id },
      include: { reviewers: true },
    });
    expect(row.reviewEveryMonths).toBeNull();
    expect(row.reviewSince).toBeNull();
    expect(row.reviewDueAt).toBeNull();
    expect(row.reviewers).toEqual([]);
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      adaActor,
    );
    expect(read.review).toBeNull();
  });

  it("rebuildIndex assigns reviewer rows to the right documents", async () => {
    const { db, owner, ada, project, adaActor } = await fixture("batch");
    const outsider = await makeUser("User", "batch-outsider");
    const first = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "First",
        content: { kind: "markdown", contentJson: body("One") },
      },
      adaActor,
    );
    const second = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Second",
        content: { kind: "markdown", contentJson: body("Two") },
      },
      adaActor,
    );
    const reviewersFor = async (path: string, ids: [string, string][]) =>
      withProjectRepo(project.id, async (repo) => {
        const current = await repo.readFileFromWorktree(path);
        const lines = ids
          .map(([id, name]) => ({ id, name }))
          .sort((x, y) => (x.id < y.id ? -1 : 1));
        const next = current
          .split("\n")
          .map((line) =>
            line.startsWith("reviewers: ")
              ? `reviewers: ${JSON.stringify(
                  lines.map((r) => ({ type: "user", ...r })),
                )}`
              : line,
          )
          .join("\n");
        await repo.writeFileAtomic(path, next);
        await repo.commitAll(
          "set reviewers",
          { name: "Ada", email: "ada@test.local", userId: ada.id },
          {},
        );
      });
    const before = await fileAt(project.id, first.path);
    expect(before).toMatch(/^reviewers: /m);
    await reviewersFor(first.path, [[owner.id, "Owner"]]);
    await reviewersFor(second.path, [
      [ada.id, "Ada"],
      [outsider.id, "Outsider"],
    ]);
    await rebuildIndex(db, { projectId: project.id }, actorFor(owner, "Owner"));
    const rows = await db.documentReviewer.findMany({
      where: { documentId: { in: [first.id, second.id] } },
      orderBy: { refId: "asc" },
    });
    const pick = (documentId: string) =>
      rows
        .filter((r) => r.documentId === documentId)
        .map((r) => ({ refId: r.refId, userId: r.userId }))
        .sort((a, b) => a.refId.localeCompare(b.refId));
    expect(pick(first.id)).toEqual([{ refId: owner.id, userId: owner.id }]);
    expect(pick(second.id)).toEqual(
      [
        { refId: ada.id, userId: ada.id },
        { refId: outsider.id, userId: null },
      ].sort((a, b) => a.refId.localeCompare(b.refId)),
    );
  });

  it("recovering a deleted document keeps its review block", async () => {
    const f = await fixture("recover-keep");
    const { db, owner, project, adaActor } = f;
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Keep",
        content: { kind: "markdown", contentJson: body("Text") },
      },
      adaActor,
    );
    const before = reviewLines(await fileAt(project.id, doc.path));
    expect(before.length).toBeGreaterThan(0);
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      adaActor,
    );
    await storeDefaults(
      f,
      [],
      [{ type: "user", id: f.ada.id, name: f.ada.name }],
    );
    const ownerActor = actorFor(owner, "Owner");
    const item = (
      await listDeletedContent(
        db,
        { projectId: project.id, limit: 5 },
        ownerActor,
      )
    ).items.find((candidate) => candidate.id === doc.id)!;
    const result = await applyMcpOperation(db, ownerActor, {
      idempotencyKey: "recover-keep-1",
      toolName: "restore_content",
      summary: "Recover",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "deleted",
        sourceSha: item.sourceSha,
        deletedAtSha: item.deletedAtSha,
      },
    });
    expect(reviewLines(await fileAt(project.id, result.path))).toEqual(before);
  });

  it("recovering a deleted document without a review block restarts its clock now", async () => {
    const f = await fixture("recover-new");
    const { db, owner, ada, project, adaActor } = f;
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Old",
        content: { kind: "markdown", contentJson: body("Text") },
      },
      adaActor,
    );
    await withProjectRepo(project.id, async (repo) => {
      const current = await repo.readFileFromWorktree(doc.path);
      const stripped = current
        .split("\n")
        .filter((line) => !/^(reviewers|reviewEvery|reviewSince): /.test(line))
        .join("\n")
        .replace(/^created: .*$/m, "created: 2020-01-01T00:00:00.000Z")
        .replace(/^updated: .*$/m, "updated: 2020-01-01T00:00:00.000Z");
      await repo.writeFileAtomic(doc.path, stripped);
      await repo.commitAll(
        "legacy file",
        { name: "Ada", email: "ada@test.local", userId: ada.id },
        {},
      );
    });
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      adaActor,
    );
    await storeDefaults(
      f,
      [],
      [{ type: "user", id: f.ada.id, name: f.ada.name }],
    );
    const ownerActor = actorFor(owner, "Owner");
    const item = (
      await listDeletedContent(
        db,
        { projectId: project.id, limit: 5 },
        ownerActor,
      )
    ).items.find((candidate) => candidate.id === doc.id)!;
    const result = await applyMcpOperation(db, ownerActor, {
      idempotencyKey: "recover-new-1",
      toolName: "restore_content",
      summary: "Recover",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "deleted",
        sourceSha: item.sourceSha,
        deletedAtSha: item.deletedAtSha,
      },
    });
    const file = await fileAt(project.id, result.path);
    expect(file).toContain("created: 2020-01-01");
    const since = /^reviewSince: "?([^"\n]+)"?$/m.exec(file)?.[1];
    expect(since).toBeDefined();
    expect(Date.now() - new Date(since!).getTime()).toBeLessThan(60_000);
    expect(parseDocumentFile(file, "markdown").meta.review!.reviewers).toEqual([
      { type: "user", id: ada.id, name: f.ada.name },
    ]);
  });
});

describe("reviewing", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  async function setup(suffix: string) {
    const f = await fixture(suffix);
    const ownerActor = actorFor(f.owner, "Owner");
    const maintainer = await makeUser("User", `${suffix}-maint`);
    await addMembership(f.project.id, maintainer.id, "Maintainer");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        title: "Doc",
        content: { kind: "markdown", contentJson: body("Text") },
      },
      f.adaActor,
    );
    const ids = { projectId: f.project.id, documentId: doc.id };
    const read = (actor = ownerActor) => getDocument(f.db, ids, actor);
    const headSubject = (path: string) =>
      withProjectRepo(f.project.id, async (repo) => {
        const [entry] = await repo.logForPath(path, { skip: 0, limit: 1 });
        return entry!.message;
      });
    return {
      ...f,
      ownerActor,
      maintainerActor: actorFor(maintainer, "Maint"),
      doc,
      ids,
      read,
      headSubject,
    };
  }

  async function assign(
    s: Awaited<ReturnType<typeof setup>>,
    reviewers: { type: "user" | "group"; id: string }[],
  ) {
    const before = await s.read();
    await setDocumentReview(
      s.db,
      { ...s.ids, expectedHeadCommitSha: before.baseCommitSha, reviewers },
      s.ownerActor,
    );
  }

  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string }) => error.code ?? "OTHER",
    );

  it("lets an assigned Viewer mark a document reviewed without touching updated", async () => {
    const s = await setup("mark");
    await assign(s, [{ type: "user", id: s.vic.id }]);
    const before = await s.read();
    const fileBefore = await fileAt(s.project.id, s.doc.path);
    const result = await markDocumentReviewed(
      s.db,
      { ...s.ids, expectedHeadCommitSha: before.baseCommitSha },
      s.vicActor,
    );
    const after = await s.read();
    expect(after.baseCommitSha).toBe(result.headCommitSha);
    expect(after.review).toMatchObject({ reviewedBy: { id: s.vic.id } });
    expect(after.review!.lastReviewedAt).not.toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedBy).toEqual(before.updatedBy);
    expect(after.review!.since).toEqual(before.review!.since);
    expect(await s.headSubject(before.path)).toBe(`review: ${before.path}`);
    const fileAfter = await fileAt(s.project.id, s.doc.path);
    const stripReview = (file: string) =>
      file
        .split("\n")
        .filter((line) => !/^(lastReviewed|reviewedBy): /.test(line))
        .join("\n");
    expect(stripReview(fileAfter)).toBe(fileBefore);
    expect(fileAfter).toMatch(/^lastReviewed: /m);
    const row = await s.db.document.findUniqueOrThrow({
      where: { id: s.doc.id },
    });
    expect(row.lastReviewedAt).toEqual(after.review!.lastReviewedAt);
    expect(row.reviewedById).toBe(s.vic.id);
    expect(row.reviewDueAt).toEqual(after.review!.dueAt);
    expect(row.reviewDueAt!.getTime()).toBeGreaterThan(
      before.review!.dueAt.getTime(),
    );
  });

  it("refuses a member who is not a reviewer and hides the project from outsiders", async () => {
    const s = await setup("deny");
    await assign(s, [{ type: "user", id: s.vic.id }]);
    const head = (await s.read()).baseCommitSha;
    const input = { ...s.ids, expectedHeadCommitSha: head };
    expect(await code(markDocumentReviewed(s.db, input, s.adaActor))).toBe(
      "FORBIDDEN",
    );
    const outsider = await makeUser("User", "deny-out");
    expect(
      await code(
        markDocumentReviewed(s.db, input, actorFor(outsider, "Outsider")),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(
        markDocumentReviewed(
          s.db,
          { ...input, documentId: "00000000-0000-4000-8000-000000000000" },
          s.vicActor,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect((await s.read()).baseCommitSha).toBe(head);
  });

  it("refuses a read-only credential even for an assigned reviewer", async () => {
    const s = await setup("readonly");
    await assign(s, [{ type: "user", id: s.vic.id }]);
    const head = (await s.read()).baseCommitSha;
    const readOnly = {
      ...createApiKeySecurityContext({
        userId: s.vic.id,
        globalRole: "User",
        keyId: "key-1",
        permissions: { content: ["read"] },
        projectIds: [],
      }),
      name: "Vic",
      email: s.vic.email,
    };
    expect(
      await code(
        markDocumentReviewed(
          s.db,
          { ...s.ids, expectedHeadCommitSha: head },
          readOnly,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect((await s.read()).baseCommitSha).toBe(head);
  });

  it("rejects a stale head", async () => {
    const s = await setup("stale");
    await assign(s, [{ type: "user", id: s.vic.id }]);
    const stale = (await s.read()).baseCommitSha;
    await saveDocument(
      s.db,
      {
        ...s.ids,
        baseCommitSha: stale,
        content: { kind: "markdown", contentJson: body("Changed") },
        changeSummary: "",
      },
      s.adaActor,
    );
    const current = (await s.read()).baseCommitSha;
    expect(current).not.toBe(stale);
    const error = await markDocumentReviewed(
      s.db,
      { ...s.ids, expectedHeadCommitSha: stale },
      s.vicActor,
    ).catch((e: { code: string; details?: unknown }) => e);
    expect(error).toMatchObject({
      code: "CONFLICT",
      details: { headCommitSha: current },
    });
  });

  it("resolves group members as reviewers", async () => {
    const s = await setup("group");
    const group = await createReviewerGroup(
      s.db,
      { projectId: s.project.id, name: "Team", memberIds: [s.ada.id] },
      s.ownerActor,
    );
    await assign(s, [{ type: "group", id: group.id }]);
    expect(
      await reviewPermissions(s.db, s.project.id, s.doc.id, s.adaActor),
    ).toEqual({ canMarkReviewed: true, canEditReview: false });
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.vicActor))
        .canMarkReviewed,
    ).toBe(false);
    const head = (await s.read()).baseCommitSha;
    await markDocumentReviewed(
      s.db,
      { ...s.ids, expectedHeadCommitSha: head },
      s.adaActor,
    );
    expect((await s.read()).review).toMatchObject({
      reviewedBy: { id: s.ada.id },
    });
  });

  it("falls back to Owners when no reviewer resolves", async () => {
    const s = await setup("fallback");
    await assign(s, [{ type: "user", id: s.vic.id }]);
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.ownerActor))
        .canMarkReviewed,
    ).toBe(false);
    await removeMember(
      s.db,
      { projectId: s.project.id, userId: s.vic.id },
      s.ownerActor,
    );
    expect(
      await reviewPermissions(s.db, s.project.id, s.doc.id, s.ownerActor),
    ).toEqual({ canMarkReviewed: true, canEditReview: true });
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.adaActor))
        .canMarkReviewed,
    ).toBe(false);
    const head = (await s.read()).baseCommitSha;
    await markDocumentReviewed(
      s.db,
      { ...s.ids, expectedHeadCommitSha: head },
      s.ownerActor,
    );
    expect((await s.read()).review!.reviewedBy).toMatchObject({
      id: s.owner.id,
    });
  });

  it("re-links a re-added member so they can mark and see the document", async () => {
    const s = await setup("readd");
    await assign(s, [{ type: "user", id: s.vic.id }]);
    await removeMember(
      s.db,
      { projectId: s.project.id, userId: s.vic.id },
      s.ownerActor,
    );
    const row = () =>
      s.db.documentReviewer.findFirstOrThrow({
        where: { documentId: s.doc.id, refId: s.vic.id },
      });
    expect((await row()).userId).toBeNull();
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.ownerActor))
        .canMarkReviewed,
    ).toBe(true);
    await addMember(
      s.db,
      { projectId: s.project.id, email: s.vic.email, role: "Viewer" },
      s.ownerActor,
    );
    expect((await row()).userId).toBe(s.vic.id);
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.vicActor))
        .canMarkReviewed,
    ).toBe(true);
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.ownerActor))
        .canMarkReviewed,
    ).toBe(false);
    await s.db.document.update({
      where: { id: s.doc.id },
      data: { reviewDueAt: new Date(Date.now() - 60_000) },
    });
    const due = await listDocumentsToReview(s.db, {}, s.vicActor);
    expect(due.items.map((item) => item.id)).toContain(s.doc.id);
    await markDocumentReviewed(
      s.db,
      { ...s.ids, expectedHeadCommitSha: (await s.read()).baseCommitSha },
      s.vicActor,
    );
    expect((await s.read()).review!.reviewedBy).toMatchObject({
      id: s.vic.id,
    });
  });

  it("cleans up and re-links through the admin membership edit", async () => {
    const s = await setup("admin");
    const admin = await makeUser("Admin", "admin-edit");
    const adminActor = actorFor(admin, "Admin");
    const group = await createReviewerGroup(
      s.db,
      { projectId: s.project.id, name: "Team", memberIds: [s.vic.id] },
      s.ownerActor,
    );
    await setReviewDefaults(
      s.db,
      {
        projectId: s.project.id,
        everyMonths: 12,
        reviewers: [
          { type: "user", id: s.vic.id },
          { type: "group", id: group.id },
        ],
      },
      s.ownerActor,
    );
    await assign(s, [{ type: "user", id: s.vic.id }]);
    await setUserMembership(s.db, adminActor, {
      userId: s.vic.id,
      projectId: s.project.id,
      role: null,
    });
    expect(
      await s.db.reviewerGroupMember.count({ where: { userId: s.vic.id } }),
    ).toBe(0);
    expect(
      await s.db.projectDefaultReviewer.count({
        where: { projectId: s.project.id, userId: s.vic.id },
      }),
    ).toBe(0);
    const row = () =>
      s.db.documentReviewer.findFirstOrThrow({
        where: { documentId: s.doc.id, refId: s.vic.id },
      });
    expect((await row()).userId).toBeNull();
    const metadata = JSON.parse(await fileAt(s.project.id, "project.json")) as {
      members: { userId: string }[];
      documentReview: { defaultReviewers: { id: string }[] };
      reviewerGroups: { members: string[] }[];
    };
    expect(metadata.members.map((m) => m.userId)).not.toContain(s.vic.id);
    expect(metadata.documentReview.defaultReviewers.map((r) => r.id)).toEqual([
      group.id,
    ]);
    expect(metadata.reviewerGroups[0]?.members).toEqual([]);
    await setUserMembership(s.db, adminActor, {
      userId: s.vic.id,
      projectId: s.project.id,
      role: "Viewer",
    });
    expect((await row()).userId).toBe(s.vic.id);
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.vicActor))
        .canMarkReviewed,
    ).toBe(true);
  });

  it("falls back to Owners when the only group has no members left", async () => {
    const s = await setup("emptygroup");
    const group = await createReviewerGroup(
      s.db,
      { projectId: s.project.id, name: "Empty", memberIds: [s.ada.id] },
      s.ownerActor,
    );
    await assign(s, [{ type: "group", id: group.id }]);
    await setReviewerGroupMembers(
      s.db,
      { projectId: s.project.id, groupId: group.id, memberIds: [] },
      s.ownerActor,
    );
    const owner = await reviewPermissions(
      s.db,
      s.project.id,
      s.doc.id,
      s.ownerActor,
    );
    expect(owner.canMarkReviewed).toBe(true);
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.adaActor))
        .canMarkReviewed,
    ).toBe(false);
  });

  it.each([false, true])(
    "guards composed UTF-8 bytes in single-document review settings (overflow=%s)",
    async (overflow) => {
      const s = await setup(`byte-limit-${overflow}`);
      const name = "é".repeat(100);
      await s.db.user.update({ where: { id: s.vic.id }, data: { name } });
      const head = await withProjectRepo(s.project.id, async (repo) => {
        const parsed = parseDocumentFile(
          await repo.readFileFromWorktree(s.doc.path),
          "markdown",
        );
        const meta = {
          ...parsed.meta,
          review: {
            ...parsed.meta.review!,
            reviewers: [{ type: "user" as const, id: s.vic.id, name: "A" }],
          },
        };
        const target = {
          ...meta,
          review: {
            ...meta.review,
            reviewers: [{ type: "user" as const, id: s.vic.id, name }],
          },
        };
        const remaining =
          2_000_000 +
          Number(overflow) -
          Buffer.byteLength(
            composeDocumentFile(target, "\n", "markdown"),
            "utf8",
          );
        const body =
          "é".repeat(Math.floor(remaining / 2)) +
          "x".repeat(remaining % 2) +
          "\n";
        expect(
          Buffer.byteLength(
            composeDocumentFile(target, body, "markdown"),
            "utf8",
          ),
        ).toBe(overflow ? 2_000_001 : 2_000_000);
        await repo.writeFileAtomic(
          s.doc.path,
          composeDocumentFile(meta, body, "markdown"),
        );
        return repo.commitAll("test: review settings byte boundary", {
          name: "Owner",
          email: s.owner.email,
          userId: s.owner.id,
        });
      });
      const dir = repoDir(s.project.id);
      const original = await readFile(join(dir, s.doc.path), "utf8");
      expect(Buffer.byteLength(original, "utf8")).toBeLessThan(2_000_000);
      const result = setDocumentReview(
        s.db,
        {
          ...s.ids,
          expectedHeadCommitSha: head,
          reviewers: [{ type: "user", id: s.vic.id }],
        },
        s.ownerActor,
      );
      if (overflow) {
        await expect(result).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringContaining(s.doc.path),
        });
        expect(await simpleGit(dir).revparse(["HEAD"])).toBe(head);
        expect(await readFile(join(dir, s.doc.path), "utf8")).toBe(original);
        expect(await simpleGit(dir).show([`HEAD:${s.doc.path}`])).toBe(
          original,
        );
      } else {
        expect((await result).headCommitSha).not.toBe(head);
        expect(
          Buffer.byteLength(
            await readFile(join(dir, s.doc.path), "utf8"),
            "utf8",
          ),
        ).toBe(2_000_000);
      }
      expect(
        await simpleGit(dir).raw(["diff", "--cached", "--name-only"]),
      ).toBe("");
      expect(
        await simpleGit(dir).raw([
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]),
      ).toBe("");
    },
  );

  it("lets Maintainers change settings and Editors not", async () => {
    const s = await setup("settings");
    const before = await s.read();
    const input = {
      ...s.ids,
      expectedHeadCommitSha: before.baseCommitSha,
      everyMonths: 3,
    };
    expect(await code(setDocumentReview(s.db, input, s.adaActor))).toBe(
      "FORBIDDEN",
    );
    const result = await setDocumentReview(
      s.db,
      { ...input, reviewers: [{ type: "user", id: s.vic.id }] },
      s.maintainerActor,
    );
    const after = await s.read();
    expect(after.baseCommitSha).toBe(result.headCommitSha);
    expect(after.review!.everyMonths).toBe(3);
    expect(after.review!.reviewers).toMatchObject([
      { type: "user", id: s.vic.id, resolved: true },
    ]);
    expect(after.review!.since).toEqual(before.review!.since);
    expect(after.review!.lastReviewedAt).toBeNull();
    expect(after.review!.dueAt).toEqual(before.review!.since);
    expect(after.review!.dueAt).toEqual(before.review!.dueAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedBy).toEqual(before.updatedBy);
    expect(await s.headSubject(before.path)).toBe(
      `review settings: ${before.path}`,
    );
    const row = await s.db.document.findUniqueOrThrow({
      where: { id: s.doc.id },
    });
    expect(row.reviewEveryMonths).toBe(3);
    expect(row.reviewDueAt).toEqual(after.review!.dueAt);
  });

  it("validates review settings", async () => {
    const s = await setup("invalid");
    const head = (await s.read()).baseCommitSha;
    const base = { ...s.ids, expectedHeadCommitSha: head };
    for (const everyMonths of [0, 121, 1.5])
      expect(
        await code(
          setDocumentReview(s.db, { ...base, everyMonths }, s.ownerActor),
        ),
      ).toBe("BAD_REQUEST");
    expect(await code(setDocumentReview(s.db, base, s.ownerActor))).toBe(
      "BAD_REQUEST",
    );
    const other = await makeProject("Other project");
    const stranger = await makeUser("User", "invalid-stranger");
    await addMembership(other.id, stranger.id, "Owner");
    expect(
      await code(
        setDocumentReview(
          s.db,
          { ...base, reviewers: [{ type: "user", id: stranger.id }] },
          s.ownerActor,
        ),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await code(
        setDocumentReview(
          s.db,
          {
            ...base,
            reviewers: Array.from({ length: 51 }, () => ({
              type: "user" as const,
              id: s.vic.id,
            })),
          },
          s.ownerActor,
        ),
      ),
    ).toBe("BAD_REQUEST");
    expect((await s.read()).baseCommitSha).toBe(head);
  });

  it("returns the document's last commit for a no-op settings change", async () => {
    const s = await setup("noop");
    const before = await s.read();
    const other = await createDocument(
      s.db,
      {
        projectId: s.project.id,
        folderPath: [],
        title: "Other",
        content: { kind: "markdown", contentJson: body("Other") },
      },
      s.adaActor,
    );
    const repoHead = () =>
      withProjectRepo(s.project.id, (repo) => repo.resolveHead());
    const headBefore = await repoHead();
    expect(headBefore).not.toBe(before.baseCommitSha);
    const result = await setDocumentReview(
      s.db,
      {
        ...s.ids,
        expectedHeadCommitSha: before.baseCommitSha,
        everyMonths: before.review!.everyMonths,
        reviewers: [{ type: "user", id: s.owner.id }],
      },
      s.ownerActor,
    );
    expect(result.headCommitSha).toBe(before.baseCommitSha);
    expect(await repoHead()).toBe(headBefore);
    expect(other.headCommitSha).toBe(headBefore);
    const marked = await markDocumentReviewed(
      s.db,
      { ...s.ids, expectedHeadCommitSha: result.headCommitSha },
      s.ownerActor,
    );
    expect(marked.headCommitSha).not.toBe(headBefore);
  });

  it("changes only the interval or only the reviewers when the other is omitted", async () => {
    const s = await setup("partial");
    const before = await s.read();
    const linesBefore = reviewLines(await fileAt(s.project.id, s.doc.path));
    const onlyInterval = await setDocumentReview(
      s.db,
      {
        ...s.ids,
        expectedHeadCommitSha: before.baseCommitSha,
        everyMonths: 6,
      },
      s.ownerActor,
    );
    const linesInterval = reviewLines(await fileAt(s.project.id, s.doc.path));
    const pick = (lines: string[], key: string) =>
      lines.find((line) => line.startsWith(`${key}: `));
    expect(pick(linesInterval, "reviewEvery")).toBe("reviewEvery: 6");
    expect(pick(linesInterval, "reviewers")).toBe(
      pick(linesBefore, "reviewers"),
    );
    expect(pick(linesInterval, "reviewSince")).toBe(
      pick(linesBefore, "reviewSince"),
    );
    await setDocumentReview(
      s.db,
      {
        ...s.ids,
        expectedHeadCommitSha: onlyInterval.headCommitSha,
        reviewers: [{ type: "user", id: s.vic.id }],
      },
      s.ownerActor,
    );
    const linesReviewers = reviewLines(await fileAt(s.project.id, s.doc.path));
    expect(pick(linesReviewers, "reviewEvery")).toBe("reviewEvery: 6");
    expect(pick(linesReviewers, "reviewers")).not.toBe(
      pick(linesInterval, "reviewers"),
    );
    const after = await s.read();
    expect(after.review!.everyMonths).toBe(6);
    expect(after.review!.reviewers).toMatchObject([
      { type: "user", id: s.vic.id },
    ]);
  });

  it("hides the document from non-members for settings and permissions", async () => {
    const s = await setup("nonmember");
    const head = (await s.read()).baseCommitSha;
    const outsider = actorFor(await makeUser("User", "nonmember-out"), "Out");
    expect(
      await code(
        setDocumentReview(
          s.db,
          { ...s.ids, expectedHeadCommitSha: head, everyMonths: 3 },
          outsider,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(reviewPermissions(s.db, s.project.id, s.doc.id, outsider)),
    ).toBe("NOT_FOUND");
    expect((await s.read()).baseCommitSha).toBe(head);
  });

  it("enqueues no change-summary job for a review commit", async () => {
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const s = await setup("nosummary");
    const head = (await s.read()).baseCommitSha;
    const jobsBefore = queue.jobs.length;
    await markDocumentReviewed(
      s.db,
      { ...s.ids, expectedHeadCommitSha: head },
      s.ownerActor,
    );
    expect(
      queue.jobs
        .slice(jobsBefore)
        .filter((job) => job.name === "document.change-summary"),
    ).toEqual([]);
    expect(
      queue.jobs.some((job) => job.name === "document.change-summary"),
    ).toBe(false);
  });

  it("marks a document without a review block reviewed with the project defaults", async () => {
    const s = await setup("noblock");
    await withProjectRepo(s.project.id, async (repo) => {
      const current = await repo.readFileFromWorktree(s.doc.path);
      await repo.writeFileAtomic(
        s.doc.path,
        current
          .split("\n")
          .filter(
            (line) => !/^(reviewers|reviewEvery|reviewSince): /.test(line),
          )
          .join("\n"),
      );
      await repo.commitAll(
        "drop review block",
        { name: "Ada", email: "ada@test.local", userId: s.ada.id },
        {},
      );
    });
    await rebuildIndex(s.db, { projectId: s.project.id }, s.ownerActor);
    const before = await s.read();
    expect(before.review).toBeNull();
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.ownerActor))
        .canMarkReviewed,
    ).toBe(true);
    expect(
      (await reviewPermissions(s.db, s.project.id, s.doc.id, s.adaActor))
        .canMarkReviewed,
    ).toBe(false);
    const input = { ...s.ids, expectedHeadCommitSha: before.baseCommitSha };
    expect(await code(markDocumentReviewed(s.db, input, s.adaActor))).toBe(
      "FORBIDDEN",
    );
    const startedAt = Date.now();
    await markDocumentReviewed(s.db, input, s.ownerActor);
    const after = await s.read();
    expect(after.review).toMatchObject({
      reviewers: [{ type: "user", id: s.owner.id }],
      everyMonths: 12,
      reviewedBy: { id: s.owner.id },
    });
    expect(after.review!.lastReviewedAt).not.toBeNull();
    expect(after.review!.since.getTime()).toBeGreaterThan(startedAt - 60_000);
    expect(after.review!.since.getTime()).toBeLessThanOrEqual(Date.now());
    const lines = reviewLines(await fileAt(s.project.id, s.doc.path));
    expect(lines).toHaveLength(5);
    const row = await s.db.document.findUniqueOrThrow({
      where: { id: s.doc.id },
    });
    expect(row.reviewSince).toEqual(after.review!.since);
    expect(row.reviewDueAt).toEqual(after.review!.dueAt);
  });

  describe("due list", () => {
    const PAST = new Date("2021-03-01T00:00:00Z");
    const PAST_LATER = new Date("2021-06-01T00:00:00Z");
    const FUTURE = new Date("2999-01-01T00:00:00Z");

    async function twoProjects() {
      const a = await setup("due-a");
      const b = await fixture("due-b");
      const bOwner = actorFor(b.owner, "Owner B");
      const mk = (title: string) =>
        createDocument(
          b.db,
          {
            projectId: b.project.id,
            folderPath: [],
            title,
            content: { kind: "markdown", contentJson: body(title) },
          },
          bOwner,
        );
      const b1 = await mk("B one");
      const b2 = await mk("B two");
      const a2 = await createDocument(
        a.db,
        {
          projectId: a.project.id,
          folderPath: [],
          title: "A two",
          content: { kind: "markdown", contentJson: body("two") },
        },
        a.adaActor,
      );
      // The reviewer is vic in A and owner of B; make the shared user vic.
      await addMembership(b.project.id, a.vic.id, "Viewer");
      await b.db.documentReviewer.deleteMany({
        where: { documentId: { in: [b1.id, b2.id] } },
      });
      for (const doc of [b1, b2])
        await b.db.documentReviewer.create({
          data: {
            documentId: doc.id,
            type: "user",
            refId: a.vic.id,
            name: "Vic",
            userId: a.vic.id,
          },
        });
      await assign(a, [{ type: "user", id: a.vic.id }]);
      const setDue = (id: string, at: Date) =>
        a.db.document.update({ where: { id }, data: { reviewDueAt: at } });
      await setDue(a.doc.id, PAST_LATER);
      await setDue(b1.id, PAST);
      await setDue(b2.id, FUTURE);
      await setDue(a2.id, PAST);
      return { a, b, b1, b2, a2, setDue };
    }

    it("lists due documents across projects for their reviewers only", async () => {
      const { a, b, b1, a2 } = await twoProjects();
      // a2 is reviewed by the owner fallback (default reviewer), not vic.
      const list = await listDocumentsToReview(a.db, {}, a.vicActor);
      expect(list.items.map((item) => item.id)).toEqual([b1.id, a.doc.id]);
      expect(list.nextCursor).toBeNull();
      expect(list.items[0]).toEqual({
        id: b1.id,
        title: "B one",
        path: b1.path,
        projectId: b.project.id,
        projectName: "Review due-b",
        dueAt: PAST,
        lastReviewedAt: null,
      });
      expect(await countDocumentsToReview(a.db, a.vicActor)).toBe(2);
      expect(await isReviewerAnywhere(a.db, a.vicActor)).toBe(true);
      expect(await countDocumentsToReview(a.db, a.adaActor)).toBe(0);
      expect((await listDocumentsToReview(a.db, {}, a.adaActor)).items).toEqual(
        [],
      );
      expect(await isReviewerAnywhere(a.db, a.adaActor)).toBe(false);
      const ownerList = await listDocumentsToReview(a.db, {}, a.ownerActor);
      expect(ownerList.items.map((item) => item.id)).toEqual([a2.id]);
      const stranger = await makeUser("User", "due-stranger");
      const strangerActor = actorFor(stranger, "Stranger");
      expect(await countDocumentsToReview(a.db, strangerActor)).toBe(0);
      expect(await isReviewerAnywhere(a.db, strangerActor)).toBe(false);
    });

    it("hides soft-deleted projects and restricted credentials' other projects", async () => {
      const { a, b } = await twoProjects();
      const restricted = createApiKeySecurityContext({
        userId: a.vic.id,
        globalRole: "User",
        keyId: "key-2",
        permissions: { content: ["read"] },
        projectIds: [a.project.id],
      });
      const only = await listDocumentsToReview(a.db, {}, restricted);
      expect(only.items.map((item) => item.projectId)).toEqual([a.project.id]);
      expect(await countDocumentsToReview(a.db, restricted)).toBe(1);
      await a.db.project.update({
        where: { id: b.project.id },
        data: { deletedAt: new Date() },
      });
      const list = await listDocumentsToReview(a.db, {}, a.vicActor);
      expect(list.items.map((item) => item.id)).toEqual([a.doc.id]);
      expect(await countDocumentsToReview(a.db, a.vicActor)).toBe(1);
      await a.db.project.update({
        where: { id: a.project.id },
        data: { deletedAt: new Date() },
      });
      expect(await countDocumentsToReview(a.db, a.vicActor)).toBe(0);
      expect(await isReviewerAnywhere(a.db, a.vicActor)).toBe(false);
    });

    it("pages the due list", async () => {
      const { a, b1 } = await twoProjects();
      const first = await listDocumentsToReview(a.db, { limit: 1 }, a.vicActor);
      expect(first.items.map((item) => item.id)).toEqual([b1.id]);
      expect(first.nextCursor).not.toBeNull();
      const second = await listDocumentsToReview(
        a.db,
        { limit: 1, cursor: first.nextCursor! },
        a.vicActor,
      );
      expect(second.items.map((item) => item.id)).toEqual([a.doc.id]);
      expect(second.nextCursor).toBeNull();
    });

    it("keeps pages stable when due dates tie", async () => {
      const { a, b1, b2, setDue } = await twoProjects();
      await setDue(b2.id, PAST);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listDocumentsToReview(
          a.db,
          { limit: 1, cursor },
          a.vicActor,
        );
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual([b1.id, b2.id].sort().concat(a.doc.id));
    });

    it("rejects an empty cursor and invalid limits", async () => {
      const { a } = await twoProjects();
      expect(
        await code(listDocumentsToReview(a.db, { cursor: "" }, a.vicActor)),
      ).toBe("BAD_REQUEST");
      for (const limit of [0, -1, 1.5, Number.NaN])
        expect(
          await code(listDocumentsToReview(a.db, { limit }, a.vicActor)),
        ).toBe("BAD_REQUEST");
      const clamped = await listDocumentsToReview(
        a.db,
        { limit: 100_000 },
        a.vicActor,
      );
      expect(clamped.items).toHaveLength(2);
    });

    it("rejects malformed cursors", async () => {
      const { a } = await twoProjects();
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      for (const cursor of [
        "not-a-cursor",
        encode("x"),
        encode(["nope", a.doc.id]),
        encode(["2021-03-01T00:00:00.000Z", "not-a-uuid"]),
        encode(["2021-03-01T00:00:00.000Z", 5]),
        encode([]),
      ])
        expect(
          await code(listDocumentsToReview(a.db, { cursor }, a.vicActor)),
        ).toBe("BAD_REQUEST");
    });
  });
});

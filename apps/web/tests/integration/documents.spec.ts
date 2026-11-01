import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { simpleGit } from "simple-git";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  testEncryptionKeys,
  markdownContent,
} from "./_harness";
import { encryptSecret, secretAad } from "@weaver/core/security/encryption";
import { openProjectRepo, repoDir, withProjectRepo } from "@weaver/git-store";
import * as gitStore from "@weaver/git-store";
import {
  createDocument,
  getDocument,
  moveDocument,
  rebuildIndex,
  repairDocumentProjectionInRepo,
  writeDocumentInRepo,
} from "@weaver/core/services/documents";
import { composeDocumentFile } from "@weaver/core/documents/frontmatter";
import { serializeDocumentBody } from "@weaver/core/editor/markdown";
import {
  FakeJobQueue,
  setJobQueueForTests,
  type JobQueue,
} from "@weaver/core/jobs/queue";
import type {
  KnowledgeJobName,
  KnowledgeJobPayloads,
} from "@weaver/core/jobs/types";

type MatrixRole = "Owner" | "Maintainer" | "Editor" | "Viewer" | null;

async function setupProjectWith(role: MatrixRole, suffix: string) {
  const owner = await makeUser("User", `owner-${suffix}`);
  const project = await makeProject(`P-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  const ownerCaller = callerFor(owner);
  if (role === null) {
    const outsider = await makeUser("User", `out-${suffix}`);
    return {
      project,
      caller: callerFor(outsider),
      ownerCaller,
      actor: outsider,
    };
  }
  const actor = await makeUser("User", `${role.toLowerCase()}-${suffix}`);
  await addMembership(project.id, actor.id, role);
  return { project, caller: callerFor(actor), ownerCaller, actor };
}

const PARA = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** An eligible, unqueued ProjectGitRemote row, so a content commit is expected
 * to dispatch an immediate `project.git-push` job (mirrors the jobs spec fixture). */
async function addEligibleGitRemote(projectId: string) {
  const id = randomUUID();
  const encrypted = encryptSecret(
    testEncryptionKeys(),
    "synthetic-private-key",
    secretAad("project-git-remote", id),
  );
  await getPrisma().projectGitRemote.create({
    data: {
      id,
      projectId,
      remoteUrl: "git@example.test:repo.git",
      branch: "main",
      enabled: true,
      keyName: "test key",
      keyFingerprint: "SHA256:test",
      keyUploadedAt: new Date(),
      credentialCiphertext: new Uint8Array(encrypted.ciphertext),
      credentialNonce: new Uint8Array(encrypted.nonce),
      credentialTag: new Uint8Array(encrypted.tag),
      credentialKeyVersion: encrypted.keyVersion,
      nextAttemptAt: new Date(),
    },
  });
  return id;
}

let knowledgeQueue: FakeJobQueue;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  knowledgeQueue = new FakeJobQueue();
  setJobQueueForTests(knowledgeQueue);
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

async function makeTable(
  projectId: string,
  title: string,
  slug: string,
  id: string = randomUUID(),
) {
  return getPrisma().dataTable.create({
    data: {
      id,
      projectId,
      path: `tables/${slug}.table`,
      slug,
      title,
      rowCount: 0,
      headCommitSha: "0".repeat(40),
      lastEditedById: null,
      lastEditedAt: new Date("2026-08-28T12:00:00.000Z"),
      createdAt: new Date("2026-08-28T12:00:00.000Z"),
    },
  });
}

describe("document router", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("create", () => {
    it("creates file + commit + index row; returns the save contract", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dc1");
      await addEligibleGitRemote(project.id);
      const res = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Getting Started",
        contentJson: PARA("Hello"),
      });
      expect(res).toMatchObject({
        slug: "getting-started",
        path: "getting-started.md",
      });
      expect(res.headCommitSha).toMatch(/^[0-9a-f]{40}$/);
      const repo = (await openProjectRepo(project.id))!;
      const file = (await repo.readCommittedFile("getting-started.md"))!
        .content;
      expect(file).toContain(`id: ${res.id}`);
      expect(file).toContain("Hello");
      const row = await getPrisma().document.findUnique({
        where: { id: res.id },
      });
      expect(row).toMatchObject({
        projectId: project.id,
        headCommitSha: res.headCommitSha,
      });
      expect(knowledgeQueue.jobs).toContainEqual({
        name: "document.search-sync",
        data: {
          projectId: project.id,
          documentId: res.id,
          sourceCommitSha: res.headCommitSha,
          pathAtSha: res.path,
        },
      });
      await vi.waitFor(
        () =>
          expect(knowledgeQueue.jobs).toContainEqual(
            expect.objectContaining({ name: "project.git-push" }),
          ),
        { timeout: 5000 },
      );
    });

    it("auto-suffixes slug collisions (never a user-facing error)", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dc2");
      const a = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Setup",
        contentJson: PARA("a"),
      });
      const b = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Setup",
        contentJson: PARA("b"),
      });
      expect(a.slug).toBe("setup");
      expect(b.slug).toBe("setup-2");
    });

    it("refuses creating into a missing folder with NOT_FOUND", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dc3");
      await expect(
        caller.document.create({
          projectId: project.id,
          folderPath: ["nope"],
          title: "X",
          contentJson: PARA("x"),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("permission matrix", async () => {
      const { project, caller } = await setupProjectWith("Viewer", "dc4");
      await expect(
        caller.document.create({
          projectId: project.id,
          folderPath: [],
          title: "X",
          contentJson: PARA("x"),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const { project: p2, caller: out } = await setupProjectWith(null, "dc5");
      await expect(
        out.document.create({
          projectId: p2.id,
          folderPath: [],
          title: "X",
          contentJson: PARA("x"),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("does not commit when projection materialization fails", async () => {
      const actor = await makeUser("User", "dc6");
      const project = await makeProject("P-dc6");
      await addMembership(project.id, actor.id, "Editor");
      const children: JSONContent[] = [
        {
          type: "paragraph",
          content: [{ type: "text", text: "body" }],
        },
      ];
      const visit = children.forEach.bind(children);
      let traversals = 0;
      Object.defineProperty(children, "forEach", {
        value: (callback: (node: JSONContent) => void) => {
          traversals += 1;
          if (traversals === 2) {
            throw new Error("excerpt materialization failed");
          }
          visit(callback);
        },
      });

      await expect(
        createDocument(
          getPrisma(),
          {
            projectId: project.id,
            folderPath: [],
            title: "Projection Fault",
            content: {
              kind: "markdown",
              contentJson: { type: "doc", content: children },
            },
          },
          { ...securityContextFor(actor), email: actor.email, name: null },
        ),
      ).rejects.toThrow("excerpt materialization failed");
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.listTrackedFiles()).not.toContain(
        "projection-fault.md",
      );
    });

    it("keeps a committed create successful and logs safe identifiers when enqueue fails", async () => {
      const { project, actor } = await setupProjectWith(
        "Editor",
        "dc-enqueue-failure",
      );
      const queueError = new Error("queue unavailable");
      const failingQueue: JobQueue = {
        send<N extends KnowledgeJobName>(
          _name: N,
          _data: KnowledgeJobPayloads[N],
        ) {
          return Promise.reject(queueError);
        },
        work: () => Promise.resolve(),
        schedule: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      };
      setJobQueueForTests(failingQueue);
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      let created!: Awaited<ReturnType<typeof createDocument>>;
      let logCall: unknown[] | undefined;
      try {
        created = await createDocument(
          getPrisma(),
          {
            projectId: project.id,
            folderPath: [],
            title: "Safe Queue Failure",
            content: { kind: "markdown", contentJson: PARA("committed body") },
          },
          { ...securityContextFor(actor), email: actor.email, name: null },
        );
        logCall = errorLog.mock.calls.find(
          ([message]) =>
            typeof message === "string" &&
            message.startsWith(
              "Knowledge enqueue failed after durable source transition",
            ),
        );
      } finally {
        setJobQueueForTests(knowledgeQueue);
        errorLog.mockRestore();
      }

      const repo = (await openProjectRepo(project.id))!;
      await expect(repo.resolveHead()).resolves.toBe(created.headCommitSha);
      // The identifiers now live in the knowledge.enqueue.failed event; the
      // console keeps only its reference, and no writer runs here.
      expect(logCall).toEqual([
        "Knowledge enqueue failed after durable source transition (ref none)",
      ]);
    });
  });

  describe("importFile", () => {
    it("creates a document from markdown, using the frontmatter title and stripping the block", async () => {
      const { project, caller } = await setupProjectWith("Editor", "imp1");
      const res = await caller.document.importFile({
        projectId: project.id,
        folderPath: [],
        fileName: "setup-guide.md",
        text: '---\ntitle: "Setup Guide"\nid: not-a-uuid\n---\n\n# Intro\n\nHello import\n',
      });
      expect(res).toMatchObject({
        slug: "setup-guide",
        path: "setup-guide.md",
      });
      const repo = (await openProjectRepo(project.id))!;
      const file = (await repo.readCommittedFile("setup-guide.md"))!.content;
      expect(file).toContain(`id: ${res.id}`);
      expect(file).toContain("\n# Setup Guide\n");
      expect(file).not.toContain("not-a-uuid");
      expect(file).toContain("Hello import");
      const document = await caller.document.get({
        projectId: project.id,
        documentId: res.id,
      });
      expect(document.title).toBe("Setup Guide");
      expect(knowledgeQueue.jobs).toContainEqual(
        expect.objectContaining({
          name: "document.search-sync",
          data: expect.objectContaining({ documentId: res.id }),
        }),
      );
    });

    it("derives the title from the file name and targets the requested folder", async () => {
      const { project, caller } = await setupProjectWith("Editor", "imp2");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "notes",
      });
      const res = await caller.document.importFile({
        projectId: project.id,
        folderPath: ["notes"],
        fileName: "weekly_status-report.md",
        text: "Just a body",
      });
      expect(res.path).toBe("notes/weekly-status-report.md");
      expect(
        (
          await caller.document.get({
            projectId: project.id,
            documentId: res.id,
          })
        ).title,
      ).toBe("Weekly status report");
    });

    it("rejects oversize markdown, Viewers, and non-members", async () => {
      const editor = await setupProjectWith("Editor", "imp3");
      await expect(
        editor.caller.document.importFile({
          projectId: editor.project.id,
          folderPath: [],
          fileName: "big.md",
          text: "x".repeat(200_001),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const viewer = await setupProjectWith("Viewer", "imp4");
      await expect(
        viewer.caller.document.importFile({
          projectId: viewer.project.id,
          folderPath: [],
          fileName: "a.md",
          text: "a",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const outsider = await setupProjectWith(null, "imp5");
      await expect(
        outsider.caller.document.importFile({
          projectId: outsider.project.id,
          folderPath: [],
          fileName: "a.md",
          text: "a",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("get", () => {
    it("returns content parsed from the file and baseCommitSha from git", async () => {
      const { project, caller } = await setupProjectWith("Viewer", "dg1");
      const actor = {
        ...(await makeUser("Admin", "dg1a")),
        name: "Ada Editor",
      };
      await addMembership(project.id, actor.id, "Editor");
      await getPrisma().user.update({
        where: { id: actor.id },
        data: { name: actor.name },
      });
      const created = await callerFor(actor).document.create({
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        contentJson: PARA("Body text"),
      });
      const got = await caller.document.get({
        projectId: project.id,
        documentId: created.id,
      });
      expect(got.title).toBe("Doc");
      expect(got.baseCommitSha).toBe(created.headCommitSha);
      expect(JSON.stringify(markdownContent(got))).toContain("Body text");
      expect(got.lastEditedBy).toEqual({
        id: actor.id,
        name: actor.name,
        email: actor.email,
      });
    });

    it("self-heals a drifted index headCommitSha from git", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Viewer",
        "dg2",
      );
      const created = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        contentJson: PARA("x"),
      });
      await getPrisma().document.update({
        where: { id: created.id },
        data: { headCommitSha: "0".repeat(40) },
      });
      const got = await caller.document.get({
        projectId: project.id,
        documentId: created.id,
      });
      expect(got.baseCommitSha).toBe(created.headCommitSha);
      const row = await getPrisma().document.findUnique({
        where: { id: created.id },
      });
      expect(row!.headCommitSha).toBe(created.headCommitSha);
    });

    it("unknown document in an accessible project is NOT_FOUND", async () => {
      const { project, caller } = await setupProjectWith("Viewer", "dg3");
      await expect(
        caller.document.get({
          projectId: project.id,
          documentId: "9e107d9d-4a5a-4c8e-8f6b-000000000000",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns NOT_FOUND when the projected document is truly deleted in Git", async () => {
      const { project, caller, ownerCaller, actor } = await setupProjectWith(
        "Viewer",
        "dg3b",
      );
      const created = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Deleted",
        contentJson: PARA("gone"),
      });
      await withProjectRepo(project.id, async (repo) => {
        await repo.rm(created.path);
        await repo.commitAll("external delete without projection", {
          name: null,
          email: actor.email,
          userId: actor.id,
        });
      });

      await expect(
        caller.document.get({
          projectId: project.id,
          documentId: created.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns an isolated content tree for every cached read", async () => {
      const { project, ownerCaller } = await setupProjectWith("Viewer", "dg4");
      const created = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        contentJson: PARA("Git body"),
      });
      const first = await ownerCaller.document.get({
        projectId: project.id,
        documentId: created.id,
      });
      markdownContent(first).content![0]!.content![0]!.text = "mutated";

      const second = await ownerCaller.document.get({
        projectId: project.id,
        documentId: created.id,
      });
      expect(JSON.stringify(markdownContent(second))).toContain("Git body");
      expect(JSON.stringify(markdownContent(second))).not.toContain("mutated");
    });

    it("returns content and base SHA from one committed snapshot during a concurrent save", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dg5");
      const created = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        contentJson: PARA("old body"),
      });
      const originalOpenProjectRepo = gitStore.openProjectRepo;
      let advanced = false;
      const advance = async () => {
        if (advanced) return;
        advanced = true;
        await caller.document.update({
          projectId: project.id,
          documentId: created.id,
          baseCommitSha: created.headCommitSha,
          content: { kind: "markdown", contentJson: PARA("new body") },
          changeSummary: "Advance the concurrent save",
        });
      };
      const openSpy = vi
        .spyOn(gitStore, "openProjectRepo")
        .mockImplementation(async (projectId) => {
          const repo = await originalOpenProjectRepo(projectId);
          if (!repo || projectId !== project.id) return repo;
          return {
            ...repo,
            resolveHead: async () => {
              const sha = await repo.resolveHead();
              await advance();
              return sha;
            },
            lastCommitForPath: async (relPath: string) => {
              const sha = await repo.lastCommitForPath(relPath);
              await advance();
              return sha;
            },
            readCommittedFile: async (relPath: string) => {
              const snapshotSha = await repo.resolveHead();
              const [entry] = await repo.logForPath(relPath, {
                skip: 0,
                limit: 1,
                commitish: snapshotSha,
              });
              const content = entry
                ? await repo.showFileAt(snapshotSha, relPath)
                : null;
              await advance();
              return entry && content
                ? { content, baseCommitSha: entry.sha }
                : null;
            },
          };
        });

      try {
        const got = await caller.document.get({
          projectId: project.id,
          documentId: created.id,
        });
        expect(advanced).toBe(true);
        expect(got.baseCommitSha).toBe(created.headCommitSha);
        expect(JSON.stringify(markdownContent(got))).toContain("old body");
        expect(JSON.stringify(markdownContent(got))).not.toContain("new body");
      } finally {
        openSpy.mockRestore();
      }
    });

    it("retries the current index path when a concurrent rename removes the captured path", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dg6");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "guides",
      });
      const created = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        contentJson: PARA("body"),
      });
      const originalOpenProjectRepo = gitStore.openProjectRepo;
      let moved = false;
      const move = async () => {
        if (moved) return;
        moved = true;
        await caller.document.move({
          projectId: project.id,
          documentId: created.id,
          folderPath: ["guides"],
        });
      };
      const openSpy = vi
        .spyOn(gitStore, "openProjectRepo")
        .mockImplementation(async (projectId) => {
          const repo = await originalOpenProjectRepo(projectId);
          if (!repo || projectId !== project.id) return repo;
          return {
            ...repo,
            resolveHead: async () => {
              await move();
              return repo.resolveHead();
            },
            lastCommitForPath: async (relPath: string) => {
              await move();
              return repo.lastCommitForPath(relPath);
            },
            readCommittedFile: async (relPath: string) => {
              await move();
              const snapshotSha = await repo.resolveHead();
              const blob = await repo.blobShaAt(snapshotSha, relPath);
              if (!blob) return null;
              const [entry] = await repo.logForPath(relPath, {
                skip: 0,
                limit: 1,
                commitish: snapshotSha,
              });
              return entry
                ? {
                    content: await repo.showFileAt(snapshotSha, relPath),
                    baseCommitSha: entry.sha,
                  }
                : null;
            },
          };
        });

      try {
        await expect(
          caller.document.get({
            projectId: project.id,
            documentId: created.id,
          }),
        ).resolves.toMatchObject({
          path: "guides/doc.md",
          title: "Doc",
        });
      } finally {
        openSpy.mockRestore();
      }
    });

    it("reads the renamed Git snapshot while move projection is paused", async () => {
      const { project, caller, actor } = await setupProjectWith(
        "Editor",
        "dg7",
      );
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "guides",
      });
      const created = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        contentJson: PARA("body during move"),
      });
      const db = getPrisma();
      const originalUpdate = db.document.update.bind(
        db.document,
      ) as unknown as (...args: unknown[]) => Promise<unknown>;
      let releaseProjection!: () => void;
      const projectionRelease = new Promise<void>((resolve) => {
        releaseProjection = resolve;
      });
      let markProjectionPaused!: () => void;
      const projectionPaused = new Promise<void>((resolve) => {
        markProjectionPaused = resolve;
      });
      const pausedDocument = new Proxy(db.document, {
        get(target, property): unknown {
          if (property === "update") {
            return async (...args: unknown[]) => {
              markProjectionPaused();
              await projectionRelease;
              return originalUpdate(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const pausedDb = new Proxy(db, {
        get(target, property): unknown {
          if (property === "document") return pausedDocument;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      let moveFinished = false;
      const movePromise = moveDocument(
        pausedDb,
        {
          projectId: project.id,
          documentId: created.id,
          folderPath: ["guides"],
        },
        { ...securityContextFor(actor), email: actor.email, name: null },
      ).finally(() => {
        moveFinished = true;
      });
      await projectionPaused;
      const repo = (await openProjectRepo(project.id))!;
      const moveSha = await repo.resolveHead();
      expect(
        await db.document.findUniqueOrThrow({ where: { id: created.id } }),
      ).toMatchObject({
        path: "doc.md",
        headCommitSha: created.headCommitSha,
      });

      let got!: Awaited<ReturnType<typeof getDocument>>;
      try {
        got = await getDocument(
          db,
          { projectId: project.id, documentId: created.id },
          securityContextFor(actor),
        );
        expect(moveFinished).toBe(false);
        expect(got).toMatchObject({
          path: "guides/doc.md",
          slug: "doc",
          baseCommitSha: moveSha,
        });
        expect(JSON.stringify(markdownContent(got))).toContain(
          "body during move",
        );
        expect(
          await db.document.findUniqueOrThrow({ where: { id: created.id } }),
        ).toMatchObject({
          path: "guides/doc.md",
          slug: "doc",
          headCommitSha: moveSha,
        });
      } finally {
        releaseProjection();
        await movePromise;
      }
    });
  });

  describe("update (save)", () => {
    it("appends a commit, bumps the index, and syncs links", async () => {
      const { project, caller } = await setupProjectWith("Editor", "du1");
      const target = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Target",
        contentJson: PARA("t"),
      });
      const source = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Source",
        contentJson: PARA("s"),
      });
      const withRef = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "crossref",
                attrs: { targetId: target.id, label: null },
              },
            ],
          },
        ],
      };
      const saved = await caller.document.update({
        projectId: project.id,
        documentId: source.id,
        baseCommitSha: source.headCommitSha,
        content: { kind: "markdown", contentJson: withRef },
        changeSummary: "Link the source document",
      });
      expect(saved.headCommitSha).not.toBe(source.headCommitSha);
      const links = await getPrisma().documentLink.findMany({
        where: { sourceDocumentId: source.id },
      });
      expect(links.map((l) => l.targetDocumentId)).toEqual([target.id]);
      const repo = (await openProjectRepo(project.id))!;
      const file = (await repo.readCommittedFile("source.md"))!.content;
      expect(file).toContain(`[Target](weaver://document/${target.id})`);
      expect(knowledgeQueue.jobs).toContainEqual({
        name: "document.search-sync",
        data: {
          projectId: project.id,
          documentId: saved.id,
          sourceCommitSha: saved.headCommitSha,
          pathAtSha: saved.path,
        },
      });
    });

    it("enqueues the exact restored document snapshot", async () => {
      const { project, caller } = await setupProjectWith(
        "Editor",
        "du-restore-index",
      );
      const created = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Restore Index",
        contentJson: PARA("version one"),
      });
      const saved = await caller.document.update({
        projectId: project.id,
        documentId: created.id,
        baseCommitSha: created.headCommitSha,
        content: { kind: "markdown", contentJson: PARA("version two") },
        changeSummary: "Create a restore source",
      });
      knowledgeQueue.jobs.length = 0;

      const restored = await caller.document.restore({
        expectedHeadCommitSha: saved.headCommitSha,
        projectId: project.id,
        documentId: created.id,
        sha: created.headCommitSha,
      });

      expect(restored.headCommitSha).not.toBe(saved.headCommitSha);
      expect(knowledgeQueue.jobs).toEqual([
        {
          name: "document.search-sync",
          data: {
            projectId: project.id,
            documentId: restored.id,
            sourceCommitSha: restored.headCommitSha,
            pathAtSha: restored.path,
          },
        },
      ]);
    });

    it("resolves and syncs table labels without leaking foreign targets", async () => {
      const { project, caller } = await setupProjectWith("Editor", "du-table");
      const source = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Source",
        contentJson: PARA("s"),
      });
      const table = await makeTable(project.id, "Budget", "budget");
      const other = await setupProjectWith("Editor", "du-table-other");
      const foreign = await makeTable(
        other.project.id,
        "Secret Budget",
        "secret-budget",
      );
      const unknownId = randomUUID();
      const contentJson = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "crossref",
                attrs: {
                  targetType: "table",
                  targetId: table.id,
                  label: "Old Budget",
                },
              },
              {
                type: "crossref",
                attrs: {
                  targetType: "table",
                  targetId: foreign.id,
                  label: "Foreign fallback",
                },
              },
              {
                type: "crossref",
                attrs: {
                  targetType: "table",
                  targetId: unknownId,
                  label: "Missing fallback",
                },
              },
            ],
          },
        ],
      };

      await caller.document.update({
        projectId: project.id,
        documentId: source.id,
        baseCommitSha: source.headCommitSha,
        content: { kind: "markdown", contentJson },
        changeSummary: "Link table targets",
      });

      const repo = (await openProjectRepo(project.id))!;
      const file = (await repo.readCommittedFile("source.md"))!.content;
      expect(file).toContain(`[Budget](weaver://table/${table.id})`);
      expect(file).toContain(
        `[Foreign fallback](weaver://table/${foreign.id})`,
      );
      expect(file).not.toContain("Secret Budget");
      expect(file).toContain(`[Missing fallback](weaver://table/${unknownId})`);
      const links = await getPrisma().documentLink.findMany({
        where: { sourceDocumentId: source.id },
        select: { targetDocumentId: true, targetType: true },
      });
      expect(links).toHaveLength(3);
      expect(links).toEqual(
        expect.arrayContaining(
          [table.id, foreign.id, unknownId].map((targetDocumentId) => ({
            targetDocumentId,
            targetType: "table",
          })),
        ),
      );
    });

    it("keeps document and table labels distinct when their ids collide", async () => {
      const { project, caller } = await setupProjectWith(
        "Editor",
        "du-typed-collision",
      );
      const target = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Document Target",
        contentJson: PARA("document"),
      });
      await makeTable(project.id, "Table Target", "table-target", target.id);
      const source = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Source",
        contentJson: PARA("source"),
      });

      await caller.document.update({
        projectId: project.id,
        documentId: source.id,
        baseCommitSha: source.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "crossref",
                    attrs: { targetId: target.id, label: "Old Document" },
                  },
                  {
                    type: "crossref",
                    attrs: {
                      targetType: "table",
                      targetId: target.id,
                      label: "Old Table",
                    },
                  },
                ],
              },
            ],
          },
        },
        changeSummary: "Link colliding typed targets",
      });

      const repo = (await openProjectRepo(project.id))!;
      const file = (await repo.readCommittedFile("source.md"))!.content;
      expect(file).toContain(
        `[Document Target](weaver://document/${target.id})`,
      );
      expect(file).toContain(`[Table Target](weaver://table/${target.id})`);
      const links = await getPrisma().documentLink.findMany({
        where: { sourceDocumentId: source.id },
        select: { targetType: true, targetDocumentId: true },
        orderBy: { targetType: "asc" },
      });
      expect(links).toEqual([
        { targetType: "document", targetDocumentId: target.id },
        { targetType: "table", targetDocumentId: target.id },
      ]);
    });

    it("CONFLICTs on a stale baseCommitSha when content changed", async () => {
      const { project, caller } = await setupProjectWith("Editor", "du2");
      const doc = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("v1"),
      });
      await caller.document.update({
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: PARA("v2") },
        changeSummary: "Create the current version",
      });
      await expect(
        caller.document.update({
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: doc.headCommitSha,
          content: { kind: "markdown", contentJson: PARA("v3") },
          changeSummary: "Attempt a stale save",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("auto-resolves when the blob is unchanged (pure folder move)", async () => {
      const { project, caller } = await setupProjectWith("Editor", "du3");
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "a",
      });
      const doc = await caller.document.create({
        projectId: project.id,
        folderPath: ["a"],
        title: "D",
        contentJson: PARA("v1"),
      });
      await caller.folder.rename({
        projectId: project.id,
        path: ["a"],
        name: "b",
      });
      await expect(
        caller.document.update({
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: doc.headCommitSha,
          content: { kind: "markdown", contentJson: PARA("v2") },
          changeSummary: "Save after moving folders",
        }),
      ).resolves.toMatchObject({ path: "b/d.md" });
    });

    it("title change renames the file via git mv and re-slugs", async () => {
      const { project, caller } = await setupProjectWith("Editor", "du4");
      const doc = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Old Name",
        contentJson: PARA("x"),
      });
      const saved = await caller.document.update({
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        title: "New Name",
        content: { kind: "markdown", contentJson: PARA("x") },
        changeSummary: "Rename the document",
      });
      expect(saved).toMatchObject({
        slug: "new-name",
        path: "new-name.md",
      });
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.listTrackedFiles()).toContain("new-name.md");
      expect(await repo.listTrackedFiles()).not.toContain("old-name.md");
      const [head] = await repo.logForPath("new-name.md", {
        skip: 0,
        limit: 1,
      });
      expect(head!.message).toBe(
        "update: new-name.md (was old-name.md) — Rename the document",
      );
    });

    it("does not suffix a document against its own historical path", async () => {
      const { project, caller } = await setupProjectWith("Editor", "du4b");
      const original = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Old Name",
        contentJson: PARA("x"),
      });
      const renamed = await caller.document.update({
        projectId: project.id,
        documentId: original.id,
        baseCommitSha: original.headCommitSha,
        title: "New Name",
        content: { kind: "markdown", contentJson: PARA("x") },
        changeSummary: "Rename before restoring title",
      });
      const restoredName = await caller.document.update({
        projectId: project.id,
        documentId: original.id,
        baseCommitSha: renamed.headCommitSha,
        title: "Old Name",
        content: { kind: "markdown", contentJson: PARA("x") },
        changeSummary: "Restore the original title",
      });
      expect(restoredName).toMatchObject({
        slug: "old-name",
        path: "old-name.md",
      });
    });

    it("Viewer cannot save", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Viewer",
        "du5",
      );
      const doc = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });
      await expect(
        caller.document.update({
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: doc.headCommitSha,
          content: { kind: "markdown", contentJson: PARA("y") },
          changeSummary: "Attempt a viewer save",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("list", () => {
    it("scopes results to the requested folder subtree", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Viewer",
        "dl-folder",
      );
      await ownerCaller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "guides",
      });
      await ownerCaller.folder.create({
        projectId: project.id,
        parentPath: ["guides"],
        name: "deep",
      });
      await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Root",
        contentJson: PARA("root"),
      });
      await ownerCaller.document.create({
        projectId: project.id,
        folderPath: ["guides"],
        title: "Setup",
        contentJson: PARA("setup"),
      });
      await ownerCaller.document.create({
        projectId: project.id,
        folderPath: ["guides", "deep"],
        title: "Nested",
        contentJson: PARA("nested"),
      });

      const scoped = await caller.document.list({
        projectId: project.id,
        page: 1,
        pageSize: 20,
        sort: "title",
        dir: "asc",
        folderPath: ["guides"],
      });
      expect(scoped.items.map((item) => item.path)).toEqual([
        "guides/deep/nested.md",
        "guides/setup.md",
      ]);
    });

    it("pages, sorts, and title-filters per entity-tables conventions", async () => {
      const { project, caller } = await setupProjectWith("Viewer", "dl1");
      const admin = await makeUser("Admin", "dl1a");
      await addMembership(project.id, admin.id, "Editor");
      for (const t of ["Alpha", "Beta", "Gamma"]) {
        await callerFor(admin).document.create({
          projectId: project.id,
          folderPath: [],
          title: t,
          contentJson: PARA(t),
        });
      }
      const page = await caller.document.list({
        projectId: project.id,
        page: 1,
        pageSize: 2,
        sort: "title",
        dir: "asc",
      });
      expect(page.total).toBe(3);
      expect(page.items.map((i) => i.title)).toEqual(["Alpha", "Beta"]);
      const filtered = await caller.document.list({
        projectId: project.id,
        page: 1,
        pageSize: 0,
        search: "amm",
        sort: "title",
        dir: "asc",
      });
      expect(filtered.items.map((i) => i.title)).toEqual(["Gamma"]);
    });
  });

  describe("move / delete", () => {
    it("moves a document into an existing folder with a move commit", async () => {
      const { project, caller, actor } = await setupProjectWith(
        "Editor",
        "dm1",
      );
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "guides",
      });
      const doc = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });

      const moved = await caller.document.move({
        projectId: project.id,
        documentId: doc.id,
        folderPath: ["guides"],
      });

      expect(moved.path).toBe("guides/d.md");
      const repo = (await openProjectRepo(project.id))!;
      const [head] = await repo.logForPath("guides/d.md", {
        skip: 0,
        limit: 1,
      });
      expect(head!.message).toBe("move: guides/d.md (was d.md)");
      const row = await getPrisma().document.findUnique({
        where: { id: doc.id },
      });
      expect(row).toMatchObject({
        path: moved.path,
        slug: moved.slug,
        headCommitSha: moved.headCommitSha,
        lastEditedById: actor.id,
      });
      expect(row!.lastEditedAt).toEqual(
        await repo.commitDate(moved.headCommitSha),
      );
      expect(knowledgeQueue.jobs).toContainEqual({
        name: "document.search-sync",
        data: {
          projectId: project.id,
          documentId: moved.id,
          sourceCommitSha: moved.headCommitSha,
          pathAtSha: moved.path,
        },
      });
    });

    it("re-slugs instead of overwriting an unindexed target-folder drift file", async () => {
      const { project, caller, actor } = await setupProjectWith(
        "Editor",
        "dm2",
      );
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "guides",
      });
      const source = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("source"),
      });
      const timestamp = "2026-08-27T12:34:56.000Z";
      const driftFile = composeDocumentFile(
        {
          id: randomUUID(),
          title: "Unindexed Drift",
          created: timestamp,
          createdBy: null,
          updated: timestamp,
          updatedBy: null,
          review: null,
        },
        serializeDocumentBody(PARA("target drift")),
        "markdown",
      );
      await withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic("guides/d.md", driftFile);
        await repo.commitAll("external unindexed target drift", {
          name: null,
          email: actor.email,
          userId: actor.id,
        });
      });

      const moved = await caller.document.move({
        projectId: project.id,
        documentId: source.id,
        folderPath: ["guides"],
      });

      expect(moved).toMatchObject({ path: "guides/d-2.md", slug: "d-2" });
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.showFileAt("HEAD", "guides/d.md")).toBe(driftFile);
      expect(await repo.showFileAt("HEAD", "guides/d-2.md")).toContain(
        `id: ${source.id}`,
      );
      expect(
        await getPrisma().document.findMany({
          where: { projectId: project.id },
          select: { id: true, path: true },
        }),
      ).toEqual([{ id: source.id, path: "guides/d-2.md" }]);
    });

    it("returns Git truth without committing when moving to its current folder", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dm3");
      const doc = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });
      await getPrisma().document.update({
        where: { id: doc.id },
        data: { title: "Stale", headCommitSha: "0".repeat(40) },
      });

      await expect(
        caller.document.move({
          projectId: project.id,
          documentId: doc.id,
          folderPath: [],
        }),
      ).resolves.toMatchObject({
        title: "D",
        headCommitSha: doc.headCommitSha,
      });
    });

    it("does not report success for a same-folder move when its Git file is missing", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dm3b");
      const doc = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });
      await withProjectRepo(project.id, async (repo) => {
        await repo.rm(doc.path);
        await repo.commitAll("external delete", {
          name: "System",
          email: "system@test.local",
          userId: "00000000-0000-4000-8000-000000000000",
        });
      });

      await expect(
        caller.document.move({
          projectId: project.id,
          documentId: doc.id,
          folderPath: [],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects a missing target folder and Viewer mutations", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Viewer",
        "dm4",
      );
      const doc = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });

      await expect(
        ownerCaller.document.move({
          projectId: project.id,
          documentId: doc.id,
          folderPath: ["missing"],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        caller.document.move({
          projectId: project.id,
          documentId: doc.id,
          folderPath: [],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller.document.delete({ projectId: project.id, documentId: doc.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("delete removes file + index row; inbound link rows survive", async () => {
      const { project, caller } = await setupProjectWith("Editor", "dd1");
      const target = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "T",
        contentJson: PARA("t"),
      });
      const source = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "S",
        contentJson: PARA("s"),
      });
      await caller.document.update({
        projectId: project.id,
        documentId: source.id,
        baseCommitSha: source.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "crossref",
                    attrs: { targetId: target.id, label: null },
                  },
                ],
              },
            ],
          },
        },
        changeSummary: "Link the document before deletion",
      });

      await caller.document.delete({
        projectId: project.id,
        documentId: target.id,
      });

      expect(
        await getPrisma().document.findUnique({ where: { id: target.id } }),
      ).toBeNull();
      const links = await getPrisma().documentLink.findMany({
        where: { sourceDocumentId: source.id },
      });
      expect(links.map((link) => link.targetDocumentId)).toEqual([target.id]);
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.listTrackedFiles()).not.toContain("t.md");
      const deletionSha = await repo.resolveHead();
      expect(knowledgeQueue.jobs).toContainEqual({
        name: "content.delete",
        data: {
          projectId: project.id,
          sourceType: "document",
          sourceId: target.id,
          sourceCommitSha: deletionSha,
        },
      });
    });

    it("hides a document deletion from a nonmember", async () => {
      const { project, ownerCaller } = await setupProjectWith("Viewer", "dd2");
      const document = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });
      const outsider = await makeUser("User", "out-dd2");

      await expect(
        callerFor(outsider).document.delete({
          projectId: project.id,
          documentId: document.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("resolveRefs", () => {
    it("resolves same-project ids and hides foreign or unknown ids in input order", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Viewer",
        "rr5",
      );
      const mine = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Mine",
        contentJson: PARA("m"),
      });
      const other = await setupProjectWith("Editor", "rr2");
      const foreign = await other.caller.document.create({
        projectId: other.project.id,
        folderPath: [],
        title: "Secret",
        contentJson: PARA("s"),
      });
      const mineTable = await makeTable(project.id, "Budget", "budget");
      const foreignTable = await makeTable(
        other.project.id,
        "Secret Table",
        "secret-table",
      );
      const unknown = "9e107d9d-4a5a-4c8e-8f6b-000000000000";

      const res = await caller.document.resolveRefs({
        projectId: project.id,
        ids: [
          foreign.id,
          foreignTable.id,
          mine.id,
          mineTable.id,
          unknown,
          mine.id,
        ],
      });

      expect(res).toEqual([
        { id: foreign.id, exists: false },
        { id: foreignTable.id, exists: false },
        expect.objectContaining({
          id: mine.id,
          exists: true,
          title: "Mine",
          targetType: "document",
        }),
        expect.objectContaining({
          id: mineTable.id,
          exists: true,
          title: "Budget",
          excerpt: "",
          targetType: "table",
        }),
        { id: unknown, exists: false },
        expect.objectContaining({
          id: mine.id,
          exists: true,
          title: "Mine",
          targetType: "document",
        }),
      ]);
    });

    it("hides resolution from a nonmember", async () => {
      const { project, ownerCaller } = await setupProjectWith("Viewer", "rr3");
      const document = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });
      const outsider = await makeUser("User", "out-rr3");

      await expect(
        callerFor(outsider).document.resolveRefs({
          projectId: project.id,
          ids: [document.id],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("backlinks", () => {
    it("lists same-project sources linking to the document in deterministic order", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Viewer",
        "bl1",
      );
      const target = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "T",
        contentJson: PARA("t"),
      });
      const sourceZ = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Z",
        contentJson: PARA("z"),
      });
      const sourceA = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "A",
        contentJson: PARA("a"),
      });
      const contentJson = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "crossref",
                attrs: { targetId: target.id, label: null },
              },
            ],
          },
        ],
      };
      await ownerCaller.document.update({
        projectId: project.id,
        documentId: sourceZ.id,
        baseCommitSha: sourceZ.headCommitSha,
        content: { kind: "markdown", contentJson },
        changeSummary: "Link source Z",
      });
      await ownerCaller.document.update({
        projectId: project.id,
        documentId: sourceA.id,
        baseCommitSha: sourceA.headCommitSha,
        content: { kind: "markdown", contentJson },
        changeSummary: "Link source A",
      });
      const tableOnlySource = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Table Only",
        contentJson: PARA("table"),
      });
      await getPrisma().documentLink.create({
        data: {
          sourceDocumentId: tableOnlySource.id,
          targetDocumentId: target.id,
          targetType: "table",
        },
      });
      const other = await setupProjectWith("Editor", "bl1-other");
      const foreignSource = await other.ownerCaller.document.create({
        projectId: other.project.id,
        folderPath: [],
        title: "Foreign Source",
        contentJson: PARA("foreign"),
      });
      await getPrisma().documentLink.create({
        data: {
          sourceDocumentId: foreignSource.id,
          targetDocumentId: target.id,
          targetType: "document",
        },
      });

      const res = await caller.document.backlinks({
        projectId: project.id,
        documentId: target.id,
      });

      expect(res.documents.map((row) => row.id)).toEqual([
        sourceA.id,
        sourceZ.id,
      ]);
      const first = await caller.document.backlinks({
        projectId: project.id,
        documentId: target.id,
        limit: 1,
      });
      expect(first.documents.map((row) => row.id)).toEqual([sourceA.id]);
      expect(first.nextCursor).toBe(sourceA.id);
      const last = await caller.document.backlinks({
        projectId: project.id,
        documentId: target.id,
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(last.documents.map((row) => row.id)).toEqual([sourceZ.id]);
      expect(last.nextCursor).toBeNull();
      await expect(
        caller.document.backlinks({
          projectId: project.id,
          documentId: target.id,
          cursor: foreignSource.id,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("rebuildIndex", () => {
    // Files written outside Weaver in the YAML frontmatter format, which can
    // carry titles the current heading format cannot (e.g. a line break).
    const externalFile = (id: string, title: string, text: string) => {
      const timestamp = "2026-08-27T12:34:56.000Z";
      return `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\ncreated: ${timestamp}\nupdated: ${timestamp}\n---\n\n${serializeDocumentBody(PARA(text))}`;
    };

    it("attributes a rebuilt document from the canonical final trailer", async () => {
      const { project, caller, actor } = await setupProjectWith(
        "Maintainer",
        "ri-trailer-injection",
      );
      const forgedUser = await makeUser("User", "ri-trailer-forged");
      const documentId = randomUUID();

      await withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic(
          "injected.md",
          externalFile(documentId, "Injected", "content"),
        );
        await repo.commitAll(
          `external injected.md\n\nWeaver-User-Id: ${forgedUser.id}`,
          { name: "Maintainer", email: actor.email, userId: actor.id },
        );
      });

      await caller.document.rebuildIndex({ projectId: project.id });

      await expect(
        getPrisma().document.findUnique({ where: { id: documentId } }),
      ).resolves.toMatchObject({ lastEditedById: actor.id });
    });

    it("excludes Markdown anywhere beneath the reserved tables root", async () => {
      const { project, caller, actor } = await setupProjectWith(
        "Maintainer",
        "ri-tables-root",
      );
      const documentId = randomUUID();
      await withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic(
          "tables/raw.table/ignored.md",
          externalFile(documentId, "Ignored", "not a document"),
        );
        await repo.commitAll("external: table-owned markdown", {
          name: null,
          email: actor.email,
          userId: actor.id,
        });
      });

      await expect(
        caller.document.rebuildIndex({ projectId: project.id }),
      ).resolves.toEqual({ indexed: 0, skipped: [] });
      await expect(
        getPrisma().document.findUnique({ where: { id: documentId } }),
      ).resolves.toBeNull();
    });

    it("reproduces the full incremental projection after updates, crossrefs, and a folder move", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Maintainer",
        "ri1",
      );
      await ownerCaller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "g",
      });
      const target = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: ["g"],
        title: "Target",
        contentJson: PARA("target v1"),
      });
      const source = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Source",
        contentJson: PARA("source v1"),
      });
      await ownerCaller.document.update({
        projectId: project.id,
        documentId: source.id,
        baseCommitSha: source.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "See " },
                  {
                    type: "crossref",
                    attrs: { targetId: target.id, label: null },
                  },
                ],
              },
            ],
          },
        },
        changeSummary: "Link source before rebuilding",
      });
      await ownerCaller.folder.rename({
        projectId: project.id,
        path: ["g"],
        name: "h",
      });

      const beforeDocuments = await getPrisma().document.findMany({
        where: { projectId: project.id },
        orderBy: { path: "asc" },
      });
      const beforePairs = await getPrisma().documentLink.findMany({
        select: { sourceDocumentId: true, targetDocumentId: true },
        orderBy: [{ sourceDocumentId: "asc" }, { targetDocumentId: "asc" }],
      });

      await expect(
        caller.document.rebuildIndex({ projectId: project.id }),
      ).resolves.toEqual({ indexed: 2, skipped: [] });

      expect(knowledgeQueue.jobs).toContainEqual({
        name: "project.reconcile",
        data: { projectId: project.id },
      });

      expect(
        await getPrisma().document.findMany({
          where: { projectId: project.id },
          orderBy: { path: "asc" },
        }),
      ).toEqual(beforeDocuments);
      expect(
        await getPrisma().documentLink.findMany({
          select: { sourceDocumentId: true, targetDocumentId: true },
          orderBy: [{ sourceDocumentId: "asc" }, { targetDocumentId: "asc" }],
        }),
      ).toEqual(beforePairs);
      expect(beforePairs).toEqual([
        { sourceDocumentId: source.id, targetDocumentId: target.id },
      ]);
    });

    it("skips malformed, duplicate, foreign, and colliding files while leaving HEAD and the dirty worktree byte-identical", async () => {
      const { project, caller, ownerCaller, actor } = await setupProjectWith(
        "Maintainer",
        "ri2",
      );
      const good = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Good",
        contentJson: PARA("good"),
      });
      const foreignContext = await setupProjectWith("Editor", "ri2-foreign");
      const foreign = await foreignContext.caller.document.create({
        projectId: foreignContext.project.id,
        folderPath: [],
        title: "Foreign",
        contentJson: PARA("secret"),
      });
      const emailUser = await makeUser("User", "ri2-email");
      const trailerUser = await makeUser("User", "ri2-trailer");
      const emailId = randomUUID();
      const trailerId = randomUUID();
      const unknownId = randomUUID();
      const slugCollisionId = randomUUID();

      await withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic("broken.md", "no frontmatter here\n");
        await repo.writeFileAtomic(
          "foreign.md",
          externalFile(foreign.id, "Foreign Copy", "foreign"),
        );
        await repo.writeFileAtomic(
          "nested/good.md",
          externalFile(slugCollisionId, "Good Elsewhere", "collision"),
        );
        await repo.writeFileAtomic(
          "z-duplicate.md",
          externalFile(good.id, "Duplicate", "duplicate"),
        );
        await repo.commitAll("external skip cases", {
          name: "Maintainer",
          email: actor.email,
          userId: actor.id,
        });

        const git = simpleGit({ baseDir: repo.dir }).env({
          GIT_COMMITTER_NAME: "Weaver",
          GIT_COMMITTER_EMAIL: "weaver@local",
        });
        const commitFile = async (
          filePath: string,
          content: string,
          authorName: string,
          authorEmail: string,
          trailer: string,
        ) => {
          await repo.writeFileAtomic(filePath, content);
          await git.add([filePath]);
          await git
            .env({
              GIT_AUTHOR_NAME: authorName,
              GIT_AUTHOR_EMAIL: authorEmail,
              GIT_COMMITTER_NAME: "Weaver",
              GIT_COMMITTER_EMAIL: "weaver@local",
            })
            .raw([
              "commit",
              "-m",
              `external ${filePath}`,
              "--trailer",
              trailer,
            ]);
        };
        await commitFile(
          "email.md",
          externalFile(emailId, "Email", "email"),
          "Email User",
          emailUser.email,
          "Weaver-User-Id: 11111111-1111-4111-8111-111111111111",
        );
        await commitFile(
          "trailer.md",
          externalFile(trailerId, "Trailer", "trailer"),
          "Email User",
          emailUser.email,
          `Weaver-User-Id: ${trailerUser.id.toUpperCase()}`,
        );
        await commitFile(
          "unknown.md",
          externalFile(unknownId, "Unknown", "unknown"),
          "Unknown User",
          "unknown@example.invalid",
          "Weaver-User-Id: not-a-uuid",
        );
      });

      const repo = (await openProjectRepo(project.id))!;
      const projectRepoDir = repoDir(project.id);
      const git = simpleGit({ baseDir: projectRepoDir });
      await writeFile(
        path.join(projectRepoDir, "good.md"),
        "dirty good bytes\n",
      );
      await writeFile(
        path.join(projectRepoDir, "untracked.tmp"),
        "untracked bytes\n",
      );
      const before = {
        head: (await git.revparse(["HEAD"])).trim(),
        status: await git.raw(["status", "--porcelain=v1"]),
        dirty: await readFile(path.join(projectRepoDir, "good.md"), "utf8"),
        untracked: await readFile(
          path.join(projectRepoDir, "untracked.tmp"),
          "utf8",
        ),
        tracked: await repo.showFileAt("HEAD", "good.md"),
      };

      const report = await caller.document.rebuildIndex({
        projectId: project.id,
      });

      expect(report.indexed).toBe(4);
      expect(report.skipped).toHaveLength(4);
      const skippedByPath = new Map(
        report.skipped.map(({ path: filePath, reason }) => [filePath, reason]),
      );
      expect(skippedByPath.get("broken.md")).toContain("document header");
      expect(skippedByPath.get("foreign.md")).toContain(
        "belongs to another project",
      );
      expect(skippedByPath.get("nested/good.md")).toContain(
        "duplicate slug good",
      );
      expect(skippedByPath.get("z-duplicate.md")).toContain(
        `duplicate id ${good.id}`,
      );
      expect(
        await getPrisma().document.findUnique({ where: { id: good.id } }),
      ).toMatchObject({ path: "good.md" });
      expect(
        await getPrisma().document.findUnique({ where: { id: emailId } }),
      ).toMatchObject({ lastEditedById: null });
      expect(
        await getPrisma().document.findUnique({ where: { id: trailerId } }),
      ).toMatchObject({ lastEditedById: null });
      expect(
        await getPrisma().document.findUnique({ where: { id: unknownId } }),
      ).toMatchObject({ lastEditedById: null });
      expect(
        await getPrisma().document.findUnique({ where: { id: foreign.id } }),
      ).toMatchObject({ projectId: foreignContext.project.id });
      expect({
        head: (await git.revparse(["HEAD"])).trim(),
        status: await git.raw(["status", "--porcelain=v1"]),
        dirty: await readFile(path.join(projectRepoDir, "good.md"), "utf8"),
        untracked: await readFile(
          path.join(projectRepoDir, "untracked.tmp"),
          "utf8",
        ),
        tracked: await repo.showFileAt("HEAD", "good.md"),
      }).toEqual(before);
    });

    it("skips external files outside the path, size, and title contract without changing Git", async () => {
      const { project, caller, ownerCaller, actor } = await setupProjectWith(
        "Maintainer",
        "ri-contract",
      );
      const good = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Good",
        contentJson: PARA("good"),
      });
      const invalidIds = Array.from({ length: 5 }, () => randomUUID());
      const deepPath = `${Array.from({ length: 11 }, (_, i) => `d${i}`).join("/")}/deep.md`;

      await withProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic(
          "Bad/upper.md",
          externalFile(invalidIds[0]!, "Upper Folder", "invalid folder"),
        );
        await repo.writeFileAtomic(
          "bad_name.md",
          externalFile(invalidIds[1]!, "Bad Basename", "invalid basename"),
        );
        await repo.writeFileAtomic(
          deepPath,
          externalFile(invalidIds[2]!, "Too Deep", "deep"),
        );
        await repo.writeFileAtomic("too-large.md", "x".repeat(2_000_001));
        await repo.writeFileAtomic(
          "long-title.md",
          externalFile(invalidIds[3]!, "t".repeat(201), "long title"),
        );
        await repo.writeFileAtomic(
          "newline-title.md",
          externalFile(invalidIds[4]!, "Line one\nLine two", "newline title"),
        );
        await repo.commitAll("external invalid contract files", {
          name: "Maintainer",
          email: actor.email,
          userId: actor.id,
        });
      });

      const repo = (await openProjectRepo(project.id))!;
      const git = simpleGit({ baseDir: repoDir(project.id) });
      const before = {
        head: await repo.resolveHead(),
        status: await git.raw(["status", "--porcelain=v1"]),
      };
      const report = await caller.document.rebuildIndex({
        projectId: project.id,
      });

      expect(report.indexed).toBe(1);
      expect(report.skipped).toHaveLength(6);
      const skippedByPath = new Map(
        report.skipped.map(({ path: filePath, reason }) => [filePath, reason]),
      );
      expect(skippedByPath.get("Bad/upper.md")).toContain(
        "invalid path segment",
      );
      expect(skippedByPath.get("bad_name.md")).toContain(
        "invalid path segment",
      );
      expect(skippedByPath.get(deepPath)).toContain("folder depth exceeds 10");
      expect(skippedByPath.get("too-large.md")).toContain("document too large");
      expect(skippedByPath.get("long-title.md")).toContain(
        "title exceeds 200 characters",
      );
      expect(skippedByPath.get("newline-title.md")).toContain(
        "title must be a single line",
      );
      await expect(
        getPrisma().document.findUnique({ where: { id: good.id } }),
      ).resolves.toMatchObject({ path: "good.md", title: "Good" });
      for (const id of invalidIds) {
        await expect(
          getPrisma().document.findUnique({ where: { id } }),
        ).resolves.toBeNull();
      }
      expect({
        head: await repo.resolveHead(),
        status: await git.raw(["status", "--porcelain=v1"]),
      }).toEqual(before);
    });

    it("repairs missing and stale projections from successful Git commits", async () => {
      const { project, caller, ownerCaller } = await setupProjectWith(
        "Maintainer",
        "ri3",
      );
      const target = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Target",
        contentJson: PARA("target"),
      });
      const source = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Source",
        contentJson: PARA("source"),
      });
      const saved = await ownerCaller.document.update({
        projectId: project.id,
        documentId: source.id,
        baseCommitSha: source.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "crossref",
                    attrs: { targetId: target.id, label: null },
                  },
                ],
              },
            ],
          },
        },
        changeSummary: "Link source before projection repair",
      });
      const committed = await getPrisma().document.findMany({
        where: { projectId: project.id },
        orderBy: { path: "asc" },
      });
      await getPrisma().document.delete({ where: { id: source.id } });
      await getPrisma().document.update({
        where: { id: target.id },
        data: {
          path: "stale.md",
          slug: "stale",
          title: "Stale",
          excerpt: "stale",
          headCommitSha: "0".repeat(40),
          lastEditedById: null,
          lastEditedAt: new Date(0),
        },
      });

      await expect(
        caller.document.rebuildIndex({ projectId: project.id }),
      ).resolves.toEqual({ indexed: 2, skipped: [] });
      expect(
        await getPrisma().document.findMany({
          where: { projectId: project.id },
          orderBy: { path: "asc" },
        }),
      ).toEqual(committed);
      expect(
        await getPrisma().documentLink.findMany({
          select: { sourceDocumentId: true, targetDocumentId: true },
        }),
      ).toEqual([{ sourceDocumentId: source.id, targetDocumentId: target.id }]);
      expect(saved.headCommitSha).toBe(
        committed.find((row) => row.id === source.id)!.headCommitSha,
      );
    });

    it("pins one HEAD snapshot when a commit lands during the scan", async () => {
      const { project, caller, ownerCaller, actor } = await setupProjectWith(
        "Maintainer",
        "ri-snapshot",
      );
      const original = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Original",
        contentJson: PARA("old body"),
      });
      const before = await getPrisma().document.findMany({
        where: { projectId: project.id },
        orderBy: { path: "asc" },
      });
      const repo = (await gitStore.openProjectRepo(project.id))!;
      const originalWithExistingProjectRepoReader =
        gitStore.withExistingProjectRepoReader;
      let advanced = false;
      const existingSpy = vi
        .spyOn(gitStore, "withExistingProjectRepoReader")
        .mockImplementation((projectId, fn) => {
          return originalWithExistingProjectRepoReader(
            projectId,
            async (lockedRepo) => {
              if (projectId !== project.id) return fn(lockedRepo);
              return fn({
                ...lockedRepo,
                listTrackedFiles: async (commitish = "HEAD") => {
                  const files = await lockedRepo.listTrackedFiles(commitish);
                  if (!advanced) {
                    advanced = true;
                    const projectRepoDir = repoDir(project.id);
                    await writeFile(
                      path.join(projectRepoDir, original.path),
                      externalFile(original.id, "Changed", "new body"),
                    );
                    await writeFile(
                      path.join(projectRepoDir, "new.md"),
                      externalFile(randomUUID(), "New", "new file"),
                    );
                    const git = simpleGit({ baseDir: projectRepoDir }).env({
                      GIT_AUTHOR_NAME: "Maintainer",
                      GIT_AUTHOR_EMAIL: actor.email,
                      GIT_COMMITTER_NAME: "Weaver",
                      GIT_COMMITTER_EMAIL: "weaver@local",
                    });
                    await git.raw(["add", "-A"]);
                    await git.raw([
                      "commit",
                      "-m",
                      "external concurrent commit",
                      "--trailer",
                      `Weaver-User-Id: ${actor.id}`,
                    ]);
                  }
                  return files;
                },
              });
            },
          );
        });

      try {
        await expect(
          caller.document.rebuildIndex({ projectId: project.id }),
        ).resolves.toEqual({ indexed: 1, skipped: [] });
      } finally {
        existingSpy.mockRestore();
      }
      expect(advanced).toBe(true);
      expect(
        await getPrisma().document.findMany({
          where: { projectId: project.id },
          orderBy: { path: "asc" },
        }),
      ).toEqual(before);
      expect(await repo.listTrackedFiles()).toEqual(["new.md", original.path]);
    });

    it("serializes a normal save behind snapshot rebuild and preserves the newer projection", async () => {
      const { project, ownerCaller, actor } = await setupProjectWith(
        "Maintainer",
        "ri-writer",
      );
      const original = await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Original",
        contentJson: PARA("old body"),
      });
      const db = getPrisma();
      const originalTransaction = db.$transaction.bind(db) as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let releaseRebuild!: () => void;
      const rebuildRelease = new Promise<void>((resolve) => {
        releaseRebuild = resolve;
      });
      let markRebuildPaused!: () => void;
      const rebuildPaused = new Promise<void>((resolve) => {
        markRebuildPaused = resolve;
      });
      const pausedDb = new Proxy(db, {
        get(target, property): unknown {
          if (property === "$transaction") {
            return async (...args: unknown[]) => {
              markRebuildPaused();
              await rebuildRelease;
              return originalTransaction(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const originalWithProjectRepo = gitStore.withProjectRepo;
      let markWriterRequested!: () => void;
      const writerRequested = new Promise<void>((resolve) => {
        markWriterRequested = resolve;
      });
      let markWriterEntered!: () => void;
      const writerEntry = new Promise<void>((resolve) => {
        markWriterEntered = resolve;
      });
      let writerEntered = false;
      const writerSpy = vi
        .spyOn(gitStore, "withProjectRepo")
        .mockImplementation((projectId, fn) => {
          markWriterRequested();
          return originalWithProjectRepo(projectId, async (repo) => {
            writerEntered = true;
            markWriterEntered();
            return fn(repo);
          });
        });

      const rebuildPromise = rebuildIndex(
        pausedDb,
        { projectId: project.id },
        securityContextFor(actor),
      );
      await rebuildPaused;
      const writerPromise = ownerCaller.document.update({
        projectId: project.id,
        documentId: original.id,
        baseCommitSha: original.headCommitSha,
        content: { kind: "markdown", contentJson: PARA("new body") },
        changeSummary: "Save while rebuilding",
      });
      await writerRequested;
      let entryTimeout: ReturnType<typeof setTimeout> | undefined;
      const writerEnteredBeforeRelease = await Promise.race([
        writerEntry.then(() => true),
        new Promise<false>((resolve) => {
          entryTimeout = setTimeout(() => resolve(false), 5_000);
        }),
      ]);
      if (entryTimeout) clearTimeout(entryTimeout);
      expect(writerEntered).toBe(writerEnteredBeforeRelease);
      if (writerEnteredBeforeRelease) await writerPromise;
      releaseRebuild();

      let saved;
      try {
        [, saved] = await Promise.all([rebuildPromise, writerPromise]);
      } finally {
        writerSpy.mockRestore();
      }

      expect(writerEnteredBeforeRelease).toBe(false);
      const row = await db.document.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(row).toMatchObject({
        excerpt: "new body",
        headCommitSha: saved.headCommitSha,
      });
      const repo = (await openProjectRepo(project.id))!;
      expect(await repo.resolveHead()).toBe(saved.headCommitSha);
      expect(await repo.showFileAt("HEAD", original.path)).toContain(
        "new body",
      );
    });

    it("requires Maintainer while allowing Owner and global Admin", async () => {
      const owner = await makeUser("User", "ri4-owner");
      const project = await makeProject("P-ri4");
      await addMembership(project.id, owner.id, "Owner");
      const ownerCaller = callerFor(owner);
      await ownerCaller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "D",
        contentJson: PARA("x"),
      });
      const maintainer = await makeUser("User", "ri4-maintainer");
      const editor = await makeUser("User", "ri4-editor");
      const viewer = await makeUser("User", "ri4-viewer");
      const outsider = await makeUser("User", "ri4-outsider");
      const admin = await makeUser("Admin", "ri4-admin");
      await addMembership(project.id, maintainer.id, "Maintainer");
      await addMembership(project.id, editor.id, "Editor");
      await addMembership(project.id, viewer.id, "Viewer");
      await addMembership(project.id, admin.id, "Maintainer");

      await expect(
        callerFor(maintainer).document.rebuildIndex({ projectId: project.id }),
      ).resolves.toMatchObject({ indexed: 1 });
      await expect(
        ownerCaller.document.rebuildIndex({ projectId: project.id }),
      ).resolves.toMatchObject({ indexed: 1 });
      await expect(
        callerFor(admin).document.rebuildIndex({ projectId: project.id }),
      ).resolves.toMatchObject({ indexed: 1 });
      await expect(
        callerFor(editor).document.rebuildIndex({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerFor(viewer).document.rebuildIndex({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerFor(outsider).document.rebuildIndex({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("does not erase an existing projection when the repository is absent", async () => {
      const { project, caller, actor } = await setupProjectWith(
        "Maintainer",
        "ri5",
      );
      const id = randomUUID();
      await getPrisma().document.create({
        data: {
          id,
          projectId: project.id,
          path: "orphan.md",
          slug: "orphan",
          title: "Orphan",
          excerpt: "orphan",
          headCommitSha: "1".repeat(40),
          lastEditedById: actor.id,
          lastEditedAt: new Date("2026-08-27T12:34:56.000Z"),
          createdAt: new Date("2026-08-27T12:34:56.000Z"),
          updatedAt: new Date("2026-08-27T12:34:56.000Z"),
        },
      });

      await expect(
        caller.document.rebuildIndex({ projectId: project.id }),
      ).resolves.toEqual({
        indexed: 0,
        skipped: [{ path: "", reason: "project repository not found" }],
      });
      await expect(
        getPrisma().document.findUnique({ where: { id } }),
      ).resolves.toMatchObject({ title: "Orphan", path: "orphan.md" });
      await expect(openProjectRepo(project.id)).resolves.toBeNull();
    });
  });
  it("rejects carriage returns at the direct document service boundary", async () => {
    const { project, actor } = await setupProjectWith(
      "Editor",
      "direct-title-invariant",
    );
    await expect(
      createDocument(
        getPrisma(),
        {
          projectId: project.id,
          folderPath: [],
          title: "Alpha\rBeta",
          content: { kind: "markdown", contentJson: PARA("body") },
        },
        {
          ...securityContextFor(actor),
          name: null,
          email: actor.email,
        },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await getPrisma().document.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });

  it("preserves every accepted normalized title through an unchanged rebuild", async () => {
    const { project, caller } = await setupProjectWith(
      "Maintainer",
      "title-rebuild-roundtrip",
    );
    const titles = [
      "Alpha Beta",
      "Budget 界",
      "a".repeat(200),
      "  Trimmed title  ",
    ];
    const documents = [];
    for (const title of titles)
      documents.push(
        await caller.document.create({
          projectId: project.id,
          folderPath: [],
          title,
          contentJson: PARA("body"),
        }),
      );
    await expect(
      caller.document.rebuildIndex({ projectId: project.id }),
    ).resolves.toEqual({ indexed: titles.length, skipped: [] });
    for (const [index, document] of documents.entries()) {
      expect(
        await caller.document.get({
          projectId: project.id,
          documentId: document.id,
        }),
      ).toMatchObject({ title: titles[index]!.trim() });
    }
  });

  it("repairs swapped projection paths without deleting the retained documents", async () => {
    const { project, caller } = await setupProjectWith(
      "Maintainer",
      "rebuild-path-swap",
    );
    const first = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "First",
      contentJson: PARA("first"),
    });
    const second = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Second",
      contentJson: PARA("second"),
    });
    const db = getPrisma();
    await db.document.update({
      where: { id: first.id },
      data: { path: "temporary.md", slug: "temporary" },
    });
    await db.document.update({
      where: { id: second.id },
      data: { path: first.path, slug: "first" },
    });
    await db.document.update({
      where: { id: first.id },
      data: { path: second.path, slug: "second" },
    });
    await expect(
      caller.document.rebuildIndex({ projectId: project.id }),
    ).resolves.toEqual({ indexed: 2, skipped: [] });
    expect(
      await db.document.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ path: first.path, slug: "first" });
    expect(
      await db.document.findUniqueOrThrow({ where: { id: second.id } }),
    ).toMatchObject({ path: second.path, slug: "second" });
  });
  it.each([false, true])(
    "repairs a committed document projection inside an existing lock (moved: %s)",
    async (moved) => {
      const { project, caller } = await setupProjectWith(
        "Editor",
        `locked-repair-${moved}`,
      );
      let document = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Repair Source",
        contentJson: PARA("Committed body"),
      });
      if (moved) {
        await caller.folder.create({
          projectId: project.id,
          parentPath: [],
          name: "guides",
        });
        document = await caller.document.move({
          projectId: project.id,
          documentId: document.id,
          folderPath: ["guides"],
        });
      }
      await getPrisma().document.delete({ where: { id: document.id } });
      const repaired = await withProjectRepo(project.id, (repo) =>
        repairDocumentProjectionInRepo(
          getPrisma(),
          repo,
          project.id,
          document.id,
        ),
      );
      expect(repaired).toMatchObject({
        id: document.id,
        path: document.path,
        headCommitSha: document.headCommitSha,
        title: "Repair Source",
      });
      expect(
        await caller.document.get({
          projectId: project.id,
          documentId: document.id,
        }),
      ).toMatchObject({
        title: "Repair Source",
        baseCommitSha: document.headCommitSha,
      });
      await caller.document.delete({
        projectId: project.id,
        documentId: document.id,
      });
      await expect(
        withProjectRepo(project.id, (repo) =>
          repairDocumentProjectionInRepo(
            getPrisma(),
            repo,
            project.id,
            document.id,
          ),
        ),
      ).resolves.toBeNull();
      expect(
        await getPrisma().document.findUnique({ where: { id: document.id } }),
      ).toBeNull();
    },
  );
});

describe("document review regressions", () => {
  beforeEach(async () => {
    await resetDb();
  });
  it("rejects malformed trees and unsafe titles before creating a version", async () => {
    const { project, caller } = await setupProjectWith(
      "Editor",
      "review-validation",
    );
    for (const contentJson of [
      "text",
      { type: "doc", content: [{ type: "unknown" }] },
    ]) {
      await expect(
        caller.document.create({
          projectId: project.id,
          folderPath: [],
          title: "Invalid",
          contentJson,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    for (const title of ["Line\u2028break", "Line\u2029break", "Null\0title"]) {
      await expect(
        caller.document.create({
          projectId: project.id,
          folderPath: [],
          title,
          contentJson: PARA("body"),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(
      await getPrisma().document.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });
  it("keeps NUL-containing bodies rebuildable and excerpts safe for PostgreSQL", async () => {
    const { project, caller, ownerCaller } = await setupProjectWith(
      "Editor",
      "review-nul",
    );
    const created = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Nul body",
      contentJson: PARA("before\0after"),
    });
    expect(
      (
        await getPrisma().document.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).excerpt,
    ).toBe("beforeafter");
    await expect(
      ownerCaller.document.rebuildIndex({ projectId: project.id }),
    ).resolves.toMatchObject({ indexed: 1 });
  });
  it("returns Git content even when read projection healing fails", async () => {
    const { project, caller } = await setupProjectWith("Editor", "review-heal");
    const created = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Heal",
      contentJson: PARA("committed"),
    });
    await getPrisma().document.update({
      where: { id: created.id },
      data: { headCommitSha: "0".repeat(40) },
    });
    const update = vi
      .spyOn(getPrisma().document, "updateMany")
      .mockRejectedValueOnce(new Error("projection collision"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        caller.document.get({ projectId: project.id, documentId: created.id }),
      ).resolves.toMatchObject({
        title: "Heal",
        baseCommitSha: created.headCommitSha,
      });
    } finally {
      update.mockRestore();
      log.mockRestore();
    }
  });
  it("preserves a summary supplied through the shared document write tail", async () => {
    const { project, caller, actor } = await setupProjectWith(
      "Editor",
      "review-summary",
    );
    const created = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Summary",
      contentJson: PARA("before"),
    });
    const security = securityContextFor(actor);
    await withProjectRepo(project.id, (repo) =>
      writeDocumentInRepo(
        getPrisma(),
        repo,
        project.id,
        {
          kind: "update",
          documentId: created.id,
          baseCommitSha: created.headCommitSha,
          content: { kind: "markdown", contentJson: PARA("after") },
          changeSummary: "Explain the change",
        },
        { ...security, name: null, email: actor.email },
        { operation: "update" },
      ),
    );
    const repo = (await openProjectRepo(project.id))!;
    expect(
      (await repo.logForPath(created.path, { skip: 0, limit: 1 }))[0]?.message,
    ).toContain(" — Explain the change");
  });
  it("resolves colliding document and table ids with both target types", async () => {
    const { project, caller } = await setupProjectWith("Editor", "review-refs");
    const created = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Document",
      contentJson: PARA("body"),
    });
    await makeTable(project.id, "Table", "typed-table", created.id);
    const resolved = await caller.document.resolveRefs({
      projectId: project.id,
      ids: [created.id],
    });
    expect(resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetType: "document", title: "Document" }),
        expect.objectContaining({ targetType: "table", title: "Table" }),
      ]),
    );
  });
});

it("queues a distinct projection repair after a committed create loses its projection", async () => {
  const { project, actor } = await setupProjectWith(
    "Editor",
    "projection-repair-review",
  );
  const db = getPrisma();
  const queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  const transaction = vi
    .spyOn(db, "$transaction")
    .mockRejectedValueOnce(new Error("projection failed"));
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Repair me",
        content: { kind: "markdown", contentJson: PARA("committed body") },
      },
      { ...securityContextFor(actor), email: actor.email, name: null },
    );
    expect(
      await db.document.findUnique({ where: { id: created.id } }),
    ).toBeNull();
    expect(queue.jobs).toContainEqual({
      name: "project.reconcile",
      data: { projectId: project.id, repairDocumentIds: [created.id] },
    });
    transaction.mockRestore();
    await withProjectRepo(project.id, (repo) =>
      repairDocumentProjectionInRepo(db, repo, project.id, created.id),
    );
    expect(
      (
        await getDocument(
          db,
          { projectId: project.id, documentId: created.id },
          securityContextFor(actor),
        )
      ).title,
    ).toBe("Repair me");
  } finally {
    transaction.mockRestore();
    log.mockRestore();
  }
});

it("rejects restore and diff of a different document at a reused historical path", async () => {
  const { project, caller, actor } = await setupProjectWith(
    "Editor",
    "historic-identity-review",
  );
  const created = await caller.document.create({
    projectId: project.id,
    folderPath: [],
    title: "Identity",
    contentJson: PARA("body"),
  });
  const repo = (await openProjectRepo(project.id))!;
  const original = await repo.showFileAt("HEAD", created.path);
  const foreign = original.replace(created.id, randomUUID());
  const foreignSha = await withProjectRepo(project.id, async (writer) => {
    await writer.writeFileAtomic(created.path, foreign);
    const sha = await writer.commitAll("foreign identity", {
      name: null,
      email: actor.email,
      userId: actor.id,
    });
    await writer.writeFileAtomic(created.path, original);
    await writer.commitAll("current identity", {
      name: null,
      email: actor.email,
      userId: actor.id,
    });
    return sha;
  });
  const current = await caller.document.get({
    projectId: project.id,
    documentId: created.id,
  });
  await expect(
    caller.document.diff({
      projectId: project.id,
      documentId: created.id,
      fromSha: foreignSha,
      toSha: current.baseCommitSha,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.document.restore({
      projectId: project.id,
      documentId: created.id,
      sha: foreignSha,
      expectedHeadCommitSha: current.baseCommitSha,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

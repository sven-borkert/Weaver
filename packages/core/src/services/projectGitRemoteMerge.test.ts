import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { captureError } from "../diagnostics/writer";
import type { FolderMetadata } from "../documents/folderMetadata";
vi.mock("../diagnostics/writer", () => ({ captureError: vi.fn() }));
vi.mock("./untrackedDocuments", () => ({
  lockUntracked: vi.fn(),
  moveUntrackedPrefix: vi.fn(),
  reslugUntrackedDocument: vi.fn(),
  untrackedSlugTaken: vi.fn(async () => false),
}));
vi.mock("./folders", () => ({
  listScopeDirsAt: vi.fn(async () => []),
  readFolderMetadataAt: vi.fn(async () => ({})),
}));
vi.mock("./projectMetadata", () => ({
  PROJECT_METADATA_PATH: "project.json",
  composeProjectMetadataFor: vi.fn(async () => "{}\n"),
}));
import { describe, expect, it, vi } from "vitest";
import {
  hasCaseCollidingPaths,
  mergeFetchedBranch,
} from "./projectGitRemoteMerge";

describe("portable pull tree paths", () => {
  it("rejects aliases in filenames and parent directories", () => {
    expect(hasCaseCollidingPaths(["Foo.md", "foo.md"])).toBe(true);
    expect(hasCaseCollidingPaths(["Docs/a.md", "docs/b.md"])).toBe(true);
    expect(hasCaseCollidingPaths(["café.md", "cafe\u0301.md"])).toBe(true);
    expect(
      hasCaseCollidingPaths(["same.md", "same.md", "docs/a.md", "docs/b.md"]),
    ).toBe(false);
  });
});

it("reports transient-ref cleanup failure without replacing the accepted pull", async () => {
  const head = "a".repeat(40);
  const cleanup = new Error("ref cleanup failed");
  const repo = {
    resolveHead: vi.fn(async () => head),
    fetchLocalRef: vi.fn(async () => head),
    listTreeEntries: vi.fn(async () => []),
    listTrackedFiles: vi.fn(async () => []),
    isAncestor: vi.fn(async () => true),
    fileExistsInWorktree: vi.fn(async () => true),
    readFileFromWorktree: vi.fn(async () => "{}\n"),
    deleteRef: vi.fn(async () => {
      throw cleanup;
    }),
  } as unknown as ProjectRepoWriter;
  const result = await mergeFetchedBranch({} as PrismaClient, repo, {
    projectId: "project",
    bareDirectory: "/unused",
    branch: "main",
    remoteHead: head,
    author: { name: "Author", email: "author@test", userId: "author" },
  });
  expect(result.mergedSha).toBe(head);
  expect(captureError).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "git.remote.pull_cleanup_failed",
      projectId: "project",
      error: cleanup,
    }),
  );
});

describe("pulled trees and content kept out of Git", () => {
  const localHead = "1".repeat(40);
  const remoteHead = "2".repeat(40);
  const mergedSha = "3".repeat(40);

  /** In-memory untracked store behind the Prisma calls the pull makes. */
  function fakeStore() {
    const state = {
      folders: ["notes", "team/scratch"],
      documents: [
        {
          id: "u1",
          path: "team/notes.md",
          slug: "team-notes",
          kind: "markdown",
          title: "Team notes",
        },
        {
          id: "u2",
          path: "team/scratch/idea.md",
          slug: "idea",
          kind: "markdown",
          title: "Idea",
        },
        {
          id: "u3",
          path: "old/keep.md",
          slug: "keep",
          kind: "markdown",
          title: "Keep",
        },
        {
          id: "u4",
          path: "notes/private.md",
          slug: "private",
          kind: "markdown",
          title: "Private",
        },
        {
          id: "u5",
          path: "plan.md",
          slug: "plan",
          kind: "markdown",
          title: "Plan",
        },
      ],
      created: [] as Array<{ path: string; metadata: string }>,
      log: [] as string[],
    };
    const shift = (from: string, to: string) => (path: string) =>
      path.startsWith(`${from}/`)
        ? `${to}/${path.slice(from.length + 1)}`
        : path;
    const db = {
      untrackedFolder: {
        findMany: vi.fn(async () =>
          [...state.folders].sort().map((path) => ({ path })),
        ),
        update: vi.fn(
          async (args: {
            where: { projectId_path: { path: string } };
            data: { path: string };
          }) => {
            const from = args.where.projectId_path.path;
            state.log.push(`folder ${from} -> ${args.data.path}`);
            state.folders = state.folders.map((path) =>
              path === from ? args.data.path : path,
            );
          },
        ),
        upsert: vi.fn(
          async (args: { create: { path: string; metadata: string } }) => {
            state.log.push(`keep ${args.create.path}`);
            state.created.push(args.create);
            state.folders.push(args.create.path);
          },
        ),
      },
      untrackedDocument: {
        findMany: vi.fn(async () =>
          [...state.documents].sort((a, b) => (a.path < b.path ? -1 : 1)),
        ),
      },
      untrackedFile: { findMany: vi.fn(async () => []) },
      document: { findFirst: vi.fn(async () => null) },
    };
    return { state, shift, db: db as unknown as PrismaClient };
  }

  it("carries, keeps, moves aside and re-slugs untracked content before publishing", async () => {
    const { state, shift, db } = fakeStore();
    const untracked = await import("./untrackedDocuments");
    vi.mocked(untracked.lockUntracked).mockImplementation(async () => {
      state.log.push("lock");
    });
    vi.mocked(untracked.moveUntrackedPrefix).mockImplementation(
      async (_db, _projectId, from, to) => {
        state.log.push(`prefix ${from} -> ${to}`);
        state.folders = state.folders.map(shift(from, to));
        for (const document of state.documents)
          document.path = shift(from, to)(document.path);
      },
    );
    vi.mocked(untracked.reslugUntrackedDocument).mockImplementation(
      async (_db, _projectId, documentId, slug) => {
        state.log.push(`reslug ${documentId} -> ${slug}`);
      },
    );
    vi.mocked(untracked.untrackedSlugTaken).mockImplementation(
      async (_db, _projectId, slug) =>
        state.documents.some((document) => document.slug === slug),
    );
    const folders = await import("./folders");
    vi.mocked(folders.listScopeDirsAt).mockResolvedValue([
      "crew",
      "guides",
      "notes",
    ]);
    vi.mocked(folders.readFolderMetadataAt).mockImplementation(
      async (_repo, _scope, commit): Promise<Record<string, FolderMetadata>> =>
        commit === localHead
          ? {
              team: {
                id: "team-id",
                name: "Team",
                created: null,
                createdBy: null,
                updated: null,
                updatedBy: null,
              },
              old: {
                id: "old-id",
                name: "Old",
                created: null,
                createdBy: null,
                updated: null,
                updatedBy: null,
              },
            }
          : {
              crew: {
                id: "team-id",
                name: "Team",
                created: null,
                createdBy: null,
                updated: null,
                updatedBy: null,
              },
            },
    );
    const trees: Record<string, string[]> = {
      [localHead]: ["team/.folder.json", "old/.folder.json"],
      "refs/weaver/pull": ["crew/.folder.json"],
      [mergedSha]: [
        "crew/.folder.json",
        "notes/meeting.md",
        "guides/plan.md",
        "project.json",
      ],
    };
    const repo = {
      resolveHead: vi.fn(async () => localHead),
      fetchLocalRef: vi.fn(async () => remoteHead),
      listTreeEntries: vi.fn(async () => []),
      listTrackedFiles: vi.fn(async (ref: string) => trees[ref] ?? []),
      listTrackedBlobs: vi.fn(async () => []),
      readBlobsAt: vi.fn(async () => new Map()),
      isAncestor: vi.fn(async (left: string) => left === localHead),
      mergeBase: vi.fn(async () => localHead),
      resetWorktreeTo: vi.fn(async () => undefined),
      writeFileAtomic: vi.fn(async () => undefined),
      createTreeCommit: vi.fn(async () => mergedSha),
      publishTreeCommit: vi.fn(async () => {
        state.log.push("publish");
      }),
      deleteRef: vi.fn(async () => undefined),
    } as unknown as ProjectRepoWriter;

    const result = await mergeFetchedBranch(db, repo, {
      projectId: "project",
      bareDirectory: "/unused",
      branch: "main",
      remoteHead,
      author: { name: "Author", email: "author@test", userId: "author" },
    });

    expect(result).toMatchObject({ mergedSha, fastForward: true });
    expect(state.log).toEqual([
      "lock",
      // Pulled content landed in the untracked folder: it moves aside first.
      "folder notes -> notes-2",
      "prefix notes -> notes-2",
      // The renamed tracked folder takes its untracked content along.
      "prefix team -> crew",
      // The deleted one stays as a folder outside Git.
      "keep old",
      // A pulled document took the slug.
      "reslug u5 -> plan-2",
      "publish",
    ]);
    expect(state.documents.map((document) => document.path)).toEqual([
      "crew/notes.md",
      "crew/scratch/idea.md",
      "old/keep.md",
      "notes-2/private.md",
      "plan.md",
    ]);
    expect(state.folders.sort()).toEqual(["crew/scratch", "notes-2", "old"]);
    expect(JSON.parse(state.created[0]!.metadata)).toMatchObject({
      id: "old-id",
      name: "Old",
    });
  });
});

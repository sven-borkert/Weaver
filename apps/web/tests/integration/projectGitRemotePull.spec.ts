import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { simpleGit } from "simple-git";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeUser,
  resetDb,
  securityContextFor,
  testEncryptionKeys,
} from "./_harness";
import {
  openProjectRepo,
  repoDir,
  withExistingProjectRepo,
} from "@weaver/git-store";
import { GitRemoteError } from "@weaver/git-store/remote";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import {
  parseSchemaFile,
  serializeSchemaFile,
} from "@weaver/core/tables/jsonl";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import { composeProjectMetadataFor } from "@weaver/core/services/projectMetadata";
import { mergeFetchedBranch } from "@weaver/core/services/projectGitRemoteMerge";
import * as mergeService from "@weaver/core/services/projectGitRemoteMerge";
import {
  PROJECT_GIT_LEASE_MS,
  PROJECT_GIT_QUEUE_TTL_MS,
  pullProjectGitRemote,
  discoverProjectGitRemotes,
} from "@weaver/core/services/projectGitRemoteJobs";
import {
  getProjectGitRemote,
  requestProjectGitRemotePull,
  saveProjectGitRemote,
} from "@weaver/core/services/projectGitRemote";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { encryptSecret, secretAad } from "@weaver/core/security/encryption";

const execAsync = promisify(execFile);
const T0 = "2026-09-10T00:00:00.000Z";

const PARA = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const IMAGE_DOC = (src: string) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Notes" }] },
    { type: "image", attrs: { src, alt: "Shot", title: null } },
  ],
});
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const TEXT_COL = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Item",
  type: "text" as const,
};
const ROW_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "weaver-git-pull-spec-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
});

/** Builds a non-bare "remote" repository with the git CLI, seeds it through
 * `build`, commits, and clones it `--bare` — mirroring how a real fetched
 * remote branch arrives (see remote.test.ts). */
async function buildRemoteRepo(
  build: (
    source: string,
    git: (...args: string[]) => Promise<string>,
  ) => Promise<void>,
): Promise<{ bareDirectory: string; remoteHead: string }> {
  const source = path.join(tmp, `source-${randomUUID()}`);
  await execAsync("git", ["init", "-b", "main", source]);
  const git = async (...args: string[]) =>
    (await execAsync("git", ["-C", source, ...args])).stdout.trim();
  await git("config", "user.name", "Remote Fixture");
  await git("config", "user.email", "remote-fixture@example.test");
  await build(source, git);
  await git("add", ".");
  await git("commit", "-m", "seed");
  const remoteHead = await git("rev-parse", "HEAD");
  const bareDirectory = path.join(tmp, `remote-${randomUUID()}.git`);
  await execAsync("git", ["clone", "--bare", source, bareDirectory]);
  return { bareDirectory, remoteHead };
}

async function parentsOf(projectId: string, sha: string): Promise<string[]> {
  return (
    await simpleGit(repoDir(projectId)).raw(["log", "--format=%P", "-1", sha])
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

async function pullRefs(projectId: string): Promise<string> {
  return (
    await simpleGit(repoDir(projectId)).raw(["for-each-ref", "refs/weaver"])
  ).trim();
}

async function ownerProject(suffix: string, name: string) {
  const owner = await makeUser("User", suffix);
  const caller = callerFor(owner);
  const project = await caller.project.create({ name });
  const author = { name: "Puller", email: owner.email, userId: owner.id };
  return { owner, caller, project, author };
}

describe("mergeFetchedBranch", () => {
  it("merges into a fresh project: remote content plus regenerated project.json, correct parents", async () => {
    const { project, author } = await ownerProject(
      "pull-fresh",
      "Fresh Project",
    );
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const docA = randomUUID();
    const docB = randomUUID();
    const tableT = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(
          path.join(source, "project.json"),
          '{"placeholder":true}\n',
        );
        await mkdir(path.join(source, "guides"), { recursive: true });
        await writeFile(
          path.join(source, "guides/intro.md"),
          composeDocumentFile(
            {
              id: docA,
              title: "Intro",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Intro body\n",
            "markdown",
          ),
        );
        await writeFile(
          path.join(source, "notes.md"),
          composeDocumentFile(
            {
              id: docB,
              title: "Notes",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote notes body\n",
            "markdown",
          ),
        );
        await mkdir(path.join(source, "tables/budget.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/budget.table/schema.json"),
          serializeSchemaFile({
            id: tableT,
            title: "Budget",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/budget.table/data.jsonl"),
          "",
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome).toMatchObject({
      remoteHead,
      fastForward: false,
      reslugged: [],
    });

    const repo = (await openProjectRepo(project.id))!;
    expect(await repo.listTrackedFiles()).toEqual(
      expect.arrayContaining([
        "guides/intro.md",
        "notes.md",
        "tables/budget.table/schema.json",
        "tables/budget.table/data.jsonl",
        "project.json",
      ]),
    );
    const projectJson = await repo.readCommittedFile("project.json");
    expect(projectJson!.content).toBe(
      await composeProjectMetadataFor(getPrisma(), project.id),
    );
    // No re-slug happened, so the merge commit's second parent is localHead
    // directly — no intermediate "prepare" commit was created.
    expect(await parentsOf(project.id, outcome.mergedSha)).toEqual([
      remoteHead,
      localHeadBefore,
    ]);
    expect(await pullRefs(project.id)).toBe("");
  });

  it("re-slugs a local document that collides by path with a different remote identity, moving its assets", async () => {
    const { owner, caller, project, author } = await ownerProject(
      "pull-reslug",
      "Reslug Project",
    );
    const localNotes = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: IMAGE_DOC("notes.assets/pic.png"),
    });
    const actor = {
      ...securityContextFor(owner),
      name: "Owner",
      email: owner.email,
    };
    await storeDocumentImage(
      getPrisma(),
      {
        projectId: project.id,
        documentId: localNotes.id,
        fileName: "pic.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const remoteNoteId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "notes.md"),
          composeDocumentFile(
            {
              id: remoteNoteId,
              title: "Notes",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote notes\n",
            "markdown",
          ),
        );
        // Remote also owns an asset at the same conventional path/name as
        // the local document's image, with different bytes: a move that
        // clobbers this path instead of writing to a fresh one would lose
        // either copy.
        await mkdir(path.join(source, "notes.assets"), { recursive: true });
        await writeFile(path.join(source, "notes.assets/pic.png"), GIF_1X1);
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      { kind: "document", from: "notes.md", to: "notes-2.md" },
    ]);

    // R1: the re-slug is a separate single-parent "prepare" commit ahead of
    // the merge commit, not content introduced only by the merge itself.
    const mergeParents = await parentsOf(project.id, outcome.mergedSha);
    expect(mergeParents).toHaveLength(2);
    expect(mergeParents[0]).toBe(remoteHead);
    const preparedSha = mergeParents[1]!;
    expect(await parentsOf(project.id, preparedSha)).toEqual([localHeadBefore]);

    const repo = (await openProjectRepo(project.id))!;
    // Because the re-slug is its own ordinary (single-parent) commit, the
    // moved path has real, discoverable git history — this is the assertion
    // that actually proves R1, not just that the blob is present in the tree.
    const remoteFile = await repo.readCommittedFile("notes.md");
    expect(parseDocumentFile(remoteFile!.content, "markdown").meta.id).toBe(
      remoteNoteId,
    );
    const movedFile = await repo.readCommittedFile("notes-2.md");
    expect(parseDocumentFile(movedFile!.content, "markdown").meta.id).toBe(
      localNotes.id,
    );
    expect(movedFile!.content).toContain("notes-2.assets/pic.png");
    const movedLog = await repo.logForPath("notes-2.md", { skip: 0, limit: 5 });
    expect(movedLog.length).toBeGreaterThan(0);

    const trackedAfter = await repo.listTrackedFiles();
    expect(trackedAfter).toContain("notes-2.assets/pic.png");
    expect(trackedAfter).toContain("notes.assets/pic.png");

    // Byte-exact: the moved asset is local's PNG, remote's own same-named
    // asset at notes.assets/pic.png is untouched (still the GIF).
    const movedBlob = await repo.readCommittedBlobAt(
      outcome.mergedSha,
      "notes-2.assets/pic.png",
      1_000_000,
    );
    expect(Buffer.from(movedBlob!.bytes)).toEqual(PNG_1X1);
    const remoteBlob = await repo.readCommittedBlobAt(
      outcome.mergedSha,
      "notes.assets/pic.png",
      1_000_000,
    );
    expect(Buffer.from(remoteBlob!.bytes)).toEqual(GIF_1X1);

    expect(await pullRefs(project.id)).toBe("");
  });

  it("re-slugs past a slug another local folder already holds, because slugs are unique project-wide", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-reslug-slug",
      "Reslug Slug Project",
    );
    for (const name of ["z", "a"]) {
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name,
      });
    }
    const localTopic = await caller.document.create({
      projectId: project.id,
      folderPath: ["z"],
      title: "Topic",
      contentJson: PARA("Local topic"),
    });
    const otherTopic = await caller.document.create({
      projectId: project.id,
      folderPath: ["a"],
      title: "Topic",
      contentJson: PARA("Other topic"),
    });
    expect(localTopic.path).toBe("z/topic.md");
    expect(otherTopic.path).toBe("a/topic-2.md");

    const remoteTopicId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "z"), { recursive: true });
        await writeFile(
          path.join(source, "z/topic.md"),
          composeDocumentFile(
            {
              id: remoteTopicId,
              title: "Topic",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote topic\n",
            "markdown",
          ),
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    // "z/topic-2.md" is a free path, but "topic-2" is a/topic-2.md's slug.
    expect(outcome.reslugged).toEqual([
      { kind: "document", from: "z/topic.md", to: "z/topic-3.md" },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const tracked = await repo.listTrackedFiles();
    expect(tracked).not.toContain("z/topic-2.md");
    const idAt = async (file: string) =>
      parseDocumentFile(
        (await repo.readCommittedFile(file))!.content,
        "markdown",
      ).meta.id;
    expect(await idAt("z/topic.md")).toBe(remoteTopicId);
    expect(await idAt("z/topic-3.md")).toBe(localTopic.id);
    expect(await idAt("a/topic-2.md")).toBe(otherTopic.id);
    expect(await pullRefs(project.id)).toBe("");
  });

  it("re-slugs a local markdown document whose slug a remote python file takes", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-reslug-python",
      "Reslug Python Project",
    );
    const localNotes = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Tool",
      contentJson: PARA("Local notes"),
    });
    expect(localNotes.path).toBe("tool.md");

    const remoteToolId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "tool.py"),
          composeDocumentFile(
            {
              id: remoteToolId,
              title: "Tool",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "print('remote')\n",
            "python",
          ),
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      { kind: "document", from: "tool.md", to: "tool-2.md" },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const remoteFile = parseDocumentFile(
      (await repo.readCommittedFile("tool.py"))!.content,
      "python",
    );
    expect(remoteFile.meta.id).toBe(remoteToolId);
    expect(remoteFile.body).toBe("print('remote')\n");
    expect(
      parseDocumentFile(
        (await repo.readCommittedFile("tool-2.md"))!.content,
        "markdown",
      ).meta.id,
    ).toBe(localNotes.id);

    await caller.document.rebuildIndex({ projectId: project.id });
    const rows = await getPrisma().document.findMany({
      where: { projectId: project.id },
      select: { id: true, kind: true, path: true },
      orderBy: { path: "asc" },
    });
    expect(rows).toEqual([
      { id: localNotes.id, kind: "markdown", path: "tool-2.md" },
      { id: remoteToolId, kind: "python", path: "tool.py" },
    ]);
  });

  it("preserves both conflicting versions when unrelated histories share a document id", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-sameid",
      "Same Id Project",
    );
    const local = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Shared",
      contentJson: PARA("Local shared body"),
    });
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "shared.md"),
          composeDocumentFile(
            {
              id: local.id,
              title: "Shared",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote shared body\n",
            "markdown",
          ),
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      {
        kind: "document",
        from: "shared.md",
        to: "shared-2.md",
        reassignedId: true,
      },
    ]);
    const parents = await parentsOf(project.id, outcome.mergedSha);
    expect(parents[0]).toBe(remoteHead);
    expect(await parentsOf(project.id, parents[1]!)).toEqual([localHeadBefore]);

    const repo = (await openProjectRepo(project.id))!;
    const merged = await repo.readCommittedFile("shared.md");
    expect(merged!.content).toContain("Remote shared body");
    const copy = parseDocumentFile(
      (await repo.readCommittedFile("shared-2.md"))!.content,
      "markdown",
    );
    expect(copy.body).toContain("Local shared body");
    expect(copy.meta.id).not.toBe(local.id);
  });

  it("re-slugs and reassigns the id of a local document and table the remote carries at another path (I3)", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-i3-merge",
      "Reassign Id Project",
    );
    const localNotes = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: PARA("Local notes body"),
    });
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "milk" } }],
    });

    // The remote renamed both items elsewhere: their ids live at paths that
    // do not collide with the local ones.
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "archive"), { recursive: true });
        await writeFile(
          path.join(source, "archive/notes.md"),
          composeDocumentFile(
            {
              id: localNotes.id,
              title: "Notes",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote renamed notes\n",
            "markdown",
          ),
        );
        await mkdir(path.join(source, "tables/ledger.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/ledger.table/schema.json"),
          serializeSchemaFile({
            id: localTable.id,
            title: "Ledger",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/ledger.table/data.jsonl"),
          "",
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      {
        kind: "document",
        from: "notes.md",
        to: "notes-2.md",
        reassignedId: true,
      },
      {
        kind: "table",
        from: "tables/budget.table",
        to: "tables/budget-2.table",
        reassignedId: true,
      },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const remoteDoc = await repo.readCommittedFile("archive/notes.md");
    expect(parseDocumentFile(remoteDoc!.content, "markdown").meta.id).toBe(
      localNotes.id,
    );
    const movedDoc = parseDocumentFile(
      (await repo.readCommittedFile("notes-2.md"))!.content,
      "markdown",
    );
    expect(movedDoc.meta.id).not.toBe(localNotes.id);
    expect(movedDoc.meta.title).toBe("Notes");
    expect(movedDoc.body).toContain("Local notes body");

    const remoteSchema = await repo.readCommittedFile(
      "tables/ledger.table/schema.json",
    );
    expect(parseSchemaFile(remoteSchema!.content).id).toBe(localTable.id);
    const movedSchema = parseSchemaFile(
      (await repo.readCommittedFile("tables/budget-2.table/schema.json"))!
        .content,
    );
    expect(movedSchema.id).not.toBe(localTable.id);
    expect(movedSchema.title).toBe("Budget");
    expect(
      (await repo.readCommittedFile("tables/budget-2.table/data.jsonl"))!
        .content,
    ).toContain("milk");
  });

  it("restores a non-ASCII remote path on a later pull (I2)", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-unicode",
      "Unicode Project",
    );
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Local",
      contentJson: PARA("Local body"),
    });
    const merge = async (fetched: {
      bareDirectory: string;
      remoteHead: string;
    }) =>
      (await withExistingProjectRepo(project.id, (repo) =>
        mergeFetchedBranch(getPrisma(), repo, {
          projectId: project.id,
          bareDirectory: fetched.bareDirectory,
          branch: "main",
          remoteHead: fetched.remoteHead,
          author,
        }),
      ))!;

    const umlautId = randomUUID();
    await merge(
      await buildRemoteRepo(async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "docs"), { recursive: true });
        await writeFile(
          path.join(source, "docs/Übersicht.md"),
          composeDocumentFile(
            {
              id: umlautId,
              title: "Übersicht",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote overview\n",
            "markdown",
          ),
        );
      }),
    );
    const repoAfterFirst = (await openProjectRepo(project.id))!;
    expect(await repoAfterFirst.listTrackedFiles()).toContain(
      "docs/Übersicht.md",
    );

    // A second pull from a remote that lacks the path must restore the local
    // copy — the C-quoted listing used to make that restore fail forever.
    await merge(
      await buildRemoteRepo(async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "guide.md"),
          composeDocumentFile(
            {
              id: randomUUID(),
              title: "Guide",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Guide body\n",
            "markdown",
          ),
        );
      }),
    );
    const repo = (await openProjectRepo(project.id))!;
    const tracked = await repo.listTrackedFiles();
    expect(tracked).toContain("docs/Übersicht.md");
    expect(tracked).toContain("guide.md");
    const restored = await repo.readCommittedFile("docs/Übersicht.md");
    expect(parseDocumentFile(restored!.content, "markdown").meta.id).toBe(
      umlautId,
    );
  });

  it("keeps a local document and a local-only folder unchanged when the remote lacks their paths", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-localonly",
      "Local Only Project",
    );
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Local Only",
      contentJson: PARA("Only here"),
    });
    await caller.folder.create({
      projectId: project.id,
      parentPath: [],
      name: "empty-folder",
    });

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "other.md"),
          composeDocumentFile(
            {
              id: randomUUID(),
              title: "Other",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote other\n",
            "markdown",
          ),
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([]);

    const repo = (await openProjectRepo(project.id))!;
    const kept = await repo.readCommittedFile("local-only.md");
    expect(kept!.content).toContain("Only here");
    expect(await repo.listTrackedFiles()).toEqual(
      expect.arrayContaining([
        "local-only.md",
        "other.md",
        "empty-folder/.gitkeep",
      ]),
    );
  });

  it("never re-slugs non-Weaver files: remote wins the path whether or not the content matches (R2)", async () => {
    const { project, author } = await ownerProject(
      "pull-nonweaver",
      "Non Weaver Project",
    );
    const dir = repoDir(project.id);
    // Two non-canonical/non-Weaver local files: a plain-text file (never
    // Weaver content regardless of extension) and a frontmatter-less .md
    // with a non-canonical basename — exactly the shape that used to throw
    // PathError building a re-slug path (C1).
    await writeFile(path.join(dir, "notes.txt"), "shared text\n");
    await writeFile(path.join(dir, "README.md"), "# Local readme\n");
    await execAsync("git", ["-C", dir, "add", "."]);
    await execAsync("git", [
      "-C",
      dir,
      "-c",
      "user.name=Weaver",
      "-c",
      "user.email=weaver@local",
      "commit",
      "-m",
      "local misc files",
    ]);

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(path.join(source, "notes.txt"), "shared text\n");
        await writeFile(path.join(source, "README.md"), "# Remote readme\n");
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([]);

    const repo = (await openProjectRepo(project.id))!;
    const tracked = await repo.listTrackedFiles();
    // Never re-slugged: no README-2.md / notes-2.txt appeared.
    expect(tracked.filter((p) => p.includes("README"))).toEqual(["README.md"]);
    expect(tracked.filter((p) => p.includes("notes"))).toEqual(["notes.txt"]);
    const readme = await repo.readCommittedFile("README.md");
    expect(readme!.content).toBe("# Remote readme\n");
    const notes = await repo.readCommittedFile("notes.txt");
    expect(notes!.content).toBe("shared text\n");
  });

  it("treats an already-merged remote head as up to date and commits nothing (R4)", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-uptodate",
      "Up To Date Project",
    );
    const midSha = await (await openProjectRepo(project.id))!.resolveHead();

    const bareDirectory = path.join(tmp, `anc-${randomUUID()}.git`);
    await execAsync("git", [
      "clone",
      "--bare",
      repoDir(project.id),
      bareDirectory,
    ]);

    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Ahead",
      contentJson: PARA("Local moved ahead"),
    });
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead: midSha,
        author,
      }),
    ))!;
    // R4: nothing to merge and project.json is already current — no commit
    // at all; the reported sha is simply the unchanged local head.
    expect(outcome).toMatchObject({
      fastForward: false,
      reslugged: [],
      remoteHead: midSha,
      mergedSha: localHeadBefore,
    });
    expect(await (await openProjectRepo(project.id))!.resolveHead()).toBe(
      localHeadBefore,
    );
    expect(await pullRefs(project.id)).toBe("");
  });

  it("a second consecutive pull of the same branch is a no-op (R4)", async () => {
    const { project, author } = await ownerProject(
      "pull-second-noop",
      "Second Pull No-op Project",
    );
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "guide.md"),
          composeDocumentFile(
            {
              id: randomUUID(),
              title: "Guide",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Guide body\n",
            "markdown",
          ),
        );
      },
    );

    const first = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(first.fastForward).toBe(false);

    const beforeSecond = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();
    expect(beforeSecond).toBe(first.mergedSha);

    const second = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(second).toMatchObject({
      mergedSha: first.mergedSha,
      remoteHead,
      fastForward: false,
      reslugged: [],
    });
    expect(await (await openProjectRepo(project.id))!.resolveHead()).toBe(
      first.mergedSha,
    );
    expect(await pullRefs(project.id)).toBe("");
  });

  it("records a true fast-forward when the local head is an ancestor of the remote head", async () => {
    const { project, author } = await ownerProject(
      "pull-fastforward",
      "Fast Forward Project",
    );

    const worktree = path.join(tmp, `ff-wt-${randomUUID()}`);
    await execAsync("git", ["clone", repoDir(project.id), worktree]);
    const git = async (...args: string[]) =>
      (await execAsync("git", ["-C", worktree, ...args])).stdout.trim();
    await git("config", "user.name", "Remote Fixture");
    await git("config", "user.email", "remote-fixture@example.test");
    await writeFile(
      path.join(worktree, "guide.md"),
      composeDocumentFile(
        {
          id: randomUUID(),
          title: "Guide",
          created: T0,
          createdBy: null,
          updated: T0,
          updatedBy: null,
          review: null,
        },
        "Guide body\n",
        "markdown",
      ),
    );
    await git("add", ".");
    await git("commit", "-m", "remote extra commit");
    const remoteHead = await git("rev-parse", "HEAD");
    const bareDirectory = path.join(tmp, `ff-bare-${randomUUID()}.git`);
    await execAsync("git", ["clone", "--bare", worktree, bareDirectory]);

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome).toMatchObject({
      fastForward: true,
      reslugged: [],
      remoteHead,
    });

    const repo = (await openProjectRepo(project.id))!;
    expect(await repo.listTrackedFiles()).toEqual(
      expect.arrayContaining(["guide.md", "project.json"]),
    );
    expect(await parentsOf(project.id, outcome.mergedSha)).toEqual([
      remoteHead,
    ]);
  });

  it("adopts deliberate remote identity replacement during fast-forward", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-ff-collision",
      "FF Collision Project",
    );
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Shared",
      contentJson: PARA("Local original body"),
    });
    // The "remote" descends directly from the local repository's own
    // history (so the local head really is a git ancestor of it) but its
    // one extra commit replaces the same document with a different id at
    // the same path — a genuine content collision despite the ancestry.
    const worktree = path.join(tmp, `ff-collide-wt-${randomUUID()}`);
    await execAsync("git", ["clone", repoDir(project.id), worktree]);
    const git = async (...args: string[]) =>
      (await execAsync("git", ["-C", worktree, ...args])).stdout.trim();
    await git("config", "user.name", "Remote Fixture");
    await git("config", "user.email", "remote-fixture@example.test");
    const remoteDocId = randomUUID();
    await writeFile(
      path.join(worktree, "shared.md"),
      composeDocumentFile(
        {
          id: remoteDocId,
          title: "Shared",
          created: T0,
          createdBy: null,
          updated: T0,
          updatedBy: null,
          review: null,
        },
        "Remote replaced body\n",
        "markdown",
      ),
    );
    await git("add", ".");
    await git("commit", "-m", "remote replaces shared.md");
    const remoteHead = await git("rev-parse", "HEAD");
    const bareDirectory = path.join(tmp, `ff-collide-bare-${randomUUID()}.git`);
    await execAsync("git", ["clone", "--bare", worktree, bareDirectory]);

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.fastForward).toBe(true);
    expect(outcome.reslugged).toEqual([]);
    expect(await parentsOf(project.id, outcome.mergedSha)).toEqual([
      remoteHead,
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const remoteFile = await repo.readCommittedFile("shared.md");
    expect(parseDocumentFile(remoteFile!.content, "markdown").meta.id).toBe(
      remoteDocId,
    );
    expect(await repo.readCommittedFile("shared-2.md")).toBeNull();
  });

  it("lets the remote win a path it renamed away when the local head is contained in remote history (I3/R3)", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-ff-rename",
      "FF Rename Project",
    );
    const localDoc = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Alpha",
      contentJson: PARA("Local alpha body"),
    });
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "milk" } }],
    });

    // The remote descends from the local history: it renamed both items and
    // put unrelated new content at the vacated paths. Re-slugging the local
    // copies there would duplicate their ids in the merged tree.
    const worktree = path.join(tmp, `ff-rename-wt-${randomUUID()}`);
    await execAsync("git", ["clone", repoDir(project.id), worktree]);
    const git = async (...args: string[]) =>
      (await execAsync("git", ["-C", worktree, ...args])).stdout.trim();
    await git("config", "user.name", "Remote Fixture");
    await git("config", "user.email", "remote-fixture@example.test");
    await git("mv", "alpha.md", "beta.md");
    await git("mv", "tables/budget.table", "tables/ledger.table");
    const newDocId = randomUUID();
    const newTableId = randomUUID();
    await writeFile(
      path.join(worktree, "alpha.md"),
      composeDocumentFile(
        {
          id: newDocId,
          title: "Alpha",
          created: T0,
          createdBy: null,
          updated: T0,
          updatedBy: null,
          review: null,
        },
        "Remote replacement body\n",
        "markdown",
      ),
    );
    await mkdir(path.join(worktree, "tables/budget.table"), {
      recursive: true,
    });
    await writeFile(
      path.join(worktree, "tables/budget.table/schema.json"),
      serializeSchemaFile({
        id: newTableId,
        title: "Budget",
        sourceOfTruth: "git",
        columns: [],
        created: T0,
        updated: T0,
      }),
    );
    await writeFile(path.join(worktree, "tables/budget.table/data.jsonl"), "");
    await git("add", "-A");
    await git("commit", "-m", "remote renames and replaces");
    const remoteHead = await git("rev-parse", "HEAD");
    const bareDirectory = path.join(tmp, `ff-rename-bare-${randomUUID()}.git`);
    await execAsync("git", ["clone", "--bare", worktree, bareDirectory]);

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([]);

    const repo = (await openProjectRepo(project.id))!;
    const tracked = await repo.listTrackedFiles();
    const documentIds = new Map<string, string[]>();
    const tableIds = new Map<string, string[]>();
    for (const file of tracked) {
      if (file.endsWith(".md")) {
        const id = parseDocumentFile(
          (await repo.readCommittedFile(file))!.content,
          "markdown",
        ).meta.id;
        documentIds.set(id, [...(documentIds.get(id) ?? []), file]);
      } else if (file.endsWith("/schema.json")) {
        const id = parseSchemaFile(
          (await repo.readCommittedFile(file))!.content,
        ).id;
        tableIds.set(id, [...(tableIds.get(id) ?? []), file]);
      }
    }
    // Exactly one file carries each moved id — no duplicate for rebuild to
    // drop silently.
    expect(documentIds.get(localDoc.id)).toEqual(["beta.md"]);
    expect(documentIds.get(newDocId)).toEqual(["alpha.md"]);
    expect(tableIds.get(localTable.id)).toEqual([
      "tables/ledger.table/schema.json",
    ]);
    expect(tableIds.get(newTableId)).toEqual([
      "tables/budget.table/schema.json",
    ]);
  });

  it("preserves remote deletions and replacements when remote contains local history", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-ff-restore",
      "FF Restore Project",
    );
    const alpha = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Alpha",
      contentJson: PARA("Local alpha body"),
    });
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Cruft",
      contentJson: PARA("Local cruft body"),
    });
    const delta = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Delta",
      contentJson: PARA("Local delta body"),
    });
    const echo = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Echo",
      contentJson: PARA("Local echo body"),
    });
    // The remote descends from the local history: it renamed alpha away,
    // deleted cruft, edited echo in place and replaced delta with a
    // different document. Only the replaced delta is a real collision.
    const worktree = path.join(tmp, `ff-restore-wt-${randomUUID()}`);
    await execAsync("git", ["clone", repoDir(project.id), worktree]);
    const git = async (...args: string[]) =>
      (await execAsync("git", ["-C", worktree, ...args])).stdout.trim();
    await git("config", "user.name", "Remote Fixture");
    await git("config", "user.email", "remote-fixture@example.test");
    await git("mv", "alpha.md", "beta.md");
    await git("rm", "-q", "cruft.md");
    const replacementId = randomUUID();
    await writeFile(
      path.join(worktree, "alpha.md"),
      composeDocumentFile(
        {
          id: replacementId,
          title: "Alpha",
          created: T0,
          createdBy: null,
          updated: T0,
          updatedBy: null,
          review: null,
        },
        "Remote replacement body\n",
        "markdown",
      ),
    );
    await writeFile(
      path.join(worktree, "delta.md"),
      composeDocumentFile(
        {
          id: randomUUID(),
          title: "Delta",
          created: T0,
          createdBy: null,
          updated: T0,
          updatedBy: null,
          review: null,
        },
        "Remote delta body\n",
        "markdown",
      ),
    );
    await writeFile(
      path.join(worktree, "echo.md"),
      composeDocumentFile(
        {
          id: echo.id,
          title: "Echo",
          created: T0,
          createdBy: null,
          updated: T0,
          updatedBy: null,
          review: null,
        },
        "Remote echo body\n",
        "markdown",
      ),
    );
    await git("add", "-A");
    await git("commit", "-m", "remote renames, deletes and replaces");
    const remoteHead = await git("rev-parse", "HEAD");
    const bareDirectory = path.join(tmp, `ff-restore-bare-${randomUUID()}.git`);
    await execAsync("git", ["clone", "--bare", worktree, bareDirectory]);

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([]);
    expect(outcome.fastForward).toBe(true);
    expect(await parentsOf(project.id, outcome.mergedSha)).toEqual([
      remoteHead,
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const tracked = await repo.listTrackedFiles();
    // The renamed document keeps its id exactly once, the upstream deletion
    // stands, and only the re-slugged collision came back.
    expect(tracked).not.toContain("cruft.md");
    expect(tracked).not.toContain("alpha-2.md");
    expect(tracked).not.toContain("delta-2.md");
    const ids = new Map<string, string[]>();
    for (const file of tracked.filter((f) => f.endsWith(".md"))) {
      const id = parseDocumentFile(
        (await repo.readCommittedFile(file))!.content,
        "markdown",
      ).meta.id;
      ids.set(id, [...(ids.get(id) ?? []), file]);
    }
    expect(ids.get(alpha.id)).toEqual(["beta.md"]);
    expect(ids.get(replacementId)).toEqual(["alpha.md"]);
    expect(ids.has(delta.id)).toBe(false);
    // Same id at the same path: the remote's copy descends from the local
    // one, so its newer body wins instead of being restored away.
    expect((await repo.readCommittedFile("echo.md"))!.content).toContain(
      "Remote echo body",
    );
  });

  it("re-slugs a local table directory (with rows) that collides by path with a different remote identity", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-table-reslug",
      "Table Reslug Project",
    );
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "milk" } }],
    });
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const remoteTableId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "tables/budget.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/budget.table/schema.json"),
          serializeSchemaFile({
            id: remoteTableId,
            title: "Budget",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/budget.table/data.jsonl"),
          "",
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      {
        kind: "table",
        from: "tables/budget.table",
        to: "tables/budget-2.table",
      },
    ]);
    const mergeParents = await parentsOf(project.id, outcome.mergedSha);
    expect(mergeParents[0]).toBe(remoteHead);
    expect(await parentsOf(project.id, mergeParents[1]!)).toEqual([
      localHeadBefore,
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const remoteSchema = await repo.readCommittedFile(
      "tables/budget.table/schema.json",
    );
    expect(parseSchemaFile(remoteSchema!.content).id).toBe(remoteTableId);
    const movedSchema = await repo.readCommittedFile(
      "tables/budget-2.table/schema.json",
    );
    expect(parseSchemaFile(movedSchema!.content).id).toBe(localTable.id);
    // A lost data.jsonl (or an empty one) would fail this: the row must
    // have moved with the rest of the table directory.
    const movedData = await repo.readCommittedFile(
      "tables/budget-2.table/data.jsonl",
    );
    expect(movedData!.content).toContain("milk");
  });

  it("re-slugs a table past a slug another local folder already holds, because slugs are unique project-wide", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-table-reslug-slug",
      "Table Reslug Slug Project",
    );
    for (const name of ["z", "a"]) {
      await caller.tableFolder.create({
        projectId: project.id,
        parentPath: [],
        name,
      });
    }
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: ["z"],
      title: "Budget",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "milk" } }],
    });
    const otherTable = await caller.table.create({
      projectId: project.id,
      folderPath: ["a"],
      title: "Budget",
      columns: [TEXT_COL],
      rows: [],
    });
    const rowsBefore = await getPrisma().dataTable.findMany({
      where: { projectId: project.id },
      orderBy: { path: "asc" },
      select: { id: true, path: true },
    });
    expect(rowsBefore).toEqual([
      { id: otherTable.id, path: "tables/a/budget-2.table" },
      { id: localTable.id, path: "tables/z/budget.table" },
    ]);

    const remoteTableId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "tables/z/budget.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/z/budget.table/schema.json"),
          serializeSchemaFile({
            id: remoteTableId,
            title: "Budget",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/z/budget.table/data.jsonl"),
          "",
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      {
        kind: "table",
        from: "tables/z/budget.table",
        to: "tables/z/budget-3.table",
      },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const idAt = async (dir: string) =>
      parseSchemaFile(
        (await repo.readCommittedFile(`${dir}/schema.json`))!.content,
      ).id;
    expect(await idAt("tables/z/budget.table")).toBe(remoteTableId);
    expect(await idAt("tables/z/budget-3.table")).toBe(localTable.id);
    expect(await idAt("tables/a/budget-2.table")).toBe(otherTable.id);
    const movedData = await repo.readCommittedFile(
      "tables/z/budget-3.table/data.jsonl",
    );
    expect(movedData!.content).toContain("milk");
  });

  it("preserves both table versions when unrelated histories share an id", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-table-sameid",
      "Table Same Id Project",
    );
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "tables/budget.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/budget.table/schema.json"),
          serializeSchemaFile({
            id: localTable.id,
            title: "Budget Remote Title",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/budget.table/data.jsonl"),
          "",
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      {
        kind: "table",
        from: "tables/budget.table",
        to: "tables/budget-2.table",
        reassignedId: true,
      },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const merged = await repo.readCommittedFile(
      "tables/budget.table/schema.json",
    );
    expect(parseSchemaFile(merged!.content).title).toBe("Budget Remote Title");
    const copy = parseSchemaFile(
      (await repo.readCommittedFile("tables/budget-2.table/schema.json"))!
        .content,
    );
    expect(copy.title).toBe("Budget");
    expect(copy.id).not.toBe(localTable.id);
  });

  it("rejects a fetch result mismatch with MERGE_FAILED and deletes the pull ref", async () => {
    const { project, author } = await ownerProject(
      "pull-mismatch",
      "Mismatch Project",
    );
    const { bareDirectory } = await buildRemoteRepo(async (source) => {
      await writeFile(path.join(source, "project.json"), "{}\n");
    });

    await expect(
      withExistingProjectRepo(project.id, (repo) =>
        mergeFetchedBranch(getPrisma(), repo, {
          projectId: project.id,
          bareDirectory,
          branch: "main",
          remoteHead: "a".repeat(40),
          author,
        }),
      ),
    ).rejects.toMatchObject({ code: "MERGE_FAILED" });

    expect(await pullRefs(project.id)).toBe("");
  });

  it("rejects a remote branch carrying a symlink before touching the worktree", async () => {
    const { project, author } = await ownerProject(
      "pull-symlink",
      "Symlink Project",
    );
    const before = await withExistingProjectRepo(project.id, (repo) =>
      repo.resolveHead(),
    );
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await symlink(tmp, path.join(source, "notes"));
      },
    );

    await expect(
      withExistingProjectRepo(project.id, (repo) =>
        mergeFetchedBranch(getPrisma(), repo, {
          projectId: project.id,
          bareDirectory,
          branch: "main",
          remoteHead,
          author,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_REMOTE_CONTENT" });

    expect(await pullRefs(project.id)).toBe("");
    await withExistingProjectRepo(project.id, async (repo) => {
      expect(await repo.resolveHead()).toBe(before);
      expect(await repo.fileExistsInWorktree("notes")).toBe(false);
    });
    await expect(
      lstat(path.join(repoDir(project.id), "notes")),
    ).rejects.toThrow();
  });

  it("skips a free table directory the remote already occupies with unrelated content (C6)", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-table-dir-collision",
      "Table Dir Collision Project",
    );
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "milk" } }],
    });

    const remoteTableId = randomUUID();
    const remoteOtherId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "tables/budget.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/budget.table/schema.json"),
          serializeSchemaFile({
            id: remoteTableId,
            title: "Budget",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/budget.table/data.jsonl"),
          "",
        );
        // The taken-set must notice this directory has content even though
        // no DataTable row in the local project's DB ever refers to it — it
        // is the free-slug search's first candidate.
        await mkdir(path.join(source, "tables/budget-2.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/budget-2.table/schema.json"),
          serializeSchemaFile({
            id: remoteOtherId,
            title: "Other Remote Table",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/budget-2.table/data.jsonl"),
          "",
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      {
        kind: "table",
        from: "tables/budget.table",
        to: "tables/budget-3.table",
      },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const movedSchema = await repo.readCommittedFile(
      "tables/budget-3.table/schema.json",
    );
    expect(parseSchemaFile(movedSchema!.content).id).toBe(localTable.id);
    const movedData = await repo.readCommittedFile(
      "tables/budget-3.table/data.jsonl",
    );
    expect(movedData!.content).toContain("milk");
    // Remote's own unrelated table at the "first choice" slug is untouched.
    const otherSchema = await repo.readCommittedFile(
      "tables/budget-2.table/schema.json",
    );
    expect(parseSchemaFile(otherSchema!.content).id).toBe(remoteOtherId);
  });

  it("moves a re-slugged document's assets clear of an orphan remote assets directory (C6)", async () => {
    const { owner, caller, project, author } = await ownerProject(
      "pull-asset-dir-collision",
      "Asset Dir Collision Project",
    );
    const localNotes = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: IMAGE_DOC("notes.assets/pic.png"),
    });
    const actor = {
      ...securityContextFor(owner),
      name: "Owner",
      email: owner.email,
    };
    await storeDocumentImage(
      getPrisma(),
      {
        projectId: project.id,
        documentId: localNotes.id,
        fileName: "pic.png",
        bytes: PNG_1X1,
      },
      actor,
    );

    const remoteNoteId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "notes.md"),
          composeDocumentFile(
            {
              id: remoteNoteId,
              title: "Notes",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote notes\n",
            "markdown",
          ),
        );
        // An orphan assets directory at the "first choice" slug (no
        // matching notes-2.md): the taken-set must still notice it.
        await mkdir(path.join(source, "notes-2.assets"), { recursive: true });
        await writeFile(path.join(source, "notes-2.assets/x.png"), GIF_1X1);
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      { kind: "document", from: "notes.md", to: "notes-3.md" },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const movedFile = await repo.readCommittedFile("notes-3.md");
    expect(parseDocumentFile(movedFile!.content, "markdown").meta.id).toBe(
      localNotes.id,
    );
    expect(movedFile!.content).toContain("notes-3.assets/pic.png");
    const movedBlob = await repo.readCommittedBlobAt(
      outcome.mergedSha,
      "notes-3.assets/pic.png",
      1_000_000,
    );
    expect(Buffer.from(movedBlob!.bytes)).toEqual(PNG_1X1);
    // The remote's orphan assets directory at the skipped slug is untouched.
    const orphanBlob = await repo.readCommittedBlobAt(
      outcome.mergedSha,
      "notes-2.assets/x.png",
      1_000_000,
    );
    expect(Buffer.from(orphanBlob!.bytes)).toEqual(GIF_1X1);
  });

  it("does not nest a re-slugged table into a local orphan directory sharing its would-be target (C6)", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-table-local-orphan",
      "Table Local Orphan Project",
    );
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });
    // A directory tracked locally with no DataTable row pointing at it —
    // the free-slug search's DB check alone would miss this collision.
    const dir = repoDir(project.id);
    await mkdir(path.join(dir, "tables/budget-2.table"), { recursive: true });
    await writeFile(
      path.join(dir, "tables/budget-2.table/schema.json"),
      serializeSchemaFile({
        id: randomUUID(),
        title: "Local Orphan",
        sourceOfTruth: "git",
        columns: [],
        created: T0,
        updated: T0,
      }),
    );
    await writeFile(path.join(dir, "tables/budget-2.table/data.jsonl"), "");
    await execAsync("git", ["-C", dir, "add", "."]);
    await execAsync("git", [
      "-C",
      dir,
      "-c",
      "user.name=Weaver",
      "-c",
      "user.email=weaver@local",
      "commit",
      "-m",
      "local orphan table directory",
    ]);

    const remoteTableId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "tables/budget.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/budget.table/schema.json"),
          serializeSchemaFile({
            id: remoteTableId,
            title: "Budget",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/budget.table/data.jsonl"),
          "",
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    expect(outcome.reslugged).toEqual([
      {
        kind: "table",
        from: "tables/budget.table",
        to: "tables/budget-3.table",
      },
    ]);

    const repo = (await openProjectRepo(project.id))!;
    const tracked = await repo.listTrackedFiles();
    // No nesting: budget-2.table's own two files, nothing moved inside it.
    expect(
      tracked.filter((p) => p.startsWith("tables/budget-2.table/")),
    ).toEqual([
      "tables/budget-2.table/data.jsonl",
      "tables/budget-2.table/schema.json",
    ]);
    const movedSchema = await repo.readCommittedFile(
      "tables/budget-3.table/schema.json",
    );
    expect(parseSchemaFile(movedSchema!.content).id).toBe(localTable.id);
  });

  it("never re-slugs a parseable Weaver document at a non-canonical path, so the merge cannot abort on it (I6)", async () => {
    const { project, author } = await ownerProject(
      "pull-noncanonical-collision",
      "Non Canonical Collision Project",
    );
    const localDocId = randomUUID();
    const dir = repoDir(project.id);
    await mkdir(path.join(dir, "Docs"), { recursive: true });
    await writeFile(
      path.join(dir, "Docs/Notes.md"),
      composeDocumentFile(
        {
          id: localDocId,
          title: "Notes",
          created: T0,
          createdBy: null,
          updated: T0,
          updatedBy: null,
          review: null,
        },
        "Local notes at a non-canonical path\n",
        "markdown",
      ),
    );
    await execAsync("git", ["-C", dir, "add", "."]);
    await execAsync("git", [
      "-C",
      dir,
      "-c",
      "user.name=Weaver",
      "-c",
      "user.email=weaver@local",
      "commit",
      "-m",
      "local non-canonical document",
    ]);

    const remoteDocId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "Docs"), { recursive: true });
        await writeFile(
          path.join(source, "Docs/Notes.md"),
          composeDocumentFile(
            {
              id: remoteDocId,
              title: "Notes",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote notes at the same non-canonical path\n",
            "markdown",
          ),
        );
      },
    );

    const outcome = (await withExistingProjectRepo(project.id, (repo) =>
      mergeFetchedBranch(getPrisma(), repo, {
        projectId: project.id,
        bareDirectory,
        branch: "main",
        remoteHead,
        author,
      }),
    ))!;
    // Never re-slugged: the merge did not abort, and remote wins the path.
    expect(outcome.reslugged).toEqual([]);

    const repo = (await openProjectRepo(project.id))!;
    const merged = await repo.readCommittedFile("Docs/Notes.md");
    expect(parseDocumentFile(merged!.content, "markdown").meta.id).toBe(
      remoteDocId,
    );
    const tracked = await repo.listTrackedFiles();
    expect(tracked.filter((p) => p.startsWith("Docs/"))).toEqual([
      "Docs/Notes.md",
    ]);
  });

  it("recovers the worktree after a mid-merge failure once the remote tree is checked out (M6)", async () => {
    const { project, author } = await ownerProject(
      "pull-mid-failure",
      "Mid Failure Project",
    );
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "other.md"),
          composeDocumentFile(
            {
              id: randomUUID(),
              title: "Other",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote other\n",
            "markdown",
          ),
        );
      },
    );

    // Fails inside writeMetadata's composeProjectMetadataFor, which only
    // runs after resetWorktreeTo(PULL_REF) has already mutated the worktree
    // — exercising the catch block's recovery, not just the pre-fetch guard
    // (unlike the MERGE_FAILED test, which fails before any worktree change).
    const failure = new Error("injected mid-merge failure");
    const spy = vi
      .spyOn(getPrisma().project, "findFirst")
      .mockRejectedValueOnce(failure);
    try {
      await expect(
        withExistingProjectRepo(project.id, (repo) =>
          mergeFetchedBranch(getPrisma(), repo, {
            projectId: project.id,
            bareDirectory,
            branch: "main",
            remoteHead,
            author,
          }),
        ),
      ).rejects.toThrow(failure);
    } finally {
      spy.mockRestore();
    }

    expect(await (await openProjectRepo(project.id))!.resolveHead()).toBe(
      localHeadBefore,
    );
    const status = await simpleGit(repoDir(project.id)).raw([
      "status",
      "--porcelain",
    ]);
    expect(status.trim()).toBe("");
    expect(await pullRefs(project.id)).toBe("");
  });

  it("propagates a free-slug database failure instead of silently dropping the local document (I7)", async () => {
    const { caller, project, author } = await ownerProject(
      "pull-slug-db-failure",
      "Slug DB Failure Project",
    );
    await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: PARA("Local notes"),
    });
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const remoteNoteId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "notes.md"),
          composeDocumentFile(
            {
              id: remoteNoteId,
              title: "Notes",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote notes\n",
            "markdown",
          ),
        );
      },
    );

    // The first candidate ("notes.md") is already taken by both trees, so
    // the free-slug search's first real DB lookup is for "notes-2.md" —
    // exactly the call this rejects once. A transient failure here must
    // propagate (and trigger the same worktree recovery as M6), not be
    // swallowed by the I6/R2 non-canonical-path fallback.
    const failure = new Error("db down");
    const spy = vi
      .spyOn(getPrisma().document, "findFirst")
      .mockRejectedValueOnce(failure);
    try {
      await expect(
        withExistingProjectRepo(project.id, (repo) =>
          mergeFetchedBranch(getPrisma(), repo, {
            projectId: project.id,
            bareDirectory,
            branch: "main",
            remoteHead,
            author,
          }),
        ),
      ).rejects.toThrow(failure);
    } finally {
      spy.mockRestore();
    }

    expect(await (await openProjectRepo(project.id))!.resolveHead()).toBe(
      localHeadBefore,
    );
    const status = await simpleGit(repoDir(project.id)).raw([
      "status",
      "--porcelain",
    ]);
    expect(status.trim()).toBe("");
    expect(await pullRefs(project.id)).toBe("");
  });
});

async function pullFixture(projectId: string, enabled = true): Promise<string> {
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
      enabled,
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

/** Requests a pull through the real service (so pullRequestedById/pullQueueToken
 * are set exactly as production code sets them) and returns the resulting job
 * payload captured by `queue`. */
async function requestPull(
  projectId: string,
  owner: Awaited<ReturnType<typeof makeUser>>,
  queue: FakeJobQueue,
) {
  setJobQueueForTests(queue);
  try {
    await requestProjectGitRemotePull(
      getPrisma(),
      securityContextFor(owner),
      projectId,
    );
  } finally {
    setJobQueueForTests(null);
  }
  const job = queue.jobs.find((job) => job.name === "project.git-pull");
  if (job?.name !== "project.git-pull") throw new Error("Expected pull job");
  return job.data;
}

describe("pullProjectGitRemote (job)", () => {
  it.each([false, true])(
    "pauses divergent pulls until an Owner explicitly re-enables pushes (outcome rollback: %s)",
    async (rollbackOutcome) => {
      const { owner, caller, project } = await ownerProject(
        "pull-job-merge",
        "Pull Job Merge Project",
      );
      // Created before the remote row exists so document.create's own
      // fire-and-forget notifyProjectContentChanged has no remote to dispatch
      // (it would otherwise race a real pg-boss publisher against this test's
      // FakeJobQueue and claim the row's push queueToken out from under it).
      const localNotes = await caller.document.create({
        projectId: project.id,
        folderPath: [],
        title: "Notes",
        contentJson: PARA("Local notes body"),
      });
      await pullFixture(project.id);

      const remoteNoteId = randomUUID();
      const remoteGuideId = randomUUID();
      const remoteTableId = randomUUID();
      const { bareDirectory, remoteHead } = await buildRemoteRepo(
        async (source) => {
          await writeFile(path.join(source, "project.json"), "{}\n");
          await writeFile(
            path.join(source, "notes.md"),
            composeDocumentFile(
              {
                id: remoteNoteId,
                title: "Notes",
                created: T0,
                createdBy: null,
                updated: T0,
                updatedBy: null,
                review: null,
              },
              "Remote notes\n",
              "markdown",
            ),
          );
          await writeFile(
            path.join(source, "guide.md"),
            composeDocumentFile(
              {
                id: remoteGuideId,
                title: "Guide",
                created: T0,
                createdBy: null,
                updated: T0,
                updatedBy: null,
                review: null,
              },
              "Guide body\n",
              "markdown",
            ),
          );
          await mkdir(path.join(source, "tables/budget.table"), {
            recursive: true,
          });
          await writeFile(
            path.join(source, "tables/budget.table/schema.json"),
            serializeSchemaFile({
              id: remoteTableId,
              title: "Budget",
              sourceOfTruth: "git",
              columns: [],
              created: T0,
              updated: T0,
            }),
          );
          await writeFile(
            path.join(source, "tables/budget.table/data.jsonl"),
            "",
          );
        },
      );

      const queue = new FakeJobQueue();
      const payload = await requestPull(project.id, owner, queue);
      const fetch = async () => ({
        bareDirectory,
        remoteHead,
        knownHosts: null,
        dispose: async () => undefined,
      });

      // Deterministic guard against document.create's background
      // notifyProjectContentChanged racing a real pg-boss publisher against
      // this test's FakeJobQueue and leaving a stray push queueToken behind
      // (the ordering above already avoids it, but this makes the test not
      // depend on that ordering to stay correct).
      await getPrisma().projectGitRemote.update({
        where: { projectId: project.id },
        data: { queueToken: null, queuedAt: null },
      });

      let settingsLockHeld = false;
      const merge = mergeService.mergeFetchedBranch;
      const mergeSpy = vi
        .spyOn(mergeService, "mergeFetchedBranch")
        .mockImplementation(async (...args) => {
          const result = await merge(...args);
          settingsLockHeld = await getPrisma().$transaction(async (tx) => {
            const [lock] = await tx.$queryRaw<
              Array<{ acquired: boolean }>
            >`SELECT pg_try_advisory_xact_lock(hashtextextended(${project.id}, 0)) AS acquired`;
            return lock?.acquired === false;
          });
          if (rollbackOutcome) {
            vi.spyOn(
              args[0].projectGitRemote,
              "updateMany",
            ).mockRejectedValueOnce(
              new Error("outcome transaction unavailable"),
            );
          }
          return result;
        });
      setJobQueueForTests(queue);
      try {
        await pullProjectGitRemote({
          db: getPrisma(),
          payload,
          ring: testEncryptionKeys(),
          fetch,
        });
      } finally {
        mergeSpy.mockRestore();
        setJobQueueForTests(null);
      }

      const repo = (await openProjectRepo(project.id))!;
      const headAfter = await repo.resolveHead();
      const row = await getPrisma().projectGitRemote.findUniqueOrThrow({
        where: { projectId: project.id },
      });
      expect(row).toMatchObject({
        lastPullSha: headAfter,
        lastPullErrorCode: null,
        pullQueueToken: null,
        leaseToken: null,
        lastPushedSha: null,
      });
      expect(settingsLockHeld).toBe(true);
      expect(row.enabled).toBe(false);
      expect(row.lastPullAt).not.toBeNull();
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

      const notesDoc = await getPrisma().document.findFirst({
        where: { projectId: project.id, path: "notes.md" },
      });
      expect(notesDoc?.id).toBe(remoteNoteId);
      const reslugged = await getPrisma().document.findFirst({
        where: { projectId: project.id, path: "notes-2.md" },
      });
      expect(reslugged?.id).toBe(localNotes.id);
      const guideDoc = await getPrisma().document.findFirst({
        where: { projectId: project.id, path: "guide.md" },
      });
      expect(guideDoc?.id).toBe(remoteGuideId);
      const table = await getPrisma().dataTable.findFirst({
        where: { projectId: project.id, path: "tables/budget.table" },
      });
      expect(table?.id).toBe(remoteTableId);

      expect(
        queue.jobs.filter((job) => job.name === "project.reconcile"),
      ).toHaveLength(1);
      expect(
        queue.jobs.filter((job) => job.name === "project.git-push"),
      ).toHaveLength(0);
      expect(
        await discoverProjectGitRemotes({
          db: getPrisma(),
          queue,
          now: new Date(Date.now() + 600_000),
        }),
      ).toBe(0);
      const settings = {
        projectId: project.id,
        remoteUrl: row.remoteUrl,
        branch: row.branch,
        enabled: true,
      };
      await expect(
        saveProjectGitRemote(getPrisma(), securityContextFor(owner), {
          ...settings,
          expectedRevision: row.revision - 1,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      setJobQueueForTests(queue);
      try {
        const resumed = await saveProjectGitRemote(
          getPrisma(),
          securityContextFor(owner),
          {
            ...settings,
            expectedRevision: row.revision,
          },
        );
        expect(resumed.enabled).toBe(true);
      } finally {
        setJobQueueForTests(null);
      }
      expect(
        queue.jobs.filter((job) => job.name === "project.git-push"),
      ).toHaveLength(1);
    },
  );

  it("records REMOTE_BRANCH_MISSING and leaves no lease or merge commit when the fetch fails", async () => {
    const { owner, project } = await ownerProject(
      "pull-job-fetch-fail",
      "Pull Job Fetch Fail Project",
    );
    await pullFixture(project.id);
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);

    await pullProjectGitRemote({
      db: getPrisma(),
      payload,
      ring: testEncryptionKeys(),
      fetch: async () => {
        throw new GitRemoteError("REMOTE_BRANCH_MISSING");
      },
    });

    const row = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(row).toMatchObject({
      lastPullErrorCode: "REMOTE_BRANCH_MISSING",
      leaseToken: null,
      lastPullSha: null,
    });
    expect(await (await openProjectRepo(project.id))!.resolveHead()).toBe(
      localHeadBefore,
    );
  });

  it("keeps both rows after the rebuild when the remote holds a local id elsewhere (I3)", async () => {
    const { owner, caller, project } = await ownerProject(
      "pull-job-i3",
      "Pull Job Reassign Project",
    );
    const localNotes = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: PARA("Local notes body"),
    });
    const localTable = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "milk" } }],
    });
    await pullFixture(project.id);

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "archive"), { recursive: true });
        await writeFile(
          path.join(source, "archive/notes.md"),
          composeDocumentFile(
            {
              id: localNotes.id,
              title: "Notes",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote renamed notes\n",
            "markdown",
          ),
        );
        await mkdir(path.join(source, "tables/ledger.table"), {
          recursive: true,
        });
        await writeFile(
          path.join(source, "tables/ledger.table/schema.json"),
          serializeSchemaFile({
            id: localTable.id,
            title: "Ledger",
            sourceOfTruth: "git",
            columns: [],
            created: T0,
            updated: T0,
          }),
        );
        await writeFile(
          path.join(source, "tables/ledger.table/data.jsonl"),
          "",
        );
      },
    );

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });
    setJobQueueForTests(queue);
    try {
      await pullProjectGitRemote({
        db: getPrisma(),
        payload,
        ring: testEncryptionKeys(),
        fetch: async () => ({
          bareDirectory,
          remoteHead,
          knownHosts: null,
          dispose: async () => undefined,
        }),
      });
    } finally {
      setJobQueueForTests(null);
    }

    const documents = await getPrisma().document.findMany({
      where: { projectId: project.id },
      orderBy: { path: "asc" },
      select: { id: true, path: true },
    });
    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({
      id: localNotes.id,
      path: "archive/notes.md",
    });
    expect(documents[1]!.path).toBe("notes-2.md");
    expect(documents[1]!.id).not.toBe(localNotes.id);

    const tables = await getPrisma().dataTable.findMany({
      where: { projectId: project.id },
      orderBy: { path: "asc" },
      select: { id: true, path: true },
    });
    expect(tables).toHaveLength(2);
    expect(tables).toContainEqual({
      id: localTable.id,
      path: "tables/ledger.table",
    });
    const moved = tables.find((t) => t.path === "tables/budget-2.table");
    expect(moved).toBeDefined();
    expect(moved!.id).not.toBe(localTable.id);
  });

  it("keeps all three rows after the rebuild when a re-slug must skip a slug held in another folder", async () => {
    const { owner, caller, project } = await ownerProject(
      "pull-job-slug",
      "Pull Job Slug Project",
    );
    for (const name of ["z", "a"]) {
      await caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name,
      });
    }
    const localTopic = await caller.document.create({
      projectId: project.id,
      folderPath: ["z"],
      title: "Topic",
      contentJson: PARA("Local topic"),
    });
    const otherTopic = await caller.document.create({
      projectId: project.id,
      folderPath: ["a"],
      title: "Topic",
      contentJson: PARA("Other topic"),
    });
    await pullFixture(project.id);

    const remoteTopicId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "z"), { recursive: true });
        await writeFile(
          path.join(source, "z/topic.md"),
          composeDocumentFile(
            {
              id: remoteTopicId,
              title: "Topic",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote topic\n",
            "markdown",
          ),
        );
      },
    );

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });
    setJobQueueForTests(queue);
    try {
      await pullProjectGitRemote({
        db: getPrisma(),
        payload,
        ring: testEncryptionKeys(),
        fetch: async () => ({
          bareDirectory,
          remoteHead,
          knownHosts: null,
          dispose: async () => undefined,
        }),
      });
    } finally {
      setJobQueueForTests(null);
    }

    const documents = await getPrisma().document.findMany({
      where: { projectId: project.id },
      orderBy: { path: "asc" },
      select: { id: true, path: true, slug: true },
    });
    // A duplicate slug would make rebuild skip one file and delete its row.
    expect(documents).toEqual([
      { id: otherTopic.id, path: "a/topic-2.md", slug: "topic-2" },
      { id: localTopic.id, path: "z/topic-3.md", slug: "topic-3" },
      { id: remoteTopicId, path: "z/topic.md", slug: "topic" },
    ]);
  });

  it("re-slugs a local-only document whose slug an unrelated remote document holds in another folder (FIX-DOC-04)", async () => {
    const { owner, caller, project } = await ownerProject(
      "pull-job-cross-slug",
      "Pull Job Cross Slug Project",
    );
    await caller.folder.create({
      projectId: project.id,
      parentPath: [],
      name: "a",
    });
    const localTopic = await caller.document.create({
      projectId: project.id,
      folderPath: ["a"],
      title: "Topic",
      contentJson: PARA("Local topic"),
    });
    const notes = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: PARA("Untouched notes"),
    });
    await pullFixture(project.id);

    // Neither tree contains the other's history and the paths never collide:
    // only the project-wide slug does.
    const remoteTopicId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await mkdir(path.join(source, "z"), { recursive: true });
        await writeFile(
          path.join(source, "z/topic.md"),
          composeDocumentFile(
            {
              id: remoteTopicId,
              title: "Topic",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Remote topic\n",
            "markdown",
          ),
        );
      },
    );

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });
    setJobQueueForTests(queue);
    try {
      await pullProjectGitRemote({
        db: getPrisma(),
        payload,
        ring: testEncryptionKeys(),
        fetch: async () => ({
          bareDirectory,
          remoteHead,
          knownHosts: null,
          dispose: async () => undefined,
        }),
      });
    } finally {
      setJobQueueForTests(null);
    }

    const documents = await getPrisma().document.findMany({
      where: { projectId: project.id },
      orderBy: { path: "asc" },
      select: { id: true, path: true, slug: true },
    });
    // Both "topic" documents keep their ids and rows; the local side moves to
    // a free slug because the remote tree is authoritative for its path.
    expect(documents).toEqual([
      { id: localTopic.id, path: "a/topic-2.md", slug: "topic-2" },
      { id: notes.id, path: "notes.md", slug: "notes" },
      { id: remoteTopicId, path: "z/topic.md", slug: "topic" },
    ]);
  });

  it("frees a pull token the job could not admit once the queue TTL passes (C1)", async () => {
    const { owner, project } = await ownerProject(
      "pull-job-ttl",
      "Pull Job Ttl Project",
    );
    await pullFixture(project.id);
    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);

    // A push holds the shared lease, so this job can never admit; retryLimit
    // is 0, so nothing else would ever clear the token.
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + PROJECT_GIT_LEASE_MS),
      },
    });
    const fetch = vi.fn(async () => ({
      bareDirectory: "",
      remoteHead: "",
      knownHosts: null,
      dispose: async () => undefined,
    }));
    await pullProjectGitRemote({
      db: getPrisma(),
      payload,
      ring: testEncryptionKeys(),
      fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
    const stuck = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(stuck.pullQueueToken).toBe(payload.pullToken);

    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
    await expect(
      requestProjectGitRemotePull(
        getPrisma(),
        securityContextFor(owner),
        project.id,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Past the queue TTL the token is stale: the view stops reporting a
    // queued pull and a fresh request wins with a new token.
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: {
        pullRequestedAt: new Date(Date.now() - PROJECT_GIT_QUEUE_TTL_MS - 1000),
      },
    });
    expect(
      (await getProjectGitRemote(
        getPrisma(),
        securityContextFor(owner),
        project.id,
      ))!.pullQueued,
    ).toBe(false);

    setJobQueueForTests(queue);
    try {
      const view = await requestProjectGitRemotePull(
        getPrisma(),
        securityContextFor(owner),
        project.id,
      );
      expect(view.pullQueued).toBe(true);
    } finally {
      setJobQueueForTests(null);
    }
    const fresh = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(fresh.pullQueueToken).not.toBeNull();
    expect(fresh.pullQueueToken).not.toBe(payload.pullToken);

    // The abandoned job's token no longer matches, so it stays a no-op.
    await pullProjectGitRemote({
      db: getPrisma(),
      payload,
      ring: testEncryptionKeys(),
      fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a stale pull token", async () => {
    const { owner, project } = await ownerProject(
      "pull-job-stale-token",
      "Pull Job Stale Token Project",
    );
    await pullFixture(project.id);
    const queue = new FakeJobQueue();
    await requestPull(project.id, owner, queue);

    const fetch = vi.fn(async () => ({
      bareDirectory: "",
      remoteHead: "",
      knownHosts: null,
      dispose: async () => undefined,
    }));

    await pullProjectGitRemote({
      db: getPrisma(),
      payload: { projectId: project.id, pullToken: randomUUID() },
      ring: testEncryptionKeys(),
      fetch,
    });

    expect(fetch).not.toHaveBeenCalled();
    const row = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(row.leaseToken).toBeNull();
    expect(row.pullQueueToken).not.toBeNull();
  });

  it("rebuilds indices using the project's earliest Owner even when the requester is gone (I1)", async () => {
    const { owner: requester, project } = await ownerProject(
      "pull-job-i1",
      "Pull Job I1 Project",
    );
    // A second Owner remains after the requester is deleted, so R1's
    // earliest-Owner fallback has someone to resolve to.
    const secondOwner = await makeUser("User", "pull-job-i1-owner2");
    await addMembership(project.id, secondOwner.id, "Owner");
    await pullFixture(project.id);

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, requester, queue);

    const remoteDocId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "guide.md"),
          composeDocumentFile(
            {
              id: remoteDocId,
              title: "Guide",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Guide body\n",
            "markdown",
          ),
        );
      },
    );

    // The requester is gone by the time the job runs.
    await getPrisma().user.delete({ where: { id: requester.id } });
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });

    await pullProjectGitRemote({
      db: getPrisma(),
      payload,
      ring: testEncryptionKeys(),
      fetch: async () => ({
        bareDirectory,
        remoteHead,
        knownHosts: null,
        dispose: async () => undefined,
      }),
    });

    const row = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(row.lastPullErrorCode).toBeNull();
    expect(row.lastPullSha).not.toBeNull();
    const doc = await getPrisma().document.findFirst({
      where: { projectId: project.id, path: "guide.md" },
    });
    expect(doc?.id).toBe(remoteDocId);
  });

  it("records the pull outcome before running rebuilds, so a rebuild failure does not lose it (I2)", async () => {
    const { owner, project } = await ownerProject(
      "pull-job-i2",
      "Pull Job I2 Project",
    );
    await pullFixture(project.id);

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);

    const remoteDocId = randomUUID();
    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "guide.md"),
          composeDocumentFile(
            {
              id: remoteDocId,
              title: "Guide",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Guide body\n",
            "markdown",
          ),
        );
      },
    );

    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });

    // The first `document.findMany` call in the whole run happens inside
    // rebuildIndex's reconciliation step, well after the merge commit and
    // the outcome update have already landed.
    const failure = new Error("db unavailable during rebuild");
    const spy = vi
      .spyOn(getPrisma().document, "findMany")
      .mockRejectedValueOnce(failure);
    try {
      await pullProjectGitRemote({
        db: getPrisma(),
        payload,
        ring: testEncryptionKeys(),
        fetch: async () => ({
          bareDirectory,
          remoteHead,
          knownHosts: null,
          dispose: async () => undefined,
        }),
      });
    } finally {
      spy.mockRestore();
    }

    const row = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(row.lastPullErrorCode).toBeNull();
    expect(row.lastPullSha).not.toBeNull();
    expect(row.leaseToken).toBeNull();
  });

  it("preserves lastPushedSha on a no-op pull but still advances lastPullAt (M6)", async () => {
    const { owner, project } = await ownerProject(
      "pull-job-noop",
      "Pull Job Noop Project",
    );
    await pullFixture(project.id);

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "guide.md"),
          composeDocumentFile(
            {
              id: randomUUID(),
              title: "Guide",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Guide body\n",
            "markdown",
          ),
        );
      },
    );
    const fetch = async () => ({
      bareDirectory,
      remoteHead,
      knownHosts: null,
      dispose: async () => undefined,
    });

    const t1 = new Date("2026-09-18T00:00:00.000Z");
    const t2 = new Date("2026-09-18T00:05:00.000Z");

    const firstPayload = await requestPull(
      project.id,
      owner,
      new FakeJobQueue(),
    );
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });
    await pullProjectGitRemote({
      db: getPrisma(),
      payload: firstPayload,
      ring: testEncryptionKeys(),
      fetch,
      now: t1,
    });
    const afterFirst = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(afterFirst.lastPushedSha).toBeNull();

    // Simulate a completed push in between the two pulls.
    const simulatedPush = "b".repeat(40);
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { lastPushedSha: simulatedPush },
    });

    const secondPayload = await requestPull(
      project.id,
      owner,
      new FakeJobQueue(),
    );
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });
    await pullProjectGitRemote({
      db: getPrisma(),
      payload: secondPayload,
      ring: testEncryptionKeys(),
      fetch,
      now: t2,
    });

    const afterSecond = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(afterSecond.lastPushedSha).toBe(simulatedPush);
    expect(afterSecond.lastPullSha).toBe(afterFirst.lastPullSha);
    expect(afterSecond.lastPullAt).toEqual(t2);
  });

  it("records MERGE_FAILED when the merge phase fails after a successful fetch (M6)", async () => {
    const { owner, project } = await ownerProject(
      "pull-job-mergefail",
      "Pull Job Merge Fail Project",
    );
    await pullFixture(project.id);
    const localHeadBefore = await (await openProjectRepo(
      project.id,
    ))!.resolveHead();

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);
    await getPrisma().projectGitRemote.update({
      where: { projectId: project.id },
      data: { queueToken: null, queuedAt: null },
    });

    const { bareDirectory, remoteHead } = await buildRemoteRepo(
      async (source) => {
        await writeFile(path.join(source, "project.json"), "{}\n");
        await writeFile(
          path.join(source, "guide.md"),
          composeDocumentFile(
            {
              id: randomUUID(),
              title: "Guide",
              created: T0,
              createdBy: null,
              updated: T0,
              updatedBy: null,
              review: null,
            },
            "Guide body\n",
            "markdown",
          ),
        );
      },
    );

    // As in the merge spec's mid-failure coverage: fail the project.json
    // read that mergeFetchedBranch's writeMetadata performs.
    const failure = new Error("db down during merge");
    const merge = mergeService.mergeFetchedBranch;
    const spy = vi
      .spyOn(mergeService, "mergeFetchedBranch")
      .mockImplementationOnce((tx, ...args) => {
        vi.spyOn(tx.project, "findFirst").mockRejectedValueOnce(failure);
        return merge(tx, ...args);
      });
    try {
      await pullProjectGitRemote({
        db: getPrisma(),
        payload,
        ring: testEncryptionKeys(),
        fetch: async () => ({
          bareDirectory,
          remoteHead,
          knownHosts: null,
          dispose: async () => undefined,
        }),
      });
    } finally {
      spy.mockRestore();
    }

    const row = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(row.lastPullErrorCode).toBe("MERGE_FAILED");
    expect(row.lastPullSha).toBeNull();
    expect(row.leaseToken).toBeNull();
    expect(await (await openProjectRepo(project.id))!.resolveHead()).toBe(
      localHeadBefore,
    );
  });

  it("records KEY_UNAVAILABLE when the encryption ring cannot decrypt the stored key (M6)", async () => {
    const { owner, project } = await ownerProject(
      "pull-job-keyunavail",
      "Pull Job Key Unavailable Project",
    );
    await pullFixture(project.id);

    const queue = new FakeJobQueue();
    const payload = await requestPull(project.id, owner, queue);

    const wrongRing = {
      activeVersion: 999,
      keys: new Map([[999, new Uint8Array(randomBytes(32))]]),
    };
    const fetch = vi.fn();

    await pullProjectGitRemote({
      db: getPrisma(),
      payload,
      ring: wrongRing,
      fetch,
    });

    expect(fetch).not.toHaveBeenCalled();
    const row = await getPrisma().projectGitRemote.findUniqueOrThrow({
      where: { projectId: project.id },
    });
    expect(row.lastPullErrorCode).toBe("KEY_UNAVAILABLE");
    expect(row.leaseToken).toBeNull();
  });
});

describe("three-way pull regressions", () => {
  it.each(["edit", "delete", "rename", "conflict"] as const)(
    "preserves remote %s on a diverged branch",
    async (operation) => {
      const { project, author } = await ownerProject(
        `three-way-${operation}`,
        "Three way",
      );
      const id = randomUUID();
      const file = (body: string) =>
        composeDocumentFile(
          {
            id,
            title: "Notes",
            created: T0,
            createdBy: null,
            updated: T0,
            updatedBy: null,
            review: null,
          },
          `${body}\n`,
          "markdown",
        );
      await withExistingProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic("notes.md", file("base"));
        await repo.commitAll("create: notes.md", author);
      });
      const worktree = path.join(tmp, `three-way-${randomUUID()}`);
      await execAsync("git", ["clone", repoDir(project.id), worktree]);
      const git = async (...args: string[]) =>
        (await execAsync("git", ["-C", worktree, ...args])).stdout.trim();
      await git("config", "user.name", "Remote");
      await git("config", "user.email", "remote@example.test");
      if (operation === "delete") await git("rm", "notes.md");
      else if (operation === "rename")
        await git("mv", "notes.md", "renamed.md");
      else
        await writeFile(path.join(worktree, "notes.md"), file("remote edit"));
      await git("add", ".");
      await git("commit", "-m", "remote change");
      const remoteHead = await git("rev-parse", "HEAD");
      await withExistingProjectRepo(project.id, async (repo) => {
        await repo.writeFileAtomic(
          operation === "conflict" ? "notes.md" : "local.txt",
          operation === "conflict" ? file("local edit") : "local change\n",
        );
        await repo.commitAll("update: local", author);
      });
      const outcome = (await withExistingProjectRepo(project.id, (repo) =>
        mergeFetchedBranch(getPrisma(), repo, {
          projectId: project.id,
          bareDirectory: path.join(worktree, ".git"),
          branch: "main",
          remoteHead,
          author,
        }),
      ))!;
      const repo = (await openProjectRepo(project.id))!;
      const files = await repo.listTrackedFiles();
      if (operation === "delete" || operation === "rename")
        expect(files).not.toContain("notes.md");
      if (operation === "rename")
        expect(
          parseDocumentFile(
            await repo.showFileAt("HEAD", "renamed.md"),
            "markdown",
          ).meta.id,
        ).toBe(id);
      if (operation === "edit" || operation === "conflict")
        expect(await repo.showFileAt("HEAD", "notes.md")).toContain(
          "remote edit",
        );
      if (operation === "conflict") {
        expect(outcome.reslugged).toHaveLength(1);
        const copy = parseDocumentFile(
          await repo.showFileAt("HEAD", outcome.reslugged[0]!.to),
          "markdown",
        );
        expect(copy.meta.id).not.toBe(id);
        expect(copy.body).toContain("local edit");
      } else expect(outcome.reslugged).toEqual([]);
    },
  );
});

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { simpleGit } from "simple-git";
import { createCredentialUser } from "@weaver/auth";
import { contentOperationSchema } from "@weaver/core/services/contentOperations";
import {
  applyWikiOperation,
  wikiRequestHash,
  type WikiOperation,
  type WikiWriteFence,
  type WikiWriteGuards,
} from "@weaver/core/services/wikiOperations";
import { createWikiAgentSecurityContext } from "@weaver/core/security/context";
import { wikiAgentContentAuthor } from "@weaver/core/services/contentAuthor";
import { listDashboardActivity } from "@weaver/core/services/dashboard/activity";
import {
  getHistory,
  listDocuments,
  rebuildIndex,
  resolveAttribution,
  writeDocumentInRepo,
} from "@weaver/core/services/documents";
import { getTree } from "@weaver/core/services/folders";
import {
  createWikiAgent,
  revokeWikiAgent,
} from "@weaver/core/services/wikiAgents";
import { listRecentChanges } from "@weaver/core/services/wikiReads";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { withProjectRepo } from "@weaver/git-store";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  testAuth,
} from "./_harness";
import { createTaskRun } from "./_dashboardFixtures";

const HASH = "a".repeat(64);
const HEADER_ONLY = { guideDocumentId: null, sourceFolderPaths: [] };

async function fixture(suffix = "w") {
  const db = getPrisma();
  const owner = await makeUser("User", `wiki-${suffix}`);
  const project = await makeProject(`Wiki-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  const agent = await createWikiAgent(db, project.id);
  const context = createWikiAgentSecurityContext({
    agentId: agent.id,
    projectId: project.id,
  });
  const security = securityContextFor(owner);
  return {
    db,
    owner,
    project,
    agent,
    context,
    author: wikiAgentContentAuthor(context),
    security,
    user: { ...security, name: null, email: owner.email },
    caller: callerFor(owner),
  };
}

async function agentCreate(
  f: Awaited<ReturnType<typeof fixture>>,
  title: string,
  markdown: string,
) {
  const runId = randomUUID();
  return withProjectRepo(f.project.id, (repo) =>
    writeDocumentInRepo(
      f.db,
      repo,
      f.project.id,
      {
        kind: "create",
        id: randomUUID(),
        folderPath: [],
        title,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(markdown),
        },
        createdAt: new Date().toISOString(),
      },
      f.author,
      {
        operation: "create",
        operationId: `wiki-run:${runId}:0001`,
        runId,
        wikiRequestHash: HASH,
      },
    ),
  );
}

describe("machine editor attribution", () => {
  beforeEach(resetDb);

  it("commits as the agent with its trailers and no user trailer, and projects the pair", async () => {
    const f = await fixture();
    const saved = await agentCreate(f, "Page", "Body");
    const raw = await withProjectRepo(f.project.id, (repo) =>
      simpleGit(repo.dir).raw(["log", "-1", "--format=%an%n%ae%n%B"]),
    );
    expect(raw).toContain("Wiki agent");
    expect(raw).toContain(`wiki-agent+${f.agent.id}@weaver.invalid`);
    expect(raw).toContain(`Weaver-Wiki-Agent-Id: ${f.agent.id}`);
    expect(raw).toContain(`Weaver-Wiki-Request-Hash: ${HASH}`);
    expect(raw).toContain("Weaver-Run-Id: ");
    expect(raw).not.toContain("Weaver-User-Id");

    const expected = {
      lastEditedById: null,
      lastEditedByProjectKeyId: null,
      lastEditedByMachineKind: "wikiAgent",
      lastEditedByMachineId: f.agent.id,
    };
    const row = await f.db.document.findUniqueOrThrow({
      where: { id: saved.id },
    });
    expect(row).toMatchObject(expected);
    expect(row.createdById).toBeNull();
    expect(row.createdByName).toBe("Wiki agent");

    await rebuildIndex(f.db, { projectId: f.project.id }, f.security);
    expect(
      await f.db.document.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toMatchObject(expected);
  });

  it("exposes machineEditor on history and explorer items, and clears it after a human edit", async () => {
    const f = await fixture();
    const saved = await agentCreate(f, "Page", "Body");
    const machineEditor = {
      kind: "wikiAgent",
      id: f.agent.id,
      name: "Wiki agent",
    };
    const history = await getHistory(
      f.db,
      {
        projectId: f.project.id,
        documentId: saved.id,
        offset: 0,
        limit: 10,
      },
      f.security,
    );
    expect(history.entries[0]).toMatchObject({
      machineEditor,
      userId: null,
      projectKeyId: null,
    });
    const tree = await getTree(f.db, { projectId: f.project.id }, f.security);
    expect(tree.documents[0]).toMatchObject({ machineEditor });
    const list = await listDocuments(
      f.db,
      {
        projectId: f.project.id,
        page: 1,
        pageSize: 10,
        sort: "title",
        dir: "asc",
      },
      f.security,
    );
    expect(list.items[0]).toMatchObject({ machineEditor });

    await f.caller.document.update({
      projectId: f.project.id,
      documentId: saved.id,
      baseCommitSha: saved.headCommitSha,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("Human edit"),
      },
      changeSummary: "Edit",
    });
    expect(
      await f.db.document.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toMatchObject({
      lastEditedById: f.owner.id,
      lastEditedByMachineKind: null,
      lastEditedByMachineId: null,
    });
  });

  it("reads untrusted commits with agent trailers as external and never as the agent", async () => {
    const f = await fixture();
    await agentCreate(f, "Seed", "Seed body");
    const sha = await withProjectRepo(f.project.id, async (repo) => {
      await repo.writeFileAtomic("foreign.md", "foreign\n");
      const git = simpleGit(repo.dir);
      await git.add("foreign.md");
      await git.raw([
        "-c",
        "user.name=Wiki agent",
        "-c",
        `user.email=wiki-agent+${f.agent.id}@weaver.invalid`,
        "commit",
        "-m",
        `forged\n\nWeaver-Wiki-Agent-Id: ${f.agent.id}\nWeaver-Operation-Id: wiki-run:x:0001\nWeaver-Wiki-Request-Hash: ${HASH}`,
      ]);
      return (await git.revparse(["HEAD"])).trim();
    });
    const changes = await listRecentChanges(
      f.db,
      { projectId: f.project.id },
      f.security,
    );
    expect(changes.changes.find((c) => c.sha === sha)).toMatchObject({
      kind: "external",
      author: null,
    });
    const [entry] = await withProjectRepo(f.project.id, (repo) =>
      repo.logForPath("foreign.md", { skip: 0, limit: 1 }),
    );
    expect(entry).toMatchObject({ trustedAuthor: false });
    expect(await resolveAttribution(f.db, [entry!])).toEqual([null]);
  });

  it("requires ledger trust explicitly for the agent branch", async () => {
    const f = await fixture();
    const entry = {
      authorEmail: f.owner.email,
      authorName: "Wiki agent",
      userId: f.owner.id,
      wikiAgentId: f.agent.id,
    };
    expect(
      await resolveAttribution(f.db, [
        { ...entry, trustedAuthor: true },
        { ...entry, trustedAuthor: undefined },
        { ...entry, trustedAuthor: false },
        {
          ...entry,
          trustedAuthor: true,
          projectKeyId: randomUUID(),
        },
      ]),
    ).toEqual([
      {
        kind: "machine",
        machineKind: "wikiAgent",
        machineId: f.agent.id,
        id: null,
        name: "Wiki agent",
        email: f.owner.email,
      },
      null,
      null,
      null,
    ]);
  });

  it("rewrites link labels to the target's current title on agent writes", async () => {
    const f = await fixture();
    const target = await f.caller.document.create({
      projectId: f.project.id,
      folderPath: [],
      title: "Current title",
      contentJson: parseDocumentBody("Target"),
    });
    const saved = await agentCreate(
      f,
      "Linker",
      `See [Stale label](weaver://document/${target.id}).`,
    );
    const body = await withProjectRepo(f.project.id, (repo) =>
      repo.readFileFromWorktree(saved.path),
    );
    expect(body).toContain(`[Current title](weaver://document/${target.id})`);
    expect(body).not.toContain("Stale label");
  });

  it("enforces the editor pair in the database", async () => {
    const f = await fixture();
    const saved = await agentCreate(f, "Page", "Body");
    const where = { id: saved.id };
    await expect(
      f.db.document.update({
        where,
        data: { lastEditedByMachineId: null },
      }),
    ).rejects.toThrow();
    await expect(
      f.db.document.update({
        where,
        data: { lastEditedByMachineKind: "robot" },
      }),
    ).rejects.toThrow();
    await expect(
      f.db.document.update({
        where,
        data: { lastEditedById: f.owner.id },
      }),
    ).rejects.toThrow();
  });

  it("counts machine editors in Activity's changes by others", async () => {
    const f = await fixture();
    const saved = await agentCreate(f, "Page", "Body");
    const others = await listDashboardActivity(f.db, f.security, {
      view: "others",
    });
    expect(others.items.map((item) => item.id)).toContain(saved.id);
    expect(others.items.find((item) => item.id === saved.id)).toMatchObject({
      editorName: "Wiki agent",
      isOwnChange: false,
    });
  });
});

describe("reserved weaver.invalid email domain", () => {
  beforeEach(resetDb);

  it.each([
    "bot@weaver.invalid",
    "Bot@WEAVER.INVALID",
    "wiki-agent+x@sub.weaver.invalid",
    " bot@weaver.invalid ",
  ])("refuses to create a user with %s", async (email) => {
    const admin = await makeUser("Admin", "reserved");
    await expect(
      callerFor(admin).user.create({
        email,
        name: "Bot",
        role: "User",
        password: "initial-password-1",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await getPrisma().user.count({
        where: { email: { contains: "weaver.invalid" } },
      }),
    ).toBe(0);
  });

  it("refuses it below the service too, in the shared Better Auth create hook", async () => {
    await expect(
      createCredentialUser(testAuth(), {
        email: "bot@weaver.invalid",
        password: "initial-password-1",
        name: "Bot",
        role: "User",
      }),
    ).rejects.toThrow(/reserved/i);
    expect(await getPrisma().user.count()).toBe(0);
  });
});

describe("applyWikiOperation", () => {
  beforeEach(resetDb);

  async function writer(suffix = "op") {
    const f = await fixture(suffix);
    const runId = randomUUID();
    let live = true;
    const fence: WikiWriteFence = {
      agentId: f.agent.id,
      projectId: f.project.id,
      runId,
      assertLive: async () => {
        if (!live) throw new Error("run is no longer live");
      },
    };
    let counter = 0;
    const nextId = () =>
      `wiki-run:${runId}:${String(++counter).padStart(4, "0")}`;
    const apply = (
      operation: unknown,
      options: {
        operationId?: string;
        guards?: WikiWriteGuards;
        fence?: WikiWriteFence;
        beforeCommit?: () => Promise<void>;
      } = {},
    ) =>
      applyWikiOperation(f.db, {
        run: options.fence ?? fence,
        guards: async () => options.guards ?? HEADER_ONLY,
        operation: operation as WikiOperation,
        operationId: options.operationId ?? nextId(),
        beforeCommit: options.beforeCommit,
      });
    const create = (title = "Page", markdown = "First paragraph.") =>
      ({
        kind: "document.create",
        projectId: f.project.id,
        folderPath: [],
        title,
        markdown,
      }) satisfies WikiOperation;
    const head = () =>
      withProjectRepo(f.project.id, (repo) => repo.resolveHead());
    return {
      ...f,
      fence,
      runId,
      apply,
      create,
      head,
      nextId,
      close: () => {
        live = false;
      },
    };
  }
  type Writer = Awaited<ReturnType<typeof writer>>;

  const patch = (
    w: Writer,
    documentId: string,
    baseCommitSha: string,
    text = "Added.",
  ) =>
    ({
      kind: "document.patch",
      projectId: w.project.id,
      documentId,
      baseCommitSha,
      actions: [{ action: "append", text }],
    }) satisfies WikiOperation;
  const folder = (w: Writer, name = "Topics", parentPath: string[] = []) =>
    ({
      kind: "content.lifecycle",
      action: "folder_create",
      projectId: w.project.id,
      parentPath,
      name,
    }) satisfies WikiOperation;

  async function forgeCommit(
    w: Writer,
    file: string,
    content: string,
    trailers: Record<string, string>,
  ) {
    return withProjectRepo(w.project.id, async (repo) => {
      await repo.writeFileAtomic(file, content);
      const git = simpleGit(repo.dir);
      await git.raw(["add", "-f", file]);
      const lines = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`);
      await git.raw([
        "-c",
        "user.name=Wiki agent",
        "-c",
        `user.email=wiki-agent+${w.agent.id}@weaver.invalid`,
        "commit",
        "-m",
        `forged\n\n${lines.join("\n")}`,
      ]);
      return (await git.revparse(["HEAD"])).trim();
    });
  }

  it("creates, patches and creates folders as the agent with the run's trailers", async () => {
    const w = await writer();
    const created = await w.apply(w.create());
    expect(created).toMatchObject({
      projectId: w.project.id,
      recovered: false,
      path: "page.md",
    });
    const patched = await w.apply(
      patch(w, created.resourceId!, created.commitSha),
    );
    expect(patched.resourceId).toBe(created.resourceId);
    const made = await w.apply(folder(w));
    expect(made).toMatchObject({ resourceId: null, path: "topics" });
    const inside = await w.apply({
      ...w.create("Nested"),
      folderPath: ["topics"],
    });
    expect(inside.path).toBe("topics/nested.md");

    const log = await withProjectRepo(w.project.id, (repo) =>
      simpleGit(repo.dir).raw(["log", "-4", "--format=%an|%ae|%B%x00"]),
    );
    const commits = log.split("\0").filter((c) => c.trim());
    expect(commits).toHaveLength(4);
    for (const commit of commits) {
      expect(commit).toContain(`Weaver-Wiki-Agent-Id: ${w.agent.id}`);
      expect(commit).toContain(`Weaver-Run-Id: ${w.runId}`);
      expect(commit).toMatch(/Weaver-Wiki-Request-Hash: [0-9a-f]{64}/);
      expect(commit).toMatch(/Weaver-Operation-Id: wiki-run:/);
      expect(commit).not.toContain("Weaver-User-Id");
      expect(commit).toContain("Wiki agent|");
    }
    expect(
      await w.db.document.findUniqueOrThrow({
        where: { id: created.resourceId! },
      }),
    ).toMatchObject({
      lastEditedById: null,
      lastEditedByMachineKind: "wikiAgent",
      lastEditedByMachineId: w.agent.id,
      createdById: null,
      updatedByName: "Wiki agent",
    });
  });

  it("rewrites link labels on create and on patch", async () => {
    const w = await writer();
    const target = await w.caller.document.create({
      projectId: w.project.id,
      folderPath: [],
      title: "Current title",
      contentJson: parseDocumentBody("Target"),
    });
    const stale = `[Stale](weaver://document/${target.id})`;
    const created = await w.apply(w.create("Linker", `See ${stale}.`));
    const patched = await w.apply(
      patch(w, created.resourceId!, created.commitSha, `Also ${stale}.`),
    );
    const body = await withProjectRepo(w.project.id, (repo) =>
      repo.showFileAt(patched.commitSha, patched.path),
    );
    expect(body).not.toContain("Stale");
    expect(body.match(/\[Current title\]\(weaver:/g)).toHaveLength(2);
  });

  it("refuses every other ContentOperation kind and lifecycle action by name", async () => {
    const w = await writer();
    const before = await w.head();
    const kinds = contentOperationSchema.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds).toContain("document.edit");
    const allowed = ["document.create", "document.patch", "content.lifecycle"];
    for (const kind of kinds.filter((name) => !allowed.includes(name)))
      await expect(
        w.apply({ kind, projectId: w.project.id }),
        kind,
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const actions = contentOperationSchema.options.flatMap((option) =>
      "action" in option.shape ? option.shape.action.options : [],
    );
    expect(actions).toContain("folder_create");
    for (const action of actions.filter((name) => name !== "folder_create"))
      await expect(
        w.apply({ kind: "content.lifecycle", action, projectId: w.project.id }),
        action,
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await w.head()).toBe(before);
  });

  it("has no title, author metadata or table folder input", async () => {
    const w = await writer();
    const created = await w.apply(w.create());
    const base = patch(w, created.resourceId!, created.commitSha);
    for (const operation of [
      { ...base, title: "Renamed" },
      { ...base, actions: [] },
      { ...base, metadata: { updatedBy: { name: "Someone" } } },
      { ...w.create("Other"), metadata: { createdBy: { name: "Someone" } } },
      { ...folder(w), resourceType: "table" },
    ])
      await expect(w.apply(operation)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
  });

  it("stays inside its project", async () => {
    const w = await writer();
    const other = await makeProject("Elsewhere");
    await addMembership(other.id, w.owner.id, "Owner");
    const foreign = await w.caller.document.create({
      projectId: other.id,
      folderPath: [],
      title: "Foreign",
      contentJson: parseDocumentBody("Foreign"),
    });
    await expect(
      w.apply({ ...w.create(), projectId: other.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      w.apply({ ...folder(w), projectId: other.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      w.apply({
        ...patch(w, foreign.id, foreign.headCommitSha),
        projectId: other.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      w.apply(patch(w, foreign.id, foreign.headCommitSha)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a revoked agent and a closed fence without committing", async () => {
    const w = await writer();
    const before = await w.head();
    w.close();
    await expect(w.apply(w.create())).rejects.toThrow(/no longer live/);
    expect(await w.head()).toBe(before);

    const open = await writer("op2");
    const start = await open.head();
    await revokeWikiAgent(open.db, { projectId: open.project.id });
    await expect(open.apply(open.create())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await open.head()).toBe(start);
  });

  it("re-checks the fence and the agent immediately before the commit", async () => {
    const w = await writer();
    const before = await w.head();
    let calls = 0;
    const closing = {
      ...w.fence,
      assertLive: async () => {
        // Open for the checks before the lock and on entry, closed at the commit.
        if (++calls >= 3) throw new Error("fence closed at commit");
      },
    };
    await expect(w.apply(w.create(), { fence: closing })).rejects.toThrow(
      /fence closed/,
    );
    expect(await w.head()).toBe(before);

    await expect(
      w.apply(w.create("Revoked"), {
        beforeCommit: () => {
          throw new Error("never reached");
        },
        fence: {
          ...w.fence,
          assertLive: async () => {
            if (calls++ === 5)
              await revokeWikiAgent(w.db, { projectId: w.project.id });
          },
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await w.head()).toBe(before);

    const stillWorks = await writer("op3");
    await expect(stillWorks.apply(stillWorks.create())).resolves.toMatchObject({
      recovered: false,
    });
  });

  it("refuses protected pages: Python, task output, guide, source pages and source folders", async () => {
    const w = await writer();
    const python = await withProjectRepo(w.project.id, (repo) =>
      writeDocumentInRepo(
        w.db,
        repo,
        w.project.id,
        {
          kind: "create",
          id: randomUUID(),
          folderPath: [],
          title: "Script",
          content: { kind: "python", text: "print(1)\n" },
          createdAt: new Date().toISOString(),
        },
        w.user,
        { operation: "create" },
      ),
    );
    await expect(
      w.apply(patch(w, python.id, python.headCommitSha)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const page = async (title: string) => w.apply(w.create(title));
    const report = await page("Report");
    const run = await createTaskRun({
      owner: w.owner,
      projectId: w.project.id,
      name: "Nightly",
    });
    await w.db.scheduledTaskRun.update({
      where: { id: run.id },
      data: { outputDocumentId: report.resourceId },
    });
    await expect(
      w.apply(patch(w, report.resourceId!, report.commitSha)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const pinned = await page("Pinned report");
    await w.db.scheduledTask.update({
      where: { id: run.taskId },
      data: { outputDocumentId: pinned.resourceId },
    });
    await expect(
      w.apply(patch(w, pinned.resourceId!, pinned.commitSha)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const guide = await page("Guide");
    await expect(
      w.apply(patch(w, guide.resourceId!, guide.commitSha), {
        guards: { guideDocumentId: guide.resourceId, sourceFolderPaths: [] },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const source = await page("Source");
    await w.db.document.update({
      where: { id: source.resourceId! },
      data: { wikiSourceItemId: randomUUID() },
    });
    await expect(
      w.apply(patch(w, source.resourceId!, source.commitSha)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await w.apply(folder(w, "Wiki"));
    await w.apply(folder(w, "Sources", ["wiki"]));
    const guards = {
      guideDocumentId: null,
      sourceFolderPaths: ["wiki/sources"],
    };
    await expect(
      w.apply(
        { ...w.create("Inside"), folderPath: ["wiki", "sources"] },
        { guards },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      w.apply(folder(w, "Sub", ["wiki", "sources"]), { guards }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      w.apply(folder(w, "Sources", ["wiki"]), { guards }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const inside = await w.apply({
      ...w.create("In sources"),
      folderPath: ["wiki", "sources"],
    });
    await expect(
      w.apply(patch(w, inside.resourceId!, inside.commitSha), { guards }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      w.apply({ ...w.create("Beside"), folderPath: ["wiki"] }, { guards }),
    ).resolves.toMatchObject({ path: "wiki/beside.md" });
  });

  it("refuses weaver-image references and img tags, also split across actions", async () => {
    const w = await writer();
    const id = randomUUID();
    const before = await w.head();
    for (const markdown of [
      `![x](weaver-image:${id})`,
      `![x](WEAVER-IMAGE:${id})`,
      '<img src="x.png" alt="x" width="10">',
      '<IMG src="x.png">',
      '< img src="x.png">',
    ])
      await expect(
        w.apply(w.create("Image", markdown)),
        markdown,
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await w.head()).toBe(before);

    const created = await w.apply(w.create());
    const base = patch(w, created.resourceId!, created.commitSha);
    for (const actions of [
      [{ action: "append", text: `![x](weaver-image:${id})` }],
      [{ action: "prepend", text: '<img src="x.png">' }],
      [
        {
          action: "replace_text",
          find: "First",
          replace: '<img src="x.png">',
        },
      ],
    ])
      await expect(
        w.apply({ ...base, actions }),
        JSON.stringify(actions),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await w.head()).toBe(created.commitSha);

    const joined = await w.apply(w.create("Joined", 'ZZg src="x.png"> tail'));
    await expect(
      w.apply({
        ...patch(w, joined.resourceId!, joined.commitSha),
        actions: [{ action: "replace_text", find: "ZZ", replace: "<im" }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await w.head()).toBe(joined.commitSha);
  });

  it("returns STALE_BASE for an old base and never writes a Python file by title", async () => {
    const w = await writer();
    const created = await w.apply(w.create());
    await w.apply(patch(w, created.resourceId!, created.commitSha));
    await expect(
      w.apply(patch(w, created.resourceId!, created.commitSha)),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "STALE_BASE" },
    });
    const named = await w.apply(w.create("script.py"));
    expect(named.path.endsWith(".md")).toBe(true);
  });

  it("recovers its own commit after a lost acknowledgement, for all three operations", async () => {
    const w = await writer();
    const createId = w.nextId();
    const created = await w.apply(w.create(), { operationId: createId });
    await expect(
      w.apply(w.create(), { operationId: createId }),
    ).resolves.toMatchObject({
      recovered: true,
      commitSha: created.commitSha,
      resourceId: created.resourceId,
      path: created.path,
    });

    const operation = patch(w, created.resourceId!, created.commitSha);
    const patchId = w.nextId();
    const patched = await w.apply(operation, { operationId: patchId });
    const again = await w.apply(operation, { operationId: patchId });
    expect(again).toMatchObject({
      recovered: true,
      commitSha: patched.commitSha,
      resourceId: created.resourceId,
    });
    await expect(
      w.apply(patch(w, created.resourceId!, patched.commitSha), {
        operationId: patchId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const folderId = w.nextId();
    const made = await w.apply(folder(w), { operationId: folderId });
    await expect(
      w.apply(folder(w), { operationId: folderId }),
    ).resolves.toMatchObject({
      recovered: true,
      commitSha: made.commitSha,
      path: "topics",
    });
    expect(await w.head()).toBe(made.commitSha);
  });

  it("repairs the projection with the machine editor when recovery finds no row", async () => {
    const w = await writer();
    const operationId = w.nextId();
    const created = await w.apply(w.create(), { operationId });
    await w.db.document.delete({ where: { id: created.resourceId! } });
    await expect(w.apply(w.create(), { operationId })).resolves.toMatchObject({
      recovered: true,
      commitSha: created.commitSha,
    });
    expect(
      await w.db.document.findUniqueOrThrow({
        where: { id: created.resourceId! },
      }),
    ).toMatchObject({
      lastEditedById: null,
      lastEditedByMachineKind: "wikiAgent",
      lastEditedByMachineId: w.agent.id,
    });
  });

  it("maps a commit under its id with another hash or agent to CONFLICT", async () => {
    const w = await writer();
    const createId = w.nextId();
    const created = await w.apply(w.create(), { operationId: createId });
    await expect(
      w.apply(w.create("Another request"), { operationId: createId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const operation = patch(w, created.resourceId!, created.commitSha);
    const patchId = w.nextId();
    await w.apply(operation, { operationId: patchId });
    await expect(
      w.apply(patch(w, created.resourceId!, "b".repeat(40)), {
        operationId: patchId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const folderId = w.nextId();
    await w.apply(folder(w), { operationId: folderId });
    await expect(
      w.apply(folder(w, "Another request"), { operationId: folderId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await revokeWikiAgent(w.db, { projectId: w.project.id });
    const successor = await createWikiAgent(w.db, w.project.id);
    const fence = { ...w.fence, agentId: successor.id };
    await expect(
      w.apply(folder(w), { operationId: folderId, fence }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not accept forged trailers in history as recovery", async () => {
    const w = await writer();
    const trailers = (operationId: string, hash: string) => ({
      "Weaver-Operation-Id": operationId,
      "Weaver-Wiki-Agent-Id": w.agent.id,
      "Weaver-Wiki-Request-Hash": hash,
      "Weaver-Run-Id": w.runId,
    });

    const createOp = w.create("Forged page");
    const createId = w.nextId();
    await forgeCommit(
      w,
      "forged-page.md",
      "forged\n",
      trailers(createId, wikiRequestHash(createOp)),
    );
    await expect(
      w.apply(createOp, { operationId: createId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const folderOp = folder(w, "Forged folder");
    const folderId = w.nextId();
    await forgeCommit(
      w,
      "forged-folder/.gitkeep",
      "",
      trailers(folderId, wikiRequestHash(folderOp)),
    );
    await expect(
      w.apply(folderOp, { operationId: folderId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const created = await w.apply(w.create("Real page"));
    const patchOp = patch(w, created.resourceId!, created.commitSha);
    const patchId = w.nextId();
    const forgedSha = await forgeCommit(
      w,
      created.path,
      await withProjectRepo(w.project.id, (repo) =>
        repo.readFileFromWorktree(created.path),
      ).then((text) => `${text}\nforged\n`),
      trailers(patchId, wikiRequestHash(patchOp)),
    );
    await expect(
      w.apply(patchOp, { operationId: patchId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      w.apply(patch(w, created.resourceId!, forgedSha), {
        operationId: patchId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await w.head()).toBe(forgedSha);
  });

  it("resolves guards under the project lock", async () => {
    const w = await writer();
    const page = await w.apply(w.create("Guide later"));
    const resolvedInsideLock = vi.fn(async () => ({
      guideDocumentId: page.resourceId,
      sourceFolderPaths: [],
    }));
    await expect(
      applyWikiOperation(w.db, {
        run: w.fence,
        guards: resolvedInsideLock,
        operation: patch(w, page.resourceId!, page.commitSha),
        operationId: w.nextId(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(resolvedInsideLock).toHaveBeenCalledOnce();
  });

  it("validates its operation id", async () => {
    const w = await writer();
    for (const operationId of [
      "project-api:1",
      `wiki-run:${randomUUID()}:0001`,
      `wiki-run:${w.runId}:1`,
      "ingestion:abc",
    ])
      await expect(
        w.apply(w.create(), { operationId }),
        operationId,
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

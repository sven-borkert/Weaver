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
  getLiveWikiAgent,
  revokeWikiAgent,
} from "@weaver/core/services/wikiAgents";
import {
  approveGuide,
  disableWiki,
  enableWiki,
  getWikiSettings,
  listGuideSuggestions,
  resolveGuideSuggestion,
  revokeAgent,
  reviewGuide,
  setGuideDocument,
  updateWikiSettings,
  wikiWriteGuardsFor,
} from "@weaver/core/services/wikiSettings";
import { resolveProjectAccess } from "@weaver/core/services/projectAccess";
import { setLlmRoute } from "@weaver/core/services/llmRoutes";
import { normalizeGuideText } from "@weaver/core/wiki/guideText";
import { listRecentChanges } from "@weaver/core/services/wikiReads";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { withProjectRepo } from "@weaver/git-store";
import {
  addMembership,
  bindWikiSettings,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
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
  await bindWikiSettings(project.id, agent.id);
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
    await bindWikiSettings(w.project.id, successor.id);
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

describe("wiki settings, bootstrap and guide", () => {
  beforeEach(resetDb);

  async function project(suffix = "s") {
    const db = getPrisma();
    const owner = await makeUser("User", `own-${suffix}`);
    const maintainer = await makeUser("User", `mnt-${suffix}`);
    const editor = await makeUser("User", `edt-${suffix}`);
    const viewer = await makeUser("User", `vwr-${suffix}`);
    const admin = await makeUser("Admin", `adm-${suffix}`);
    const p = await makeProject(`WikiSettings-${suffix}`);
    await addMembership(p.id, owner.id, "Owner");
    await addMembership(p.id, maintainer.id, "Maintainer");
    await addMembership(p.id, editor.id, "Editor");
    await addMembership(p.id, viewer.id, "Viewer");
    const ctx = securityContextFor;
    const enable = async (expectedRevision = 0) =>
      enableWiki(db, ctx(owner), { projectId: p.id, expectedRevision });
    const settings = () =>
      db.projectWikiSettings.findUniqueOrThrow({ where: { projectId: p.id } });
    const log = () =>
      withProjectRepo(p.id, (repo) =>
        simpleGit(repo.dir).raw(["log", "--format=%an|%ae|%B%x00"]),
      ).then((out) => out.split("\0").filter((c) => c.trim()));
    return {
      db,
      owner,
      maintainer,
      editor,
      viewer,
      admin,
      project: p,
      ctx,
      enable,
      settings,
      log,
      id: p.id,
    };
  }
  type P = Awaited<ReturnType<typeof project>>;

  async function editGuide(f: P, markdown: string) {
    const row = await f.settings();
    const doc = await f.db.document.findUniqueOrThrow({
      where: { id: row.guideDocumentId! },
    });
    return f.db.document.findUniqueOrThrow({ where: { id: doc.id } }).then(() =>
      callerFor(f.owner).document.update({
        projectId: f.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: parseDocumentBody(markdown) },
        changeSummary: "Edit guide",
      }),
    );
  }

  it("enables: creates the agent, folders, guide, overview and approves the template", async () => {
    const f = await project();
    const view = await f.enable();
    expect(view).toMatchObject({
      enabled: true,
      revision: 1,
      routeReady: false,
      guide: { approved: true, approvedById: null },
    });
    const row = await f.settings();
    const agent = await getLiveWikiAgent(f.db, f.id);
    expect(agent).not.toBeNull();
    expect(row).toMatchObject({ agentId: agent!.id, enabledById: f.owner.id });
    expect(row.sourcesFolderId).toMatch(/^[0-9a-f-]{36}$/);

    const tree = await getTree(f.db, { projectId: f.id }, f.ctx(f.owner));
    const paths = JSON.stringify(tree);
    expect(paths).toContain("wiki");
    expect(paths).toContain("sources");

    const guide = await f.db.document.findUniqueOrThrow({
      where: { id: row.guideDocumentId! },
    });
    expect(guide).toMatchObject({
      wikiType: "guide",
      reviewExempt: true,
      reviewDueAt: null,
      lastEditedByMachineKind: "wikiAgent",
      lastEditedByMachineId: agent!.id,
    });
    expect(guide.path.startsWith("wiki/")).toBe(true);
    const overview = await f.db.document.findUniqueOrThrow({
      where: { id: row.overviewDocumentId! },
    });
    expect(overview).toMatchObject({
      wikiType: "overview",
      reviewExempt: true,
    });

    const review = await reviewGuide(f.db, f.ctx(f.owner), f.id);
    expect(review).toMatchObject({
      digest: row.approvedGuideDigest,
      matchesApproved: true,
      tooLarge: false,
    });
    expect(review.text).toBe(row.approvedGuideBody);
    expect(row.approvedGuideCommitSha).toBe(guide.headCommitSha);
    expect(review.flags).toEqual([]);
  });

  it("commits each bootstrap step as the agent with a bootstrap id and no run or user trailer", async () => {
    const f = await project();
    await f.enable();
    const agent = (await getLiveWikiAgent(f.db, f.id))!;
    const commits = await f.log();
    const steps = commits.filter((c) =>
      c.includes("Weaver-Operation-Id: wiki-bootstrap:"),
    );
    expect(steps).toHaveLength(4);
    const ids = steps
      .map((c) => /Weaver-Operation-Id: (\S+)/.exec(c)![1])
      .sort();
    expect(ids).toEqual(
      [1, 2, 3, 4].map((n) => `wiki-bootstrap:${f.id}:000${n}`),
    );
    for (const commit of steps) {
      expect(commit).toContain(`Weaver-Wiki-Agent-Id: ${agent.id}`);
      expect(commit).toMatch(/Weaver-Wiki-Request-Hash: [0-9a-f]{64}/);
      expect(commit).not.toContain("Weaver-Run-Id");
      expect(commit).not.toContain("Weaver-User-Id");
      expect(commit).toContain("Wiki agent|");
    }
    const changes = await listRecentChanges(
      f.db,
      { projectId: f.id },
      f.ctx(f.owner),
    );
    expect(changes.changes.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["wiki-bootstrap"]),
    );
    expect(
      await f.db.user.count({
        where: { email: { endsWith: "@weaver.invalid" } },
      }),
    ).toBe(0);
  });

  it("resumes missing pieces by operation id and never adopts an existing page", async () => {
    const f = await project();
    const human = await callerFor(f.owner).folder.create({
      projectId: f.id,
      parentPath: [],
      name: "wiki",
    });
    expect(human).toBeTruthy();
    const mine = await callerFor(f.owner).document.create({
      projectId: f.id,
      folderPath: ["wiki"],
      title: "Wiki guide",
      contentJson: parseDocumentBody("Mine, not the agent's"),
    });
    const view = await f.enable();
    const row = await f.settings();
    expect(row.guideDocumentId).not.toBe(mine.id);
    expect(view.guide.approved).toBe(true);
    const untouched = await f.db.document.findUniqueOrThrow({
      where: { id: mine.id },
    });
    expect(untouched.headCommitSha).toBe(mine.headCommitSha);
    expect(untouched.wikiType).toBeNull();

    // A crash after the commits but before the anchors were recorded.
    const before = await f.log();
    await f.db.projectWikiSettings.update({
      where: { projectId: f.id },
      data: {
        enabled: false,
        guideDocumentId: null,
        overviewDocumentId: null,
        sourcesFolderId: null,
        approvedGuideBody: null,
        approvedGuideDigest: null,
      },
    });
    const again = await f.enable((await f.settings()).revision);
    expect(again.enabled).toBe(true);
    expect(await f.settings()).toMatchObject({
      guideDocumentId: row.guideDocumentId,
      overviewDocumentId: row.overviewDocumentId,
      sourcesFolderId: row.sourcesFolderId,
      approvedGuideDigest: row.approvedGuideDigest,
    });
    expect(await f.log()).toHaveLength(before.length);
  });

  it("rolls a failed first enable back to off and can be retried", async () => {
    const f = await project();
    await callerFor(f.owner).folder.create({
      projectId: f.id,
      parentPath: [],
      name: "wiki",
    });
    await callerFor(f.owner).folder.create({
      projectId: f.id,
      parentPath: ["wiki"],
      name: "sources",
    });
    await expect(f.enable()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.settings()).toMatchObject({ enabled: false });
    const agent = await getLiveWikiAgent(f.db, f.id);
    await expect(
      resolveProjectAccess(
        f.db,
        f.id,
        createWikiAgentSecurityContext({ agentId: agent!.id, projectId: f.id }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("gates settings by role and keeps non-members out", async () => {
    const f = await project();
    for (const user of [f.maintainer, f.editor, f.viewer])
      await expect(
        enableWiki(f.db, f.ctx(user), { projectId: f.id, expectedRevision: 0 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      enableWiki(f.db, f.ctx(f.admin), {
        projectId: f.id,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.enable();
    const revision = (await f.settings()).revision;

    for (const user of [f.editor, f.viewer])
      await expect(
        getWikiSettings(f.db, f.ctx(user), f.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      getWikiSettings(f.db, f.ctx(f.admin), f.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const user of [f.owner, f.maintainer])
      await expect(
        getWikiSettings(f.db, f.ctx(user), f.id),
      ).resolves.toMatchObject({ enabled: true, revision });

    const guideId = (await f.settings()).guideDocumentId!;
    for (const user of [f.maintainer, f.editor, f.viewer]) {
      const actor = f.ctx(user);
      const input = { projectId: f.id, expectedRevision: revision };
      await expect(disableWiki(f.db, actor, input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(revokeAgent(f.db, actor, input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        updateWikiSettings(f.db, actor, {
          ...input,
          destructiveBudget24h: 5000,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setGuideDocument(f.db, actor, { ...input, documentId: guideId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const review = await reviewGuide(f.db, f.ctx(f.maintainer), f.id);
    for (const user of [f.editor, f.viewer]) {
      await expect(
        approveGuide(f.db, f.ctx(user), {
          projectId: f.id,
          expectedRevision: revision,
          expectedDigest: review.digest,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(reviewGuide(f.db, f.ctx(user), f.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    await expect(
      approveGuide(f.db, f.ctx(f.maintainer), {
        projectId: f.id,
        expectedRevision: revision,
        expectedDigest: review.digest,
      }),
    ).resolves.toMatchObject({
      revision: revision + 1,
      guide: { approvedById: f.maintainer.id },
    });
    expect((await f.settings()).revision).toBe(revision + 1);
  });

  it("refuses every non-session actor on every settings read and write", async () => {
    const f = await project();
    await f.enable();
    const revision = (await f.settings()).revision;
    const row = await f.settings();
    const session = f.ctx(f.owner);
    const actors = [
      { ...session, authenticationMethod: "apiKey" as const },
      { ...session, authenticationMethod: "oauth" as const },
      { ...session, authenticationMethod: "task" as const },
      createWikiAgentSecurityContext({
        agentId: row.agentId!,
        projectId: f.id,
      }) as never,
    ];
    const base = { projectId: f.id, expectedRevision: revision };
    for (const actor of actors) {
      const calls = [
        () => getWikiSettings(f.db, actor, f.id),
        () => enableWiki(f.db, actor, base),
        () => disableWiki(f.db, actor, base),
        () => revokeAgent(f.db, actor, base),
        () =>
          updateWikiSettings(f.db, actor, {
            ...base,
            destructiveBudget24h: 5000,
          }),
        () =>
          setGuideDocument(f.db, actor, {
            ...base,
            documentId: row.guideDocumentId!,
          }),
        () => reviewGuide(f.db, actor, f.id),
        () =>
          approveGuide(f.db, actor, {
            ...base,
            expectedDigest: row.approvedGuideDigest!,
          }),
        () => listGuideSuggestions(f.db, actor, f.id),
        () =>
          resolveGuideSuggestion(f.db, actor, {
            projectId: f.id,
            suggestionId: randomUUID(),
          }),
      ];
      for (const call of calls)
        await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await f.settings()).toMatchObject({ revision, enabled: true });
  });

  it("is compare-and-set on the revision for every write", async () => {
    const f = await project();
    await expect(f.enable(1)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.enable();
    const actor = f.ctx(f.owner);
    const stale = { projectId: f.id, expectedRevision: 99 };
    const guideId = (await f.settings()).guideDocumentId!;
    await expect(disableWiki(f.db, actor, stale)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(revokeAgent(f.db, actor, stale)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      updateWikiSettings(f.db, actor, { ...stale, destructiveBudget24h: 5000 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      setGuideDocument(f.db, actor, { ...stale, documentId: guideId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const review = await reviewGuide(f.db, actor, f.id);
    await expect(
      approveGuide(f.db, actor, { ...stale, expectedDigest: review.digest }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await f.settings()).revision).toBe(1);

    const updated = await updateWikiSettings(f.db, actor, {
      projectId: f.id,
      expectedRevision: 1,
      destructiveBudget24h: 50_000,
      spendAlertCentsPerDay: 300,
    });
    expect(updated).toMatchObject({
      revision: 2,
      destructiveBudget24h: 50_000,
      spendAlertCentsPerDay: 300,
    });
    await expect(
      updateWikiSettings(f.db, actor, {
        projectId: f.id,
        expectedRevision: 2,
        destructiveBudget24h: 10,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("disables keeping everything, re-enables the same agent, and revokes to a new one", async () => {
    const f = await project();
    await f.enable();
    const first = (await getLiveWikiAgent(f.db, f.id))!;
    const row = await f.settings();
    const actor = f.ctx(f.owner);
    const context = createWikiAgentSecurityContext({
      agentId: first.id,
      projectId: f.id,
    });
    await resolveProjectAccess(f.db, f.id, context);

    const off = await disableWiki(f.db, actor, {
      projectId: f.id,
      expectedRevision: row.revision,
    });
    expect(off).toMatchObject({ enabled: false, guide: { approved: true } });
    expect(await f.db.document.count({ where: { projectId: f.id } })).toBe(2);
    await expect(
      resolveProjectAccess(f.db, f.id, context),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const on = await f.enable(off.revision);
    expect(on.enabled).toBe(true);
    expect((await getLiveWikiAgent(f.db, f.id))!.id).toBe(first.id);
    await resolveProjectAccess(f.db, f.id, context);
    expect(await f.db.document.count({ where: { projectId: f.id } })).toBe(2);

    const revoked = await revokeAgent(f.db, actor, {
      projectId: f.id,
      expectedRevision: on.revision,
    });
    expect(revoked.enabled).toBe(false);
    expect(await getLiveWikiAgent(f.db, f.id)).toBeNull();
    await expect(
      resolveProjectAccess(f.db, f.id, context),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Old commits still resolve to the agent.
    const history = await getHistory(
      f.db,
      {
        projectId: f.id,
        documentId: row.guideDocumentId!,
        offset: 0,
        limit: 5,
      },
      actor,
    );
    expect(history.entries[0]).toMatchObject({
      machineEditor: { kind: "wikiAgent", id: first.id, name: "Wiki agent" },
    });

    const again = await f.enable(revoked.revision);
    const second = (await getLiveWikiAgent(f.db, f.id))!;
    expect(second.id).not.toBe(first.id);
    expect(again.agent).toMatchObject({ id: second.id, live: true });
    const newContext = createWikiAgentSecurityContext({
      agentId: second.id,
      projectId: f.id,
    });
    await resolveProjectAccess(f.db, f.id, newContext);
    await expect(
      resolveProjectAccess(f.db, f.id, context),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires the feature enabled and the agent to equal agentId for agent access", async () => {
    const f = await project();
    await f.enable();
    const row = await f.settings();
    const other = await makeProject("OtherAgent");
    const stranger = await createWikiAgent(f.db, other.id);
    await bindWikiSettings(other.id, stranger.id);
    await f.db.projectWikiSettings.update({
      where: { projectId: f.id },
      data: { agentId: null },
    });
    await expect(
      resolveProjectAccess(
        f.db,
        f.id,
        createWikiAgentSecurityContext({
          agentId: row.agentId!,
          projectId: f.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("normalizes the guide before the digest and approves exactly what the reviewer saw", async () => {
    const f = await project();
    await f.enable();
    const actor = f.ctx(f.maintainer);
    await editGuide(
      f,
      "Keep pages short.\n\nHidden‮​­⁠﻿\u{e0041}️ text\n\nSee the style page at https://example.com/rules",
    );
    const review = await reviewGuide(f.db, actor, f.id);
    expect(review.text).toContain("Hidden text");
    expect(review.text).not.toMatch(/[­​-‏‪-‮⁠-⁩﻿︀-️]|\u{e0041}/u);
    expect(review.removed.reduce((n, r) => n + r.count, 0)).toBe(7);
    expect(review.matchesApproved).toBe(false);
    expect(review.digest).toBe(normalizeGuideText(review.text).digest);
    expect(review.diff.some((l) => l.type === "add")).toBe(true);
    expect(review.diff.some((l) => l.type === "del")).toBe(true);
    expect(review.flags.map((fl) => fl.reason)).toContain(
      "Mentions an external address",
    );

    const revision = review.revision;
    await expect(
      approveGuide(f.db, actor, {
        projectId: f.id,
        expectedRevision: revision,
        expectedDigest: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "GUIDE_CHANGED" },
    });
    expect((await f.settings()).approvedGuideDigest).not.toBe(review.digest);

    // The reviewed text changes after review: refused, never approved blind.
    await editGuide(f, "Something else entirely.");
    await expect(
      approveGuide(f.db, actor, {
        projectId: f.id,
        expectedRevision: revision,
        expectedDigest: review.digest,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const fresh = await reviewGuide(f.db, actor, f.id);
    const approved = await approveGuide(f.db, actor, {
      projectId: f.id,
      expectedRevision: revision,
      expectedDigest: fresh.digest,
    });
    expect(approved.guide.approved).toBe(true);
    const row = await f.settings();
    expect(row.approvedGuideBody).toBe(fresh.text);
    expect(row.approvedGuideDigest).toBe(fresh.digest);
    expect(row.approvedGuideBody).toContain("Something else entirely.");
    expect((await reviewGuide(f.db, actor, f.id)).matchesApproved).toBe(true);
  });

  it("refuses a guide over 16,000 bytes and never truncates", async () => {
    const f = await project();
    await f.enable();
    const actor = f.ctx(f.owner);
    const before = await f.settings();
    await editGuide(
      f,
      `${"A line of guide text that is long enough.\n\n".repeat(400)}`,
    );
    const review = await reviewGuide(f.db, actor, f.id);
    expect(review).toMatchObject({ tooLarge: true, text: "" });
    expect(review.bytes).toBeGreaterThan(16_000);
    await expect(
      approveGuide(f.db, actor, {
        projectId: f.id,
        expectedRevision: before.revision,
        expectedDigest: review.digest,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "GUIDE_TOO_LARGE" },
    });
    expect(await f.settings()).toMatchObject({
      approvedGuideDigest: before.approvedGuideDigest,
      approvedGuideBody: before.approvedGuideBody,
    });
  });

  it("clears approval when the guide is re-pointed and refuses unsuitable targets", async () => {
    const f = await project();
    await f.enable();
    const actor = f.ctx(f.owner);
    const owner = callerFor(f.owner);
    const page = await owner.document.create({
      projectId: f.id,
      folderPath: [],
      title: "Alt guide",
      contentJson: parseDocumentBody("Alternative guide."),
    });
    const revision = (await f.settings()).revision;

    const other = await makeProject("Elsewhere");
    await addMembership(other.id, f.owner.id, "Owner");
    const foreign = await owner.document.create({
      projectId: other.id,
      folderPath: [],
      title: "Foreign",
      contentJson: parseDocumentBody("Foreign"),
    });
    await expect(
      setGuideDocument(f.db, actor, {
        projectId: f.id,
        expectedRevision: revision,
        documentId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const python = await withProjectRepo(f.id, (repo) =>
      writeDocumentInRepo(
        f.db,
        repo,
        f.id,
        {
          kind: "create",
          id: randomUUID(),
          folderPath: [],
          title: "Script",
          content: { kind: "python", text: "print(1)\n" },
          createdAt: new Date().toISOString(),
        },
        { ...f.ctx(f.owner), name: null, email: f.owner.email },
        { operation: "create" },
      ),
    );
    await expect(
      setGuideDocument(f.db, actor, {
        projectId: f.id,
        expectedRevision: revision,
        documentId: python.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const doomed = await owner.document.create({
      projectId: f.id,
      folderPath: [],
      title: "Doomed",
      contentJson: parseDocumentBody("Soon gone"),
    });
    await owner.document.delete({ projectId: f.id, documentId: doomed.id });
    await expect(
      setGuideDocument(f.db, actor, {
        projectId: f.id,
        expectedRevision: revision,
        documentId: doomed.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await f.settings()).approvedGuideDigest).not.toBeNull();

    const moved = await setGuideDocument(f.db, actor, {
      projectId: f.id,
      expectedRevision: revision,
      documentId: page.id,
    });
    expect(moved).toMatchObject({
      revision: revision + 1,
      guide: { documentId: page.id, approved: false, approvedAt: null },
    });
    expect(await f.settings()).toMatchObject({
      approvedGuideBody: null,
      approvedGuideDigest: null,
      approvedGuideCommitSha: null,
    });
    const review = await reviewGuide(f.db, actor, f.id);
    expect(review).toMatchObject({
      matchesApproved: false,
      title: "Alt guide",
    });
    expect(review.diff).toEqual([]);
  });

  it("keeps the guide and source folders unwritable through applyWikiOperation with the real guards", async () => {
    const f = await project();
    await f.enable();
    const row = await f.settings();
    const agent = (await getLiveWikiAgent(f.db, f.id))!;
    const guards = await wikiWriteGuardsFor(f.db, f.id);
    expect(guards).toEqual({
      guideDocumentId: row.guideDocumentId,
      sourceFolderPaths: ["wiki/sources"],
    });
    const runId = randomUUID();
    const run: WikiWriteFence = {
      agentId: agent.id,
      projectId: f.id,
      runId,
      assertLive: async () => {},
    };
    let n = 0;
    const apply = (operation: WikiOperation) =>
      applyWikiOperation(f.db, {
        run,
        guards: () => wikiWriteGuardsFor(f.db, f.id),
        operation,
        operationId: `wiki-run:${runId}:${String(++n).padStart(4, "0")}`,
      });
    const guide = await f.db.document.findUniqueOrThrow({
      where: { id: row.guideDocumentId! },
    });
    await expect(
      apply({
        kind: "document.patch",
        projectId: f.id,
        documentId: guide.id,
        baseCommitSha: guide.headCommitSha,
        actions: [{ action: "append", text: "Take over." }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      apply({
        kind: "document.create",
        projectId: f.id,
        folderPath: ["wiki", "sources"],
        title: "Sneaky",
        markdown: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      apply({
        kind: "document.create",
        projectId: f.id,
        folderPath: ["wiki"],
        title: "Fine",
        markdown: "x",
      }),
    ).resolves.toMatchObject({ recovered: false });

    // Re-pointing the guide moves the protection with it.
    const alt = await callerFor(f.owner).document.create({
      projectId: f.id,
      folderPath: [],
      title: "Alt",
      contentJson: parseDocumentBody("Alt"),
    });
    await setGuideDocument(f.db, f.ctx(f.owner), {
      projectId: f.id,
      expectedRevision: row.revision,
      documentId: alt.id,
    });
    await expect(
      apply({
        kind: "document.patch",
        projectId: f.id,
        documentId: alt.id,
        baseCommitSha: alt.headCommitSha,
        actions: [{ action: "append", text: "Nope." }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The old guide, no longer the guide, is an ordinary page.
    await expect(
      apply({
        kind: "document.patch",
        projectId: f.id,
        documentId: guide.id,
        baseCommitSha: guide.headCommitSha,
        actions: [{ action: "append", text: "Ordinary now." }],
      }),
    ).resolves.toMatchObject({ recovered: false });
  });

  it("lists and dismisses guide suggestions for Maintainers", async () => {
    const f = await project();
    await f.enable();
    const suggestion = await f.db.wikiGuideSuggestion.create({
      data: {
        projectId: f.id,
        runId: randomUUID(),
        text: "Prefer short titles.",
      },
    });
    expect(
      await listGuideSuggestions(f.db, f.ctx(f.maintainer), f.id),
    ).toMatchObject([{ id: suggestion.id, text: "Prefer short titles." }]);
    expect(
      (await getWikiSettings(f.db, f.ctx(f.owner), f.id)).openSuggestions,
    ).toBe(1);
    await expect(
      resolveGuideSuggestion(f.db, f.ctx(f.editor), {
        projectId: f.id,
        suggestionId: suggestion.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await resolveGuideSuggestion(f.db, f.ctx(f.maintainer), {
      projectId: f.id,
      suggestionId: suggestion.id,
    });
    expect(await listGuideSuggestions(f.db, f.ctx(f.owner), f.id)).toEqual([]);
    await expect(
      resolveGuideSuggestion(f.db, f.ctx(f.maintainer), {
        projectId: f.id,
        suggestionId: suggestion.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports route readiness from the wiki route and serves the router for sessions", async () => {
    const f = await project();
    const caller = callerFor(f.owner);
    expect(await caller.wiki.settings({ projectId: f.id })).toMatchObject({
      enabled: false,
      revision: 0,
      routeReady: false,
    });
    const { admin } = await seedTestLlmRouting();
    const model = await f.db.llmModel.findFirstOrThrow({
      where: { providerModelId: "test-extraction" },
    });
    await setLlmRoute(f.db, securityContextFor(admin), {
      purpose: "wiki",
      modelId: model.id,
    });
    const enabled = await caller.wiki.enable({
      projectId: f.id,
      expectedRevision: 0,
    });
    expect(enabled).toMatchObject({ enabled: true, routeReady: true });
    await expect(
      callerFor(f.editor).wiki.settings({ projectId: f.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(f.admin).wiki.settings({ projectId: f.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

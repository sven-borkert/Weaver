import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { createCredentialUser } from "@weaver/auth";
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
import { createWikiAgent } from "@weaver/core/services/wikiAgents";
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

const HASH = "a".repeat(64);

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

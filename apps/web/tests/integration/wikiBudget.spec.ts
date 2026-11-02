import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import simpleGit from "simple-git";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  createDocument,
  getDocument,
  moveDocument,
  rebuildIndex,
  repairDocumentProjectionInRepo,
  saveDocument,
} from "@weaver/core/services/documents";
import { createFolder } from "@weaver/core/services/folders";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import {
  applyWikiOperation,
  type WikiOperation,
} from "@weaver/core/services/wikiOperations";
import { isOwnedAtWrite } from "@weaver/core/services/wikiOwnership";
import { leaseWikiRun, wikiRunFence } from "@weaver/core/services/wikiRuns";
import {
  enableWiki,
  getWikiSettings,
  revokeAgent,
  wikiWriteGuardsFor,
} from "@weaver/core/services/wikiSettings";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

async function setup() {
  const db = getPrisma();
  const owner = await makeUser("User", "budget-owner");
  const project = await makeProject("Wiki budget");
  await addMembership(project.id, owner.id, "Owner");
  const security = {
    ...securityContextFor(owner),
    name: owner.name,
    email: owner.email,
  };
  await enableWiki(db, security, {
    projectId: project.id,
    expectedRevision: 0,
  });
  const { agentId: storedAgentId } =
    await db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: project.id },
    });
  const agentId = storedAgentId!;
  const row = await db.wikiRun.create({
    data: {
      projectId: project.id,
      agentId,
      kind: "ingest",
      status: "queued",
    },
  });
  const lease = (await leaseWikiRun(db, {
    runId: row.id,
    workerId: "budget-spec",
  }))!;
  let n = 0;
  const apply = (operation: unknown) =>
    applyWikiOperation(db, {
      run: wikiRunFence(db, lease),
      guards: () => wikiWriteGuardsFor(db, project.id),
      operation: operation as WikiOperation,
      operationId: `wiki-run:${lease.id}:${String(++n).padStart(4, "0")}`,
    });
  const agentCreate = (title: string, markdown = "Agent body.") =>
    apply({
      kind: "document.create",
      projectId: project.id,
      folderPath: [],
      title,
      markdown,
    });
  const agentPatch = (
    documentId: string,
    baseCommitSha: string,
    text: string,
  ) =>
    apply({
      kind: "document.patch",
      projectId: project.id,
      documentId,
      baseCommitSha,
      actions: [{ action: "append", text }],
    });
  return {
    db,
    owner,
    project,
    security,
    agentId,
    lease,
    agentCreate,
    agentPatch,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const ownedRow = (s: Setup, documentId: string) =>
  s.db.wikiOwnedPage.findUnique({ where: { documentId } });

async function humanSave(s: Setup, documentId: string, text: string) {
  const current = await getDocument(
    s.db,
    { projectId: s.project.id, documentId },
    s.security,
  );
  return saveDocument(
    s.db,
    {
      projectId: s.project.id,
      documentId,
      baseCommitSha: current.baseCommitSha,
      content: { kind: "markdown", contentJson: parseDocumentBody(text) },
      changeSummary: "human",
    },
    s.security,
  );
}

describe("wiki ownership", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  it("records an agent create and advances on the agent's next patch", async () => {
    const s = await setup();
    const created = await s.agentCreate("Owned page");
    expect(await ownedRow(s, created.resourceId!)).toMatchObject({
      projectId: s.project.id,
      runId: s.lease.id,
      createdCommitSha: created.commitSha,
      lastAgentCommitSha: created.commitSha,
    });
    const patched = await s.agentPatch(
      created.resourceId!,
      created.commitSha,
      "More.",
    );
    expect(await ownedRow(s, created.resourceId!)).toMatchObject({
      createdCommitSha: created.commitSha,
      lastAgentCommitSha: patched.commitSha,
    });
  }, 30_000);

  it("drops ownership at a human save and does not regain it on the next agent patch", async () => {
    const s = await setup();
    const created = await s.agentCreate("Edited page");
    const saved = await humanSave(s, created.resourceId!, "Human words.");
    expect(await ownedRow(s, created.resourceId!)).toBeNull();
    await s.agentPatch(
      created.resourceId!,
      saved.headCommitSha,
      "Agent again.",
    );
    expect(await ownedRow(s, created.resourceId!)).toBeNull();
  }, 30_000);

  it("drops ownership on a human move", async () => {
    const s = await setup();
    const created = await s.agentCreate("Moved page");
    await createFolder(
      s.db,
      { projectId: s.project.id, parentPath: [], name: "Elsewhere" },
      s.security,
    );
    await moveDocument(
      s.db,
      {
        projectId: s.project.id,
        documentId: created.resourceId!,
        folderPath: ["elsewhere"],
      },
      s.security,
    );
    expect(await ownedRow(s, created.resourceId!)).toBeNull();
  }, 30_000);

  it("re-derives ownership through projection repair and rebuildIndex", async () => {
    const s = await setup();
    const owned = await s.agentCreate("Repaired page");
    const edited = await s.agentCreate("Human touched");
    await humanSave(s, edited.resourceId!, "Human.");

    await s.db.wikiOwnedPage.deleteMany({
      where: { documentId: owned.resourceId! },
    });
    await withProjectRepo(s.project.id, (repo) =>
      repairDocumentProjectionInRepo(
        s.db,
        repo,
        s.project.id,
        owned.resourceId!,
      ),
    );
    expect(await ownedRow(s, owned.resourceId!)).toMatchObject({
      createdCommitSha: owned.commitSha,
      runId: s.lease.id,
    });

    await s.db.wikiOwnedPage.deleteMany({
      where: { projectId: s.project.id },
    });
    await rebuildIndex(s.db, { projectId: s.project.id }, s.security);
    expect(await ownedRow(s, owned.resourceId!)).toMatchObject({
      lastAgentCommitSha: owned.commitSha,
    });
    expect(await ownedRow(s, edited.resourceId!)).toBeNull();
  }, 30_000);

  it("rebuildIndex removes a stale row whose head is no longer an agent commit", async () => {
    const s = await setup();
    const created = await s.agentCreate("Stale cache");
    const saved = await humanSave(s, created.resourceId!, "Human.");
    await s.db.wikiOwnedPage.create({
      data: {
        documentId: created.resourceId!,
        projectId: s.project.id,
        runId: s.lease.id,
        createdCommitSha: created.commitSha,
        lastAgentCommitSha: created.commitSha,
      },
    });
    expect(saved.headCommitSha).not.toBe(created.commitSha);
    await rebuildIndex(s.db, { projectId: s.project.id }, s.security);
    expect(await ownedRow(s, created.resourceId!)).toBeNull();
  }, 30_000);

  it("never owns source, bootstrap or human pages", async () => {
    const s = await setup();
    const anchors = await s.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: s.project.id },
    });
    expect(await ownedRow(s, anchors.guideDocumentId!)).toBeNull();
    expect(await ownedRow(s, anchors.overviewDocumentId!)).toBeNull();
    const human = await createDocument(
      s.db,
      {
        projectId: s.project.id,
        folderPath: [],
        title: "Human page",
        content: { kind: "markdown", contentJson: parseDocumentBody("Words") },
      },
      s.security,
    );
    expect(await ownedRow(s, human.id)).toBeNull();
    await s.agentPatch(human.id, human.headCommitSha, "Agent note.");
    expect(await ownedRow(s, human.id)).toBeNull();
  }, 30_000);

  it("write-time check fails safe when the row misses a commit", async () => {
    const s = await setup();
    const created = await s.agentCreate("Missed hook");
    const check = () =>
      withProjectRepo(s.project.id, async (repo) =>
        isOwnedAtWrite(s.db, repo, {
          documentId: created.resourceId!,
          path: created.path,
          agentId: s.agentId,
        }),
      );
    expect(await check()).toBe(true);
    await withProjectRepo(s.project.id, async (repo) => {
      await repo.writeFileAtomic(
        created.path,
        `${await repo.readFileFromWorktree(created.path)}\nPulled.\n`,
      );
      const git = simpleGit(repo.dir);
      await git.add(created.path);
      await git.raw([
        "-c",
        "user.name=Remote",
        "-c",
        "user.email=remote@example.com",
        "commit",
        "-m",
        "pulled",
      ]);
    });
    expect(await check()).toBe(false);
    expect(await ownedRow(s, created.resourceId!)).not.toBeNull();
  }, 30_000);

  it("write-time check refuses another agent's row and revoke clears the rows", async () => {
    const s = await setup();
    const created = await s.agentCreate("Revoked");
    expect(
      await withProjectRepo(s.project.id, (repo) =>
        isOwnedAtWrite(s.db, repo, {
          documentId: created.resourceId!,
          path: created.path,
          agentId: randomUUID(),
        }),
      ),
    ).toBe(false);
    const current = await getWikiSettings(s.db, s.security, s.project.id);
    await s.db.wikiRun.updateMany({
      where: { id: s.lease.id },
      data: { status: "stopped", leaseToken: null },
    });
    await revokeAgent(s.db, s.security, {
      projectId: s.project.id,
      expectedRevision: current.revision,
    });
    expect(await ownedRow(s, created.resourceId!)).toBeNull();
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import {
  WIKI_AGENT_DISPATCH,
  wikiAgentToolContext,
} from "@weaver/assistant-tools/wikiAgentRegistry";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  createDocument,
  getDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import { addTextInput, processInputs } from "@weaver/core/services/wikiInputs";
import { WikiRunSession } from "@weaver/core/services/wikiRunSession";
import {
  leaseWikiRun,
  type LeasedWikiRun,
} from "@weaver/core/services/wikiRuns";
import { enableWiki } from "@weaver/core/services/wikiSettings";
import { runWikiTick } from "@weaver/core/services/wikiTick";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  securityContextFor,
} from "./_harness";

export async function wikiProject(name = "Wiki run") {
  const db = getPrisma();
  const owner = await makeUser("User", `run-owner-${randomUUID().slice(0, 8)}`);
  const project = await makeProject(name);
  await addMembership(project.id, owner.id, "Owner");
  const security = {
    ...securityContextFor(owner),
    name: "Run owner",
    email: owner.email,
  };
  await enableWiki(db, security, {
    projectId: project.id,
    expectedRevision: 0,
  });
  const settings = await db.projectWikiSettings.findUniqueOrThrow({
    where: { projectId: project.id },
  });
  return { db, owner, project, projectId: project.id, security, settings };
}
export type WikiProject = Awaited<ReturnType<typeof wikiProject>>;

/** A real queued ingest run: note added, Process pressed, source written by the tick. */
export async function queuedRun(p: WikiProject, notes: string[] = ["A note"]) {
  for (const text of notes)
    await addTextInput(p.db, p.security, { projectId: p.projectId, text });
  await processInputs(p.db, p.security, {
    projectId: p.projectId,
    itemIds: "all",
  });
  await runWikiTick(p.db, { hasActiveRunJob: async () => true });
  const run = await p.db.wikiRun.findFirstOrThrow({
    where: { projectId: p.projectId, status: "queued" },
  });
  const items = await p.db.wikiInputItem.findMany({
    where: { runId: run.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { run, items };
}

export function toolCaller(session: WikiRunSession) {
  return async (name: string, input: unknown) => {
    const tool = WIKI_AGENT_DISPATCH.find((entry) => entry.name === name);
    if (!tool) throw new Error(`no such tool ${name}`);
    const parsed = tool.inputSchema.parse(input);
    const { output } = await tool.execute(
      parsed,
      wikiAgentToolContext(session),
    );
    return output as Record<string, any>;
  };
}

export async function startedRun(p: WikiProject, notes?: string[]) {
  const { run, items } = await queuedRun(p, notes);
  const lease = (await leaseWikiRun(p.db, {
    runId: run.id,
    workerId: "spec",
  })) as LeasedWikiRun;
  const session = new WikiRunSession(p.db, lease, 64 * 1024);
  return { lease, session, items, call: toolCaller(session) };
}

export const humanPage = (p: WikiProject, title: string, markdown: string) =>
  createDocument(
    p.db,
    {
      projectId: p.projectId,
      folderPath: [],
      title,
      content: { kind: "markdown", contentJson: parseDocumentBody(markdown) },
    },
    p.security,
  );

export async function humanEdit(
  p: WikiProject,
  documentId: string,
  markdown: string,
) {
  const current = await getDocument(
    p.db,
    { projectId: p.projectId, documentId },
    p.security,
  );
  return saveDocument(
    p.db,
    {
      projectId: p.projectId,
      documentId,
      baseCommitSha: current.baseCommitSha,
      content: { kind: "markdown", contentJson: parseDocumentBody(markdown) },
      changeSummary: "human",
    },
    p.security,
  );
}

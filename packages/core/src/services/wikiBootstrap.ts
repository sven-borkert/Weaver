import { createHash } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { parseDocumentBody } from "../editor/markdown";
import { CoreError } from "../errors";
import { createWikiAgentSecurityContext } from "../security/context";
import {
  parseFolderMetadata,
  folderMetadataPath,
} from "../documents/folderMetadata";
import { normalizeGuideText } from "../wiki/guideText";
import {
  GUIDE_TEMPLATE_V1,
  GUIDE_TEMPLATE_VERSION,
  GUIDE_TITLE,
  OVERVIEW_TEMPLATE,
  OVERVIEW_TITLE,
} from "../wiki/templates/guide-v1.md";
import { wikiAgentContentAuthor } from "./contentAuthor";
import {
  applyFolderCreate,
  createdResourceId,
  recoverCheckApply,
  type AppliedOperation,
  type ContentOperation,
  type RecoveryIdentity,
} from "./contentOperations";
import { getDocumentAtSnapshot, writeDocumentInRepo } from "./documents";
import { assertProjectRole } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Deterministic setup commits; they carry no run id, so only this prefix may omit it. */
export const WIKI_BOOTSTRAP_OPERATION_ID_RE = new RegExp(
  `^wiki-bootstrap:(${UUID}):\\d{4}$`,
);

export const WIKI_FOLDER = "wiki";
export const WIKI_SOURCES_FOLDER = "sources";

export type WikiBootstrapAnchors = {
  sourcesFolderId: string | null;
  guideDocumentId: string | null;
  overviewDocumentId: string | null;
};

export type WikiBootstrapGuide = {
  documentId: string;
  commitSha: string;
  /** Normalized canonical body, ready to store as the approved text. */
  text: string;
  digest: string;
};

export type WikiBootstrapRecord = {
  sourcesFolderId?: string;
  guide?: WikiBootstrapGuide;
  overviewDocumentId?: string;
};

function operationId(projectId: string, n: number): string {
  const id = `wiki-bootstrap:${projectId}:${String(n).padStart(4, "0")}`;
  if (!WIKI_BOOTSTRAP_OPERATION_ID_RE.test(id))
    throw new CoreError("BAD_REQUEST", "Invalid wiki bootstrap operation id");
  return id;
}

function stepHash(step: unknown): string {
  return createHash("sha256").update(JSON.stringify(step)).digest("hex");
}

/**
 * The deterministic setup of a project's wiki: folders, guide, overview. One
 * commit per step as the agent, resumable by operation id, never adopting an
 * existing page. Pieces already recorded in `existing` are skipped.
 */
export async function runWikiBootstrap(
  db: PrismaClient,
  input: {
    projectId: string;
    agentId: string;
    existing: WikiBootstrapAnchors;
    record: (patch: WikiBootstrapRecord) => Promise<void>;
  },
): Promise<void> {
  const { projectId, agentId, existing } = input;
  const actor = createWikiAgentSecurityContext({ agentId, projectId });
  const author = wikiAgentContentAuthor(actor);
  // The bootstrap fence: project not deleted, agent live and enabled, checked before every commit.
  const assertLive = async () => {
    await assertProjectRole(db, projectId, actor, "Editor");
  };
  await assertLive();

  const run = async <T>(
    n: number,
    step: unknown,
    body: (repo: ProjectRepoWriter, id: string, hash: string) => Promise<T>,
  ): Promise<T> => {
    const id = operationId(projectId, n);
    const hash = stepHash({ n, step });
    const result = await withProjectRepo(projectId, async (repo) => {
      await assertLive();
      return body(repo, id, hash);
    });
    void notifyProjectContentChanged(db, projectId);
    return result;
  };
  const identity = (hash: string): RecoveryIdentity => ({
    wikiAgentId: agentId,
    wikiRequestHash: hash,
  });
  const audit = (id: string, hash: string) => ({
    operationId: id,
    wikiRequestHash: hash,
    beforeCommit: assertLive,
  });

  const folder = async (
    n: number,
    parentPath: string[],
    name: string,
    reuse: boolean,
  ): Promise<string | null> =>
    run(n, { folder: [...parentPath, name] }, async (repo, id, hash) => {
      const rel = [...parentPath, name].join("/");
      // A human-made container folder is reused; the recorded sources folder never is.
      if (reuse && (await repo.fileExistsInWorktree(rel))) return null;
      const operation: ContentOperation = {
        kind: "content.lifecycle",
        action: "folder_create",
        resourceType: "document",
        projectId,
        parentPath,
        name,
        baseProjectCommitSha: await repo.resolveHead(),
      };
      await recoverCheckApply({
        db,
        repo,
        operation,
        operationId: id,
        identity: identity(hash),
        apply: (): Promise<AppliedOperation> =>
          applyFolderCreate(repo, operation, author, audit(id, hash)),
      });
      const meta = parseFolderMetadata(
        await repo.readFileFromWorktree(folderMetadataPath(rel)),
      );
      return meta?.id ?? null;
    });

  const page = async (
    n: number,
    title: string,
    markdown: string,
    type: "guide" | "overview",
  ): Promise<{ documentId: string; commitSha: string }> =>
    run(
      n,
      { page: title, type, v: GUIDE_TEMPLATE_VERSION },
      async (repo, id, hash) => {
        const operation: ContentOperation = {
          kind: "document.create",
          projectId,
          folderPath: [WIKI_FOLDER],
          title,
          markdown,
        };
        const { applied } = await recoverCheckApply({
          db,
          repo,
          operation,
          operationId: id,
          identity: identity(hash),
          apply: async (): Promise<AppliedOperation> => {
            const result = await writeDocumentInRepo(
              db,
              repo,
              projectId,
              {
                kind: "create",
                id: createdResourceId(id),
                folderPath: [WIKI_FOLDER],
                title,
                content: {
                  kind: "markdown",
                  contentJson: parseDocumentBody(markdown),
                },
                createdAt: new Date().toISOString(),
                properties: { type, reviewExempt: true },
              },
              author,
              {
                operation: "create",
                message: (path) => `wiki: ${path}`,
                ...audit(id, hash),
              },
            );
            return {
              commitSha: result.headCommitSha,
              resourceId: result.id,
              path: result.path,
            };
          },
        });
        return {
          documentId: applied.resourceId!,
          commitSha: applied.commitSha,
        };
      },
    );

  if (existing.sourcesFolderId === null) {
    await folder(1, [], WIKI_FOLDER, true);
    const sourcesFolderId = await folder(
      2,
      [WIKI_FOLDER],
      WIKI_SOURCES_FOLDER,
      false,
    );
    if (sourcesFolderId === null)
      throw new CoreError("INTERNAL_SERVER_ERROR", "Sources folder has no id");
    await input.record({ sourcesFolderId });
  }
  if (existing.guideDocumentId === null) {
    const created = await page(3, GUIDE_TITLE, GUIDE_TEMPLATE_V1, "guide");
    const read = await getDocumentAtSnapshot(
      db,
      {
        projectId,
        documentId: created.documentId,
        atCommitSha: created.commitSha,
      },
      actor,
    );
    const normalized = normalizeGuideText(read.markdown);
    await input.record({
      guide: {
        documentId: created.documentId,
        commitSha: created.commitSha,
        text: normalized.text,
        digest: normalized.digest,
      },
    });
  }
  if (existing.overviewDocumentId === null) {
    const created = await page(
      4,
      OVERVIEW_TITLE,
      OVERVIEW_TEMPLATE,
      "overview",
    );
    await input.record({ overviewDocumentId: created.documentId });
  }
}

import { createHash } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { parseDocumentBody } from "../editor/markdown";
import { CoreError } from "../errors";
import { createWikiAgentSecurityContext } from "../security/context";
import {
  FOLDER_METADATA_FILE,
  folderMetadataPath,
  parseFolderMetadata,
} from "../documents/folderMetadata";
import { slugify } from "../documents/slug";
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
  matchesRecoveryIdentity,
  RECOVERY_LOG_LIMIT,
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

/** Keyed by agent, so a successor never meets a revoked agent's commits. */
function operationId(agentId: string, n: number): string {
  const id = `wiki-bootstrap:${agentId}:${String(n).padStart(4, "0")}`;
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
    const id = operationId(agentId, n);
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

  // The step's own prior commit, found by operation id and verified; its name may carry a suffix.
  const recoverFolder = async (
    repo: ProjectRepoWriter,
    id: string,
    hash: string,
  ): Promise<{ segments: string[]; folderId: string | null } | null> => {
    const entries = await repo.logForPath(".", {
      skip: 0,
      limit: RECOVERY_LOG_LIMIT + 1,
      operationId: id,
    });
    const matching = entries.filter((entry) => entry.operationId === id);
    if (matching.length === 0) return null;
    const entry = matching[0]!;
    if (matching.length > 1 || !matchesRecoveryIdentity(entry, identity(hash)))
      throw new CoreError(
        "CONFLICT",
        "A commit under this bootstrap id cannot be verified",
        { reason: "IDEMPOTENCY_KEY_REUSED" },
      );
    const [change] = await repo.logChangesBefore(entry.sha, { limit: 1 });
    const meta = change?.changes.find(
      (item) =>
        item.status !== "D" && item.path.endsWith(`/${FOLDER_METADATA_FILE}`),
    );
    if (!meta)
      throw new CoreError("CONFLICT", "Bootstrap folder commit is malformed");
    const rel = meta.path.slice(0, -`/${FOLDER_METADATA_FILE}`.length);
    const text = (
      await repo.readBlobsAt(entry.sha, [meta.path], 64 * 1024)
    ).get(meta.path);
    return {
      segments: rel.split("/"),
      folderId: (text ? parseFolderMetadata(text)?.id : undefined) ?? null,
    };
  };

  // Never adopts or fails on an occupied path: the next free suffix is taken under the lock.
  const folder = async (
    n: number,
    parentPath: string[],
    baseName: string,
  ): Promise<{ segments: string[]; folderId: string | null }> =>
    run(n, { folder: baseName }, async (repo, id, hash) => {
      const prior = await recoverFolder(repo, id, hash);
      if (prior) return prior;
      const parentRel = parentPath.join("/");
      let name = baseName;
      for (let suffix = 2; ; suffix += 1) {
        const rel = [parentRel, slugify(name)].filter(Boolean).join("/");
        if (!(await repo.fileExistsInWorktree(rel))) break;
        if (suffix > 1000)
          throw new CoreError("CONFLICT", "No free folder name was found");
        name = `${baseName}-${suffix}`;
      }
      const operation: ContentOperation = {
        kind: "content.lifecycle",
        action: "folder_create",
        resourceType: "document",
        projectId,
        parentPath,
        name,
        baseProjectCommitSha: await repo.resolveHead(),
      };
      const applied = await applyFolderCreate(
        repo,
        operation,
        author,
        audit(id, hash),
      );
      const meta = parseFolderMetadata(
        await repo.readFileFromWorktree(folderMetadataPath(applied.path)),
      );
      return { segments: applied.path.split("/"), folderId: meta?.id ?? null };
    });

  const page = async (
    n: number,
    folderPath: string[],
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
          folderPath,
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
                folderPath,
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

  const needed =
    existing.sourcesFolderId === null ||
    existing.guideDocumentId === null ||
    existing.overviewDocumentId === null;
  if (!needed) return;
  const root = await folder(1, [], WIKI_FOLDER);
  if (existing.sourcesFolderId === null) {
    const sources = await folder(2, root.segments, WIKI_SOURCES_FOLDER);
    if (sources.folderId === null)
      throw new CoreError("INTERNAL_SERVER_ERROR", "Sources folder has no id");
    await input.record({ sourcesFolderId: sources.folderId });
  }
  if (existing.guideDocumentId === null) {
    const created = await page(
      3,
      root.segments,
      GUIDE_TITLE,
      GUIDE_TEMPLATE_V1,
      "guide",
    );
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
      root.segments,
      OVERVIEW_TITLE,
      OVERVIEW_TEMPLATE,
      "overview",
    );
    await input.record({ overviewDocumentId: created.documentId });
  }
}

import { CoreError } from "../errors";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "../documents/frontmatter";
import { documentKindOfPath } from "../documents/kinds";
import {
  applyPagePropertiesInput,
  type WikiPagePropertiesInput,
} from "../wiki/properties";
import type { PrismaClient } from "@weaver/db/client";
import {
  author,
  assertDocumentFileSize,
  repairDocumentProjectionInRepo,
  reportProjectionFailureAndReconcile,
  type EnrichedActor,
} from "./documents";
import { documentAuthorForContent } from "./contentAuthor";
import { assertProjectRole } from "./projectAccess";
import { withProjectRepo } from "./projectRepo";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";

/** Header-only edit: changes the page's properties and nothing else. */
export async function setDocumentProperties(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
    properties: WikiPagePropertiesInput;
  },
  actor: EnrichedActor,
): Promise<{ headCommitSha: string }> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  let changed = false;
  const result = await withProjectRepo(input.projectId, async (repo) => {
    await assertProjectRole(db, input.projectId, actor, "Editor");
    const row = await db.document.findFirst({
      where: { id: input.documentId, projectId: input.projectId },
    });
    if (!row) throw new CoreError("NOT_FOUND");
    const head = await repo.lastCommitForPath(row.path);
    if (!head) throw new CoreError("NOT_FOUND");
    if (head !== input.expectedHeadCommitSha)
      throw new CoreError(
        "CONFLICT",
        "The document changed. Reload and try again.",
        { headCommitSha: head },
      );
    const kind = documentKindOfPath(row.path);
    const currentFile = await repo.readFileFromWorktree(row.path);
    const { meta, body } = parseDocumentFile(currentFile, kind);
    const properties = applyPagePropertiesInput(
      meta.properties,
      input.properties,
    );
    const { properties: _old, ...rest } = meta;
    const file = composeDocumentFile(
      {
        ...rest,
        ...(properties ? { properties } : {}),
        updated: new Date().toISOString(),
        updatedBy: documentAuthorForContent(actor),
      },
      body,
      kind,
    );
    assertDocumentFileSize(file, row.path);
    const unchanged =
      composeDocumentFile(
        { ...rest, ...(properties ? { properties } : {}) },
        body,
        kind,
      ) === composeDocumentFile(meta, body, kind);
    if (unchanged) return { headCommitSha: head };
    await repo.writeFileAtomic(row.path, file);
    const sha = await repo.commitAll(`properties: ${row.path}`, author(actor));
    changed = true;
    try {
      await repairDocumentProjectionInRepo(
        db,
        repo,
        input.projectId,
        row.id,
        row.path,
      );
    } catch (error) {
      await reportProjectionFailureAndReconcile({
        projectId: input.projectId,
        documentId: row.id,
        headCommitSha: sha,
        error,
      });
    }
    return { headCommitSha: sha };
  });
  if (changed) void notifyProjectContentChanged(db, input.projectId);
  return result;
}

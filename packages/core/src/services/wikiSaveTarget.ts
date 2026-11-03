import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import { loadFolderIdentityIndex } from "../projectApi/folderIdentity";
import type { UserSecurityContext } from "../security/context";
import { assertProjectRole } from "./projectAccess";

/**
 * Where "Save as page" files an answer: the folder holding the recorded sources folder,
 * so a renamed or suffixed wiki folder still resolves. Null when the wiki is off or the anchor is gone.
 */
export async function wikiSaveTarget(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string },
): Promise<{ enabled: boolean; folderPath: string[] | null }> {
  await assertProjectRole(db, input.projectId, actor, "Editor", {
    capability: "content:write",
  });
  const row = await db.projectWikiSettings.findUnique({
    where: { projectId: input.projectId },
    select: { enabled: true, sourcesFolderId: true },
  });
  if (!row?.enabled) return { enabled: false, folderPath: null };
  if (!row.sourcesFolderId) return { enabled: true, folderPath: null };
  const repo = await openProjectRepo(input.projectId);
  if (!repo) return { enabled: true, folderPath: null };
  const index = await loadFolderIdentityIndex(
    repo,
    input.projectId,
    "documents",
    await repo.resolveHead(),
  );
  const entry = index.byId.get(row.sourcesFolderId);
  const parent = entry?.path.slice(0, -1) ?? [];
  return {
    enabled: true,
    folderPath: entry && parent.length > 0 ? parent : null,
  };
}

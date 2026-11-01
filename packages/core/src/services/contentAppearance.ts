import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoReader } from "@weaver/git-store";
import {
  applyAppearancePatch,
  assertAppearancePatch,
  normalizeAppearance,
  type Appearance,
  type AppearancePatch,
  type AppearanceTarget,
} from "../appearance/metadata";
import { iconAssetPath } from "../appearance/icons";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "../documents/frontmatter";
import { documentKindOfPath } from "../documents/kinds";
import {
  composeFolderMetadata,
  folderMetadataPath,
  parseFolderMetadata,
} from "../documents/folderMetadata";
import { assertSafeSegments } from "../documents/paths";
import { assertOutsideTablesRoot } from "../tables/paths";
import { parseSchemaFile, serializeSchemaFile } from "../tables/jsonl";
import { CoreError } from "../errors";
import { hasCapability } from "../security/context";
import {
  author,
  isDocumentFilePath,
  repairDocumentProjectionInRepo,
  reportProjectionFailureAndReconcile,
  type EnrichedActor,
} from "./documents";
import { getTableInRepo, repairTableProjectionInRepo } from "./tables";
import { listScopeDirsAt } from "./folders";
import {
  assertProjectRole,
  projectRoleAtLeast,
  type ProjectActor,
} from "./projectAccess";
import { withExistingProjectRepoReader, withProjectRepo } from "./projectRepo";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import {
  imageIconFromBytes,
  readAppearanceAssetInRepo,
} from "./appearanceAssets";

type LoadedAppearance = {
  path: string;
  original: string | null;
  revision: string;
  appearance: Appearance | null;
  compose: (appearance: Appearance | null) => string;
};

async function load(
  db: PrismaClient,
  repo: ProjectRepoReader,
  target: AppearanceTarget,
  head: string,
): Promise<LoadedAppearance> {
  if (target.kind === "table") {
    const table = await getTableInRepo(db, repo, target.projectId, target.id);
    const path = `${table.path}/schema.json`;
    const original = await repo.showFileAt(head, path);
    const schema = parseSchemaFile(original);
    return {
      path,
      original,
      revision: table.baseCommitSha,
      appearance: normalizeAppearance(schema.appearance),
      compose: (appearance) =>
        serializeSchemaFile({ ...schema, appearance: appearance ?? undefined }),
    };
  }
  if (target.kind === "document") {
    const row = await db.document.findFirst({
      where: { id: target.id, projectId: target.projectId },
      select: { path: true },
    });
    const files = (await repo.listTrackedFiles(head))
      .filter(isDocumentFilePath)
      .sort((a, b) =>
        a === row?.path ? -1 : b === row?.path ? 1 : a.localeCompare(b),
      );
    for (const path of files) {
      const snapshot = await repo.readCommittedFileAt(head, path);
      if (!snapshot) continue;
      let file: ReturnType<typeof parseDocumentFile>;
      try {
        file = parseDocumentFile(snapshot.content, documentKindOfPath(path));
      } catch {
        continue;
      }
      if (file.meta.id !== target.id) continue;
      return {
        path,
        original: snapshot.content,
        revision: snapshot.baseCommitSha,
        appearance: normalizeAppearance(file.meta.appearance),
        compose: (appearance) =>
          composeDocumentFile(
            { ...file.meta, appearance: appearance ?? undefined },
            file.body,
            documentKindOfPath(path),
          ),
      };
    }
    throw new CoreError("NOT_FOUND");
  }
  try {
    assertSafeSegments(target.path);
    if (target.scope === "documents") {
      assertOutsideTablesRoot(target.path);
      if (target.path.length === 0) throw new Error("nameless root");
    }
  } catch {
    throw new CoreError("BAD_REQUEST", "Choose a named content folder", {
      field: "path",
    });
  }
  const rel = target.path.join("/");
  const dirs = await listScopeDirsAt(repo, target.scope, head);
  if (target.path.length > 0 && !dirs.includes(rel))
    throw new CoreError("NOT_FOUND");
  if (
    target.path.length === 0 &&
    !(await repo.listTrackedFiles(head)).some((path) =>
      path.startsWith("tables/"),
    )
  )
    throw new CoreError("NOT_FOUND");
  const path = folderMetadataPath(
    [...(target.scope === "tables" ? ["tables"] : []), ...target.path].join(
      "/",
    ),
  );
  const original = (await repo.readBlobsAt(head, [path])).get(path) ?? null;
  const meta = (original === null ? null : parseFolderMetadata(original)) ?? {
    name: target.path.at(-1) ?? "Tables",
    created: null,
    createdBy: null,
    updated: null,
    updatedBy: null,
  };
  return {
    path,
    original,
    revision: head,
    appearance: normalizeAppearance(meta.appearance),
    compose: (appearance) =>
      composeFolderMetadata({ ...meta, appearance: appearance ?? undefined }),
  };
}

export async function getContentAppearance(
  db: PrismaClient,
  target: AppearanceTarget,
  actor: ProjectActor,
): Promise<{
  appearance: Appearance | null;
  revision: string;
  canEdit: boolean;
}> {
  await assertProjectRole(db, target.projectId, actor, "Viewer");
  const result = await withExistingProjectRepoReader(
    target.projectId,
    async (repo) => {
      const access = await assertProjectRole(
        db,
        target.projectId,
        actor,
        "Viewer",
      );
      const current = await load(db, repo, target, await repo.resolveHead());
      return {
        appearance: current.appearance,
        revision: current.revision,
        canEdit:
          projectRoleAtLeast(access.effectiveRole, "Editor") &&
          hasCapability(actor, "content:write"),
      };
    },
  );
  if (!result) throw new CoreError("NOT_FOUND");
  return result;
}

export async function setContentAppearance(
  db: PrismaClient,
  input: {
    target: AppearanceTarget;
    expectedRevision: string;
    patch: AppearancePatch;
  },
  actor: EnrichedActor,
  image?: { bytes: Uint8Array },
): Promise<{ headCommitSha: string; revision: string }> {
  const { target } = input;
  await assertProjectRole(db, target.projectId, actor, "Editor");
  let changed = false;
  const result = await withProjectRepo(target.projectId, async (repo) => {
    await assertProjectRole(db, target.projectId, actor, "Editor");
    const patch = assertAppearancePatch(input.patch);
    const head = await repo.resolveHead();
    const current = await load(db, repo, target, head);
    if (input.expectedRevision !== current.revision)
      throw new CoreError(
        "CONFLICT",
        "The content changed. Reload and try again.",
        { headCommitSha: current.revision },
      );
    if (image) patch.icon = imageIconFromBytes(image.bytes);
    if (
      patch.icon?.type === "image" &&
      !image &&
      !(await readAppearanceAssetInRepo(repo, patch.icon, current.revision))
    )
      throw new CoreError(
        "BAD_REQUEST",
        "The selected icon is unavailable at this revision",
        { field: "icon" },
      );
    const appearance = applyAppearancePatch(current.appearance, patch);
    const file = current.compose(appearance);
    const assetPath =
      image && patch.icon?.type === "image" ? iconAssetPath(patch.icon) : null;
    const assetExists = assetPath
      ? (await repo.blobShaAt(head, assetPath)) !== null
      : false;
    if (
      assetExists &&
      patch.icon?.type === "image" &&
      !(await readAppearanceAssetInRepo(repo, patch.icon, head))
    )
      throw new CoreError("BAD_REQUEST", "The existing icon asset is invalid", {
        field: "icon",
      });
    if (
      JSON.stringify(appearance) === JSON.stringify(current.appearance) &&
      (!assetPath || assetExists)
    )
      return { headCommitSha: head, revision: current.revision };
    try {
      if (assetPath && !assetExists)
        await repo.writeBinaryFileAtomic(assetPath, image!.bytes);
      await repo.writeFileAtomic(current.path, file);
      const sha = await repo.commitAll(
        `appearance: ${current.path}`,
        author(actor),
      );
      changed = true;
      if (target.kind === "document") {
        try {
          await repairDocumentProjectionInRepo(
            db,
            repo,
            target.projectId,
            target.id,
            current.path,
          );
        } catch (error) {
          await reportProjectionFailureAndReconcile({
            projectId: target.projectId,
            documentId: target.id,
            headCommitSha: sha,
            error,
          });
        }
      } else if (target.kind === "table")
        await repairTableProjectionInRepo(
          db,
          repo,
          target.projectId,
          target.id,
        );
      const committed = await load(db, repo, target, sha);
      return { headCommitSha: sha, revision: committed.revision };
    } catch (error) {
      // A committed mutation remains Git truth even if projection repair fails.
      if ((await repo.resolveHead()) !== head) throw error;
      if (current.original !== null)
        await repo.writeFileAtomic(current.path, current.original);
      await repo.resetWorktreeTo(head);
      if (current.original === null)
        await repo.removeUntrackedFile(current.path);
      if (assetPath && !assetExists) await repo.removeUntrackedFile(assetPath);
      throw error;
    }
  });
  if (changed) void notifyProjectContentChanged(db, target.projectId);
  return result;
}

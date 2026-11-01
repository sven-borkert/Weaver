import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import {
  composeFolderMetadata,
  folderMetadataPath,
  parseFolderMetadata,
} from "../documents/folderMetadata";
import { TABLES_ROOT } from "../tables/paths";
import { authorOf, SYSTEM_AUTHOR } from "./documentHeaderUpgrade";
import { listScopeDirs } from "./folders";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withExistingProjectRepo } from "./projectRepo";

/** Folder metadata format every folder of a current project has: create/update stamps in `.folder.json`. */
export const FOLDER_METADATA_VERSION = 1;
const PROJECTS_PER_PASS = 20;
const FOLDERS_PER_PROJECT = 500;
/** Whole-path history: the oldest entry is the creating commit. */
const HISTORY_LIMIT = 100_000;

/** One system commit per project: folders without create/update stamps get them from Git history. */
export async function upgradeFolderMetadata(
  db: PrismaClient,
): Promise<{ projects: number; folders: number }> {
  const pending = await db.project.findMany({
    where: {
      deletedAt: null,
      folderMetadataVersion: { lt: FOLDER_METADATA_VERSION },
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: PROJECTS_PER_PASS,
  });
  const errors: unknown[] = [];
  let folders = 0;
  for (const { id: projectId } of pending) {
    try {
      const result = await withExistingProjectRepo(projectId, (repo) =>
        upgradeProject(db, repo, projectId),
      );
      folders += result?.changed ?? 0;
      if (!result || result.complete)
        await db.project.update({
          where: { id: projectId },
          data: { folderMetadataVersion: FOLDER_METADATA_VERSION },
        });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "folder metadata upgrade failed for some projects",
    );
  return { projects: pending.length, folders };
}

async function upgradeProject(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
): Promise<{ changed: number; complete: boolean }> {
  const dirs = [
    ...(await listScopeDirs(repo, "documents")),
    ...(await listScopeDirs(repo, "tables")).map(
      (dir) => `${TABLES_ROOT}/${dir}`,
    ),
  ].sort();
  let changed = 0;
  let complete = true;
  for (const dir of dirs) {
    if (changed >= FOLDERS_PER_PROJECT) {
      complete = false;
      break;
    }
    const metadataRel = folderMetadataPath(dir);
    const existing = (await repo.fileExistsInWorktree(metadataRel))
      ? parseFolderMetadata(await repo.readFileFromWorktree(metadataRel))
      : null;
    if (
      existing?.created &&
      existing.createdBy &&
      existing.updated &&
      existing.updatedBy
    )
      continue;
    // The folder's own marker files describe the folder; its content history is the fallback.
    let history: Awaited<ReturnType<typeof repo.logForPath>> = [];
    for (const path of [metadataRel, `${dir}/.gitkeep`, dir]) {
      history = await repo.logForPath(path, { skip: 0, limit: HISTORY_LIMIT });
      if (history.length) break;
    }
    const newest = history[0];
    const oldest = history.at(-1);
    if (!newest || !oldest) continue;
    await repo.writeFileAtomic(
      metadataRel,
      composeFolderMetadata({
        ...existing,
        name: existing?.name ?? dir.split("/").at(-1)!,
        created: existing?.created ?? oldest.date.toISOString(),
        createdBy: existing?.createdBy ?? (await authorOf(db, oldest)),
        updated: existing?.updated ?? newest.date.toISOString(),
        updatedBy: existing?.updatedBy ?? (await authorOf(db, newest)),
      }),
    );
    changed += 1;
  }
  if (!changed) return { changed, complete };
  await repo.commitAll("chore: add folder metadata", SYSTEM_AUTHOR);
  void notifyProjectContentChanged(db, projectId);
  return { changed, complete };
}

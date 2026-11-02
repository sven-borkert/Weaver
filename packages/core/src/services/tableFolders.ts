import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import type { PrismaClient } from "@weaver/db/client";
import { machineEditorFromRow } from "./contentAuthor";
import * as folders from "./folders";
import { withExistingProjectRepoReader } from "./projectRepo";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import { reconcileTableTreeAtHead } from "./tables";

type Actor = ProjectActor & { name?: string | null; email?: string };

export async function getTree(
  db: PrismaClient,
  input: { projectId: string },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const tree = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const head = await repo.resolveHead();
      const folderPaths = await folders.listScopeDirsAt(repo, "tables", head);
      const presented = await folders.presentFolderTree(
        db,
        repo,
        "tables",
        head,
        folderPaths,
      );
      const tables = await reconcileTableTreeAtHead(
        db,
        repo,
        input.projectId,
        head,
      );
      return { folders: folderPaths, ...presented, tables };
    },
  );
  if (tree) return tree;
  const fallbackRows = await db.dataTable.findMany({
    where: { projectId: input.projectId },
    select: {
      id: true,
      title: true,
      slug: true,
      path: true,
      rowCount: true,
      appearance: true,
      lastEditedAt: true,
      lastEditedBy: { select: { id: true, name: true, email: true } },
      lastEditedByMachineKind: true,
      lastEditedByMachineId: true,
      lastEditedByName: true,
    },
    orderBy: { path: "asc" },
  });
  return {
    folders: [],
    folderAppearances: {} as Record<string, Appearance>,
    folderNames: {} as Record<string, string>,
    folderStamps: {} as Record<string, folders.FolderStamps>,
    tables: fallbackRows.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      path: row.path,
      rowCount: row.rowCount,
      lastEditedAt: row.lastEditedAt,
      appearance: normalizeAppearance(row.appearance),
      lastEditedBy: row.lastEditedBy
        ? { ...row.lastEditedBy, name: row.lastEditedBy.name ?? "" }
        : null,
      machineEditor: machineEditorFromRow(row),
    })),
  };
}

export function createFolder(
  db: PrismaClient,
  input: { projectId: string; parentPath: string[]; name: string },
  actor: Actor,
) {
  return folders.createFolder(db, input, actor, "tables");
}

export function renameFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[]; name: string },
  actor: Actor,
) {
  return folders.renameFolder(db, input, actor, "tables");
}

export function moveFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[]; newParentPath: string[] },
  actor: Actor,
) {
  return folders.moveFolder(db, input, actor, "tables");
}

export function deleteFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[] },
  actor: Actor,
) {
  return folders.deleteFolder(db, input, actor, "tables");
}

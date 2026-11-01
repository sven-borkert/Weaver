import type { PrismaClient, Prisma } from "@weaver/db/client";
import type { ProjectRepoReader } from "@weaver/git-store";
import { CoreError } from "../errors";
import { requireLiveProjectMachineKey } from "../security/projectMachine";
import {
  loadFolderIdentityIndex,
  type FolderIdentityIndex,
} from "./folderIdentity";
import {
  readMachineDocumentSnapshot,
  readMachineTableSnapshot,
} from "./snapshots";
import type {
  FolderRef,
  MachineAction,
  ProjectMachineContext,
  StoredGrant,
} from "./types";

export type MachinePolicy = {
  context: ProjectMachineContext;
  grants: StoredGrant[];
  expiresAt: Date | null;
};
export type MachineTargetRef =
  | { kind: "document" | "table"; id: string }
  | { kind: "documentFolder" | "tableFolder"; folder: FolderRef };
export type ResolvedMachineTarget = {
  kind: MachineTargetRef["kind"];
  id: string | null;
  path: string[];
  root: boolean;
  ancestors: string[];
  revision?: string;
  resourcePath?: string;
};
export const folderContains = (
  parent: readonly string[],
  child: readonly string[],
) =>
  parent.length <= child.length &&
  parent.every((segment, i) => child[i] === segment);

export async function loadMachinePolicy(
  db: PrismaClient | Prisma.TransactionClient,
  context: ProjectMachineContext,
  lockKey = false,
): Promise<MachinePolicy> {
  if (typeof (db as PrismaClient).$transaction === "function")
    return (db as PrismaClient).$transaction((tx) =>
      readMachinePolicy(tx, context, lockKey),
    );
  return readMachinePolicy(db, context, lockKey);
}
async function readMachinePolicy(
  db: PrismaClient | Prisma.TransactionClient,
  context: ProjectMachineContext,
  lockKey: boolean,
): Promise<MachinePolicy> {
  if (lockKey)
    await db.$queryRaw`SELECT id FROM "ProjectApiKey" WHERE id = ${context.keyId}::uuid AND "projectId" = ${context.projectId}::uuid FOR UPDATE`;
  const key = await requireLiveProjectMachineKey(
    db,
    context.keyId,
    context.projectId,
  );
  const grants = await db.projectApiKeyGrant.findMany({
    where: { keyId: key.id },
  });
  return {
    context: { ...context, name: key.name, policyVersion: key.policyVersion },
    expiresAt: key.expiresAt,
    grants: grants.map((g) => ({
      kind: g.targetKind,
      targetId: g.targetId,
      root: g.isScopeRoot,
      actions: (["read", "create", "update", "delete"] as const).filter(
        (a) =>
          g[
            (
              {
                read: "canRead",
                create: "canCreate",
                update: "canUpdate",
                delete: "canDelete",
              } as const
            )[a]
          ],
      ),
    })),
  };
}

export function matchingMachineGrants(
  policy: MachinePolicy,
  target: ResolvedMachineTarget,
) {
  const folderKind = target.kind.startsWith("document")
    ? "documentFolder"
    : "tableFolder";
  return policy.grants.filter(
    (g) =>
      (g.kind === target.kind &&
        !g.root &&
        g.targetId === target.id &&
        target.id !== null) ||
      (g.kind === folderKind &&
        (g.root ||
          (g.targetId !== null && target.ancestors.includes(g.targetId)))),
  );
}
export function assertMachineActions(
  policy: MachinePolicy,
  target: ResolvedMachineTarget,
  actions: readonly MachineAction[],
) {
  const grants = matchingMachineGrants(policy, target);
  if (!grants.length) throw new CoreError("NOT_FOUND");
  if (!actions.every((a) => grants.some((g) => g.actions.includes(a))))
    throw new CoreError("FORBIDDEN");
}

/** Authorization view of an indexed resource at a captured HEAD, without reading its content. */
export function indexedMachineTarget(
  kind: "document" | "table",
  id: string,
  resourcePath: string,
  folders: FolderIdentityIndex,
): ResolvedMachineTarget {
  const path = resourcePath.split("/");
  if (kind === "table") path.shift();
  path.pop();
  return {
    kind,
    id,
    path,
    root: false,
    resourcePath,
    ancestors: folders.entries
      .filter((e) => folderContains(e.path, path))
      .map((e) => e.id),
  };
}

export async function resolveMachineTargetInRepo(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoReader,
  context: ProjectMachineContext,
  target: MachineTargetRef,
): Promise<ResolvedMachineTarget> {
  const scope = target.kind.startsWith("document") ? "documents" : "tables";
  const head = await repo.resolveHead();
  const folders = await loadFolderIdentityIndex(
    repo,
    context.projectId,
    scope,
    head,
  );
  let path: string[];
  let id: string | null;
  let revision: string | undefined;
  let resourcePath: string | undefined;
  if ("folder" in target) {
    id = "id" in target.folder ? target.folder.id : null;
    path = id
      ? (folders.byId.get(id)?.path ??
        (() => {
          throw new CoreError("NOT_FOUND");
        })())
      : [];
  } else {
    const snapshot =
      target.kind === "document"
        ? await readMachineDocumentSnapshot(
            db,
            repo,
            context.projectId,
            target.id,
          )
        : await readMachineTableSnapshot(
            db,
            repo,
            context.projectId,
            target.id,
          );
    path = snapshot.path.split("/");
    resourcePath = snapshot.path;
    if (scope === "tables") path.shift();
    path.pop();
    id = snapshot.id;
    revision = snapshot.revision;
  }
  return {
    kind: target.kind,
    id,
    path,
    root: id === null,
    revision,
    resourcePath,
    ancestors: folders.entries
      .filter((e) => folderContains(e.path, path))
      .map((e) => e.id),
  };
}

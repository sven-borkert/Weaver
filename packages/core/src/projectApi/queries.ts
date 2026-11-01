import type { PrismaClient } from "@weaver/db/client";
import { CoreError } from "../errors";
import { withExistingProjectRepoReader } from "../services/projectRepo";
import type { ProjectMachineContext } from "./types";
import { loadFolderIdentityIndex } from "./folderIdentity";
import {
  indexedMachineTarget,
  loadMachinePolicy,
  resolveMachineTargetInRepo,
  assertMachineActions,
  matchingMachineGrants,
} from "./policy";
import {
  readMachineDocumentSnapshot,
  readMachineTableSnapshot,
  resourceIdentityIndex,
} from "./snapshots";
import { encodeMachineCursor, decodeMachineCursor } from "./cursors";

export type MachineQuery =
  | { kind: "grants" }
  | { kind: "documents" | "tables"; limit: number; cursor?: string }
  | {
      kind: "document.get" | "document.head" | "table.get" | "table.head";
      id: string;
    }
  | { kind: "table.rows"; id: string; limit: number; cursor?: string };
export type MachineQueryResult = {
  revision?: string;
  items?: Record<string, unknown>[];
  nextCursor?: string | null;
  [key: string]: unknown;
};
export async function queryProjectMachineContent(
  db: PrismaClient,
  context: ProjectMachineContext,
  query: MachineQuery,
): Promise<MachineQueryResult> {
  const result = await withExistingProjectRepoReader(
    context.projectId,
    async (repo) => {
      const policy = await loadMachinePolicy(db, context);
      const head = await repo.resolveHead();
      if (query.kind === "grants") {
        const grants = await Promise.all(
          policy.grants.map(async (g) => {
            try {
              const target = g.kind.endsWith("Folder")
                ? {
                    kind: g.kind as "documentFolder" | "tableFolder",
                    folder: g.root
                      ? { root: true as const }
                      : { id: g.targetId! },
                  }
                : { kind: g.kind as "document" | "table", id: g.targetId! };
              const resolved = await resolveMachineTargetInRepo(
                db,
                repo,
                context,
                target,
              );
              return {
                ...g,
                available: true,
                path:
                  resolved.resourcePath ??
                  [g.kind === "tableFolder" ? "tables" : "", ...resolved.path]
                    .filter(Boolean)
                    .join("/"),
                revision: resolved.revision,
              };
            } catch {
              return { ...g, available: false };
            }
          }),
        );
        return { grants };
      }
      if ("id" in query) {
        const kind = query.kind.startsWith("document") ? "document" : "table";
        const target = await resolveMachineTargetInRepo(db, repo, context, {
          kind,
          id: query.id,
        });
        if (query.kind.endsWith("head")) {
          if (!matchingMachineGrants(policy, target).length)
            throw new CoreError("NOT_FOUND");
          if (
            !matchingMachineGrants(policy, target).some((g) =>
              g.actions.some((a) => a !== "create" || kind === "table"),
            )
          )
            throw new CoreError("FORBIDDEN");
          return { revision: target.revision };
        }
        assertMachineActions(policy, target, ["read"]);
        if (kind === "document") {
          const s = await readMachineDocumentSnapshot(
            db,
            repo,
            context.projectId,
            query.id,
          );
          return {
            id: s.id,
            path: s.path,
            title: s.title,
            revision: s.revision,
            markdown: s.markdown,
          };
        }
        const s = await readMachineTableSnapshot(
          db,
          repo,
          context.projectId,
          query.id,
        );
        if (query.kind === "table.rows") {
          const binding = JSON.stringify([
            context.keyId,
            policy.context.policyVersion,
            head,
            query.kind,
            query.id,
            query.limit,
          ]);
          const after = query.cursor
            ? decodeMachineCursor(query.cursor, binding)
            : "";
          const rows = s.rows
            .filter((r) => r.id > after)
            .sort((a, b) => a.id.localeCompare(b.id));
          const page = rows.slice(0, query.limit);
          return {
            revision: s.revision,
            items: page,
            nextCursor:
              rows.length > page.length
                ? encodeMachineCursor(binding, page.at(-1)!.id)
                : null,
          };
        }
        return {
          id: s.id,
          path: s.path,
          title: s.title,
          revision: s.revision,
          columns: s.columns,
          rows: s.rows,
        };
      }
      const kind = query.kind === "documents" ? "document" : "table";
      const binding = JSON.stringify([
        context.keyId,
        policy.context.policyVersion,
        head,
        query.kind,
        query.limit,
      ]);
      const after = query.cursor
        ? decodeMachineCursor(query.cursor, binding)
        : "";
      const identities = await resourceIdentityIndex(
        repo,
        context.projectId,
        kind,
        head,
      );
      const folders = await loadFolderIdentityIndex(
        repo,
        context.projectId,
        kind === "document" ? "documents" : "tables",
        head,
      );
      // Authorize from committed paths first; only page items are read.
      const readable = [...identities]
        .filter(([id]) => id > after)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .filter(([id, path]) =>
          matchingMachineGrants(
            policy,
            indexedMachineTarget(kind, id, path, folders),
          ).some((g) => g.actions.includes("read")),
        )
        .map(([id]) => id);
      const items: Record<string, unknown>[] = [];
      let consumed = 0;
      for (const id of readable) {
        if (items.length === query.limit) break;
        consumed += 1;
        try {
          const s =
            kind === "document"
              ? await readMachineDocumentSnapshot(
                  db,
                  repo,
                  context.projectId,
                  id,
                )
              : await readMachineTableSnapshot(db, repo, context.projectId, id);
          items.push({
            id,
            path: s.path,
            title: s.title,
            revision: s.revision,
          });
        } catch (error) {
          if (!(error instanceof CoreError) || error.code !== "NOT_FOUND")
            throw error;
        }
      }
      return {
        items,
        nextCursor:
          consumed < readable.length && items.length > 0
            ? encodeMachineCursor(binding, String(items.at(-1)!.id))
            : null,
      };
    },
  );
  if (result === null) {
    const policy = await loadMachinePolicy(db, context);
    if (query.kind === "documents" || query.kind === "tables")
      return { items: [], nextCursor: null };
    if (query.kind === "grants")
      return {
        grants: policy.grants.map((g) => ({
          ...g,
          available: g.root,
          ...(g.root ? { path: g.kind === "tableFolder" ? "tables" : "" } : {}),
        })),
      };
    throw new CoreError("NOT_FOUND");
  }
  return result;
}

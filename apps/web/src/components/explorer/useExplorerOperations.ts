"use client";

import { api } from "~/trpc/react";
import type { ExplorerEntry, ExplorerItem } from "~/lib/explorer/entries";
import { entryKey } from "~/lib/explorer/selection";
import { invalidateDocumentCachesAfterRebuild } from "~/lib/documents/document-cache-invalidation";
import { invalidateFolderReview } from "~/lib/documents/review-cache-invalidation";
import { invalidateTableCaches } from "~/lib/tables/table-cache-invalidation";

export type BulkAction = "move" | "delete" | "review";
export type PreparedSelection = {
  keys: Set<string>;
  revisions: Record<string, string>;
};
export type ExplorerOperations = {
  prepare: (
    action: BulkAction,
    entries: ExplorerEntry<ExplorerItem>[],
  ) => Promise<PreparedSelection>;
  run: (
    action: BulkAction,
    entry: ExplorerEntry<ExplorerItem>,
    target: string[],
    revisions: Record<string, string>,
  ) => Promise<void>;
  refresh: () => Promise<void>;
};

export function useExplorerOperations(
  projectId: string,
  kind: "documents" | "tables",
): ExplorerOperations {
  const utils = api.useUtils();
  const client = utils.client;
  return {
    prepare: async (action, entries) => {
      const prepared: PreparedSelection = { keys: new Set(), revisions: {} };
      for (const entry of entries) {
        const key = entryKey(entry);
        if (action === "review") {
          if (kind !== "documents" || entry.kind !== "item") continue;
          const input = { projectId, documentId: entry.id };
          const permissions =
            await client.document.reviewPermissions.query(input);
          if (!permissions.canMarkReviewed) continue;
          const snapshot = await client.document.get.query(input);
          prepared.revisions[key] = snapshot.baseCommitSha;
        } else if (
          action === "delete" &&
          kind === "tables" &&
          entry.kind === "item"
        ) {
          const snapshot = await client.table.get.query({
            projectId,
            tableId: entry.id,
          });
          prepared.revisions[key] = snapshot.baseCommitSha;
        }
        prepared.keys.add(key);
      }
      return prepared;
    },
    run: async (action, entry, target, revisions) => {
      if (action === "review") {
        if (
          kind !== "documents" ||
          entry.kind !== "item" ||
          !revisions[entryKey(entry)]
        )
          throw new Error("Review preview required");
        await client.document.markReviewed.mutate({
          projectId,
          documentId: entry.id,
          expectedHeadCommitSha: revisions[entryKey(entry)]!,
        });
      } else if (entry.kind === "folder") {
        const router =
          kind === "documents" ? client.folder : client.tableFolder;
        if (action === "move")
          await router.move.mutate({
            projectId,
            path: entry.path,
            newParentPath: target,
          });
        else await router.delete.mutate({ projectId, path: entry.path });
      } else if (kind === "documents") {
        const input = { projectId, documentId: entry.id };
        if (action === "move")
          await client.document.move.mutate({ ...input, folderPath: target });
        else await client.document.delete.mutate(input);
      } else {
        const input = { projectId, tableId: entry.id };
        if (action === "move")
          await client.table.move.mutate({ ...input, folderPath: target });
        else {
          const revision = revisions[entryKey(entry)];
          if (!revision) throw new Error("Deletion preview required");
          await client.table.delete.mutate({
            ...input,
            expectedHeadCommitSha: revision,
          });
        }
      }
    },
    refresh: async () => {
      if (kind === "tables") await invalidateTableCaches(utils, projectId);
      else
        await Promise.all([
          invalidateDocumentCachesAfterRebuild(utils, projectId),
          invalidateFolderReview(utils, projectId),
        ]);
    },
  };
}

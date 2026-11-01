import { CoreError } from "@weaver/core/errors";
import type { ChangeSummaryView } from "@weaver/core/documents/changeSummaryMessage";
import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import { getDiff, getHistory } from "@weaver/core/services/documents";
import { getTableDiff, getTableHistory } from "@weaver/core/services/tables";
import { z } from "zod";
import {
  boundItems,
  defineTool,
  newPageBudget,
  requireScope,
  type ToolOutcome,
} from "../contract";

type VersionEntry = {
  sha: string;
  message: string;
  date: Date;
  authorName: string;
  userName: string | null;
  changeSummary: ChangeSummaryView | null;
};

type ContentHistoryOutput =
  | { entries: VersionEntry[]; hasMore: boolean }
  | Awaited<ReturnType<typeof getDiff>>
  | Awaited<ReturnType<typeof getTableDiff>>
  | Awaited<ReturnType<typeof listDeletedContent>>;

export const contentHistoryTool = defineTool({
  name: "content_history",
  kind: "read",
  capability: "content:read",
  description:
    "Read a resource's history at a pinned revision. mode=versions lists commits for one document or table; mode=diff compares two of its revisions; mode=deleted lists recoverable deleted documents and tables across the project. Pass the sourceSha and deletedAtSha from a deleted item to restore_content.",
  inputSchema: z.object({
    projectId: z.uuid(),
    mode: z.enum(["versions", "diff", "deleted"]),
    resourceType: z.enum(["document", "table"]).optional(),
    resourceId: z.uuid().optional(),
    fromSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    toSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    cursor: z.string().max(2_000).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  async execute(input, ctx): Promise<ToolOutcome<ContentHistoryOutput>> {
    requireScope(ctx, input.projectId);
    // execute() can be invoked directly (bypassing the schema's zod
    // .default()s, e.g. in tests), so default offset/limit here too.
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;

    if (input.mode === "deleted") {
      if (input.resourceId !== undefined)
        throw new CoreError(
          "BAD_REQUEST",
          "mode=deleted is project-wide and does not accept resourceId",
        );
      const request = {
        projectId: input.projectId,
        cursor: input.cursor,
      };
      const result = await listDeletedContent(
        ctx.db,
        { ...request, limit },
        ctx.actor,
      );
      const { items } = boundItems(result.items, newPageBudget());
      // The service's cursor already sits past everything it scanned, so a
      // dropped item would be unreachable. Re-cut the page at what fits and
      // let the service issue the cursor for it (slice 1's convention, see
      // tableReads.ts). One item always goes out, so paging always advances.
      const page =
        items.length === result.items.length
          ? result
          : await listDeletedContent(
              ctx.db,
              { ...request, limit: Math.max(1, items.length) },
              ctx.actor,
            );
      return {
        output: {
          items: page.items,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          snapshotCommitSha: page.snapshotCommitSha,
        },
      };
    }

    if (!input.resourceType || !input.resourceId)
      throw new CoreError(
        "BAD_REQUEST",
        `mode=${input.mode} requires resourceType and resourceId`,
      );

    if (input.mode === "diff") {
      if (!input.fromSha || !input.toSha)
        throw new CoreError(
          "BAD_REQUEST",
          "mode=diff requires fromSha and toSha",
        );
      const result =
        input.resourceType === "document"
          ? await getDiff(
              ctx.db,
              {
                projectId: input.projectId,
                documentId: input.resourceId,
                fromSha: input.fromSha,
                toSha: input.toSha,
              },
              ctx.actor,
            )
          : await getTableDiff(
              ctx.db,
              {
                projectId: input.projectId,
                tableId: input.resourceId,
                fromSha: input.fromSha,
                toSha: input.toSha,
              },
              ctx.actor,
            );
      // The service's own tooLarge/complete shape is returned as-is — an
      // incomplete comparison must never be presented as a complete one.
      return { output: result };
    }

    const result =
      input.resourceType === "document"
        ? await getHistory(
            ctx.db,
            {
              projectId: input.projectId,
              documentId: input.resourceId,
              offset,
              limit,
            },
            ctx.actor,
          )
        : await getTableHistory(
            ctx.db,
            {
              projectId: input.projectId,
              tableId: input.resourceId,
              offset,
              limit,
            },
            ctx.actor,
          );
    const mapped: VersionEntry[] = result.entries.map((entry) => ({
      sha: entry.sha,
      message: entry.message,
      date: entry.date,
      authorName: entry.authorName,
      userName: entry.userName,
      changeSummary: "changeSummary" in entry ? entry.changeSummary : null,
    }));
    const { items: entries, truncated } = boundItems(mapped, newPageBudget());
    return {
      output: {
        entries,
        hasMore: result.hasMore || truncated,
      },
    };
  },
});

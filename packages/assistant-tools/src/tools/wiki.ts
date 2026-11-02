import {
  findPages,
  inspectLinks,
  listRecentChanges,
} from "@weaver/core/services/wikiReads";
import { z } from "zod";
import {
  boundItems,
  defineSharedReadTool,
  newPageBudget,
  requireScope,
  type ToolOutcome,
} from "../contract";

const cursor = z.string().max(200).optional();

export const findPageTool = defineSharedReadTool({
  name: "find_page",
  kind: "read",
  capability: "content:read",
  description:
    "Find documents by exact title, slug or path. Each hit has id, path, type, summary and a paste-ready link; paste the link verbatim ([Title](weaver://document/<id>)) to cross-reference a page. Imported source pages are left out unless includeSources is true.",
  inputSchema: z.object({
    projectId: z.uuid(),
    title: z.string().min(1).max(300).optional(),
    slug: z.string().min(1).max(300).optional(),
    path: z.string().min(1).max(1_000).optional(),
    includeSources: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const result = await findPages(ctx.db, input, ctx.actor);
    const { items, truncated } = boundItems(result.pages, newPageBudget());
    return {
      output: { pages: items, truncated: truncated || result.truncated },
    };
  },
});

export const inspectLinksTool = defineSharedReadTool({
  name: "inspect_links",
  kind: "read",
  capability: "content:read",
  description:
    "Check the link structure of a project's pages. mode=orphans lists pages nothing links to; mode=dangling lists links whose target no longer exists; mode=backlinks (needs documentId) lists the pages linking to one page. Continue with nextCursor.",
  inputSchema: z.object({
    projectId: z.uuid(),
    mode: z.enum(["orphans", "dangling", "backlinks"]),
    documentId: z.uuid().optional(),
    cursor,
  }),
  async execute(input, ctx): Promise<ToolOutcome<Record<string, unknown>>> {
    requireScope(ctx, input.projectId);
    const result = await inspectLinks(ctx.db, input, ctx.actor);
    const budget = newPageBudget();
    if (result.mode === "dangling") {
      const { items, truncated } = boundItems(result.links, budget);
      const last = items.at(-1);
      return {
        output: {
          mode: result.mode,
          links: items,
          nextCursor: truncated
            ? last
              ? `${last.from.id}:${last.targetType}:${last.targetId}`
              : result.nextCursor
            : result.nextCursor,
        },
      };
    }
    const { items, truncated } = boundItems(result.pages, budget);
    return {
      output: {
        mode: result.mode,
        pages: items,
        // Both orders resume after the last returned page id.
        nextCursor:
          truncated && items.length > 0 ? items.at(-1)!.id : result.nextCursor,
      },
    };
  },
});

export const listRecentChangesTool = defineSharedReadTool({
  name: "list_recent_changes",
  kind: "read",
  capability: "content:read",
  description:
    "The project's commit feed, newest first. kind says where a change came from (ui, mcp, proposal, task-run, ingestion, project-api, exam, wiki-run, wiki-bootstrap, wiki-input, wiki-revert); commits Weaver cannot vouch for are external and carry no author or subject (null). since is an ISO time. Continue with nextCursor.",
  inputSchema: z.object({
    projectId: z.uuid(),
    since: z.iso.datetime().optional(),
    cursor,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const result = await listRecentChanges(
      ctx.db,
      {
        projectId: input.projectId,
        ...(input.since === undefined ? {} : { since: new Date(input.since) }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      ctx.actor,
    );
    const { items, truncated } = boundItems(result.changes, newPageBudget());
    return {
      output: {
        changes: items,
        nextCursor:
          truncated && items.length > 0 && items.length < result.changes.length
            ? result.changes[items.length]!.sha
            : result.nextCursor,
      },
    };
  },
});

export const WIKI_READ_TOOLS = [
  findPageTool,
  inspectLinksTool,
  listRecentChangesTool,
] as const;

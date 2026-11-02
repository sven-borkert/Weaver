import { z } from "zod";
import { aggregateTableTool } from "./tools/aggregate";
import { listDocumentsTool, readDocumentTool } from "./tools/documents";
import { listContentFoldersTool } from "./tools/folders";
import {
  entityDetailTool,
  entityNeighborhoodTool,
  searchEntitiesTool,
} from "./tools/graph";
import { contentHistoryTool } from "./tools/history";
import { navigateDocumentTool } from "./tools/navigate";
import { searchKnowledgeTool } from "./tools/search";
import { listTableColumnsTool, readTableCellTool } from "./tools/tableReads";
import { getTableTool, queryTableRowsTool } from "./tools/tables";
import {
  findPageTool,
  inspectLinksTool,
  listRecentChangesTool,
} from "./tools/wiki";
import {
  completeInputTool,
  finishRunTool,
  listInputsTool,
  readInputTool,
  runScopedRead,
  suggestGuideChangeTool,
  wikiCreateFolderTool,
  wikiCreatePageTool,
  wikiNoteTool,
  wikiPatchPageTool,
  type WikiAgentTool,
  type WikiAgentToolContext,
} from "./tools/wikiAgent";

export { wikiAgentToolContext } from "./tools/wikiAgent";
export type { WikiAgentTool, WikiAgentToolContext } from "./tools/wikiAgent";

export const WIKI_AGENT_LOADABLE_TOOLS: readonly WikiAgentTool[] = [
  runScopedRead(
    getTableTool,
    "A table's title, counts, column summary and up to 5 sample rows at one snapshot.",
  ),
  runScopedRead(
    queryTableRowsTool,
    "Page through a table's rows with typed filters and sort at one snapshot.",
  ),
  runScopedRead(
    listTableColumnsTool,
    "A table's columns with their types, paged.",
  ),
  runScopedRead(readTableCellTool, "One cell's whole value, for long cells."),
  runScopedRead(
    aggregateTableTool,
    "count, countNonEmpty, sum, avg, min, max and distinctCount over a table's rows, optionally grouped.",
  ),
  runScopedRead(
    entityNeighborhoodTool,
    "Relations around one knowledge-graph entity.",
  ),
  runScopedRead(
    listRecentChangesTool,
    "The project's commit feed, newest first. kind says where a change came from; commits Weaver cannot vouch for are external, with no author or subject.",
  ),
  runScopedRead(
    contentHistoryTool,
    "Commit metadata for one document or table (mode=versions only).",
  ),
];

const loadableNames = WIKI_AGENT_LOADABLE_TOOLS.map((tool) => tool.name) as [
  string,
  ...string[],
];

export function wikiToolDefinitionBytes(tool: WikiAgentTool): number {
  return Buffer.byteLength(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    }),
    "utf8",
  );
}

export const loadToolsTool: WikiAgentTool = {
  name: "load_tools",
  description: `Make more read tools callable from your next step: ${loadableNames.join(", ")}.`,
  kind: "read",
  capability: "content:read",
  inputSchema: z.strictObject({
    names: z.array(z.enum(loadableNames)).min(1).max(loadableNames.length),
  }),
  async execute(input, ctx: WikiAgentToolContext) {
    const { names } = input as { names: string[] };
    const { loadedTools, schemaReserveBytes } = ctx.wiki;
    const sizeOf = (name: string) => {
      const tool = WIKI_AGENT_LOADABLE_TOOLS.find((t) => t.name === name);
      return tool ? wikiToolDefinitionBytes(tool) : 0;
    };
    let used = [...loadedTools].reduce((sum, name) => sum + sizeOf(name), 0);
    const loaded: string[] = [];
    const refused: string[] = [];
    for (const name of names) {
      if (loadedTools.has(name)) {
        loaded.push(name);
        continue;
      }
      if (used + sizeOf(name) > schemaReserveBytes) {
        refused.push(name);
        continue;
      }
      used += sizeOf(name);
      loadedTools.add(name);
      loaded.push(name);
    }
    return { output: { loaded, refused } };
  },
};

export const WIKI_AGENT_TOOLS: readonly WikiAgentTool[] = [
  wikiCreatePageTool,
  wikiPatchPageTool,
  wikiCreateFolderTool,
  listInputsTool,
  readInputTool,
  completeInputTool,
  suggestGuideChangeTool,
  wikiNoteTool,
  finishRunTool,
  runScopedRead(
    findPageTool,
    "Find pages by exact title, slug or path. Each hit has id, path, type, summary and a link to paste. Source pages only with includeSources.",
  ),
  runScopedRead(
    inspectLinksTool,
    "mode=orphans lists pages nothing links to; mode=dangling lists links to missing targets; mode=backlinks (needs documentId) lists pages linking to one page. Continue with nextCursor.",
  ),
  runScopedRead(
    listDocumentsTool,
    "List documents (paged; folder, title, type and tag filters; includeSummary adds summaries).",
  ),
  runScopedRead(
    readDocumentTool,
    "Read one window of a document at one snapshot. Returns baseCommitSha for wiki_patch_page, totalChars and nextCursor for the next window. Use maxChars 8000 for long sources.",
  ),
  runScopedRead(
    navigateDocumentTool,
    "mode=outline lists headings with section ids; mode=section reads one section (with its heading line); mode=find locates literal text. Section ids hold only for the returned revision.",
  ),
  runScopedRead(listContentFoldersTool, "List the project's folders."),
  runScopedRead(
    searchKnowledgeTool,
    "Keyword and semantic search across documents, tables and graph entities.",
  ),
  runScopedRead(
    searchEntitiesTool,
    "Find knowledge-graph entities by name or alias.",
  ),
  runScopedRead(
    entityDetailTool,
    "One entity with its mentions and provenance.",
  ),
  loadToolsTool,
];

export const WIKI_AGENT_DISPATCH: readonly WikiAgentTool[] = [
  ...WIKI_AGENT_TOOLS,
  ...WIKI_AGENT_LOADABLE_TOOLS,
];

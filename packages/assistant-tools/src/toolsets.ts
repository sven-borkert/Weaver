import {
  hasCapability,
  type SecurityContext,
} from "@weaver/core/security/context";
import type { AnyToolContract } from "./contract";
import {
  ADMIN_TOOLS,
  EXAM_TOOLS,
  WIKI_TOOLS,
  CONNECTION_TOOLS,
  MCP_TOOLS,
  WRITE_TOOLS,
} from "./registry";
import { MCP_TOOLSET_NAMES, type McpToolsetName } from "./toolsetNames";

type MemberToolset = Exclude<McpToolsetName, "external" | "all">;

// Lists follow MCP_TOOLS registry order so selection and membership agree.
export const MCP_TOOLSET_MEMBERS: Readonly<
  Record<MemberToolset, readonly string[]>
> = {
  core: [
    "list_projects",
    "list_documents",
    "read_document",
    "navigate_document",
    "list_content_folders",
    "list_tables",
    "query_table_rows",
    "search_artifacts",
    "get_artifact_overview",
    "search_knowledge",
    "search_entities",
    "entity_detail",
    "create_document",
    "patch_document",
  ],
  documents: [
    "list_documents",
    "read_document",
    "navigate_document",
    "content_history",
    "list_content_folders",
    "resolve_citation",
  ],
  tables: [
    "list_tables",
    "get_table",
    "query_table_rows",
    "list_table_columns",
    "list_table_column_options",
    "read_table_cell",
    "aggregate_table",
  ],
  files: [
    "search_artifacts",
    "get_artifact_overview",
    "search_artifact_text",
    "query_json_artifact",
    "read_text_artifact",
    "read_csv_artifact",
    "inspect_structured_artifact",
    "read_pdf_pages",
    "read_word_chapter",
    "read_word_blocks",
    "find_word_tables",
    "read_word_table",
    "read_excel_sheet",
    "read_onenote",
  ],
  graph: [
    "search_knowledge",
    "search_entities",
    "entity_neighborhood",
    "entity_detail",
  ],
  write: WRITE_TOOLS.map((tool) => tool.name),
  exams: EXAM_TOOLS.map((tool) => tool.name),
  wiki: WIKI_TOOLS.map((tool) => tool.name),
  connections: CONNECTION_TOOLS.map((tool) => tool.name),
  admin: ADMIN_TOOLS.map((tool) => tool.name),
};

export const CORE_TOOL_NAMES: readonly string[] = MCP_TOOLSET_MEMBERS.core;

export type McpToolSelection = {
  tools: AnyToolContract[];
  active: McpToolsetName[];
  external: boolean;
};

export function selectMcpTools(
  actor: SecurityContext,
  active: readonly McpToolsetName[],
): McpToolSelection {
  const names = new Set<string>();
  for (const toolset of Object.keys(MCP_TOOLSET_MEMBERS) as MemberToolset[]) {
    if (active.includes(toolset)) {
      for (const name of MCP_TOOLSET_MEMBERS[toolset]) names.add(name);
    }
  }
  return {
    tools: MCP_TOOLS.filter(
      (tool) => names.has(tool.name) && hasCapability(actor, tool.capability),
    ),
    active: [...active],
    external: active.includes("external"),
  };
}

export function toolsetsOf(name: string): McpToolsetName[] {
  return MCP_TOOLSET_NAMES.filter(
    (toolset): toolset is MemberToolset =>
      toolset !== "all" &&
      toolset !== "external" &&
      MCP_TOOLSET_MEMBERS[toolset].includes(name),
  );
}

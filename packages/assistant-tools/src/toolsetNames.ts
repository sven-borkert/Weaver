export const MCP_TOOLSET_NAMES = [
  "core",
  "documents",
  "tables",
  "files",
  "graph",
  "write",
  "exams",
  "wiki",
  "connections",
  "admin",
  "external",
  "all",
] as const;

export type McpToolsetName = (typeof MCP_TOOLSET_NAMES)[number];

export const MCP_TOOLSET_SUMMARIES: Readonly<Record<McpToolsetName, string>> = {
  core: "Find and read documents, tables, files and graph entities; create and patch documents. Always included.",
  documents: "Document history, diffs, deleted items and citation checks.",
  tables: "Table details, columns, options, cells and aggregates.",
  files:
    "Read inside uploaded Word, Excel, PDF, OneNote, CSV, JSON, YAML and text files.",
  graph: "Knowledge-graph relations around an entity.",
  write:
    "Every direct write: full document replace, table create and change, restore, folders and moves.",
  exams:
    "Trainer tools: define exams, find attempts waiting for grading, read answers beside the correct ones, and propose grades.",
  wiki: "Find pages by title, check orphan, dangling and backlink structure, and read the recent commit feed.",
  connections: "Manage your personal MCP connections.",
  admin:
    "Administration: LLM configuration, diagnostics, queue, knowledge index, ingestion and scheduled tasks (admin keys only).",
  external: "The tools of apps you connected under Account › MCP connections.",
  all: "Every toolset.",
};

export const MCP_TOOLSETS_HEADER = "x-weaver-toolsets";
export const MAX_TOOLSETS_HEADER_CHARS = 256;

export function parseToolsets(
  header: string | null | undefined,
): McpToolsetName[] {
  const requested = new Set<string>(["core"]);
  if (header && header.length <= MAX_TOOLSETS_HEADER_CHARS) {
    for (const part of header.split(",")) {
      requested.add(part.trim().toLowerCase());
    }
  }
  const everything = requested.has("all");
  return MCP_TOOLSET_NAMES.filter(
    (name) => name !== "all" && (everything || requested.has(name)),
  );
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MCP_TOOLS, WRITE_TOOLS } from "./registry";
import {
  WIKI_AGENT_DISPATCH,
  WIKI_AGENT_LOADABLE_TOOLS,
  WIKI_AGENT_TOOLS,
  wikiToolDefinitionBytes,
} from "./wikiAgentRegistry";

const names = (tools: readonly { name: string }[]) =>
  tools.map((tool) => tool.name);

describe("wiki agent registry", () => {
  it("pins the always-active tools", () => {
    expect(names(WIKI_AGENT_TOOLS).sort()).toEqual(
      [
        "wiki_create_page",
        "wiki_patch_page",
        "wiki_create_folder",
        "list_inputs",
        "read_input",
        "complete_input",
        "suggest_guide_change",
        "wiki_note",
        "finish_run",
        "find_page",
        "inspect_links",
        "list_documents",
        "read_document",
        "navigate_document",
        "list_content_folders",
        "search_knowledge",
        "search_entities",
        "entity_detail",
        "load_tools",
      ].sort(),
    );
  });

  it("pins the loadable reads", () => {
    expect(names(WIKI_AGENT_LOADABLE_TOOLS).sort()).toEqual(
      [
        "get_table",
        "query_table_rows",
        "list_table_columns",
        "read_table_cell",
        "aggregate_table",
        "entity_neighborhood",
        "list_recent_changes",
        "content_history",
        "list_missing_entity_pages",
        "list_pages_with_newer_sources",
      ].sort(),
    );
    expect(
      WIKI_AGENT_LOADABLE_TOOLS.every((tool) => tool.kind === "read"),
    ).toBe(true);
  });

  it.each(WIKI_AGENT_DISPATCH.map((tool) => [tool.name, tool] as const))(
    "%s takes no project, idempotency key or author metadata",
    (_name, tool) => {
      const schema = JSON.stringify(z.toJSONSchema(tool.inputSchema));
      for (const banned of [
        '"projectId"',
        '"projectIds"',
        '"idempotencyKey"',
        '"metadata"',
        '"reviewExempt"',
        '"sources"',
      ])
        expect(schema).not.toContain(banned);
    },
  );

  it("a patch cannot name a title", () => {
    const patch = WIKI_AGENT_TOOLS.find(
      (tool) => tool.name === "wiki_patch_page",
    )!;
    expect(JSON.stringify(z.toJSONSchema(patch.inputSchema))).not.toContain(
      '"title"',
    );
  });

  it("reaches no general write tool and never the MCP write path", () => {
    const general = new Set(names(WRITE_TOOLS));
    const writes = WIKI_AGENT_DISPATCH.filter((tool) => tool.kind === "write");
    for (const tool of writes) expect(general.has(tool.name)).toBe(false);
    for (const tool of WIKI_AGENT_DISPATCH) {
      expect(tool.name).not.toMatch(/^propose_/);
      expect(tool.name).not.toBe("apply_content_operation");
    }
    for (const file of ["./tools/wikiAgent.ts", "./wikiAgentRegistry.ts"])
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(
        /mcpOperations|applyMcpOperation|applyOperationInRepo/,
      );
  });

  it("the agent's write tools stay out of the user registries", () => {
    const mcp = new Set(names(MCP_TOOLS));
    for (const tool of WIKI_AGENT_DISPATCH.filter((t) => t.kind === "write"))
      expect(mcp.has(tool.name)).toBe(false);
  });

  it("pins the measured definition bytes", () => {
    const sum = (tools: typeof WIKI_AGENT_DISPATCH) =>
      tools.reduce((total, tool) => total + wikiToolDefinitionBytes(tool), 0);
    expect({
      always: sum(WIKI_AGENT_TOOLS),
      loadable: sum(WIKI_AGENT_LOADABLE_TOOLS),
    }).toEqual({ always: 13_995, loadable: 8_638 });
  });
});

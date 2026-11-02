import { expect, it } from "vitest";
import { z } from "zod";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import { MCP_TOOLS } from "./registry";
import { MCP_TOOLSET_NAMES, parseToolsets } from "./toolsetNames";
import {
  CORE_TOOL_NAMES,
  MCP_TOOLSET_MEMBERS,
  selectMcpTools,
  toolsetsOf,
} from "./toolsets";

const actor = (content: string[]) =>
  createApiKeySecurityContext({
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    globalRole: "User",
    keyId: "k1",
    permissions: { mcp: ["use"], content },
    projectIds: [],
  });

it("pins core membership", () => {
  expect(CORE_TOOL_NAMES).toEqual([
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
  ]);
});
it("covers every MCP contract with a named toolset and names only real tools", () => {
  const known = new Set(MCP_TOOLS.map((t) => t.name));
  const members = new Set(Object.values(MCP_TOOLSET_MEMBERS).flat());
  expect([...members].filter((n) => !known.has(n))).toEqual([]);
  expect(MCP_TOOLS.map((t) => t.name).filter((n) => !members.has(n))).toEqual(
    [],
  );
});
it("parses the header: core always, order fixed, unknown ignored, all expanded, over-length absent", () => {
  expect(parseToolsets(null)).toEqual(["core"]);
  expect(parseToolsets("")).toEqual(["core"]);
  expect(parseToolsets(" Tables , TABLES, bogus")).toEqual(["core", "tables"]);
  expect(parseToolsets("write,documents")).toEqual([
    "core",
    "documents",
    "write",
  ]);
  expect(parseToolsets("all")).toEqual(
    MCP_TOOLSET_NAMES.filter((n) => n !== "all"),
  );
  expect(parseToolsets("tables,".repeat(60))).toEqual(["core"]); // 420 chars → absent
});
it("selects by toolset then capability, in registry order", () => {
  const rw = selectMcpTools(actor(["read", "write"]), ["core"]);
  expect(rw.tools.map((t) => t.name)).toEqual(
    MCP_TOOLS.map((t) => t.name).filter((n) => CORE_TOOL_NAMES.includes(n)),
  );
  expect(rw.external).toBe(false);
  const ro = selectMcpTools(actor(["read"]), ["core", "admin"]);
  expect(ro.tools.map((t) => t.name)).toEqual(
    CORE_TOOL_NAMES.filter(
      (n) => !["create_document", "patch_document"].includes(n),
    ),
  );
  expect(selectMcpTools(actor(["read"]), ["core", "external"]).external).toBe(
    true,
  );
});
it("reports a tool's toolsets", () => {
  expect(toolsetsOf("read_document")).toEqual(["core", "documents"]);
  expect(toolsetsOf("list_diagnostic_events")).toEqual(["admin"]);
  expect(toolsetsOf("nope")).toEqual([]);
});
it("keeps the serialized core list under the budget", () => {
  const list = selectMcpTools(actor(["read", "write"]), ["core"]).tools.map(
    (t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }),
      annotations: {
        readOnlyHint: t.kind === "read",
        destructiveHint: t.kind === "write",
        idempotentHint: t.kind === "write",
        openWorldHint: false,
        ...t.annotations,
      },
    }),
  );
  expect(Buffer.byteLength(JSON.stringify(list), "utf8")).toBeLessThanOrEqual(
    26_000,
  );
});

it("selects optional exam tools by capability", () => {
  expect(parseToolsets("exams")).toEqual(["core", "exams"]);
  expect(toolsetsOf("grade_exam_attempt")).toEqual(["exams"]);
  expect(selectMcpTools(actor(["read"]), ["exams"]).tools).toHaveLength(4);
  expect(
    selectMcpTools(actor(["read", "write"]), ["exams"]).tools,
  ).toHaveLength(7);
});

it("offers the wiki reads as their own read-only toolset", () => {
  expect(parseToolsets("wiki")).toEqual(["core", "wiki"]);
  expect(MCP_TOOLSET_MEMBERS.wiki).toEqual([
    "find_page",
    "inspect_links",
    "list_recent_changes",
  ]);
  expect(toolsetsOf("find_page")).toEqual(["wiki"]);
  expect(CORE_TOOL_NAMES).not.toContain("find_page");
  const selected = selectMcpTools(actor(["read"]), ["wiki"]).tools;
  expect(selected.map((t) => t.name)).toEqual(MCP_TOOLSET_MEMBERS.wiki);
  expect(selected.every((t) => t.kind === "read")).toBe(true);
  const bytes = Buffer.byteLength(
    JSON.stringify(
      selected.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }),
      })),
    ),
    "utf8",
  );
  expect(bytes).toBeLessThanOrEqual(3_000);
});

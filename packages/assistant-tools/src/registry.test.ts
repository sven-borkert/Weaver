import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createApiKeySecurityContext,
  createSessionSecurityContext,
} from "@weaver/core/security/context";
import { contentOperationSchema } from "@weaver/core/services/contentOperations";
import {
  ADMIN_TOOLS,
  ASSISTANT_EXAM_TOOLS,
  EXAM_TOOLS,
  examToolsForActor,
  ASSISTANT_TOOLS,
  CONNECTION_TOOLS,
  MCP_TOOLS,
  WRITE_TOOLS,
  mcpToolsForActor,
  toolsForActor,
} from "./registry";

describe("tool registry", () => {
  it("has unique names and zod input schemas", () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of ASSISTANT_TOOLS)
      expect(typeof tool.inputSchema.safeParse).toBe("function");
  });
  it("gives every tool a top-level object input schema, which function-calling providers require", () => {
    const tools = [...ASSISTANT_TOOLS, ...MCP_TOOLS].map((tool) => ({
      name: tool.name,
      type: (
        z.toJSONSchema(tool.inputSchema, { io: "input" }) as {
          type?: unknown;
        }
      ).type,
    }));
    expect(tools.filter((tool) => tool.type !== "object")).toEqual([]);
  });
  it("pins the tool names and order consumed by the assistant and MCP server", () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name)).toEqual([
      "list_projects",
      "list_documents",
      "read_document",
      "navigate_document",
      "content_history",
      "list_content_folders",
      "list_tables",
      "get_table",
      "query_table_rows",
      "list_table_columns",
      "list_table_column_options",
      "read_table_cell",
      "aggregate_table",
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
      "search_knowledge",
      "search_entities",
      "entity_neighborhood",
      "entity_detail",
      "resolve_citation",
      "propose_document_create",
      "propose_document_edit",
      "propose_table_create",
      "propose_document_patch",
      "propose_table_change",
      "propose_content_restore",
      "propose_content_lifecycle",
    ]);
  });
  it("filters by capability", () => {
    const session = createSessionSecurityContext({
      userId: "u",
      globalRole: "User",
      sessionId: "s",
    });
    expect(toolsForActor(session).length).toBe(ASSISTANT_TOOLS.length);
    const readOnlyKey = createApiKeySecurityContext({
      userId: "u",
      globalRole: "User",
      keyId: "k",
      permissions: null,
      projectIds: [],
    });
    expect(toolsForActor(readOnlyKey).every((t) => t.kind === "read")).toBe(
      true,
    );
  });
});

describe("MCP registry (spec §26.2 item 1)", () => {
  it("keeps direct-write and admin tools out of the assistant surface even for Admin sessions", () => {
    const session = createSessionSecurityContext({
      userId: "u1",
      globalRole: "Admin",
      sessionId: "s1",
    });
    expect(ASSISTANT_TOOLS.some((t) => t.kind === "write")).toBe(false);
    expect(toolsForActor(session).some((t) => t.kind === "write")).toBe(false);
    expect(
      toolsForActor(session).some((tool) =>
        ADMIN_TOOLS.some((adminTool) => adminTool.name === tool.name),
      ),
    ).toBe(false);
  });

  it("exposes read + direct-write + admin over MCP and never propose", () => {
    expect(MCP_TOOLS.some((t) => t.kind === "propose")).toBe(false);
    expect(WRITE_TOOLS.map((tool) => tool.name)).toEqual([
      "create_document",
      "update_document",
      "patch_document",
      "create_table",
      "update_table_schema",
      "update_table_rows",
      "change_table",
      "restore_content",
      "apply_content_lifecycle",
    ]);
    expect(ADMIN_TOOLS.map((tool) => tool.name)).toEqual([
      "admin_overview",
      "admin_health",
      "list_queue_jobs",
      "get_queue_job",
      "queue_summary",
      "list_ai_usage",
      "ai_usage_summary",
      "list_mcp_audit_events",
      "list_assistant_runs",
      "get_assistant_run",
      "get_diagnostics_settings",
      "set_diagnostics_settings",
      "get_retention_settings",
      "set_retention_settings",
      "list_diagnostic_events",
      "get_diagnostic_event",
      "list_document_change_summaries",
      "prune_diagnostic_events",
      "list_llm_connections",
      "list_llm_models",
      "list_llm_routes",
      "create_llm_connection",
      "update_llm_connection",
      "delete_llm_connection",
      "create_llm_model",
      "update_llm_model",
      "delete_llm_model",
      "set_llm_route",
      "set_embedding_compatibility",
      "test_llm_connection",
      "test_llm_model",
      "import_llm_models",
      "list_knowledge_generations",
      "list_generation_documents",
      "get_knowledge_status",
      "rebuild_knowledge_index",
      "retry_failed_knowledge",
      "enqueue_reconcile",
      "list_ingestion_batches",
      "list_ingestion_files",
      "get_ingestion_file",
      "list_scheduled_tasks",
      "get_scheduled_task",
      "list_scheduled_task_runs",
      "get_scheduled_task_run",
    ]);
    expect(
      MCP_TOOLS.filter((t) => t.kind === "write").map((t) => t.name),
    ).toEqual([
      "create_document",
      "update_document",
      "patch_document",
      "create_table",
      "update_table_schema",
      "update_table_rows",
      "change_table",
      "restore_content",
      "apply_content_lifecycle",
      "set_diagnostics_settings",
      "set_retention_settings",
      "prune_diagnostic_events",
      "create_llm_connection",
      "update_llm_connection",
      "delete_llm_connection",
      "create_llm_model",
      "update_llm_model",
      "delete_llm_model",
      "set_llm_route",
      "set_embedding_compatibility",
      "test_llm_connection",
      "test_llm_model",
      "import_llm_models",
      "rebuild_knowledge_index",
      "retry_failed_knowledge",
      "enqueue_reconcile",
      "create_external_connection",
      "update_external_connection",
      "delete_external_connection",
      "discover_external_connection",
      "review_external_tools",
      "create_exam",
      "update_exam",
      "grade_exam_attempt",
    ]);
    const readOnly = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "User",
      keyId: "k1",
      permissions: { mcp: ["use"], content: ["read"] },
      projectIds: [],
    });
    expect(mcpToolsForActor(readOnly).some((t) => t.kind === "write")).toBe(
      false,
    );
    const writer = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "User",
      keyId: "k1",
      permissions: { mcp: ["use"], content: ["read", "write"] },
      projectIds: [],
    });
    expect(
      mcpToolsForActor(writer).filter((t) => t.kind === "write"),
    ).toHaveLength(12);
    const admin = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "Admin",
      keyId: "k-admin",
      permissions: { system: ["admin"] },
      projectIds: [],
    });
    expect(
      mcpToolsForActor(admin)
        .filter((tool) => tool.capability === "system:admin")
        .map((tool) => tool.name),
    ).toEqual(ADMIN_TOOLS.map((tool) => tool.name));
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });

  it("gates the connection tools on external:manage and keeps them out of the assistant", () => {
    expect(CONNECTION_TOOLS.map((tool) => tool.name)).toEqual([
      "list_external_connections",
      "get_external_connection",
      "list_external_tools",
      "get_external_tool",
      "create_external_connection",
      "update_external_connection",
      "delete_external_connection",
      "discover_external_connection",
      "review_external_tools",
    ]);
    expect(
      CONNECTION_TOOLS.every((tool) => tool.capability === "external:manage"),
    ).toBe(true);
    expect(
      ASSISTANT_TOOLS.some((tool) =>
        CONNECTION_TOOLS.some((c) => c.name === tool.name),
      ),
    ).toBe(false);
    const manager = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "User",
      keyId: "k1",
      permissions: { mcp: ["use"], content: ["read"], external: ["manage"] },
      projectIds: [],
    });
    expect(
      mcpToolsForActor(manager)
        .filter((tool) => tool.capability === "external:manage")
        .map((tool) => tool.name),
    ).toEqual(CONNECTION_TOOLS.map((tool) => tool.name));
  });
});

describe("slice 2 surface", () => {
  it("adds the new families to the assistant and retires the superseded table tools", () => {
    const names = ASSISTANT_TOOLS.map((tool) => tool.name);
    expect(names).toContain("navigate_document");
    expect(names).toContain("propose_document_patch");
    expect(names).toContain("propose_table_change");
    expect(names).not.toContain("propose_table_schema_change");
    expect(names).not.toContain("propose_table_rows");
  });

  it("keeps the superseded tools available to MCP clients", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(names).toContain("update_table_schema");
    expect(names).toContain("update_table_rows");
    expect(names).toContain("patch_document");
    expect(names).toContain("change_table");
    expect(names).toContain("navigate_document");
  });

  it("removes the unreachable propose_table_schema_change and propose_table_rows tool definitions from every exported registry", () => {
    for (const registry of [
      ASSISTANT_TOOLS,
      WRITE_TOOLS,
      MCP_TOOLS,
      ADMIN_TOOLS,
      EXAM_TOOLS,
      CONNECTION_TOOLS,
    ]) {
      const names = registry.map((tool) => tool.name);
      expect(names).not.toContain("propose_table_schema_change");
      expect(names).not.toContain("propose_table_rows");
    }
  });

  it("keeps every operation variant parseable so pending proposals stay valid", () => {
    const kinds = contentOperationSchema.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds).toEqual([
      "document.create",
      "document.edit",
      "document.patch",
      "table.create",
      "table.schema",
      "table.rows",
      "table.change",
      "content.restore",
      "content.lifecycle",
    ]);
  });
});

describe("artifact read tools", () => {
  const ARTIFACT_TOOLS = [
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
  ];

  it("registers them as scoped content reads between aggregate_table and search_knowledge", () => {
    const names = ASSISTANT_TOOLS.map((tool) => tool.name);
    expect(
      names.slice(
        names.indexOf("aggregate_table") + 1,
        names.indexOf("search_knowledge"),
      ),
    ).toEqual(ARTIFACT_TOOLS);
    for (const name of ARTIFACT_TOOLS) {
      const tool = ASSISTANT_TOOLS.find((entry) => entry.name === name)!;
      expect(tool.kind).toBe("read");
      expect(tool.capability).toBe("content:read");
      expect(tool.description.length).toBeLessThanOrEqual(300);
      expect(
        (
          z.toJSONSchema(tool.inputSchema, { io: "input" }) as {
            type?: unknown;
          }
        ).type,
      ).toBe("object");
    }
  });

  it("exposes them over MCP too", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    for (const name of ARTIFACT_TOOLS) expect(names).toContain(name);
  });
});

describe("slice 3 surface", () => {
  it("adds the recovery tools to the right registries", () => {
    const assistant = ASSISTANT_TOOLS.map((tool) => tool.name);
    expect(assistant).toContain("content_history");
    expect(assistant).toContain("propose_content_restore");
    expect(assistant).not.toContain("restore_content");

    const mcp = MCP_TOOLS.map((tool) => tool.name);
    expect(mcp).toContain("content_history");
    expect(mcp).toContain("restore_content");
    expect(mcp).not.toContain("propose_content_restore");
  });

  it("keeps content.restore in the operation union", () => {
    const kinds = contentOperationSchema.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds).toContain("content.restore");
    // Pinned by index, not by being last: new variants append after it, and an
    // existing variant must never shift (a persisted proposal is parsed by position
    // in the union's discriminator).
    expect(kinds.indexOf("content.restore")).toBe(7);
  });
});

it("keeps exam tools optional and exposes exactly seven trainer contracts", () => {
  const names = [
    "list_exams",
    "get_exam",
    "list_exam_attempts",
    "get_exam_attempt",
    "create_exam",
    "update_exam",
    "grade_exam_attempt",
  ];
  expect(EXAM_TOOLS.map((t) => t.name)).toEqual(names);
  expect(ASSISTANT_TOOLS.filter((t) => names.includes(t.name))).toEqual([]);
  expect(
    MCP_TOOLS.filter((t) => names.includes(t.name)).map((t) => t.name),
  ).toEqual(names);
  expect(
    z.toJSONSchema(EXAM_TOOLS[6]!.inputSchema, { io: "input" }).properties,
  ).not.toHaveProperty("release");
  const bytes = Buffer.byteLength(
    JSON.stringify(
      EXAM_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }),
      })),
    ),
  );
  expect(bytes).toBeLessThanOrEqual(14000);
  console.info("Exam tool schema bytes:", bytes);
  expect(examToolsForActor).toBeTypeOf("function");
});

it("gives assistant runs exam proposals instead of direct definition writes", () => {
  expect(ASSISTANT_EXAM_TOOLS.map((t) => t.name)).toEqual([
    "list_exams",
    "get_exam",
    "list_exam_attempts",
    "get_exam_attempt",
    "propose_exam_create",
    "propose_exam_update",
    "grade_exam_attempt",
  ]);
  expect(MCP_TOOLS.map((t) => t.name)).not.toContain("propose_exam_create");
  const questionItem = (name: string) => {
    const tool = [...EXAM_TOOLS, ...ASSISTANT_EXAM_TOOLS].find(
      (t) => t.name === name,
    )!;
    const schema = z.toJSONSchema(tool.inputSchema, {
      io: "input",
    }) as unknown as {
      properties: {
        questions: {
          items: {
            properties: Record<string, { items?: { properties: object } }>;
          };
        };
      };
    };
    return schema.properties.questions.items.properties;
  };
  // A new exam has no ids to keep, so creation never offers them.
  for (const name of ["create_exam", "propose_exam_create"]) {
    expect(questionItem(name)).not.toHaveProperty("id");
    expect(questionItem(name).choices!.items!.properties).not.toHaveProperty(
      "id",
    );
  }
  for (const name of ["update_exam", "propose_exam_update"])
    expect(questionItem(name)).toHaveProperty("id");
  const bytes = Buffer.byteLength(
    JSON.stringify(
      ASSISTANT_EXAM_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }),
      })),
    ),
  );
  expect(bytes).toBeLessThanOrEqual(14000);
  console.info("Assistant exam tool schema bytes:", bytes);
});

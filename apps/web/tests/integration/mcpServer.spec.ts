import { openUploadSink } from "@weaver/core/ingestion/blobStore";
import { finalizeArtifactUpload } from "@weaver/core/services/artifacts";
import { randomUUID } from "node:crypto";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createBearerVerifiers } from "@weaver/auth";
import {
  emitDiagnostic,
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { toOrganizationRole } from "@weaver/core/roles";
import {
  applyOperationInRepo,
  checkOperationBase,
} from "@weaver/core/services/contentOperations";
import { createDocument, getDocument } from "@weaver/core/services/documents";
import {
  invalidateDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import { syncDocumentKeywordIndex } from "@weaver/core/services/keywordIndex";
import {
  mcpOperationId,
  requestHash,
} from "@weaver/core/services/mcpOperations";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { createTable, getTable } from "@weaver/core/services/tables";
import { repoDir } from "@weaver/git-store";
import {
  createMcpHttpHandler,
  createMcpNodeServer,
  resourceUriFor,
  type McpNodeServer,
  type McpRuntimeConfig,
} from "@weaver/mcp";
import {
  addMembership,
  callerFor,
  ensureOAuthResource,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  testAuth,
  testEncryptionKeys,
  markdownContent,
} from "./_harness";
import {
  dpopProofFor,
  generateDpopKey,
  insertOAuthClient,
  obtainAccessToken,
  obtainDpopBoundToken,
  sessionCookieFor,
  TEST_OAUTH_CLIENT_ID,
} from "./_oauth";

const config: McpRuntimeConfig = {
  resourceUrl: TEST_MCP_RESOURCE,
  issuer: TEST_ISSUER,
  mcpPath: "/api/mcp",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp",
  allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
  allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
  maxBodyBytes: 1_048_576,
  maxResourceChars: 200_000,
  toolTimeoutMs: 10_000,
  rateLimitPerMinute: 10_000,
  anonRateLimitPerMinute: 10_000,
  version: "0.0.0-spec",
  production: false,
};

const runtimeFacts = {
  basePath: "/injected-base",
  dataDir: "./data-test",
  poolMax: 17,
  statementTimeoutMs: 1_234,
  jobsEnabled: true,
  reconcileCron: "*/15 * * * *",
  assistantReconcileCron: "* * * * *",
  mcpPort: 3200,
  encryptionKeyVersions: [2, 7],
};

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "weaver-spec", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const READ_TOOLS = [
  "find_page",
  "inspect_links",
  "list_recent_changes",
  "get_exam",
  "get_exam_attempt",
  "list_exams",
  "list_exam_attempts",
  "aggregate_table",
  "content_history",
  "entity_detail",
  "entity_neighborhood",
  "find_word_tables",
  "get_artifact_overview",
  "get_table",
  "inspect_structured_artifact",
  "list_content_folders",
  "list_documents",
  "list_projects",
  "list_table_column_options",
  "list_table_columns",
  "list_tables",
  "navigate_document",
  "query_json_artifact",
  "query_table_rows",
  "read_csv_artifact",
  "read_document",
  "read_excel_sheet",
  "read_onenote",
  "read_pdf_pages",
  "read_table_cell",
  "read_text_artifact",
  "read_word_blocks",
  "read_word_chapter",
  "read_word_table",
  "resolve_citation",
  "search_artifact_text",
  "search_artifacts",
  "search_entities",
  "search_knowledge",
] as const;
const WRITE_TOOLS = [
  "create_exam",
  "update_exam",
  "grade_exam_attempt",
  "apply_content_lifecycle",
  "change_table",
  "create_document",
  "create_table",
  "patch_document",
  "restore_content",
  "update_document",
  "update_table_rows",
  "update_table_schema",
] as const;
const ADMIN_TOOLS = [
  "admin_health",
  "admin_overview",
  "ai_usage_summary",
  "create_llm_connection",
  "create_llm_model",
  "delete_llm_connection",
  "delete_llm_model",
  "enqueue_reconcile",
  "get_assistant_run",
  "get_diagnostic_event",
  "get_diagnostics_settings",
  "get_ingestion_file",
  "get_knowledge_status",
  "get_queue_job",
  "get_scheduled_task",
  "get_scheduled_task_run",
  "import_llm_models",
  "list_ai_usage",
  "list_assistant_runs",
  "list_diagnostic_events",
  "list_document_change_summaries",
  "list_generation_documents",
  "list_ingestion_batches",
  "list_ingestion_files",
  "list_knowledge_generations",
  "list_llm_connections",
  "list_llm_models",
  "list_llm_routes",
  "list_mcp_audit_events",
  "list_queue_jobs",
  "list_scheduled_task_runs",
  "list_scheduled_tasks",
  "prune_diagnostic_events",
  "queue_summary",
  "rebuild_knowledge_index",
  "retry_failed_knowledge",
  "set_diagnostics_settings",
  "set_llm_route",
  "test_llm_connection",
  "test_llm_model",
  "update_llm_connection",
  "update_llm_model",
] as const;
const DESTRUCTIVE_ADMIN_TOOLS = [
  "create_llm_connection",
  "create_llm_model",
  "delete_llm_connection",
  "delete_llm_model",
  "enqueue_reconcile",
  "import_llm_models",
  "prune_diagnostic_events",
  "rebuild_knowledge_index",
  "retry_failed_knowledge",
  "set_diagnostics_settings",
  "set_llm_route",
  "test_llm_connection",
  "test_llm_model",
  "update_llm_connection",
  "update_llm_model",
] as const;
const CONNECTION_TOOLS = [
  "create_external_connection",
  "delete_external_connection",
  "discover_external_connection",
  "get_external_connection",
  "get_external_tool",
  "list_external_connections",
  "list_external_tools",
  "review_external_tools",
  "update_external_connection",
] as const;
const DESTRUCTIVE_CONNECTION_TOOLS = [
  "create_external_connection",
  "delete_external_connection",
  "discover_external_connection",
  "review_external_tools",
  "update_external_connection",
] as const;
const META_TOOLS = ["call_tool", "describe_tool", "search_tools"] as const;
const CORE_TOOLS = [
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
] as const;
const TABLES_TOOLS = [
  "list_tables",
  "get_table",
  "query_table_rows",
  "list_table_columns",
  "list_table_column_options",
  "read_table_cell",
  "aggregate_table",
] as const;
const ALL = { headers: { "X-Weaver-Toolsets": "all" } };
const COL_TASK = "11111111-1111-4111-8111-111111111111";
const COL_DONE = "22222222-2222-4222-8222-222222222222";
const COL_OWNER = "55555555-5555-4555-8555-555555555555";
const ROW_PLAN = "33333333-3333-4333-8333-333333333333";
const ROW_BUILD = "44444444-4444-4444-8444-444444444444";
const ROW_SHIP = "66666666-6666-4666-8666-666666666666";

let server: McpNodeServer;
let baseUrl: string;

function endpoint(): URL {
  return new URL(`${baseUrl}/api/mcp`);
}

async function connect(
  token: string,
  target = endpoint(),
  protocolVersion: "2026-07-28" | "2025-11-25" | "2025-06-18" = "2026-07-28",
  options: { headers?: Record<string, string> } = {},
): Promise<Client> {
  const client = new Client(
    { name: "weaver-spec", version: "0.0.0" },
    {
      supportedProtocolVersions: [protocolVersion],
      versionNegotiation: {
        mode:
          protocolVersion === "2026-07-28"
            ? { pin: protocolVersion }
            : "legacy",
      },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(target, {
      authProvider: { token: async () => token },
      requestInit: options.headers ? { headers: options.headers } : undefined,
    }),
  );
  return client;
}

/** Raw JSON-RPC POST for the negative HTTP-level cases the client would retry or hide. */
function rpc(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  target = endpoint(),
): Promise<Response> {
  return fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  });
}

function directToolRequest(
  token: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  target: string | URL = TEST_MCP_RESOURCE,
  protocolVersion = "2026-07-28",
): Request {
  return new Request(target, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...(protocolVersion === "2026-07-28" ? { _meta: ENVELOPE } : {}),
      },
    }),
    signal,
  });
}

async function startServer(
  overrides: Partial<McpRuntimeConfig> & {
    llmFetch?: typeof fetch;
    llmRing?: ReturnType<typeof testEncryptionKeys> | null;
  } = {},
): Promise<{ server: McpNodeServer; endpoint: URL }> {
  const {
    llmFetch = vi.fn(async () => {
      throw new Error("unexpected provider HTTP request");
    }),
    llmRing = testEncryptionKeys(),
    ...configOverrides
  } = overrides;
  const handler = createMcpHttpHandler({
    db: getPrisma(),
    verifiers: createBearerVerifiers(testAuth(), {
      issuer: TEST_ISSUER,
      audience: TEST_MCP_RESOURCE,
    }),
    config: { ...config, ...configOverrides },
    ring: llmRing,
    llmFetch,
    runtimeFacts,
    log: () => undefined,
  });
  const isolated = await createMcpNodeServer(handler, {
    port: 0,
    host: "127.0.0.1",
  });
  return {
    server: isolated,
    endpoint: new URL(`http://127.0.0.1:${isolated.port}/api/mcp`),
  };
}

function structured<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

const llmUnitVector = (length: number) =>
  Array.from({ length }, (_, index) => (index === 0 ? 1 : 0));

const okLlmFetch: typeof fetch = async (url, init) => {
  const href =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const pathname = new URL(href).pathname;
  if (init?.method === "GET" && pathname.endsWith("/models")) {
    return new Response(
      JSON.stringify({ data: [{ id: "m-chat" }, { id: "m-embed" }] }),
    );
  }
  if (init?.method === "GET" && pathname.endsWith("/model/info")) {
    return new Response(
      JSON.stringify({
        data: [
          {
            model_name: "m-chat",
            model_info: { mode: "chat", supports_function_calling: true },
          },
          { model_name: "m-embed", model_info: { mode: "embedding" } },
        ],
      }),
    );
  }
  if (pathname.endsWith("/embeddings")) {
    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: llmUnitVector(4) }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
    );
  }
  if (pathname.endsWith("/chat/completions")) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
  throw new Error(`unexpected fake provider request: ${pathname}`);
};

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

async function fixture(suffix: string) {
  const db = getPrisma();
  const user = await makeUser("User", `mcp-${suffix}`);
  const project = await makeProject(`MCP ${suffix}`);
  const hidden = await makeProject(`Hidden ${suffix}`);
  await addMembership(project.id, user.id, "Editor");
  const actor = {
    ...securityContextFor(user),
    name: "Spec",
    email: user.email,
  };
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Handbook",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("# Handbook\n\nWelcome aboard.\n"),
      },
    },
    actor,
  );
  const readKey = await callerFor(user).apiKey.create({ name: "read" });
  const writeKey = await callerFor(user).apiKey.create({
    name: "write",
    capabilities: ["content:write"],
  });
  return { db, user, project, hidden, doc, readKey, writeKey };
}

async function makeNewerProjectMemberships(
  userId: string,
  count: number,
): Promise<string[]> {
  const db = getPrisma();
  const rows = Array.from({ length: count }, (_unused, index) => ({
    projectId: randomUUID(),
    organizationId: randomUUID(),
    index,
  }));
  await db.organization.createMany({
    data: rows.map((row) => ({
      id: row.organizationId,
      name: `MCP capped ${row.index}`,
      slug: `project-${row.projectId}`,
    })),
  });
  await db.project.createMany({
    data: rows.map((row) => ({
      id: row.projectId,
      name: `Capped ${row.index}`,
      organizationId: row.organizationId,
      updatedAt: new Date(Date.UTC(2090, 0, 1, 0, row.index)),
    })),
  });
  await db.member.createMany({
    data: rows.map((row) => ({
      organizationId: row.organizationId,
      userId,
      role: toOrganizationRole("Editor"),
    })),
  });
  return rows.map((row) => row.projectId).reverse();
}

async function readFixture() {
  const base = await fixture("read");
  const { db, project, hidden, doc } = base;
  const actor = {
    ...securityContextFor(base.user),
    name: "Spec",
    email: base.user.email,
  };
  await syncDocumentKeywordIndex(knowledgeSystemContextForTests(), db, {
    projectId: project.id,
    documentId: doc.id,
    sourceCommitSha: doc.headCommitSha,
    pathAtSha: doc.path,
  });
  const chunk = await db.documentSearchChunk.findFirstOrThrow({
    where: { documentId: doc.id },
  });
  const table = await createTable(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Launch tasks",
      columns: [
        { id: COL_TASK, name: "Task", type: "text" },
        { id: COL_DONE, name: "Done", type: "boolean" },
      ],
      rows: [
        { id: ROW_PLAN, cells: { [COL_TASK]: "Plan", [COL_DONE]: true } },
        { id: ROW_BUILD, cells: { [COL_TASK]: "Build", [COL_DONE]: false } },
      ],
    },
    actor,
  );
  const generation = await db.knowledgeGeneration.create({
    data: {
      projectId: project.id,
      configFingerprint: "mcp-read-fixture",
      embeddingModel: "fixture",
      embeddingDimensions: 3,
      extractionSchemaVersion: 1,
      promptVersion: "fixture",
      status: "active",
      completedAt: new Date(),
      activatedAt: new Date(),
    },
  });
  const entity = await db.graphEntity.create({
    data: {
      projectId: project.id,
      generationId: generation.id,
      entityType: "Product",
      canonicalName: "Weaver",
      normalizedName: "weaver",
      description: "The knowledge platform described by the handbook.",
      aliases: {
        create: {
          projectId: project.id,
          alias: "Loom",
          normalizedAlias: "loom",
        },
      },
    },
  });
  const neighbor = await db.graphEntity.create({
    data: {
      projectId: project.id,
      generationId: generation.id,
      entityType: "Team",
      canonicalName: "Platform Team",
      normalizedName: "platform team",
    },
  });
  await db.entityMention.create({
    data: {
      projectId: project.id,
      generationId: generation.id,
      entityId: entity.id,
      documentId: doc.id,
      sourceChunkId: chunk.id,
      sourceCommitSha: doc.headCommitSha,
      mentionText: "Welcome aboard Weaver",
      confidence: 0.95,
    },
  });
  const relation = await db.graphRelation.create({
    data: {
      projectId: project.id,
      generationId: generation.id,
      sourceEntityId: entity.id,
      targetEntityId: neighbor.id,
      relationType: "built by",
      normalizedType: "built by",
    },
  });
  await db.relationEvidence.create({
    data: {
      projectId: project.id,
      generationId: generation.id,
      relationId: relation.id,
      documentId: doc.id,
      sourceChunkId: chunk.id,
      sourceCommitSha: doc.headCommitSha,
      evidenceText: "The Platform Team builds Weaver.",
      confidence: 0.9,
    },
  });

  const hiddenOwner = await makeUser("User", "mcp-hidden-owner");
  await addMembership(hidden.id, hiddenOwner.id, "Editor");
  const hiddenDoc = await createDocument(
    db,
    {
      projectId: hidden.id,
      folderPath: [],
      title: "Actually secret",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("# Secret\n\nExisting hidden data.\n"),
      },
    },
    {
      ...securityContextFor(hiddenOwner),
      name: "Hidden Owner",
      email: hiddenOwner.email,
    },
  );
  return { ...base, actor, table, entity, neighbor, hiddenDoc };
}

async function seedFailedKnowledgeDocument(
  projectId: string,
  suffix: string,
  generationId?: string,
) {
  const db = getPrisma();
  const document = await db.document.create({
    data: {
      id: randomUUID(),
      projectId,
      path: `denied-retry-${suffix}.md`,
      slug: `denied-retry-${suffix}`,
      title: `Denied retry ${suffix}`,
      excerpt: "denied retry fixture",
      headCommitSha: "b".repeat(40),
      lastEditedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  const generation = generationId
    ? await db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: generationId },
      })
    : await db.knowledgeGeneration.create({
        data: {
          projectId,
          configFingerprint: `denied-retry-${suffix}`,
          embeddingModel: "fixture",
          embeddingDimensions: 1536,
          extractionSchemaVersion: 1,
          promptVersion: "fixture",
          status: "active",
          completedAt: new Date(),
          activatedAt: new Date(),
        },
      });
  await db.knowledgeGenerationDocument.create({
    data: {
      generationId: generation.id,
      documentId: document.id,
      projectId,
      targetSha: document.headCommitSha,
      configFingerprint: generation.configFingerprint,
      status: "failed",
      failureKind: "provider",
      failureSummary: "fixture failure",
      completedAt: new Date(),
    },
  });
  return { generationId: generation.id, documentId: document.id };
}

describe("MCP server over Streamable HTTP (spec §16, §20.3, §26)", () => {
  it("executes the three shared file contracts through MCP", async () => {
    const { project, user, readKey, db } = await fixture("file-contracts");
    const actor = securityContextFor(user);
    const client = await connect(readKey.secret);
    const dataDir = process.env.WEAVER_DATA_DIR!;
    for (const [filename, source] of [
      ["lines.txt", "hello\nworld"],
      ["rows.csv", "name\nAda"],
      ["shape.yaml", "name: Ada"],
    ]) {
      const uploadId = randomUUID();
      const sink = await openUploadSink(dataDir, project.id, uploadId, {
        minFreeBytes: 0,
      });
      await sink.write(Buffer.from(source!));
      const { digest, byteSize } = await sink.finish();
      await finalizeArtifactUpload(
        db,
        actor,
        {
          projectId: project.id,
          files: [
            {
              filename: filename!,
              uploadId,
              contentDigest: digest,
              byteSize,
              replace: false,
            },
          ],
        },
        { dataDir },
      );
    }
    for (const [name, filename, field] of [
      ["read_text_artifact", "lines.txt", "text"],
      ["read_csv_artifact", "rows.csv", "rows"],
      ["inspect_structured_artifact", "shape.yaml", "nodes"],
    ]) {
      const input = { projectId: project.id, filename };
      const result = structured<{ result: Record<string, unknown> }>(
        await client.callTool({ name: name!, arguments: input }),
      );
      expect(result.result[field!]).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        16000,
      );
    }
  });
  beforeAll(async () => {
    const handler = createMcpHttpHandler({
      db: getPrisma(),
      verifiers: createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: TEST_MCP_RESOURCE,
      }),
      config,
      runtimeFacts,
      log: () => undefined,
    });
    server = await createMcpNodeServer(handler, { port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
    await ensureOAuthResource();
    await insertOAuthClient();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses every read tool and all resource types without revealing an existing hidden resource", async () => {
    const {
      db,
      user,
      project,
      hidden,
      doc,
      table,
      entity,
      hiddenDoc,
      readKey,
      writeKey,
    } = await readFixture();
    const reader = await connect(readKey.secret, endpoint(), "2026-07-28", ALL);
    const readTools = (await reader.listTools()).tools
      .map((t) => t.name)
      .sort();
    expect(readTools).toEqual([...READ_TOOLS, ...META_TOOLS].sort());
    expect(readTools).not.toContain("propose_document_edit");

    const writer = await connect(
      writeKey.secret,
      endpoint(),
      "2026-07-28",
      ALL,
    );
    const writeTools = (await writer.listTools()).tools
      .map((t) => t.name)
      .sort();
    expect(writeTools).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS, ...META_TOOLS].sort(),
    );
    expect(writeTools).not.toContain("propose_document_edit");

    const projects = structured<{ projects: Array<{ id: string }> }>(
      await reader.callTool({ name: "list_projects", arguments: {} }),
    );
    expect(projects.projects.map((p) => p.id)).toContain(project.id);
    expect(projects.projects.map((p) => p.id)).not.toContain(hidden.id);

    const documents = structured<{ documents: Array<{ id: string }> }>(
      await reader.callTool({
        name: "list_documents",
        arguments: { projectId: project.id },
      }),
    );
    expect(documents.documents.map((item) => item.id)).toContain(doc.id);

    const read = await reader.callTool({
      name: "read_document",
      arguments: { projectId: project.id, documentId: doc.id },
    });
    expect(read.isError).toBeFalsy();
    const body = structured<{ markdown: string; commitSha: string }>(read);
    expect(body.markdown).toContain("Welcome aboard.");
    const uri = resourceUriFor({
      kind: "document",
      projectId: project.id,
      documentId: doc.id,
    });
    expect(read.content).toContainEqual(
      expect.objectContaining({ type: "resource_link", uri }),
    );

    const outline = await reader.callTool({
      name: "navigate_document",
      arguments: { projectId: project.id, documentId: doc.id, mode: "outline" },
    });
    expect(outline.content).not.toContainEqual(
      expect.objectContaining({ type: "resource_link" }),
    );
    const [firstSection] = structured<{ sections: Array<{ id: string }> }>(
      outline,
    ).sections;
    expect(firstSection).toBeDefined();
    const section = await reader.callTool({
      name: "navigate_document",
      arguments: {
        projectId: project.id,
        documentId: doc.id,
        mode: "section",
        sectionId: firstSection!.id,
      },
    });
    expect(section.isError).toBeFalsy();
    expect(structured<{ text: string }>(section).text).toContain(
      "Welcome aboard.",
    );
    expect(section.content).toContainEqual(
      expect.objectContaining({ type: "resource_link", uri }),
    );
    const found = await reader.callTool({
      name: "navigate_document",
      arguments: {
        projectId: project.id,
        documentId: doc.id,
        mode: "find",
        find: "Welcome",
      },
    });
    expect(found.content).toContainEqual(
      expect.objectContaining({ type: "resource_link", uri }),
    );

    const tables = structured<{ tables: Array<{ id: string }> }>(
      await reader.callTool({
        name: "list_tables",
        arguments: { projectId: project.id },
      }),
    );
    expect(tables.tables.map((item) => item.id)).toContain(table.id);
    const tableRead = structured<{
      id: string;
      commitSha: string;
      rowCount: number;
    }>(
      await reader.callTool({
        name: "get_table",
        arguments: { projectId: project.id, tableId: table.id },
      }),
    );
    expect(tableRead).toMatchObject({
      id: table.id,
      commitSha: table.headCommitSha,
      rowCount: 2,
    });
    const rows = structured<{
      rows: Array<{ id: string }>;
      matched: number;
    }>(
      await reader.callTool({
        name: "query_table_rows",
        arguments: {
          projectId: project.id,
          tableId: table.id,
          filters: [{ columnId: COL_DONE, op: "eq", value: false }],
        },
      }),
    );
    expect(rows).toMatchObject({ matched: 1, rows: [{ id: ROW_BUILD }] });

    const search = structured<{
      documents: Array<{ documentId: string }>;
    }>(
      await reader.callTool({
        name: "search_knowledge",
        arguments: { query: "aboard", projectIds: [project.id] },
      }),
    );
    expect(search.documents.map((item) => item.documentId)).toContain(doc.id);
    const entities = structured<{
      entities: Array<{ entityId: string; canonicalName: string }>;
    }>(
      await reader.callTool({
        name: "search_entities",
        arguments: { query: "Loom", projectIds: [project.id] },
      }),
    );
    expect(entities.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: entity.id,
          canonicalName: "Weaver",
        }),
      ]),
    );
    const neighborhood = structured<{
      nodes: Array<{ entityId: string }>;
      edges: Array<{ relationId: string }>;
    }>(
      await reader.callTool({
        name: "entity_neighborhood",
        arguments: { entityId: entity.id },
      }),
    );
    expect(neighborhood.nodes.map((item) => item.entityId)).toContain(
      entity.id,
    );
    expect(neighborhood.edges).toHaveLength(1);
    const entityDetail = structured<{
      entity: { entityId: string };
      mentions: Array<{ sourceCommitSha: string }>;
    }>(
      await reader.callTool({
        name: "entity_detail",
        arguments: { entityId: entity.id },
      }),
    );
    expect(entityDetail.entity.entityId).toBe(entity.id);
    expect(entityDetail.mentions[0]?.sourceCommitSha).toBe(doc.headCommitSha);
    const resolved = structured<{
      valid: boolean;
      resourceId: string;
      commitSha: string;
    }>(
      await reader.callTool({
        name: "resolve_citation",
        arguments: {
          kind: "document",
          projectId: project.id,
          documentId: doc.id,
          commitSha: doc.headCommitSha,
          headingPath: [],
          excerpt: "Welcome aboard.",
        },
      }),
    );
    expect(resolved).toMatchObject({
      valid: true,
      resourceId: doc.id,
      commitSha: doc.headCommitSha,
    });

    const templates = await reader.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "weaver://projects/{projectId}/documents/{documentId}",
      "weaver://projects/{projectId}/documents/{documentId}/revisions/{commitSha}",
      "weaver://projects/{projectId}/tables/{tableId}",
      "weaver://projects/{projectId}/tables/{tableId}/revisions/{commitSha}",
      "weaver://projects/{projectId}/entities/{entityId}",
    ]);
    expect((await reader.listResources()).resources).toEqual([]);
    const documentResource = await reader.readResource({ uri });
    expect(documentResource.contents[0]).toMatchObject({
      uri,
      mimeType: "text/markdown",
    });
    expect((documentResource.contents[0] as { text: string }).text).toContain(
      "Welcome aboard.",
    );
    const snapshotCommitSha = (
      documentResource._meta as Record<string, unknown> | undefined
    )?.["net.weaver/snapshotCommitSha"] as string;
    expect(documentResource._meta).toMatchObject({
      "net.weaver/snapshotCommitSha": expect.stringMatching(/^[0-9a-f]{40}$/),
      "net.weaver/baseCommitSha": doc.headCommitSha,
      "net.weaver/revisionUri": `${uri}/revisions/${snapshotCommitSha}`,
    });
    const documentRevisionUri = `${uri}/revisions/${doc.headCommitSha}`;
    const revisionResource = await reader.readResource({
      uri: documentRevisionUri,
    });
    expect((revisionResource.contents[0] as { text: string }).text).toContain(
      "Welcome aboard.",
    );
    const unreachableRevisionUri = `${uri}/revisions/${"0".repeat(40)}`;
    await expect(
      reader.readResource({ uri: unreachableRevisionUri }),
    ).rejects.toMatchObject({ code: -32602 });
    const tableUri = resourceUriFor({
      kind: "table",
      projectId: project.id,
      tableId: table.id,
    });
    const tableResource = await reader.readResource({ uri: tableUri });
    expect(tableResource.contents[0]).toMatchObject({
      uri: tableUri,
      mimeType: "application/json",
    });
    expect(
      JSON.parse((tableResource.contents[0] as { text: string }).text),
    ).toMatchObject({ id: table.id, rowCount: 2 });
    const entityUri = resourceUriFor({
      kind: "entity",
      projectId: project.id,
      entityId: entity.id,
    });
    const entityResource = await reader.readResource({ uri: entityUri });
    expect(entityResource.contents[0]).toMatchObject({
      uri: entityUri,
      mimeType: "application/json",
    });
    expect(
      JSON.parse((entityResource.contents[0] as { text: string }).text),
    ).toMatchObject({
      entity: { entityId: entity.id, canonicalName: "Weaver" },
    });

    const hiddenUri = resourceUriFor({
      kind: "document",
      projectId: hidden.id,
      documentId: hiddenDoc.id,
    });
    await expect(reader.readResource({ uri: hiddenUri })).rejects.toMatchObject(
      {
        code: -32602,
      },
    );
    const resourceAudits = await db.mcpAuditEvent.findMany({
      where: { method: "resources/read" },
      orderBy: { createdAt: "asc" },
    });
    expect(resourceAudits).toHaveLength(6);
    const okAudits = resourceAudits.filter((event) => event.outcome === "ok");
    const errorAudits = resourceAudits.filter(
      (event) => event.outcome === "error",
    );
    const deniedAudits = resourceAudits.filter(
      (event) => event.outcome === "denied",
    );
    expect(okAudits.map((event) => event.name).sort()).toEqual(
      [uri, documentRevisionUri, tableUri, entityUri].sort(),
    );
    expect(
      okAudits.every(
        (event) =>
          event.userId === user.id &&
          event.credentialId === readKey.key.id &&
          event.authenticationMethod === "apiKey" &&
          event.clientId === null &&
          event.method === "resources/read" &&
          event.projectId === project.id &&
          event.outcome === "ok" &&
          event.errorCode === null,
      ),
    ).toBe(true);
    expect(errorAudits).toHaveLength(1);
    expect(errorAudits[0]).toMatchObject({
      userId: user.id,
      credentialId: readKey.key.id,
      authenticationMethod: "apiKey",
      clientId: null,
      method: "resources/read",
      name: unreachableRevisionUri,
      projectId: project.id,
      outcome: "error",
      errorCode: "NOT_FOUND",
    });
    expect(deniedAudits).toHaveLength(1);
    expect(deniedAudits[0]).toMatchObject({
      userId: user.id,
      credentialId: readKey.key.id,
      authenticationMethod: "apiKey",
      clientId: null,
      method: "resources/read",
      name: hiddenUri,
      projectId: hidden.id,
      outcome: "denied",
      errorCode: "FORBIDDEN",
    });
    await reader.close();
    await writer.close();
  });

  it("keeps nextCursor intact after the MCP transport serializes and clamps a page filled to the reserved page budget (I1)", async () => {
    const { db, project, actor, readKey } = await readFixture();
    const ORDER_COL = "b0000000-0000-4000-8000-000000000000";
    const FILLER_COL = "b0000001-0000-4000-8000-000000000000";
    // Each row's filler cell is sized so the new 14,500-char page budget
    // (I1) keeps every kept row inside the 16,000-char transport clamp; the
    // pre-fix 16,000-char budget left no room for the response envelope and
    // discarded nextCursor entirely once the page grew past it.
    const filler = "x".repeat(1_800);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i.toString(16).padStart(7, "0")}-0000-4000-8000-000000000000`,
      cells: { [ORDER_COL]: String(i).padStart(2, "0"), [FILLER_COL]: filler },
    }));
    const wide = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Filled",
        columns: [
          { id: ORDER_COL, name: "Order", type: "text" },
          { id: FILLER_COL, name: "Filler", type: "text" },
        ],
        rows,
      },
      actor,
    );
    const reader = await connect(readKey.secret);
    const result = await reader.callTool({
      name: "query_table_rows",
      arguments: {
        projectId: project.id,
        tableId: wide.id,
        sort: { columnId: ORDER_COL, dir: "asc" },
        limit: 20,
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content?.[0] as { type: string; text: string })?.text;
    expect(text?.length).toBeLessThanOrEqual(16_000);
    const page = structured<{
      tableId: string;
      truncated: boolean;
      hasMore: boolean;
      nextCursor: string | null;
    }>(result);
    // A real page must never come back as the transport's own
    // {truncated,partialJson} clamp wrapper: tableId only survives on the
    // genuine payload.
    expect(page.tableId).toBe(wide.id);
    expect(page.truncated).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    await reader.close();
  });

  it("registers admin tools only for keys carrying system:admin, connection tools only for external:manage, and drops admin tools on demotion", async () => {
    const { readKey } = await fixture("admin-tools");
    const admin = await makeUser("Admin", "mcp-admin");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin",
      capabilities: ["system:admin"],
    });

    const reader = await connect(readKey.secret, endpoint(), "2026-07-28", ALL);
    const readerTools = (await reader.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(
      readerTools.filter((name) => ADMIN_TOOLS.includes(name as never)),
    ).toEqual([]);

    const client = await connect(
      adminKey.secret,
      endpoint(),
      "2026-07-28",
      ALL,
    );
    const names = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    expect(names.filter((name) => ADMIN_TOOLS.includes(name as never))).toEqual(
      [...ADMIN_TOOLS],
    );
    const listedTools = (await client.listTools()).tools.filter((tool) =>
      ADMIN_TOOLS.includes(tool.name as never),
    );
    for (const tool of listedTools) {
      const destructive = DESTRUCTIVE_ADMIN_TOOLS.includes(tool.name as never);
      expect(tool.annotations?.destructiveHint).toBe(destructive);
      expect(tool.annotations?.readOnlyHint).toBe(!destructive);
    }
    expect(
      names.filter((name) => CONNECTION_TOOLS.includes(name as never)),
    ).toEqual([]);

    const managerKey = await callerFor(admin).apiKey.create({
      name: "connections",
      capabilities: ["external:manage"],
    });
    const manager = await connect(
      managerKey.secret,
      endpoint(),
      "2026-07-28",
      ALL,
    );
    const managerTools = (await manager.listTools()).tools;
    const managerNames = managerTools.map((tool) => tool.name).sort();
    expect(
      managerNames.filter((name) => CONNECTION_TOOLS.includes(name as never)),
    ).toEqual([...CONNECTION_TOOLS]);
    expect(
      managerNames.filter((name) => ADMIN_TOOLS.includes(name as never)),
    ).toEqual([]);
    for (const tool of managerTools.filter((t) =>
      CONNECTION_TOOLS.includes(t.name as never),
    )) {
      const destructive = DESTRUCTIVE_CONNECTION_TOOLS.includes(
        tool.name as never,
      );
      expect(tool.annotations?.destructiveHint).toBe(destructive);
      expect(tool.annotations?.readOnlyHint).toBe(!destructive);
    }
    await manager.close();

    const before = structured<{
      settings: { level: string };
      stats: { rows: number };
    }>(
      await client.callTool({
        name: "get_diagnostics_settings",
        arguments: {},
      }),
    );
    expect(before.settings.level).toBe("standard");

    const after = structured<{
      settings: { level: string; retentionDays: number };
    }>(
      await client.callTool({
        name: "set_diagnostics_settings",
        arguments: { level: "standard", retentionDays: 3 },
      }),
    );
    expect(after.settings).toMatchObject({
      level: "standard",
      retentionDays: 3,
    });

    const overview = structured<{
      version: string;
      config: {
        basePath: string;
        poolMax: number;
        encryptionKeyVersions: number[];
      };
      truncated: boolean;
    }>(await client.callTool({ name: "admin_overview", arguments: {} }));
    expect(overview).toMatchObject({
      version: config.version,
      config: {
        basePath: runtimeFacts.basePath,
        poolMax: runtimeFacts.poolMax,
        encryptionKeyVersions: runtimeFacts.encryptionKeyVersions,
      },
      truncated: expect.any(Boolean),
    });
    expect(JSON.stringify(overview)).not.toMatch(/DATABASE_URL|AUTH_SECRET/i);

    const health = structured<{
      database: { roundTripMs: number };
      truncated: boolean;
    }>(await client.callTool({ name: "admin_health", arguments: {} }));
    expect(health.database.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(health.truncated).toEqual(expect.any(Boolean));

    const listed = structured<{
      items: Array<{ event: string }>;
      nextCursor: string | null;
    }>(
      await client.callTool({
        name: "list_diagnostic_events",
        arguments: { limit: 10 },
      }),
    );
    expect(Array.isArray(listed.items)).toBe(true);

    const pruned = structured<{ verboseRemoved: number; batches: number }>(
      await client.callTool({
        name: "prune_diagnostic_events",
        arguments: {},
      }),
    );
    expect(pruned).toMatchObject({ verboseRemoved: 0 });

    await getPrisma().user.update({
      where: { id: admin.id },
      data: { role: "User" },
    });
    const demoted = await connect(
      adminKey.secret,
      endpoint(),
      "2026-07-28",
      ALL,
    );
    const demotedTools = (await demoted.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(
      demotedTools.filter((name) => ADMIN_TOOLS.includes(name as never)),
    ).toEqual([]);
    const denied = await demoted.callTool({
      name: "set_diagnostics_settings",
      arguments: { level: "off" },
    });
    expect(denied.isError).toBe(true);
    await reader.close();
    await client.close();
    await demoted.close();
  });

  it("reads paged LLM configuration without credential material", async () => {
    const admin = await makeUser("Admin", "mcp-llm-read");
    const key = await callerFor(admin).apiKey.create({
      name: "llm-read",
      capabilities: ["system:admin"],
    });
    const { admin: llmAdmin, routing } = await seedTestLlmRouting();
    await callerFor(llmAdmin).llm.setRoute({
      purpose: "ingestion",
      modelId: routing.extraction.modelId,
    });
    await callerFor(llmAdmin).llm.setRoute({
      purpose: "jobs",
      modelId: routing.extraction.modelId,
    });
    const client = await connect(key.secret);
    try {
      const connections = structured<{
        items: Array<{ id: string; models: unknown[] }>;
        nextCursor: string | null;
        truncated: boolean;
      }>(
        await client.callTool({
          name: "list_llm_connections",
          arguments: { limit: 1 },
        }),
      );
      expect(connections.items).toHaveLength(1);
      expect(connections.items[0]).toMatchObject({
        id: routing.extraction.connectionId,
      });
      expect(connections.items[0]!.models.length).toBeGreaterThan(0);
      expect(connections.nextCursor).toBeNull();
      expect(JSON.stringify(connections)).not.toMatch(
        /credentialCiphertext|credentialNonce|credentialTag|test-key/,
      );

      const first = structured<{
        items: Array<{ id: string; providerModelId: string }>;
        nextCursor: string | null;
        truncated: boolean;
      }>(
        await client.callTool({
          name: "list_llm_models",
          arguments: {
            connectionId: routing.extraction.connectionId,
            limit: 1,
          },
        }),
      );
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.truncated).toBe(true);
      const second = structured<typeof first>(
        await client.callTool({
          name: "list_llm_models",
          arguments: {
            connectionId: routing.extraction.connectionId,
            limit: 1,
            cursor: first.nextCursor,
          },
        }),
      );
      expect(second.items).toHaveLength(1);
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
      expect(second.nextCursor).toBeNull();
      expect(
        [...first.items, ...second.items]
          .map((model) => model.providerModelId)
          .sort(),
      ).toEqual(
        [
          routing.extraction.providerModelId,
          routing.embedding.providerModelId,
        ].sort(),
      );

      const routes = structured<{
        items: Array<{ purpose: string; health: string }>;
      }>(await client.callTool({ name: "list_llm_routes", arguments: {} }));
      expect(routes.items.map((route) => route.purpose).sort()).toEqual([
        "assistant",
        "document_summary",
        "ingestion",
        "jobs",
        "knowledge_embedding",
        "knowledge_extraction",
      ]);
      expect(
        routes.items.every(
          (route) =>
            route.health ===
            (route.purpose === "document_summary" ? "unassigned" : "ready"),
        ),
      ).toBe(true);
      for (const output of [connections, first, second, routes]) {
        expect(JSON.stringify(output).length).toBeLessThanOrEqual(16_000);
      }
      for (const name of ["list_llm_connections", "list_llm_models"]) {
        for (const id of ["not-a-uuid", ""]) {
          const cursor = Buffer.from(JSON.stringify([id])).toString(
            "base64url",
          );
          const invalid = await client.callTool({
            name,
            arguments: { cursor },
          });
          expect(invalid.isError).toBe(true);
          expect(
            structured<{ error: { code: string } }>(invalid).error.code,
          ).toBe("BAD_REQUEST");
        }
      }
    } finally {
      await client.close();
    }
  });

  it("manages LLM connections, models, and routes through admin tools", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "mcp-llm-write");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin",
      capabilities: ["system:admin"],
    });
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "standard",
    });
    startDiagnosticWriter({ db, runtime: "mcp", flushIntervalMs: 60_000 });
    await waitForDiagnosticWriterReady();

    const credentialSentinel = "sk-tool-secret";
    const rotatedCredentialSentinel = "sk-tool-rotated";
    const endpointSentinel = "https://models.example/v1";
    const isolated = await startServer();
    let client: Client | undefined;
    try {
      client = await connect(adminKey.secret, isolated.endpoint);
      const created = structured<{
        connection: { id: string; name: string };
      }>(
        await client.callTool({
          name: "create_llm_connection",
          arguments: {
            name: "Tool provider",
            providerType: "openai_compatible",
            endpoint: endpointSentinel,
            credential: credentialSentinel,
            requestTimeoutMs: 20_000,
          },
        }),
      );
      expect(created.connection).toMatchObject({ name: "Tool provider" });
      expect(JSON.stringify(created)).not.toContain(credentialSentinel);
      const stored = await db.llmConnection.findUniqueOrThrow({
        where: { id: created.connection.id },
      });
      expect(stored.requestTimeoutMs).toBe(20_000);
      const originalCiphertext = Buffer.from(stored.credentialCiphertext);

      const blankUpdate = structured<{
        connection: { name: string; modelsTruncated: boolean };
      }>(
        await client.callTool({
          name: "update_llm_connection",
          arguments: {
            connectionId: created.connection.id,
            name: "Tool provider 2",
            credential: "",
          },
        }),
      );
      expect(blankUpdate.connection).toMatchObject({
        name: "Tool provider 2",
        modelsTruncated: false,
      });
      expect(
        Buffer.from(
          (
            await db.llmConnection.findUniqueOrThrow({
              where: { id: created.connection.id },
            })
          ).credentialCiphertext,
        ),
      ).toEqual(originalCiphertext);

      await client.callTool({
        name: "update_llm_connection",
        arguments: {
          connectionId: created.connection.id,
          credential: rotatedCredentialSentinel,
        },
      });
      expect(
        Buffer.from(
          (
            await db.llmConnection.findUniqueOrThrow({
              where: { id: created.connection.id },
            })
          ).credentialCiphertext,
        ),
      ).not.toEqual(originalCiphertext);

      const model = structured<{
        model: { id: string; capabilities: string[] };
      }>(
        await client.callTool({
          name: "create_llm_model",
          arguments: {
            connectionId: created.connection.id,
            providerModelId: "chatty",
            displayName: "Chatty",
            capabilities: ["chat", "json_output", "tool_use"],
          },
        }),
      );
      expect(model.model.capabilities).toEqual([
        "chat",
        "json_output",
        "tool_use",
      ]);
      const updated = structured<{ model: { displayName: string } }>(
        await client.callTool({
          name: "update_llm_model",
          arguments: { modelId: model.model.id, displayName: "Chatty 2" },
        }),
      );
      expect(updated.model.displayName).toBe("Chatty 2");

      const route = structured<{
        route: { purpose: string; health: string };
      }>(
        await client.callTool({
          name: "set_llm_route",
          arguments: { purpose: "assistant", modelId: model.model.id },
        }),
      );
      expect(route.route).toMatchObject({
        purpose: "assistant",
        health: "ready",
      });
      expect(
        structured<{ route: { purpose: string; health: string } }>(
          await client.callTool({
            name: "set_llm_route",
            arguments: { purpose: "document_summary", modelId: model.model.id },
          }),
        ).route,
      ).toMatchObject({ purpose: "document_summary", health: "ready" });
      expect(
        structured<{ route: { health: string; model: unknown } }>(
          await client.callTool({
            name: "set_llm_route",
            arguments: { purpose: "document_summary", modelId: null },
          }),
        ).route,
      ).toMatchObject({ health: "unassigned", model: null });
      expect(
        (
          await client.callTool({
            name: "delete_llm_model",
            arguments: { modelId: model.model.id },
          })
        ).isError,
      ).toBe(true);
      await client.callTool({
        name: "set_llm_route",
        arguments: { purpose: "assistant", modelId: null },
      });
      expect(
        structured<{ deleted: boolean }>(
          await client.callTool({
            name: "delete_llm_model",
            arguments: { modelId: model.model.id },
          }),
        ).deleted,
      ).toBe(true);
      expect(
        structured<{ deleted: boolean }>(
          await client.callTool({
            name: "delete_llm_connection",
            arguments: { connectionId: created.connection.id },
          }),
        ).deleted,
      ).toBe(true);

      await flushDiagnostics(true);
      const diagnostics = await db.diagnosticEvent.findMany({
        where: {
          event: { in: ["settings.changed", "admin.tool.called"] },
        },
      });
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.filter((row) => row.event === "settings.changed").length,
      ).toBeGreaterThan(0);
      const adminDiagnostics = diagnostics.filter(
        (row) => row.event === "admin.tool.called",
      );
      expect(adminDiagnostics.length).toBeGreaterThan(0);
      const serializedAdminDiagnostics = JSON.stringify(adminDiagnostics);
      for (const argumentValue of [
        credentialSentinel,
        rotatedCredentialSentinel,
        endpointSentinel,
        "Tool provider",
        "Chatty",
        created.connection.id,
        model.model.id,
      ]) {
        expect(serializedAdminDiagnostics).not.toContain(argumentValue);
      }
      expect(
        diagnostics.find(
          (row) =>
            row.event === "admin.tool.called" &&
            row.message === "create_llm_connection",
        ),
      ).toMatchObject({
        details: {
          tool: "create_llm_connection",
          argumentNames: [
            "name",
            "providerType",
            "endpoint",
            "credential",
            "requestTimeoutMs",
          ],
        },
      });
    } finally {
      await client?.close();
      await isolated.server.close();
      await stopDiagnosticWriter();
      invalidateDiagnosticsSettingsCache();
    }
  });

  it("discovers, imports, and tests chat and embedding models through admin tools", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "mcp-llm-test-import");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin",
      capabilities: ["system:admin"],
    });
    const isolated = await startServer({ llmFetch: okLlmFetch });
    const client = await connect(adminKey.secret, isolated.endpoint);
    try {
      const created = structured<{ connection: { id: string } }>(
        await client.callTool({
          name: "create_llm_connection",
          arguments: {
            name: "Testable",
            providerType: "openai_compatible",
            endpoint: "https://models.example/v1",
            credential: "k",
          },
        }),
      );
      const tested = structured<{
        outcome: string;
        models: Array<{
          providerModelId: string;
          capabilities: Array<
            "chat" | "json_output" | "tool_use" | "embedding"
          >;
          contextWindow: number | null;
          maxOutputTokens: number | null;
          embeddingDimensions: number | null;
        }>;
        truncated: boolean;
      }>(
        await client.callTool({
          name: "test_llm_connection",
          arguments: { connectionId: created.connection.id },
        }),
      );
      expect(tested).toMatchObject({ outcome: "success", truncated: false });
      expect(tested.models).toHaveLength(2);
      expect(tested.models[0]).toMatchObject({
        providerModelId: "m-chat",
        capabilities: ["chat", "json_output", "tool_use"],
      });
      expect(tested.models[1]).toMatchObject({
        providerModelId: "m-embed",
        capabilities: ["embedding"],
      });

      const imported = structured<{
        created: number;
        updated: number;
        skipped: unknown[];
        truncated: boolean;
      }>(
        await client.callTool({
          name: "import_llm_models",
          arguments: {
            connectionId: created.connection.id,
            updateExisting: false,
            models: tested.models.map((model) => ({
              providerModelId: model.providerModelId,
              displayName: model.providerModelId,
              capabilities: model.capabilities,
              contextWindow: model.contextWindow,
              maxOutputTokens: model.maxOutputTokens,
              embeddingDimensions: model.embeddingDimensions,
            })),
          },
        }),
      );
      expect(imported).toEqual({
        created: tested.models.length,
        updated: 0,
        skipped: [],
        truncated: false,
      });

      const declared = await db.llmModel.findMany({
        where: { connectionId: created.connection.id },
        orderBy: { providerModelId: "asc" },
      });
      expect(
        declared.find((model) => model.providerModelId === "m-embed"),
      ).toMatchObject({ embeddingDimensions: 4 });
      for (const model of declared) {
        const modelTest = structured<{
          outcome: string;
          usage: {
            inputTokens: number | null;
            outputTokens: number | null;
            totalTokens: number | null;
          } | null;
        }>(
          await client.callTool({
            name: "test_llm_model",
            arguments: { modelId: model.id },
          }),
        );
        expect(modelTest.outcome).toBe("success");
        expect(modelTest.usage?.inputTokens).toBeGreaterThan(0);
      }
      expect(
        await db.aiUsage.count({
          where: {
            connectionId: created.connection.id,
            operation: "llm_model_import_probe",
          },
        }),
      ).toBe(1);
      expect(
        await db.aiUsage.count({
          where: {
            connectionId: created.connection.id,
            operation: "llm_model_test",
          },
        }),
      ).toBe(2);
    } finally {
      await client.close();
      await isolated.server.close();
    }
  });

  it("fails LLM administration safely without keys or on provider errors", async () => {
    const admin = await makeUser("Admin", "mcp-llm-safe-failure");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin",
      capabilities: ["system:admin"],
    });
    const secret = "credential-must-not-escape";
    const keyless = await startServer({ llmRing: null });
    const keylessClient = await connect(adminKey.secret, keyless.endpoint);
    try {
      const result = await keylessClient.callTool({
        name: "create_llm_connection",
        arguments: {
          name: "No ring",
          providerType: "openai_compatible",
          endpoint: "https://models.example/v1",
          credential: secret,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      await keylessClient.close();
      await keyless.server.close();
    }

    const rawBody = `upstream leaked ${secret}`;
    const failing = await startServer({
      llmFetch: async () => new Response(rawBody, { status: 503 }),
    });
    const failingClient = await connect(adminKey.secret, failing.endpoint);
    try {
      const connection = structured<{ connection: { id: string } }>(
        await failingClient.callTool({
          name: "create_llm_connection",
          arguments: {
            name: "Failing provider",
            providerType: "openai_compatible",
            endpoint: "https://models.example/v1",
            credential: secret,
          },
        }),
      );
      const result = await failingClient.callTool({
        name: "test_llm_connection",
        arguments: { connectionId: connection.connection.id },
      });
      expect(result.isError).not.toBe(true);
      expect(structured<{ outcome: string }>(result).outcome).toBe("failure");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(rawBody);
    } finally {
      await failingClient.close();
      await failing.server.close();
    }
  });

  it("awaits a delayed LLM write result beyond the tool timeout", async () => {
    const admin = await makeUser("Admin", "mcp-llm-delayed-write");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin",
      capabilities: ["system:admin"],
    });
    const delayedFetch: typeof fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return new Response(JSON.stringify({ data: [{ id: "slow-model" }] }));
    };
    const isolated = await startServer({
      toolTimeoutMs: 20,
      llmFetch: delayedFetch,
    });
    const client = await connect(adminKey.secret, isolated.endpoint);
    try {
      const connection = structured<{ connection: { id: string } }>(
        await client.callTool({
          name: "create_llm_connection",
          arguments: {
            name: "Slow provider",
            providerType: "openai_compatible",
            endpoint: "https://models.example/v1",
            credential: "k",
          },
        }),
      );
      const startedAt = Date.now();
      const result = structured<{ outcome: string }>(
        await client.callTool({
          name: "test_llm_connection",
          arguments: { connectionId: connection.connection.id },
        }),
      );
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
      expect(result.outcome).toBe("success");
    } finally {
      await client.close();
      await isolated.server.close();
    }
  });

  it("bounds nested LLM model summaries while keeping full model paging available", async () => {
    const admin = await makeUser("Admin", "mcp-llm-many-models");
    const key = await callerFor(admin).apiKey.create({
      name: "many-models",
      capabilities: ["system:admin"],
    });
    const { routing } = await seedTestLlmRouting();
    await getPrisma().llmModel.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        connectionId: routing.extraction.connectionId,
        providerModelId: `model-${index}-${'"'.repeat(185)}`,
        displayName: '"'.repeat(80),
        capabilities: ["chat" as const],
      })),
    });
    const client = await connect(key.secret);
    try {
      const result = await client.callTool({
        name: "list_llm_connections",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const page = structured<{
        items: Array<{
          id: string;
          models: unknown[];
          modelsTruncated: boolean;
        }>;
        truncated: boolean;
      }>(result);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: routing.extraction.connectionId,
        modelsTruncated: true,
      });
      expect(page.items[0]!.models.length).toBeGreaterThan(0);
      expect(page.items[0]!.models.length).toBeLessThan(102);
      expect(page.truncated).toBe(true);
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(16_000);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const models: {
          items: Array<{ id: string }>;
          nextCursor: string | null;
        } = structured(
          await client.callTool({
            name: "list_llm_models",
            arguments: {
              connectionId: routing.extraction.connectionId,
              limit: 200,
              ...(cursor ? { cursor } : {}),
            },
          }),
        );
        expect(models.items.length).toBeGreaterThan(0);
        ids.push(...models.items.map((model) => model.id));
        cursor = models.nextCursor;
        expect(ids.length).toBeLessThanOrEqual(102);
      } while (cursor);
      expect(new Set(ids).size).toBe(102);
    } finally {
      await client.close();
    }
  });

  it("checks knowledge scope before generation access and requires Maintainer membership", async () => {
    const admin = await makeUser("Admin", "mcp-insight-knowledge");
    const allowed = await makeProject("Insight allowed");
    const restricted = await makeProject("Insight restricted");
    const viewerProject = await makeProject("Insight viewer");
    await addMembership(allowed.id, admin.id, "Maintainer");
    await addMembership(restricted.id, admin.id, "Maintainer");
    await addMembership(viewerProject.id, admin.id, "Viewer");
    const generation = await getPrisma().knowledgeGeneration.create({
      data: {
        projectId: restricted.id,
        configFingerprint: "f",
        embeddingModel: "embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "v1",
      },
    });
    const key = await callerFor(admin).apiKey.create({
      name: "knowledge-inspection",
      capabilities: ["system:admin"],
      projectIds: [allowed.id, viewerProject.id],
    });
    const client = await connect(key.secret);
    try {
      const page = structured<{ items: unknown[] }>(
        await client.callTool({
          name: "list_knowledge_generations",
          arguments: { projectId: allowed.id },
        }),
      );
      expect(page.items).toEqual([]);
      for (const name of [
        "list_knowledge_generations",
        "get_knowledge_status",
        "list_generation_documents",
      ]) {
        const denied = await client.callTool({
          name,
          arguments: {
            projectId: restricted.id,
            ...(name === "list_generation_documents"
              ? { generationId: generation.id }
              : {}),
          },
        });
        expect(structured<{ error: { code: string } }>(denied).error.code).toBe(
          "SCOPE_VIOLATION",
        );
      }
      const mismatched = await client.callTool({
        name: "list_generation_documents",
        arguments: {
          projectId: allowed.id,
          generationId: generation.id,
        },
      });
      expect(
        structured<{ error: { code: string } }>(mismatched).error.code,
      ).toBe("NOT_FOUND");
      const viewer = await client.callTool({
        name: "get_knowledge_status",
        arguments: { projectId: viewerProject.id },
      });
      expect(structured<{ error: { code: string } }>(viewer).error.code).toBe(
        "FORBIDDEN",
      );
      const status = await client.callTool({
        name: "get_knowledge_status",
        arguments: { projectId: allowed.id },
      });
      expect(status.isError).not.toBe(true);
      expect(
        JSON.stringify(status.structuredContent).length,
      ).toBeLessThanOrEqual(16_000);
    } finally {
      await client.close();
    }
  });

  it("rebuilds, retries, and reconciles knowledge only with the required project authority", async () => {
    await seedTestLlmRouting();
    const admin = await makeUser("Admin", "mcp-knowledge-ops");
    const project = await makeProject("Knowledge operations");
    const outsider = await makeProject("Knowledge outside scope");
    const nonmember = await makeProject("Knowledge nonmember");
    const viewerProject = await makeProject("Knowledge viewer");
    await addMembership(project.id, admin.id, "Maintainer");
    await addMembership(outsider.id, admin.id, "Maintainer");
    await addMembership(viewerProject.id, admin.id, "Viewer");

    const db = getPrisma();
    const document = await db.document.create({
      data: {
        id: randomUUID(),
        projectId: project.id,
        path: "retry-me.md",
        slug: "retry-me",
        title: "Retry me",
        excerpt: "retry fixture",
        headCommitSha: "a".repeat(40),
        lastEditedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "retry-fixture",
        embeddingModel: "fixture",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "fixture",
        status: "active",
        completedAt: new Date(),
        activatedAt: new Date(),
      },
    });
    await db.knowledgeGenerationDocument.create({
      data: {
        generationId: generation.id,
        documentId: document.id,
        projectId: project.id,
        targetSha: document.headCommitSha,
        configFingerprint: generation.configFingerprint,
        status: "failed",
        failureKind: "provider",
        failureSummary: "fixture failure",
        completedAt: new Date(),
      },
    });

    const scopedKey = await callerFor(admin).apiKey.create({
      name: "knowledge-writer",
      capabilities: ["system:admin", "content:write"],
      projectIds: [project.id, viewerProject.id],
    });
    const unrestrictedKey = await callerFor(admin).apiKey.create({
      name: "knowledge-unrestricted",
      capabilities: ["system:admin", "content:write"],
    });
    const adminOnlyKey = await callerFor(admin).apiKey.create({
      name: "knowledge-admin-only",
      capabilities: ["system:admin"],
    });
    const queue = new FakeJobQueue();
    const originalJobsEnabled = process.env.WEAVER_JOBS_ENABLED;
    process.env.WEAVER_JOBS_ENABLED = "true";
    setJobQueueForTests(queue);
    const scoped = await connect(scopedKey.secret);
    const unrestricted = await connect(unrestrictedKey.secret);
    const adminOnly = await connect(adminOnlyKey.secret);
    try {
      const rebuilt = structured<{ generationId: string }>(
        await scoped.callTool({
          name: "rebuild_knowledge_index",
          arguments: { projectId: project.id },
        }),
      );
      expect(rebuilt.generationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        queue.jobs.some((job) => job.name === "project.generation-build"),
      ).toBe(true);

      const retried = structured<{ retried: number; hasMore: boolean }>(
        await scoped.callTool({
          name: "retry_failed_knowledge",
          arguments: { projectId: project.id },
        }),
      );
      expect(retried).toMatchObject({ retried: 1, hasMore: false });
      expect(
        await db.knowledgeGenerationDocument.findUniqueOrThrow({
          where: {
            generationId_documentId: {
              generationId: generation.id,
              documentId: document.id,
            },
          },
        }),
      ).toMatchObject({ status: "pending" });
      expect(queue.jobs.some((job) => job.name === "document.ai-enrich")).toBe(
        true,
      );

      expect(
        structured<{ enqueued: boolean; job: string }>(
          await scoped.callTool({
            name: "enqueue_reconcile",
            arguments: { projectId: project.id },
          }),
        ),
      ).toEqual({ enqueued: true, job: "project.reconcile" });
      expect(queue.jobs.some((job) => job.name === "project.reconcile")).toBe(
        true,
      );
      expect(
        structured<{ enqueued: boolean; job: string }>(
          await adminOnly.callTool({
            name: "enqueue_reconcile",
            arguments: {},
          }),
        ),
      ).toEqual({ enqueued: true, job: "system.reconcile" });

      const deniedRetryStates = await Promise.all([
        seedFailedKnowledgeDocument(outsider.id, "out-of-scope"),
        seedFailedKnowledgeDocument(viewerProject.id, "viewer"),
        seedFailedKnowledgeDocument(
          project.id,
          "missing-capability",
          generation.id,
        ),
      ]);
      const beforeDeniedJobs = queue.jobs.length;
      const beforeDeniedGenerations = await db.knowledgeGeneration.count();
      const deniedCalls = [
        await scoped.callTool({
          name: "rebuild_knowledge_index",
          arguments: { projectId: outsider.id },
        }),
        await unrestricted.callTool({
          name: "enqueue_reconcile",
          arguments: { projectId: nonmember.id },
        }),
        await scoped.callTool({
          name: "enqueue_reconcile",
          arguments: { projectId: viewerProject.id },
        }),
        await adminOnly.callTool({
          name: "rebuild_knowledge_index",
          arguments: { projectId: project.id },
        }),
        await scoped.callTool({
          name: "retry_failed_knowledge",
          arguments: { projectId: outsider.id },
        }),
        await scoped.callTool({
          name: "retry_failed_knowledge",
          arguments: { projectId: viewerProject.id },
        }),
        await adminOnly.callTool({
          name: "retry_failed_knowledge",
          arguments: { projectId: project.id },
        }),
      ];
      expect(
        deniedCalls.map(
          (result) =>
            structured<{ error: { code: string } }>(result).error.code,
        ),
      ).toEqual([
        "SCOPE_VIOLATION",
        "SCOPE_VIOLATION",
        "FORBIDDEN",
        "FORBIDDEN",
        "SCOPE_VIOLATION",
        "FORBIDDEN",
        "FORBIDDEN",
      ]);
      expect(queue.jobs).toHaveLength(beforeDeniedJobs);
      expect(await db.knowledgeGeneration.count()).toBe(
        beforeDeniedGenerations,
      );
      for (const state of deniedRetryStates) {
        expect(
          await db.knowledgeGenerationDocument.findUniqueOrThrow({
            where: { generationId_documentId: state },
          }),
        ).toMatchObject({ status: "failed" });
      }
    } finally {
      await scoped.close();
      await unrestricted.close();
      await adminOnly.close();
      setJobQueueForTests(null);
      if (originalJobsEnabled === undefined) {
        delete process.env.WEAVER_JOBS_ENABLED;
      } else {
        process.env.WEAVER_JOBS_ENABLED = originalJobsEnabled;
      }
    }
  });

  it("bounds knowledge failure previews without losing status metadata", async () => {
    const admin = await makeUser("Admin", "mcp-insight-failures");
    const project = await makeProject("Many failed generations");
    await addMembership(project.id, admin.id, "Maintainer");
    const key = await callerFor(admin).apiKey.create({
      name: "knowledge-failures",
      capabilities: ["system:admin"],
    });
    await getPrisma().knowledgeGeneration.createMany({
      data: Array.from({ length: 50 }, () => ({
        projectId: project.id,
        configFingerprint: "f",
        embeddingModel: "embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "v1",
        status: "failed" as const,
        failureKind: "internal" as const,
        failureSummary: "Long processing failure. ".repeat(12),
      })),
    });
    const client = await connect(key.secret);
    try {
      const result = await client.callTool({
        name: "get_knowledge_status",
        arguments: { projectId: project.id },
      });
      expect(result.isError).not.toBe(true);
      const status = structured<{
        failures: unknown[];
        readiness: unknown;
        truncated: boolean;
      }>(result);
      expect(status.readiness).toBeDefined();
      expect(status.failures.length).toBeGreaterThan(0);
      expect(status.failures.length).toBeLessThan(50);
      expect(status.truncated).toBe(true);
      expect(JSON.stringify(status).length).toBeLessThanOrEqual(16_000);
    } finally {
      await client.close();
    }
  });

  it("reads assistant and audit metadata over MCP without conversation or event payload text", async () => {
    const admin = await makeUser("Admin", "mcp-insight-runs");
    const owner = await makeUser("User", "mcp-insight-run-owner");
    const key = await callerFor(admin).apiKey.create({
      name: "run-inspection",
      capabilities: ["system:admin"],
    });
    const db = getPrisma();
    const sentinel = "private conversation payload sentinel";
    const conversation = await db.assistantConversation.create({
      data: { ownerId: owner.id, title: sentinel },
    });
    const message = await db.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: 1,
        role: "user",
        content: { text: sentinel },
      },
    });
    const run = await db.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        scopeSnapshot: { kind: "all", projectIds: [] },
        actorSnapshot: {},
      },
    });
    await db.assistantRunEvent.createMany({
      data: [
        {
          runId: run.id,
          sequence: 1,
          type: "tool.call",
          payload: { toolName: "list_projects", input: { private: sentinel } },
        },
        {
          runId: run.id,
          sequence: 2,
          type: "text.delta",
          payload: { text: sentinel },
        },
        {
          runId: run.id,
          sequence: 3,
          type: "tool.result",
          payload: { toolName: "list_projects", summary: sentinel },
        },
        {
          runId: run.id,
          sequence: 4,
          type: "tool.call",
          payload: { toolName: sentinel, input: {} },
        },
      ],
    });
    const client = await connect(key.secret);
    try {
      const page = structured<{
        items: Array<{ id: string; ownerId: string; queuedAt: string }>;
      }>(
        await client.callTool({
          name: "list_assistant_runs",
          arguments: {
            userId: owner.id,
            since: "2020-01-01T00:00:00.000Z",
            limit: 1,
          },
        }),
      );
      expect(page.items).toEqual([
        expect.objectContaining({
          id: run.id,
          ownerId: owner.id,
          queuedAt: expect.any(String),
        }),
      ]);
      const detail = structured<{
        events: Array<{
          sequence: number;
          type: string;
          toolName: string | null;
        }>;
      }>(
        await client.callTool({
          name: "get_assistant_run",
          arguments: { runId: run.id },
        }),
      );
      expect(detail.events).toEqual([
        expect.objectContaining({
          sequence: 1,
          type: "tool.call",
          toolName: "list_projects",
        }),
        expect.objectContaining({
          sequence: 2,
          type: "text.delta",
          toolName: null,
        }),
        expect.objectContaining({
          sequence: 3,
          type: "tool.result",
          toolName: "list_projects",
        }),
        expect.objectContaining({
          sequence: 4,
          type: "tool.call",
          toolName: null,
        }),
      ]);
      const audit = structured<{
        items: Array<{ name: string; userId: string; outcome: string }>;
      }>(
        await client.callTool({
          name: "list_mcp_audit_events",
          arguments: {
            name: "get_assistant_run",
            userId: admin.id,
            outcome: "ok",
          },
        }),
      );
      expect(audit.items).toEqual([
        expect.objectContaining({
          name: "get_assistant_run",
          userId: admin.id,
          outcome: "ok",
        }),
      ]);
      for (const output of [page, detail, audit]) {
        expect(JSON.stringify(output)).not.toContain(sentinel);
        expect(JSON.stringify(output).length).toBeLessThanOrEqual(16_000);
      }
    } finally {
      await client.close();
    }
  });

  it("keeps bounded diagnostic lists body-free and resumes after the last returned item", async () => {
    const admin = await makeUser("Admin", "mcp-admin-list");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin-list",
      capabilities: ["system:admin"],
    });
    const ids = [
      "70000000-0000-4000-8000-000000000003",
      "70000000-0000-4000-8000-000000000002",
      "70000000-0000-4000-8000-000000000001",
    ];
    const privateBody = "PRIVATE-DIAGNOSTIC-BODY-MUST-NOT-LIST";
    await getPrisma().diagnosticEvent.createMany({
      data: ids.map((id, index) => ({
        id,
        createdAt: new Date(Date.UTC(2026, 8, 4, 12, 0, 2 - index)),
        runtime: "mcp" as const,
        severity: "info" as const,
        category: "admin",
        event: "admin.tool.called",
        message: `large summary ${index}`,
        details: { padding: "x".repeat(8_000) },
        hasRequestBody: true,
        hasResponseBody: true,
        requestBody: privateBody,
        responseBody: privateBody,
      })),
    });

    const client = await connect(adminKey.secret);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = structured<{
        items: Array<Record<string, unknown> & { id: string }>;
        nextCursor: string | null;
        truncated: boolean;
      }>(
        await client.callTool({
          name: "list_diagnostic_events",
          arguments: { limit: 3, ...(cursor ? { cursor } : {}) },
        }),
      );
      expect(page.items.length).toBeGreaterThan(0);
      expect(
        page.items.every(
          (item) => !("requestBody" in item) && !("responseBody" in item),
        ),
      ).toBe(true);
      expect(JSON.stringify(page)).not.toContain(privateBody);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(ids);
    await client.close();
  });

  it("resolves a diagnostic reference through the admin tools", async () => {
    const admin = await makeUser("Admin", "mcp-admin-reference");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin-reference",
      capabilities: ["system:admin"],
    });
    const event = await getPrisma().diagnosticEvent.create({
      data: {
        id: "b4c5d6e7-2222-4222-8222-222222222222",
        createdAt: new Date("2026-09-12T10:00:00.000Z"),
        runtime: "worker",
        severity: "error",
        category: "job",
        event: "job.failed",
        message: "referenced",
      },
    });
    const client = await connect(adminKey.secret);
    const listed = structured<{ items: Array<{ id: string }> }>(
      await client.callTool({
        name: "list_diagnostic_events",
        arguments: { reference: "b4c5d6e7" },
      }),
    );
    expect(listed.items.map((item) => item.id)).toEqual([event.id]);
    const one = structured<{ event: { id: string } }>(
      await client.callTool({
        name: "get_diagnostic_event",
        arguments: { reference: "b4c5d6e7" },
      }),
    );
    expect(one.event.id).toBe(event.id);
    const invalid = await client.callTool({
      name: "get_diagnostic_event",
      arguments: { id: event.id, reference: "b4c5d6e7" },
    });
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it("keeps a large diagnostic event and escape-heavy body in the structured MCP envelope", async () => {
    const admin = await makeUser("Admin", "mcp-admin-event");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin-event",
      capabilities: ["system:admin"],
    });
    const privateTail = "PRIVATE-TAIL-MUST-STAY-BEYOND-THE-SLICE";
    const requestBody = `${'😀\\"'.repeat(6_000)}${privateTail}`;
    const event = await getPrisma().diagnosticEvent.create({
      data: {
        createdAt: new Date("2026-09-04T12:00:00.000Z"),
        runtime: "mcp",
        severity: "info",
        category: "admin",
        event: "admin.tool.called",
        message: "large detail and body",
        details: { padding: "x".repeat(8_000) },
        hasRequestBody: true,
        requestBody,
      },
    });

    const client = await connect(adminKey.secret);
    const result = await client.callTool({
      name: "get_diagnostic_event",
      arguments: { id: event.id, body: "request", offset: 4 },
    });
    expect(result.isError).toBeFalsy();
    const output = structured<{
      event: { id: string };
      body: {
        part: "request";
        text: string;
        offset: number;
        nextOffset: number | null;
        total: number;
      };
    }>(result);
    expect(output.event.id).toBe(event.id);
    expect(output.body).toMatchObject({
      part: "request",
      offset: 4,
      total: requestBody.length,
    });
    expect(output.body.text.length).toBeGreaterThan(0);
    expect(requestBody.slice(4, 4 + output.body.text.length)).toBe(
      output.body.text,
    );
    expect(output.body.nextOffset).toBe(4 + output.body.text.length);
    const tailCode = output.body.text.charCodeAt(output.body.text.length - 1);
    expect(tailCode < 0xd800 || tailCode > 0xdbff).toBe(true);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(output)).not.toContain(privateTail);
    expect(output).not.toHaveProperty("partialJson");
    await client.close();
  });

  it("pages a writer-sanitized emoji body on complete surrogate pairs", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "mcp-admin-emoji-body");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin-emoji-body",
      capabilities: ["system:admin"],
    });
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "verbose",
    });
    startDiagnosticWriter({
      db,
      runtime: "mcp",
      flushIntervalMs: 60_000,
    });

    let client: Client | undefined;
    try {
      await waitForDiagnosticWriterReady();
      const requestBody = JSON.stringify({
        text: Array.from({ length: 14 }, () => "😀".repeat(1_000)),
      });
      emitDiagnostic({
        event: "ai.request",
        message: "emoji body boundary",
        requestBody,
      });
      await flushDiagnostics(true);
      const event = await db.diagnosticEvent.findFirstOrThrow({
        where: { event: "ai.request", message: "emoji body boundary" },
      });
      expect(event.requestBody).toBe(requestBody);

      client = await connect(adminKey.secret);
      type BodyPage = {
        event: { id: string };
        body: {
          part: "request";
          text: string;
          offset: number;
          nextOffset: number | null;
          total: number;
        };
      };
      const readPage = async (offset: number) =>
        structured<BodyPage>(
          await client!.callTool({
            name: "get_diagnostic_event",
            arguments: { id: event.id, body: "request", offset },
          }),
        );
      const expectCompleteBoundaries = (text: string) => {
        expect(text.length).toBeGreaterThan(0);
        const first = text.charCodeAt(0);
        const last = text.charCodeAt(text.length - 1);
        expect(first < 0xdc00 || first > 0xdfff).toBe(true);
        expect(last < 0xd800 || last > 0xdbff).toBe(true);
      };

      let reconstructed = "";
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null && pages < 10) {
        const page = await readPage(offset);
        expect(page.event.id).toBe(event.id);
        expect(page.body.offset).toBe(offset);
        expect(page.body.total).toBe(requestBody.length);
        expectCompleteBoundaries(page.body.text);
        expect(
          requestBody.slice(
            page.body.offset,
            page.body.offset + page.body.text.length,
          ),
        ).toBe(page.body.text);
        expect(JSON.stringify(page).length).toBeLessThanOrEqual(16_000);
        if (page.body.nextOffset !== null) {
          expect(page.body.nextOffset).toBe(
            page.body.offset + page.body.text.length,
          );
          expect(page.body.nextOffset).toBeGreaterThan(page.body.offset);
        }
        reconstructed += page.body.text;
        offset = page.body.nextOffset;
        pages += 1;
      }
      expect(offset).toBeNull();
      expect(reconstructed).toBe(requestBody);

      const insidePair = await readPage(11);
      expect(insidePair.body.offset).toBe(10);
      expectCompleteBoundaries(insidePair.body.text);
      expect(
        requestBody.slice(
          insidePair.body.offset,
          insidePair.body.offset + insidePair.body.text.length,
        ),
      ).toBe(insidePair.body.text);
      expect(insidePair.body.nextOffset).toBe(
        insidePair.body.offset + insidePair.body.text.length,
      );
    } finally {
      await client?.close();
      await stopDiagnosticWriter();
      invalidateDiagnosticsSettingsCache();
    }
  });

  it("records ISO diagnostic filters as validated SDK argument metadata", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "mcp-admin-metadata");
    const adminKey = await callerFor(admin).apiKey.create({
      name: "admin-metadata",
      capabilities: ["system:admin"],
    });
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "standard",
    });
    startDiagnosticWriter({
      db,
      runtime: "mcp",
      flushIntervalMs: 60_000,
    });
    await waitForDiagnosticWriterReady();

    let client: Client | undefined;
    try {
      client = await connect(adminKey.secret);
      const projectId = randomUUID();
      const result = await client.callTool({
        name: "list_diagnostic_events",
        arguments: {
          since: "2026-09-04T00:00:00.000Z",
          until: "2026-09-05T00:00:00.000Z",
          projectId,
          limit: 10,
        },
      });
      expect(result.isError).toBeFalsy();
      await flushDiagnostics(true);

      const rows = await db.diagnosticEvent.findMany({
        where: {
          event: { in: ["mcp.tool.called", "admin.tool.called"] },
        },
      });
      expect(rows.find((row) => row.event === "mcp.tool.called")).toMatchObject(
        { projectId },
      );
      expect(
        rows.find((row) => row.event === "admin.tool.called"),
      ).toMatchObject({
        details: {
          tool: "list_diagnostic_events",
          argumentNames: ["since", "until", "projectId", "limit"],
        },
      });
    } finally {
      await client?.close();
      await stopDiagnosticWriter();
      invalidateDiagnosticsSettingsCache();
    }
  });

  it("lets a write-only OAuth grant write while keeping reads hidden", async () => {
    const { user, project } = await fixture("write-only-oauth");
    const tokens = await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:write",
    );
    const client = await connect(
      tokens.access_token,
      endpoint(),
      "2026-07-28",
      ALL,
    );

    expect(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ).toEqual([...WRITE_TOOLS, ...META_TOOLS].sort());
    const created = structured<{ resourceId: string; commitSha: string }>(
      await client.callTool({
        name: "create_document",
        arguments: {
          projectId: project.id,
          folderPath: [],
          title: "Write-only OAuth",
          markdown: "# Written\n",
          idempotencyKey: "write-only-oauth-0001",
          summary: "Create through a write-only OAuth grant",
        },
      }),
    );
    expect(created.commitSha).toMatch(/^[0-9a-f]{40}$/u);

    const uri = resourceUriFor({
      kind: "document",
      projectId: project.id,
      documentId: created.resourceId,
    });
    await expect(client.readResource({ uri })).rejects.toMatchObject({
      code: -32602,
    });
    await client.close();
  });

  it("uses one 100-project scope for tools and resources and reports the clamp", async () => {
    const { user, project, doc, readKey } = await fixture("scope-cap");
    const newestIds = await makeNewerProjectMemberships(user.id, 100);
    const client = await connect(readKey.secret);

    const listed = structured<{
      projects: Array<{ id: string }>;
      truncated: boolean;
    }>(await client.callTool({ name: "list_projects", arguments: {} }));
    expect(listed.projects.map((item) => item.id)).toEqual(newestIds);
    expect(listed.truncated).toBe(true);
    expect(listed.projects.map((item) => item.id)).not.toContain(project.id);

    const cappedUri = resourceUriFor({
      kind: "document",
      projectId: project.id,
      documentId: doc.id,
    });
    await expect(client.readResource({ uri: cappedUri })).rejects.toMatchObject(
      { code: -32602 },
    );
    await client.close();
  });

  it("keeps capped JSON resources parseable and marks their representation truncated", async () => {
    const { user, project, readKey } = await fixture("json-cap");
    const table = await createTable(
      getPrisma(),
      {
        projectId: project.id,
        folderPath: [],
        title: "Large MCP table",
        columns: [{ id: COL_TASK, name: "Task", type: "text" }],
        rows: Array.from({ length: 20 }, (_unused, index) => ({
          id: randomUUID(),
          cells: { [COL_TASK]: `${index}-${"x".repeat(200)}` },
        })),
      },
      {
        ...securityContextFor(user),
        name: "Spec",
        email: user.email,
      },
    );
    const isolated = await startServer({ maxResourceChars: 1_000 });
    const client = await connect(readKey.secret, isolated.endpoint);
    try {
      const result = await client.readResource({
        uri: resourceUriFor({
          kind: "table",
          projectId: project.id,
          tableId: table.id,
        }),
      });
      const text = (result.contents[0] as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(1_000);
      expect(JSON.parse(text)).toMatchObject({ truncated: true });
      expect(result._meta).toMatchObject({
        "net.weaver/truncated": true,
      });
    } finally {
      await client.close();
      await isolated.server.close();
    }
  });

  it("names a missing folder on direct writes and never creates one implicitly", async () => {
    const { project, writeKey } = await fixture("missing-folder");
    const client = await connect(writeKey.secret);
    try {
      const create = await client.callTool({
        name: "create_document",
        arguments: {
          projectId: project.id,
          folderPath: ["b2bi", "cleanup"],
          title: "Lost",
          markdown: "# Lost\n",
          idempotencyKey: "spec-missing-folder-0001",
          summary: "Create into a folder that is not there",
        },
      });
      expect(create.isError).toBe(true);
      const error = structured<{
        error: { code: string; message: string; reason?: string };
      }>(create).error;
      expect(error).toMatchObject({
        code: "NOT_FOUND",
        reason: "FOLDER_NOT_FOUND",
      });
      expect(error.message).toContain(
        "folderPath names a folder that does not exist",
      );
      expect(error.message).toContain("list_content_folders");

      const listed = structured<{
        baseProjectCommitSha: string;
        folders: unknown[];
      }>(
        await client.callTool({
          name: "list_content_folders",
          arguments: { projectId: project.id, resourceType: "document" },
        }),
      );
      expect(listed.folders).toEqual([]);

      const nested = await client.callTool({
        name: "apply_content_lifecycle",
        arguments: {
          projectId: project.id,
          action: "folder_create",
          resourceType: "document",
          parentPath: ["b2bi"],
          name: "Cleanup",
          baseProjectCommitSha: listed.baseProjectCommitSha,
          idempotencyKey: "spec-missing-parent-0001",
          summary: "Create under a parent that is not there",
        },
      });
      expect(nested.isError).toBe(true);
      expect(
        structured<{ error: { message: string; reason?: string } }>(nested)
          .error,
      ).toMatchObject({
        reason: "FOLDER_NOT_FOUND",
        message: expect.stringContaining(
          "parentPath names a folder that does not exist",
        ),
      });
    } finally {
      await client.close();
    }
  });

  it("commits all direct writes, recovers a Git-only commit, and audits without payloads", async () => {
    const { db, user, project, doc, writeKey } = await fixture("write");
    const actor = {
      ...securityContextFor(user),
      name: "Spec",
      email: user.email,
    };
    const client = await connect(writeKey.secret);
    const read = structured<{ commitSha: string }>(
      await client.callTool({
        name: "read_document",
        arguments: { projectId: project.id, documentId: doc.id },
      }),
    );
    const payloadMarker = "MCP-AUDIT-MUST-NOT-LEAK";

    const createdDocument = structured<{
      resourceId: string;
      commitSha: string;
      replayed: boolean;
    }>(
      await client.callTool({
        name: "create_document",
        arguments: {
          projectId: project.id,
          folderPath: [],
          title: "MCP decisions",
          markdown: `# Decisions\n\n${payloadMarker}\n`,
          idempotencyKey: "spec-create-document-0001",
          summary: "Create a document over MCP",
        },
      }),
    );
    expect(createdDocument.replayed).toBe(false);
    const createdDocumentState = await getDocument(
      db,
      { projectId: project.id, documentId: createdDocument.resourceId },
      actor,
    );
    expect(createdDocumentState.baseCommitSha).toBe(createdDocument.commitSha);
    expect(
      serializeDocumentBody(markdownContent(createdDocumentState)),
    ).toContain(payloadMarker);

    const args = {
      projectId: project.id,
      documentId: doc.id,
      baseCommitSha: read.commitSha,
      markdown: "# Handbook\n\nWelcome aboard, updated over MCP.\n",
      idempotencyKey: "spec-update-0001",
      summary: "Update the handbook over MCP",
    };
    const first = structured<{ commitSha: string; replayed: boolean }>(
      await client.callTool({ name: "update_document", arguments: args }),
    );
    expect(first.replayed).toBe(false);
    const again = structured<{ commitSha: string; replayed: boolean }>(
      await client.callTool({ name: "update_document", arguments: args }),
    );
    expect(again).toEqual({ ...first, replayed: true });

    const createdTable = structured<{
      resourceId: string;
      commitSha: string;
      replayed: boolean;
    }>(
      await client.callTool({
        name: "create_table",
        arguments: {
          projectId: project.id,
          folderPath: [],
          title: "MCP tasks",
          columns: [{ id: COL_TASK, name: "Task", type: "text" }],
          rows: [{ id: ROW_PLAN, cells: { [COL_TASK]: payloadMarker } }],
          idempotencyKey: "spec-create-table-0001",
          summary: "Create a table over MCP",
        },
      }),
    );
    const schema = structured<{ commitSha: string; replayed: boolean }>(
      await client.callTool({
        name: "update_table_schema",
        arguments: {
          projectId: project.id,
          tableId: createdTable.resourceId,
          baseCommitSha: createdTable.commitSha,
          changes: [
            {
              op: "add",
              column: { id: COL_OWNER, name: "Owner", type: "text" },
            },
          ],
          idempotencyKey: "spec-update-schema-0001",
          summary: "Add the owner column over MCP",
        },
      }),
    );
    const changedRows = structured<{ commitSha: string; replayed: boolean }>(
      await client.callTool({
        name: "update_table_rows",
        arguments: {
          projectId: project.id,
          tableId: createdTable.resourceId,
          baseCommitSha: schema.commitSha,
          inserts: [
            {
              id: ROW_SHIP,
              cells: { [COL_TASK]: "Ship", [COL_OWNER]: "Platform" },
            },
          ],
          updates: [{ rowId: ROW_PLAN, cells: { [COL_OWNER]: "Docs" } }],
          deletes: [],
          idempotencyKey: "spec-update-rows-0001",
          summary: "Update task rows over MCP",
        },
      }),
    );
    const tableState = await getTable(
      db,
      { projectId: project.id, tableId: createdTable.resourceId },
      actor,
    );
    expect(tableState.baseCommitSha).toBe(changedRows.commitSha);
    expect(tableState.columns.map((column) => column.id)).toEqual([
      COL_TASK,
      COL_OWNER,
    ]);
    expect(tableState.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ROW_PLAN,
          cells: expect.objectContaining({ [COL_OWNER]: "Docs" }),
        }),
        expect.objectContaining({ id: ROW_SHIP }),
      ]),
    );

    const recoveryKey = "spec-recover-0001";
    const recoveryOperation = {
      kind: "document.edit" as const,
      projectId: project.id,
      documentId: doc.id,
      baseCommitSha: first.commitSha,
      markdown: "# Handbook\n\nRecovered from the committed Git trailer.\n",
    };
    const recoverySummary = "Recover a Git-only direct write";
    const recoveryHash = requestHash({
      toolName: "update_document",
      operation: recoveryOperation,
      summary: recoverySummary,
    });
    const committedBeforeRow = await withProjectRepo(
      project.id,
      async (repo) => {
        const base = await checkOperationBase(db, repo, recoveryOperation);
        if (!base.ok)
          throw new Error(`unexpected recovery base: ${base.reason}`);
        return applyOperationInRepo(db, repo, recoveryOperation, actor, {
          table: base.table,
          summary: recoverySummary,
          operationId: mcpOperationId(user.id, recoveryKey),
          mcpRequestHash: recoveryHash,
          mcpToolName: "update_document",
        });
      },
    );
    expect(
      await db.mcpOperation.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: user.id,
            idempotencyKey: recoveryKey,
          },
        },
      }),
    ).toBeNull();
    const recovered = structured<{ commitSha: string; replayed: boolean }>(
      await client.callTool({
        name: "update_document",
        arguments: {
          ...recoveryOperation,
          idempotencyKey: recoveryKey,
          summary: recoverySummary,
        },
      }),
    );
    expect(recovered).toMatchObject({
      commitSha: committedBeforeRow.commitSha,
      replayed: false,
    });
    expect(
      await db.mcpOperation.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: user.id,
            idempotencyKey: recoveryKey,
          },
        },
      }),
    ).toMatchObject({ commitSha: committedBeforeRow.commitSha });

    const stale = await client.callTool({
      name: "update_document",
      arguments: {
        ...args,
        idempotencyKey: "spec-update-0002",
        markdown: "# Handbook\n\nStale.\n",
      },
    });
    expect(stale.isError).toBe(true);
    expect(structured<{ error: { code: string } }>(stale).error.code).toBe(
      "CONFLICT",
    );

    const reused = await client.callTool({
      name: "update_document",
      arguments: {
        ...args,
        baseCommitSha: recovered.commitSha,
        markdown: "# Handbook\n\nOther.\n",
      },
    });
    expect(reused.isError).toBe(true);
    expect(structured<{ error: { code: string } }>(reused).error.code).toBe(
      "CONFLICT",
    );

    expect(await db.mcpOperation.count()).toBe(6);
    const audit = await db.mcpAuditEvent.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((event) => [event.name, event.outcome])).toEqual([
      ["read_document", "ok"],
      ["create_document", "ok"],
      ["update_document", "ok"],
      ["update_document", "ok"],
      ["create_table", "ok"],
      ["update_table_schema", "ok"],
      ["update_table_rows", "ok"],
      ["update_document", "ok"],
      ["update_document", "error"],
      ["update_document", "error"],
    ]);
    expect(audit.every((event) => event.method === "tools/call")).toBe(true);
    expect(
      audit.every(
        (event) =>
          event.userId === user.id &&
          event.credentialId === writeKey.key.id &&
          event.authenticationMethod === "apiKey" &&
          event.clientId === null &&
          event.projectId === project.id,
      ),
    ).toBe(true);
    expect(audit[1]?.commitSha).toBe(createdDocument.commitSha);
    expect(audit[2]?.commitSha).toBe(first.commitSha);
    expect(audit[3]?.commitSha).toBe(first.commitSha);
    expect(audit[4]?.commitSha).toBe(createdTable.commitSha);
    expect(audit[5]?.commitSha).toBe(schema.commitSha);
    expect(audit[6]?.commitSha).toBe(changedRows.commitSha);
    expect(audit[7]?.commitSha).toBe(recovered.commitSha);
    expect(audit.every((event) => event.requestId.length === 36)).toBe(true);
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain(payloadMarker);
    expect(serializedAudit).not.toContain(writeKey.secret);
    expect(serializedAudit).not.toMatch(/"(arguments|payload|result|token)":/);
    await client.close();
  });

  it("cancels a write blocked on the Git lock without committing after the response", async () => {
    const { db, project, writeKey } = await fixture("write-timeout");
    const headBefore = await withProjectRepo(project.id, (repo) =>
      repo.resolveHead(),
    );
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withProjectRepo(project.id, async () => {
      markLocked();
      await holdLock;
    });
    await locked;

    const isolated = await startServer({ toolTimeoutMs: 150 });
    const client = await connect(writeKey.secret, isolated.endpoint);
    try {
      const result = await client.callTool({
        name: "create_document",
        arguments: {
          projectId: project.id,
          folderPath: [],
          title: "Must never commit",
          markdown: "# Too late\n",
          idempotencyKey: "timeout-write-0001",
          summary: "A timed-out write",
        },
      });
      expect(result.isError).toBe(true);
      expect(structured<{ error: { code: string } }>(result)).toMatchObject({
        error: { code: "CANCELLED" },
      });

      releaseLock();
      await blocker;
      // Drain earlier same-project waiters so no detached write stays queued.
      await withProjectRepo(project.id, async () => undefined);
      expect(
        await withProjectRepo(project.id, (repo) => repo.resolveHead()),
      ).toBe(headBefore);
      expect(
        await db.document.count({
          where: { projectId: project.id, title: "Must never commit" },
        }),
      ).toBe(0);
      expect(
        await db.mcpOperation.count({
          where: { idempotencyKey: "timeout-write-0001" },
        }),
      ).toBe(0);
      expect(
        await db.mcpAuditEvent.findMany({
          where: { credentialId: writeKey.key.id, name: "create_document" },
          select: { outcome: true, errorCode: true, commitSha: true },
        }),
      ).toEqual([
        { outcome: "error", errorCode: "CANCELLED", commitSha: null },
      ]);
    } finally {
      releaseLock();
      await blocker.catch(() => undefined);
      await client.close();
      await isolated.server.close();
    }
  });

  it("keeps incoming HTTP abort cancellation before write admission", async () => {
    const { db, project, writeKey } = await fixture("write-http-pre-abort");
    const headBefore = await withProjectRepo(project.id, (repo) =>
      repo.resolveHead(),
    );
    const handler = createMcpHttpHandler({
      db,
      verifiers: createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: TEST_MCP_RESOURCE,
      }),
      config,
      runtimeFacts,
      log: () => undefined,
    });
    const controller = new AbortController();
    controller.abort();

    try {
      const response = await handler.fetch(
        directToolRequest(
          writeKey.secret,
          "create_document",
          {
            projectId: project.id,
            folderPath: [],
            title: "Cancelled before admission",
            markdown: "# Never committed\n",
            idempotencyKey: "transport-abort-before-admit-0001",
            summary: "Preserve early cancellation",
          },
          controller.signal,
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "CANCELLED" } },
        },
      });
      expect(
        await withProjectRepo(project.id, (repo) => repo.resolveHead()),
      ).toBe(headBefore);
      expect(
        await db.document.count({
          where: { projectId: project.id, title: "Cancelled before admission" },
        }),
      ).toBe(0);
      expect(
        await db.mcpOperation.count({
          where: { idempotencyKey: "transport-abort-before-admit-0001" },
        }),
      ).toBe(0);
      expect(
        await db.mcpAuditEvent.findMany({
          where: {
            credentialId: writeKey.key.id,
            name: "create_document",
          },
          select: { outcome: true, errorCode: true, commitSha: true },
        }),
      ).toEqual([
        { outcome: "error", errorCode: "CANCELLED", commitSha: null },
      ]);
    } finally {
      await handler.close();
    }
  });

  it("waits for the committed result when HTTP aborts after write admission", async () => {
    const { db, project, writeKey } = await fixture("write-http-abort");
    const gitDir = path.join(repoDir(project.id), ".git");
    const hook = path.join(gitDir, "hooks", "pre-commit");
    const admitted = path.join(gitDir, "mcp-write-admitted");
    const release = path.join(gitDir, "mcp-write-release");
    await writeFile(
      hook,
      "#!/bin/sh\n: > .git/mcp-write-admitted\nwhile [ ! -e .git/mcp-write-release ]; do sleep 0.01; done\n",
      { mode: 0o755 },
    );

    const handler = createMcpHttpHandler({
      db,
      verifiers: createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: TEST_MCP_RESOURCE,
      }),
      config,
      runtimeFacts,
      log: () => undefined,
    });
    const controller = new AbortController();
    const pending = handler.fetch(
      directToolRequest(
        writeKey.secret,
        "create_document",
        {
          projectId: project.id,
          folderPath: [],
          title: "Committed through transport abort",
          markdown: "# Durable result\n",
          idempotencyKey: "transport-abort-after-admit-0001",
          summary: "Prove transport abort shielding",
        },
        controller.signal,
      ),
    );

    try {
      await waitForFile(admitted);
      controller.abort();
      const returnedBeforeRelease = await Promise.race([
        pending.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      await writeFile(release, "");
      const response = await pending;
      const headAfter = await withProjectRepo(project.id, (repo) =>
        repo.resolveHead(),
      );

      expect(returnedBeforeRelease).toBe(false);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: { commitSha?: string; error?: { code?: string } };
        };
      };
      expect(body.result?.isError).not.toBe(true);
      expect(body.result?.structuredContent?.error).toBeUndefined();
      const commitSha = body.result?.structuredContent?.commitSha;
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(headAfter).toBe(commitSha);
      expect(
        await db.document.count({
          where: {
            projectId: project.id,
            title: "Committed through transport abort",
          },
        }),
      ).toBe(1);
      expect(
        await db.mcpAuditEvent.findMany({
          where: {
            credentialId: writeKey.key.id,
            name: "create_document",
          },
          select: { outcome: true, errorCode: true, commitSha: true },
        }),
      ).toEqual([{ outcome: "ok", errorCode: null, commitSha }]);
    } finally {
      await writeFile(release, "").catch(() => undefined);
      await withProjectRepo(project.id, async () => undefined).catch(
        () => undefined,
      );
      await Promise.all([
        rm(hook, { force: true }),
        rm(admitted, { force: true }),
        rm(release, { force: true }),
      ]);
      await handler.close();
    }
  });

  it.each(["2026-07-28", "2025-11-25"])(
    "drains an admitted %s write before Node server shutdown",
    async (protocolVersion) => {
      const { db, project, writeKey } = await fixture("write-node-shutdown");
      const gitDir = path.join(repoDir(project.id), ".git");
      const hook = path.join(gitDir, "hooks", "pre-commit");
      const admitted = path.join(gitDir, "mcp-write-admitted");
      const release = path.join(gitDir, "mcp-write-release");
      await writeFile(
        hook,
        "#!/bin/sh\n: > .git/mcp-write-admitted\nwhile [ ! -e .git/mcp-write-release ]; do sleep 0.01; done\n",
        { mode: 0o755 },
      );

      const handler = createMcpHttpHandler({
        db,
        verifiers: createBearerVerifiers(testAuth(), {
          issuer: TEST_ISSUER,
          audience: TEST_MCP_RESOURCE,
        }),
        config,
        runtimeFacts,
        log: () => undefined,
      });
      const isolated = await createMcpNodeServer(handler, {
        port: 0,
        host: "127.0.0.1",
      });
      const target = new URL(`http://127.0.0.1:${isolated.port}/api/mcp`);
      const pending = fetch(
        directToolRequest(
          writeKey.secret,
          "create_document",
          {
            projectId: project.id,
            folderPath: [],
            title: "Committed through shutdown",
            markdown: "# Durable shutdown result\n",
            idempotencyKey: "shutdown-after-admit-0001",
            summary: "Drain the admitted write",
          },
          new AbortController().signal,
          target,
          protocolVersion,
        ),
      );
      let firstClose: Promise<void> | undefined;
      let secondClose: Promise<void> | undefined;

      try {
        await waitForFile(admitted);
        firstClose = isolated.close();
        secondClose = isolated.close();
        const [requestReturned, shutdownFinished] = await Promise.all([
          Promise.race([
            pending.then(() => true),
            new Promise<false>((resolve) =>
              setTimeout(() => resolve(false), 100),
            ),
          ]),
          Promise.race([
            firstClose.then(() => true),
            new Promise<false>((resolve) =>
              setTimeout(() => resolve(false), 100),
            ),
          ]),
        ]);
        await writeFile(release, "");
        const response = await pending;
        const closeResults = await Promise.allSettled([
          firstClose,
          secondClose,
        ]);
        const headAfter = await withProjectRepo(project.id, (repo) =>
          repo.resolveHead(),
        );

        expect(requestReturned).toBe(false);
        expect(shutdownFinished).toBe(false);
        expect(secondClose).toBe(firstClose);
        expect(closeResults).toEqual([
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({ status: "fulfilled" }),
        ]);
        expect(response.status).toBe(200);
        const wire = await response.text();
        const message =
          protocolVersion === "2026-07-28"
            ? wire
            : wire
                .split("\n")
                .find((line) => line.startsWith("data: "))!
                .slice(6);
        const body = JSON.parse(message) as {
          result?: {
            isError?: boolean;
            structuredContent?: {
              commitSha?: string;
              error?: { code?: string };
            };
          };
        };
        expect(body.result?.isError).not.toBe(true);
        expect(body.result?.structuredContent?.error).toBeUndefined();
        const commitSha = body.result?.structuredContent?.commitSha;
        expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
        expect(headAfter).toBe(commitSha);
        expect(
          await db.document.count({
            where: {
              projectId: project.id,
              title: "Committed through shutdown",
            },
          }),
        ).toBe(1);
        expect(
          await db.mcpAuditEvent.findMany({
            where: {
              credentialId: writeKey.key.id,
              name: "create_document",
            },
            select: { outcome: true, errorCode: true, commitSha: true },
          }),
        ).toEqual([{ outcome: "ok", errorCode: null, commitSha }]);
      } finally {
        await writeFile(release, "").catch(() => undefined);
        await withProjectRepo(project.id, async () => undefined).catch(
          () => undefined,
        );
        await pending.catch(() => undefined);
        await Promise.allSettled([
          firstClose ?? isolated.close(),
          secondClose ?? Promise.resolve(),
        ]);
        await Promise.all([
          rm(hook, { force: true }),
          rm(admitted, { force: true }),
          rm(release, { force: true }),
        ]);
      }
    },
  );

  it("authenticates OAuth tokens, enforces mcp:use, and honours consent revocation", async () => {
    const { db, user, project } = await fixture("oauth");
    const cookie = await sessionCookieFor(user.email);
    const tokens = await obtainAccessToken(cookie, "mcp:use content:read");
    const client = await connect(tokens.access_token);
    const projects = structured<{ projects: Array<{ id: string }> }>(
      await client.callTool({ name: "list_projects", arguments: {} }),
    );
    expect(projects.projects.map((p) => p.id)).toContain(project.id);
    await client.close();

    const narrow = await obtainAccessToken(cookie, "content:read", false);
    const forbidden = await rpc(
      "server/discover",
      {},
      { authorization: `Bearer ${narrow.access_token}` },
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toContain(
      'scope="mcp:use"',
    );

    await db.oauthConsent.deleteMany({
      where: { userId: user.id, clientId: TEST_OAUTH_CLIENT_ID },
    });
    const revoked = await rpc(
      "server/discover",
      {},
      { authorization: `Bearer ${tokens.access_token}` },
    );
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  it("requires a DPoP proof for a DPoP-bound token", async () => {
    await getPrisma().oauthClient.update({
      where: { clientId: TEST_OAUTH_CLIENT_ID },
      data: { dpopBoundAccessTokens: true },
    });
    const { user, project } = await fixture("dpop");
    const cookie = await sessionCookieFor(user.email);
    const key = await generateDpopKey();
    const bound = await obtainDpopBoundToken(cookie, key);

    const bare = await rpc(
      "server/discover",
      {},
      { authorization: `Bearer ${bound.access_token}` },
    );
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toMatch(/^DPoP algs=/);

    const proof = await dpopProofFor(key, {
      htm: "POST",
      htu: TEST_MCP_RESOURCE,
      accessToken: bound.access_token,
    });
    const client = new Client(
      { name: "weaver-spec-dpop", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(endpoint(), {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `DPoP ${bound.access_token}`);
          headers.set(
            "dpop",
            await dpopProofFor(key, {
              htm: "POST",
              htu: TEST_MCP_RESOURCE,
              accessToken: bound.access_token,
            }),
          );
          return fetch(input, { ...init, headers });
        },
      }),
    );
    const projects = structured<{ projects: Array<{ id: string }> }>(
      await client.callTool({ name: "list_projects", arguments: {} }),
    );
    expect(projects.projects.map((p) => p.id)).toContain(project.id);
    await client.close();

    const replayed = await rpc(
      "server/discover",
      {},
      { authorization: `DPoP ${bound.access_token}`, dpop: proof },
    );
    const replayedAgain = await rpc(
      "server/discover",
      {},
      { authorization: `DPoP ${bound.access_token}`, dpop: proof },
    );
    expect([replayed.status, replayedAgain.status]).toEqual([200, 401]);
  });

  it("reserves a replayed DPoP proof once across independent verifier instances", async () => {
    await getPrisma().oauthClient.update({
      where: { clientId: TEST_OAUTH_CLIENT_ID },
      data: { dpopBoundAccessTokens: true },
    });
    const { user } = await fixture("dpop-concurrent");
    const cookie = await sessionCookieFor(user.email);
    const key = await generateDpopKey();
    const bound = await obtainDpopBoundToken(cookie, key);
    const proof = await dpopProofFor(key, {
      htm: "POST",
      htu: TEST_MCP_RESOURCE,
      accessToken: bound.access_token,
    });
    const first = await startServer();
    const second = await startServer();
    try {
      const responses = await Promise.all(
        [first.endpoint, second.endpoint].map((target) =>
          rpc(
            "server/discover",
            {},
            {
              authorization: `DPoP ${bound.access_token}`,
              dpop: proof,
            },
            target,
          ),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 401,
      ]);
    } finally {
      await Promise.all([first.server.close(), second.server.close()]);
    }
  });

  it("prunes only expired DPoP replay reservations through the indexed prefix", async () => {
    await getPrisma().oauthClient.update({
      where: { clientId: TEST_OAUTH_CLIENT_ID },
      data: { dpopBoundAccessTokens: true },
    });
    const { user } = await fixture("dpop-prune");
    const now = Date.now();
    const expiredDpopId = randomUUID();
    const liveDpopId = randomUUID();
    const expiredOtherId = randomUUID();
    await getPrisma().verification.createMany({
      data: [
        {
          id: expiredDpopId,
          identifier: "dpop-proof:expired-integration",
          value: "expired",
          expiresAt: new Date(now - 60_000),
        },
        {
          id: liveDpopId,
          identifier: "dpop-proof:live-integration",
          value: "live",
          expiresAt: new Date(now + 60_000),
        },
        {
          id: expiredOtherId,
          identifier: "password-reset:expired-integration",
          value: "other",
          expiresAt: new Date(now - 60_000),
        },
      ],
    });
    const cookie = await sessionCookieFor(user.email);
    const key = await generateDpopKey();
    const bound = await obtainDpopBoundToken(cookie, key);
    const proof = await dpopProofFor(key, {
      htm: "POST",
      htu: TEST_MCP_RESOURCE,
      accessToken: bound.access_token,
    });

    const response = await rpc(
      "server/discover",
      {},
      { authorization: `DPoP ${bound.access_token}`, dpop: proof },
    );
    expect(response.status).toBe(200);
    expect(
      await getPrisma().verification.findUnique({
        where: { id: expiredDpopId },
      }),
    ).toBeNull();
    expect(
      await getPrisma().verification.findMany({
        where: { id: { in: [liveDpopId, expiredOtherId] } },
        orderBy: { id: "asc" },
      }),
    ).toHaveLength(2);
    const indexes = await getPrisma().$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'Verification'
        AND indexname = 'Verification_dpop_replay_expiry_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain(
      `WHERE (identifier ~~ 'dpop-proof:%'::text)`,
    );
  });

  it.each(["2025-06-18", "2025-11-25"] as const)(
    "serves a %s client with credential-scoped tools and reads",
    async (protocolVersion) => {
      const { db, user, project, hidden, doc, readKey } =
        await fixture(protocolVersion);
      const client = await connect(
        readKey.secret,
        endpoint(),
        protocolVersion,
        ALL,
      );
      try {
        expect(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
        ).toEqual([...READ_TOOLS, ...META_TOOLS].sort());
        const projects = structured<{ projects: Array<{ id: string }> }>(
          await client.callTool({ name: "list_projects", arguments: {} }),
        );
        expect(projects.projects.map((item) => item.id)).toContain(project.id);
        expect(projects.projects.map((item) => item.id)).not.toContain(
          hidden.id,
        );
        const read = await client.callTool({
          name: "read_document",
          arguments: { projectId: project.id, documentId: doc.id },
        });
        expect(read.isError).toBeFalsy();
        expect(structured<{ markdown: string }>(read).markdown).toContain(
          "Welcome aboard.",
        );
        expect(
          await db.mcpAuditEvent.findMany({
            where: { credentialId: readKey.key.id },
            select: { name: true, outcome: true, errorCode: true },
            orderBy: { createdAt: "asc" },
          }),
        ).toEqual([
          { name: "list_projects", outcome: "ok", errorCode: null },
          { name: "read_document", outcome: "ok", errorCode: null },
        ]);
        await callerFor(user).apiKey.revoke({ keyId: readKey.key.id });
        await expect(client.listTools()).rejects.toThrow();
      } finally {
        await client.close();
      }
    },
  );

  it("rejects header-mismatched, unauthenticated, and oversized requests", async () => {
    const { project, doc, readKey } = await fixture("protocol");
    const auth = { authorization: `Bearer ${readKey.secret}` };

    const anonymous = await rpc("server/discover");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp", scope="mcp:use content:read", DPoP algs="EdDSA ES256 ES512 PS256 RS256"`,
    );

    const mismatched = await rpc(
      "tools/list",
      {},
      {
        ...auth,
        "mcp-method": "resources/list",
      },
    );
    expect(mismatched.status).toBe(400);
    expect(
      ((await mismatched.json()) as { error: { code: number } }).error.code,
    ).toBe(-32020);

    const wrongToolName = await rpc(
      "tools/call",
      {
        name: "read_document",
        arguments: { projectId: project.id, documentId: doc.id },
      },
      { ...auth, "mcp-name": "list_projects" },
    );
    expect(wrongToolName.status).toBe(400);
    expect(
      ((await wrongToolName.json()) as { error: { code: number } }).error.code,
    ).toBe(-32020);

    const documentUri = resourceUriFor({
      kind: "document",
      projectId: project.id,
      documentId: doc.id,
    });
    const wrongResourceName = await rpc(
      "resources/read",
      { uri: documentUri },
      { ...auth, "mcp-name": `${documentUri}-wrong` },
    );
    expect(wrongResourceName.status).toBe(400);
    expect(
      ((await wrongResourceName.json()) as { error: { code: number } }).error
        .code,
    ).toBe(-32020);

    const oversized = await rpc(
      "tools/list",
      { pad: "x".repeat(1_100_000) },
      auth,
    );
    expect(oversized.status).toBe(413);

    expect((await fetch(endpoint())).status).toBe(405);
    const metadata = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/api/mcp`,
    );
    expect(await metadata.json()).toMatchObject({
      resource: TEST_MCP_RESOURCE,
      authorization_servers: [TEST_ISSUER],
    });
  });

  it("returns Retry-After for real anonymous and authenticated rate limits", async () => {
    const { readKey } = await fixture("rate-limit");
    const isolated = await startServer({
      rateLimitPerMinute: 2,
      anonRateLimitPerMinute: 2,
    });
    try {
      const anonymous = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        anonymous.push(await rpc("server/discover", {}, {}, isolated.endpoint));
      }
      expect(anonymous.map((response) => response.status)).toEqual([
        401, 401, 429,
      ]);
      expect(anonymous[2]?.headers.get("retry-after")).toMatch(/^\d+$/);

      const authenticated = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        authenticated.push(
          await rpc(
            "server/discover",
            {},
            { authorization: `Bearer ${readKey.secret}` },
            isolated.endpoint,
          ),
        );
      }
      expect(authenticated.map((response) => response.status)).toEqual([
        200, 200, 429,
      ]);
      expect(authenticated[2]?.headers.get("retry-after")).toMatch(/^\d+$/);
    } finally {
      await isolated.server.close();
    }
  });

  it("audits authenticated rate-limited tool and resource attempts once without payloads", async () => {
    const { db, project, doc, readKey } = await fixture("rate-audit");
    const marker = "must-not-enter-rate-limit-audit";
    const resourceUri = resourceUriFor({
      kind: "document",
      projectId: project.id,
      documentId: doc.id,
    });
    const exercise = async (
      method: "tools/call" | "resources/read",
      params: Record<string, unknown>,
    ) => {
      const isolated = await startServer({ rateLimitPerMinute: 1 });
      try {
        const headers = { authorization: `Bearer ${readKey.secret}` };
        expect(
          (await rpc("server/discover", {}, headers, isolated.endpoint)).status,
        ).toBe(200);
        const limited = await rpc(method, params, headers, isolated.endpoint);
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      } finally {
        await isolated.server.close();
      }
    };

    await exercise("tools/call", {
      name: "list_documents",
      arguments: { projectId: project.id, marker },
    });
    await exercise("resources/read", { uri: resourceUri, marker });

    const audits = await db.mcpAuditEvent.findMany({
      where: { errorCode: "RATE_LIMITED" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect(
      audits.map((event) => ({
        method: event.method,
        name: event.name,
        outcome: event.outcome,
        errorCode: event.errorCode,
      })),
    ).toEqual([
      {
        method: "tools/call",
        name: "list_documents",
        outcome: "denied",
        errorCode: "RATE_LIMITED",
      },
      {
        method: "resources/read",
        name: resourceUri,
        outcome: "denied",
        errorCode: "RATE_LIMITED",
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(marker);
  });

  it("reads ingestion batches, files, and drafts through admin tools", async () => {
    const admin = await makeUser("Admin", "mcp-ingestion-read");
    const key = await callerFor(admin).apiKey.create({
      name: "ingestion",
      capabilities: ["system:admin"],
    });
    const project = await makeProject("MCP ingestion");
    await addMembership(project.id, admin.id, "Maintainer");
    const db = getPrisma();
    const batchId = randomUUID();
    const fileId = randomUUID();
    await db.ingestionBatch.create({
      data: {
        id: batchId,
        projectId: project.id,
        createdById: admin.id,
        origin: "upload",
        label: "Debug",
      },
    });
    await db.ingestionFile.create({
      data: {
        id: fileId,
        batchId,
        projectId: project.id,
        fileName: "notes.md",
        mimeType: "text/markdown",
        byteSize: 7,
        contentDigest: "a".repeat(64),
        status: "ready",
      },
    });
    await db.ingestionDraft.create({
      data: {
        fileId,
        targetKind: "document",
        proposedTitle: "Notes",
        markdown: "# Notes",
      },
    });

    const client = await connect(key.secret);
    const batches = structured<{
      items: Array<{
        id: string;
        status: string;
        fileStatusCounts: Record<string, number>;
      }>;
      nextCursor: string | null;
    }>(
      await client.callTool({
        name: "list_ingestion_batches",
        arguments: { projectId: project.id },
      }),
    );
    expect(batches.items).toEqual([
      expect.objectContaining({
        id: batchId,
        status: "ready",
        fileStatusCounts: { ready: 1 },
      }),
    ]);

    const files = structured<{
      items: Array<{ id: string; status: string; hasDraft: boolean }>;
    }>(
      await client.callTool({
        name: "list_ingestion_files",
        arguments: { projectId: project.id, status: "ready" },
      }),
    );
    expect(files.items).toEqual([
      expect.objectContaining({ id: fileId, status: "ready", hasDraft: true }),
    ]);

    const detail = structured<{
      fileName: string;
      draft: { proposedTitle: string; markdown: string | null } | null;
      markdownTruncated: boolean;
      warningsTruncated: boolean;
    }>(
      await client.callTool({
        name: "get_ingestion_file",
        arguments: { projectId: project.id, fileId },
      }),
    );
    expect(detail).toMatchObject({
      fileName: "notes.md",
      draft: { proposedTitle: "Notes", markdown: "# Notes" },
      markdownTruncated: false,
      warningsTruncated: false,
    });
    await client.close();
  });
  it("inspects scheduled tasks and run records through MCP with payload-free auditing", async () => {
    const admin = await makeUser("Admin", "mcp-task-read");
    const key = await callerFor(admin).apiKey.create({
      name: "tasks",
      capabilities: ["system:admin"],
    });
    const project = await makeProject("MCP tasks");
    await addMembership(project.id, admin.id, "Maintainer");
    const db = getPrisma();
    const instruction = "private-task-instruction-marker";
    const task = await db.scheduledTask.create({
      data: {
        name: "First task",
        ownerId: admin.id,
        instruction,
        scopeRequest: { kind: "project", projectId: project.id },
        scopeSnapshot: {
          kind: "project",
          projectIds: [project.id],
          documentId: null,
          tableId: null,
          resolvedAt: new Date().toISOString(),
        },
        outputProjectId: project.id,
        outputFolderPath: [],
        schedule: { kind: "hourly", minute: 0 },
        timezone: "UTC",
        cron: "0 * * * *",
      },
    });
    const run = await db.scheduledTaskRun.create({
      data: {
        taskId: task.id,
        trigger: "manual",
        status: "failed",
        errorCode: "TIMEOUT",
        errorMessage: "private-task-error-marker",
        workerId: "worker-1",
        inputTokens: 42,
      },
    });
    const client = await connect(key.secret);
    const listed = structured<{ items: { id: string }[] }>(
      await client.callTool({
        name: "list_scheduled_tasks",
        arguments: { projectId: project.id, order: "oldest" },
      }),
    );
    expect(listed.items.map((x) => x.id)).toEqual([task.id]);
    const definition = structured<{ record: { instruction: string } }>(
      await client.callTool({
        name: "get_scheduled_task",
        arguments: { projectId: project.id, taskId: task.id },
      }),
    );
    expect(definition.record.instruction).toBe(instruction);
    const history = structured<{ items: { id: string }[] }>(
      await client.callTool({
        name: "list_scheduled_task_runs",
        arguments: { projectId: project.id, taskId: task.id, status: "failed" },
      }),
    );
    expect(history.items.map((x) => x.id)).toEqual([run.id]);
    const detail = structured<{
      record: { errorMessage: string; workerId: string; inputTokens: number };
    }>(
      await client.callTool({
        name: "get_scheduled_task_run",
        arguments: { projectId: project.id, runId: run.id },
      }),
    );
    expect(detail.record).toMatchObject({
      errorMessage: "private-task-error-marker",
      workerId: "worker-1",
      inputTokens: 42,
    });
    const other = await makeProject("Other tasks");
    const denied = await client.callTool({
      name: "get_scheduled_task",
      arguments: { projectId: other.id, taskId: task.id },
    });
    expect(denied.isError).toBe(true);
    const audits = await db.mcpAuditEvent.findMany({
      where: {
        name: {
          in: [
            "list_scheduled_tasks",
            "get_scheduled_task",
            "list_scheduled_task_runs",
            "get_scheduled_task_run",
          ],
        },
      },
    });
    expect(audits.filter((x) => x.outcome === "ok")).toHaveLength(4);
    expect(JSON.stringify(audits)).not.toContain(instruction);
    expect(JSON.stringify(audits)).not.toContain("private-task-error-marker");
    await client.close();
  });

  describe("exams toolset", () => {
    it("lists seven write-capable and four read-only contracts and enforces trainer gates", async () => {
      const { db, user, project, readKey, writeKey } =
        await fixture("exam-toolsets");
      await db.projectTrainingRole.create({
        data: { projectId: project.id, userId: user.id, role: "trainer" },
      });
      const reader = await connect(readKey.secret, endpoint(), "2026-07-28", {
        headers: { "X-Weaver-Toolsets": "exams" },
      });
      const writer = await connect(writeKey.secret, endpoint(), "2026-07-28", {
        headers: { "X-Weaver-Toolsets": "exams" },
      });
      try {
        const examNames = [
          "list_exams",
          "get_exam",
          "list_exam_attempts",
          "get_exam_attempt",
          "create_exam",
          "update_exam",
          "grade_exam_attempt",
        ];
        expect(
          (await reader.listTools()).tools.filter((t) =>
            examNames.includes(t.name),
          ),
        ).toHaveLength(4);
        expect(
          (await writer.listTools()).tools.filter((t) =>
            examNames.includes(t.name),
          ),
        ).toHaveLength(7);
        expect(writer.getInstructions()).toContain("review");
        const created = structured<{ exam: { id: string } }>(
          await writer.callTool({
            name: "create_exam",
            arguments: {
              projectId: project.id,
              idempotencyKey: "mcp-exam-create",
              title: "MCP exam",
              timeLimitMinutes: 5,
              questions: [],
            },
          }),
        );
        expect(created.exam.id).toBeTruthy();
        const defaultClient = await connect(writeKey.secret);
        try {
          expect(
            (await defaultClient.listTools()).tools.some((t) =>
              examNames.includes(t.name),
            ),
          ).toBe(false);
        } finally {
          await defaultClient.close();
        }
        await db.projectTrainingRole.deleteMany({ where: { userId: user.id } });
        const denied = await writer.callTool({
          name: "list_exams",
          arguments: { projectId: project.id },
        });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied)).toContain("not permitted");
      } finally {
        await reader.close();
        await writer.close();
      }
    });
  });

  describe("toolsets and meta-tools", () => {
    type Listed = { name: string; listed: boolean };
    const errorText = (result: { content?: unknown }) =>
      (result.content as Array<{ type: string; text: string }> | undefined)?.[0]
        ?.text;

    it("lists core plus the meta-tools by default and explains the header", async () => {
      const { writeKey } = await readFixture();
      const client = await connect(writeKey.secret);
      try {
        const tools = (await client.listTools()).tools;
        expect(tools.map((t) => t.name).sort()).toEqual(
          [...CORE_TOOLS, ...META_TOOLS].sort(),
        );
        expect(tools.every((t) => t.title === undefined)).toBe(true);
        expect(client.getInstructions()).toContain("X-Weaver-Toolsets");
        expect(client.getInstructions()).toContain("toolsets core;");
      } finally {
        await client.close();
      }
    });

    it("adds named toolsets, ignores unknown names and keeps admin behind the capability", async () => {
      const { writeKey } = await readFixture();
      const client = await connect(writeKey.secret, endpoint(), "2026-07-28", {
        headers: { "X-Weaver-Toolsets": "tables, Bogus, admin" },
      });
      try {
        const names = (await client.listTools()).tools
          .map((t) => t.name)
          .sort();
        expect(names).toEqual(
          [...new Set([...CORE_TOOLS, ...TABLES_TOOLS, ...META_TOOLS])].sort(),
        );
        expect(names.some((n) => ADMIN_TOOLS.includes(n as never))).toBe(false);
      } finally {
        await client.close();
      }
    });

    it("lists the wiki reads only when the wiki toolset is requested and runs them in scope", async () => {
      const { project, hidden, doc, readKey } = await readFixture();
      const wiki = ["find_page", "inspect_links", "list_recent_changes"];
      const plain = await connect(readKey.secret);
      const client = await connect(readKey.secret, endpoint(), "2026-07-28", {
        headers: { "X-Weaver-Toolsets": "wiki" },
      });
      try {
        expect(
          (await plain.listTools()).tools.some((t) => wiki.includes(t.name)),
        ).toBe(false);
        expect(
          (await client.listTools()).tools
            .map((t) => t.name)
            .filter((name) => wiki.includes(name))
            .sort(),
        ).toEqual([...wiki].sort());
        const found = structured<{
          pages: Array<{ id: string; link: string }>;
        }>(
          await client.callTool({
            name: "find_page",
            arguments: { projectId: project.id, title: doc.title ?? "Roadmap" },
          }),
        );
        expect(found.pages[0]!.link).toContain(
          `](weaver://document/${found.pages[0]!.id})`,
        );
        const feed = structured<{ changes: Array<{ kind: string }> }>(
          await client.callTool({
            name: "list_recent_changes",
            arguments: { projectId: project.id },
          }),
        );
        expect(feed.changes.length).toBeGreaterThan(0);
        const denied = await client.callTool({
          name: "inspect_links",
          arguments: { projectId: hidden.id, mode: "orphans" },
        });
        expect(denied.isError).toBe(true);
        expect(client.getInstructions()).toContain("toolsets core, wiki");
        expect(client.getInstructions()).not.toContain("Resources use");
      } finally {
        await plain.close();
        await client.close();
      }
    });

    it("searches and describes only what the credential may call", async () => {
      const { readKey } = await readFixture();
      const admin = await makeUser("Admin", "mcp-meta-admin");
      const adminKey = await callerFor(admin).apiKey.create({
        name: "admin",
        capabilities: ["system:admin"],
      });
      const reader = await connect(readKey.secret);
      const adminClient = await connect(adminKey.secret);
      try {
        const aggregate = structured<{
          tools: Listed[];
          activeToolsets: string[];
        }>(
          await reader.callTool({
            name: "search_tools",
            arguments: { query: "aggregate" },
          }),
        );
        expect(aggregate.tools[0]).toMatchObject({
          name: "aggregate_table",
          listed: false,
        });
        expect(aggregate.activeToolsets).toEqual(["core"]);

        const diagnostic = structured<{ tools: Listed[] }>(
          await reader.callTool({
            name: "search_tools",
            arguments: { query: "diagnostic" },
          }),
        );
        expect(
          diagnostic.tools.some((t) => ADMIN_TOOLS.includes(t.name as never)),
        ).toBe(false);
        const adminDiagnostic = structured<{ tools: Listed[] }>(
          await adminClient.callTool({
            name: "search_tools",
            arguments: { query: "diagnostic" },
          }),
        );
        expect(adminDiagnostic.tools.map((t) => t.name)).toContain(
          "list_diagnostic_events",
        );

        const hidden = await reader.callTool({
          name: "describe_tool",
          arguments: { name: "list_diagnostic_events" },
        });
        expect(hidden.isError).toBe(true);
        expect(errorText(hidden)).toBe(
          "NOT_FOUND: tool not found or not accessible",
        );

        const described = structured<{
          toolsets: string[];
          inputSchema: { type: string };
          listed: boolean;
        }>(
          await adminClient.callTool({
            name: "describe_tool",
            arguments: { name: "list_diagnostic_events" },
          }),
        );
        expect(described.toolsets).toEqual(["admin"]);
        expect(described.inputSchema.type).toBe("object");
        expect(described.listed).toBe(false);

        const meta = await reader.callTool({
          name: "describe_tool",
          arguments: { name: "call_tool" },
        });
        expect(meta.isError).toBe(true);
        expect(errorText(meta)).toBe(
          "NOT_FOUND: tool not found or not accessible",
        );
      } finally {
        await reader.close();
        await adminClient.close();
      }
    });

    it("runs an unlisted write through call_tool with the inner tool's guards and audit", async () => {
      const { db, project, readKey, writeKey } = await readFixture();
      const tableArguments = () => ({
        projectId: project.id,
        folderPath: [],
        title: "Via call_tool",
        columns: [{ id: COL_TASK, name: "Task", type: "text" }],
        rows: [],
        idempotencyKey: randomUUID(),
        summary: "Create a table through call_tool",
      });
      const writer = await connect(writeKey.secret);
      const reader = await connect(readKey.secret);
      try {
        const created = structured<{ resourceId: string; commitSha: string }>(
          await writer.callTool({
            name: "call_tool",
            arguments: { name: "create_table", arguments: tableArguments() },
          }),
        );
        expect(created.resourceId).toEqual(expect.any(String));
        expect(created.commitSha).toEqual(expect.any(String));
        const audit = await db.mcpAuditEvent.findMany({
          where: { name: "create_table" },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          outcome: "ok",
          projectId: project.id,
        });
        expect(
          await db.mcpAuditEvent.count({ where: { name: "call_tool" } }),
        ).toBe(0);

        const denied = await reader.callTool({
          name: "call_tool",
          arguments: { name: "create_table", arguments: tableArguments() },
        });
        expect(denied.isError).toBe(true);
        expect(errorText(denied)).toBe(
          "NOT_FOUND: tool not found or not accessible",
        );

        const invalid = await writer.callTool({
          name: "call_tool",
          arguments: {
            name: "create_table",
            arguments: { projectId: project.id },
          },
        });
        expect(invalid.isError).toBe(true);
        expect(errorText(invalid)).toMatch(
          /^BAD_REQUEST: invalid tool arguments/,
        );

        const projects = structured<{ projects: Array<{ id: string }> }>(
          await reader.callTool({
            name: "call_tool",
            arguments: { name: "list_projects" },
          }),
        );
        expect(projects.projects.map((p) => p.id)).toContain(project.id);
      } finally {
        await writer.close();
        await reader.close();
      }
    });

    it("keeps a write-only OAuth token usable without a header", async () => {
      const { user } = await fixture("meta-write-only-oauth");
      const tokens = await obtainAccessToken(
        await sessionCookieFor(user.email),
        "mcp:use content:write",
      );
      const client = await connect(tokens.access_token);
      try {
        expect(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
        ).toEqual([
          "call_tool",
          "create_document",
          "describe_tool",
          "patch_document",
          "search_tools",
        ]);
        const found = structured<{ tools: Listed[] }>(
          await client.callTool({ name: "search_tools", arguments: {} }),
        );
        expect(found.tools.length).toBeGreaterThan(0);
        expect(
          found.tools.every((t) => WRITE_TOOLS.includes(t.name as never)),
        ).toBe(true);
      } finally {
        await client.close();
      }
    });
  });
});

import { beforeEach, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  MAX_TOOL_OUTPUT_CHARS,
  type ToolContext,
} from "@weaver/assistant-tools/contract";
import {
  mcpToolByName,
  mcpToolsForActor,
} from "@weaver/assistant-tools/registry";
import { createBearerVerifiers } from "@weaver/auth";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import {
  apiKeyPermissionsFromCapabilities,
  createApiKeySecurityContext,
  type Capability,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  invalidateDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import {
  createMcpHttpHandler,
  createMcpNodeServer,
  type McpRuntimeConfig,
} from "@weaver/mcp";
import {
  callerFor,
  resetDb,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  testAuth,
} from "./_harness";
import { makeExternalFixture } from "./_externalMcpFixtures";

beforeEach(resetDb);

type Fixture = Awaited<ReturnType<typeof makeExternalFixture>>;
const ctx = (
  f: Fixture,
  actor: SecurityContext,
  external = true,
): ToolContext => ({
  db: f.db,
  actor,
  scope: {
    kind: "all",
    projectIds: [],
    documentId: null,
    tableId: null,
    resolvedAt: new Date().toISOString(),
    truncated: false,
  },
  profile: { name: null, email: "admin@example.test" },
  run: null,
  ...(external ? { external: f.deps } : {}),
});
type Tool = {
  id: string;
  remoteName: string;
  state: string;
  enabled: boolean;
  effect: string | null;
  discoveredRemoteDigest: string;
  inputSchema?: unknown;
};
type Connection = {
  id: string;
  name: string;
  revision: number;
  enabled: boolean;
};
const call = async <T>(
  name: string,
  input: unknown,
  c: ToolContext,
): Promise<T> => {
  const tool = mcpToolByName(name)!;
  return (await tool.execute(tool.inputSchema.parse(input), c)).output as T;
};

it("configures a connection end to end without returning credentials", async () => {
  const f = await makeExternalFixture();
  const owner = ctx(f, f.owner);
  const created = (
    await call<{ connection: Connection }>(
      "create_external_connection",
      {
        name: "Design Docs",
        endpoint: "https://example.test/mcp",
        authMode: "bearer",
        token: "very-secret-token",
      },
      owner,
    )
  ).connection;
  expect(JSON.stringify(created)).not.toContain("very-secret-token");

  const discovered = await call<{ totalTools: number }>(
    "discover_external_connection",
    {
      id: created.id,
      expectedRevision: created.revision,
    },
    owner,
  );
  expect(discovered.totalTools).toBe(2);

  const tools = await call<{ items: Tool[] }>(
    "list_external_tools",
    { connectionId: created.id },
    owner,
  );
  expect(tools.items.map((t) => [t.remoteName, t.state])).toEqual([
    ["read", "new"],
    ["write", "new"],
  ]);
  const detail = await call<{ tool: Tool }>(
    "get_external_tool",
    { toolId: tools.items[0]!.id },
    owner,
  );
  expect(detail.tool.inputSchema).toEqual({ type: "object", properties: {} });

  const reviewed = await call<{ tools: Tool[] }>(
    "review_external_tools",
    {
      connectionId: created.id,
      items: tools.items.map((t) => ({
        toolId: t.id,
        expectedRemoteDigest: t.discoveredRemoteDigest,
        enabled: true,
        effect: t.remoteName === "read" ? "read" : "write",
      })),
    },
    owner,
  );
  expect(
    reviewed.tools.map((t) => [t.remoteName, t.enabled, t.effect]),
  ).toEqual([
    ["read", true, "read"],
    ["write", true, "write"],
  ]);

  let connection = (
    await call<{ connection: Connection }>(
      "get_external_connection",
      { id: created.id },
      owner,
    )
  ).connection;
  connection = (
    await call<{ connection: Connection }>(
      "update_external_connection",
      {
        id: created.id,
        expectedRevision: connection.revision,
        patch: { enabled: true, token: "rotated-secret" },
      },
      owner,
    )
  ).connection;
  expect(connection.enabled).toBe(true);

  const fetched = await call<{ connection: Connection }>(
    "get_external_connection",
    { id: created.id },
    owner,
  );
  expect(JSON.stringify(fetched)).not.toMatch(/secret|ciphertext|nonce/i);
  const listed = await call<{ items: Connection[] }>(
    "list_external_connections",
    {},
    owner,
  );
  expect(listed.items.map((c) => c.name)).toEqual(["Design Docs"]);

  await call(
    "delete_external_connection",
    {
      id: created.id,
      expectedRevision: fetched.connection.revision,
    },
    owner,
  );
  expect(
    (
      await call<{ items: Connection[] }>(
        "list_external_connections",
        {},
        owner,
      )
    ).items,
  ).toEqual([]);
});

it("bounds long descriptions and review batches in tool outputs", async () => {
  const f = await makeExternalFixture();
  const owner = ctx(f, f.owner);
  f.calls.catalog.tools[0]!.description = "r".repeat(20_000);
  f.calls.catalog.tools[0]!.inputSchema = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `p${i}`,
        { type: "string", description: "x".repeat(40) },
      ]),
    ),
  };
  f.calls.catalog.tools[1]!.description = "w".repeat(2_000);
  const created = (
    await call<{ connection: Connection }>(
      "create_external_connection",
      {
        name: "Long",
        endpoint: "https://example.test/mcp",
        authMode: "none",
      },
      owner,
    )
  ).connection;
  await call(
    "discover_external_connection",
    { id: created.id, expectedRevision: created.revision },
    owner,
  );

  type Described = Tool & {
    description: string | null;
    descriptionTruncated: boolean;
    inputSchemaTruncated?: boolean;
  };
  const listed = await call<{ items: Described[]; truncated: boolean }>(
    "list_external_tools",
    { connectionId: created.id },
    owner,
  );
  expect(listed.truncated).toBe(false);
  expect(
    listed.items.map((t) => [
      t.remoteName,
      t.description?.length,
      t.descriptionTruncated,
    ]),
  ).toEqual([
    ["read", 500, true],
    ["write", 500, true],
  ]);

  const write = await call<{ tool: Described }>(
    "get_external_tool",
    { toolId: listed.items[1]!.id },
    owner,
  );
  expect(write.tool.description).toBe("w".repeat(2_000));
  expect(write.tool.descriptionTruncated).toBe(false);
  expect(write.tool.inputSchema).toEqual({ type: "object", properties: {} });

  const read = await call<{ tool: Described }>(
    "get_external_tool",
    { toolId: listed.items[0]!.id },
    owner,
  );
  expect(read.tool.inputSchema).toBeNull();
  expect(read.tool.inputSchemaTruncated).toBe(true);
  expect(read.tool.description?.length).toBe(2_000);
  expect(read.tool.descriptionTruncated).toBe(false);
  expect(JSON.stringify(read).length).toBeLessThanOrEqual(
    MAX_TOOL_OUTPUT_CHARS,
  );

  const reviewed = await call<{
    reviewed: number;
    tools: Described[];
    toolsTruncated: boolean;
  }>(
    "review_external_tools",
    {
      connectionId: created.id,
      items: listed.items.map((t) => ({
        toolId: t.id,
        expectedRemoteDigest: t.discoveredRemoteDigest,
        enabled: false,
      })),
    },
    owner,
  );
  expect(reviewed.reviewed).toBe(2);
  expect(reviewed.toolsTruncated).toBe(false);
  expect(reviewed.tools.map((t) => [t.remoteName, t.enabled])).toEqual([
    ["read", false],
    ["write", false],
  ]);
});

it("needs external:manage, hides other users' connections and needs the external runtime", async () => {
  const f = await makeExternalFixture();
  const keyWith = (capabilities: Capability[]) =>
    createApiKeySecurityContext({
      userId: f.owner.userId,
      globalRole: "User",
      keyId: `key-${crypto.randomUUID()}`,
      permissions: apiKeyPermissionsFromCapabilities(capabilities),
      projectIds: [],
    });
  expect(
    mcpToolsForActor(keyWith(["external:use"])).some((t) =>
      t.name.includes("_external_connection"),
    ),
  ).toBe(false);
  expect(
    mcpToolsForActor(keyWith(["external:manage"])).filter((t) =>
      t.name.includes("_external_connection"),
    ).length,
  ).toBe(6);
  const created = await call<{ connection: { id: string } }>(
    "create_external_connection",
    { name: "Mine", endpoint: "https://example.test/mcp", authMode: "none" },
    ctx(f, keyWith(["external:manage"])),
  );
  await expect(
    call(
      "get_external_connection",
      { id: created.connection.id },
      ctx(f, f.outsider),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(
      "create_external_connection",
      { name: "X", endpoint: "https://example.test/mcp", authMode: "none" },
      ctx(f, f.owner, false),
    ),
  ).rejects.toMatchObject({ code: "INTERNAL" });
});

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

it("runs over the MCP server and never records the token", async () => {
  const f = await makeExternalFixture();
  const ownerUser = await f.db.user.findUniqueOrThrow({
    where: { id: f.owner.userId },
  });
  const ownerKey = await callerFor(ownerUser).apiKey.create({
    name: "connections",
    capabilities: ["external:manage"],
  });
  await setDiagnosticsSettings(f.db, f.admin, { level: "standard" });
  startDiagnosticWriter({ db: f.db, runtime: "mcp", flushIntervalMs: 60_000 });
  await waitForDiagnosticWriterReady();
  const server = await createMcpNodeServer(
    createMcpHttpHandler({
      db: f.db,
      verifiers: createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: TEST_MCP_RESOURCE,
      }),
      config,
      external: f.deps,
      log: () => undefined,
    }),
    { port: 0, host: "127.0.0.1" },
  );
  const client = new Client(
    { name: "weaver-spec", version: "0.0.0" },
    {
      supportedProtocolVersions: ["2026-07-28"],
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/api/mcp`),
        { authProvider: { token: async () => ownerKey.secret } },
      ),
    );
    const result = await client.callTool({
      name: "create_external_connection",
      arguments: {
        name: "Over MCP",
        endpoint: "https://example.test/mcp",
        authMode: "bearer",
        token: "mcp-wire-secret",
      },
    });
    expect(result.isError).toBeFalsy();
    const created = (
      result.structuredContent as { connection: { id: string; name: string } }
    ).connection;
    expect(created.name).toBe("Over MCP");
    expect(JSON.stringify(result)).not.toContain("mcp-wire-secret");

    await flushDiagnostics(true);
    const diagnostics = await f.db.diagnosticEvent.findMany({
      where: { event: "mcp.tool.called" },
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          tool: "create_external_connection",
        }),
      }),
    ]);
    const audits = await f.db.mcpAuditEvent.findMany();
    expect(JSON.stringify({ diagnostics, audits })).not.toContain(
      "mcp-wire-secret",
    );
  } finally {
    await client.close();
    await server.close();
    await stopDiagnosticWriter();
    invalidateDiagnosticsSettingsCache();
  }
});

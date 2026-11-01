import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createBearerVerifiers } from "@weaver/auth";
import {
  apiKeyPermissionsFromCapabilities,
  createApiKeySecurityContext,
  type Capability,
} from "@weaver/core/security/context";
import {
  callInboundExternalTool,
  listInboundExternalTools,
  prepareExternalCall,
} from "@weaver/core/services/externalMcp";
import * as management from "@weaver/core/services/externalMcp";
import { reconcileExternalMcpState } from "@weaver/core/services/externalMcp";
import type { InboundExternalTool } from "@weaver/core/externalMcp/types";
import { ExternalMcpError } from "@weaver/external-mcp";
import {
  createMcpHttpHandler,
  createMcpNodeServer,
  type McpRuntimeConfig,
} from "@weaver/mcp";
import {
  addMembership,
  callerFor,
  ensureOAuthResource,
  makeProject,
  resetDb,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  testAuth,
} from "./_harness";
import { makeEnabledExternalFixture } from "./_externalMcpFixtures";

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

let baseUrl = "";

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

type Fixture = Awaited<ReturnType<typeof makeEnabledExternalFixture>>;

function keyActor(
  userId: string,
  capabilities: Capability[],
  projectIds: string[] = [],
) {
  return createApiKeySecurityContext({
    userId,
    globalRole: "User",
    keyId: `key-${randomUUID()}`,
    permissions: apiKeyPermissionsFromCapabilities(capabilities),
    projectIds,
  });
}

function callListed(
  f: Fixture,
  actor: ReturnType<typeof keyActor>,
  tool: InboundExternalTool,
) {
  return callInboundExternalTool(f.deps, actor, {
    tool,
    arguments: {},
    requestId: randomUUID(),
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  });
}

async function waitForDispatched(f: Fixture) {
  for (let waited = 0; waited < 5_000; waited += 25) {
    const row = await f.db.externalMcpCall.findFirst({
      where: { mcpAuthMethod: "apiKey", status: "dispatched" },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("call never reached dispatched");
}

async function call(
  f: Fixture,
  actor: ReturnType<typeof keyActor>,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = (await listInboundExternalTools(f.deps, actor)).find(
    (t) => t.name === name,
  );
  if (!tool) throw new Error(`not listed: ${name}`);
  return callInboundExternalTool(f.deps, actor, {
    tool,
    arguments: args as never,
    requestId: randomUUID(),
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  });
}

describe("inbound MCP access to external tools", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists nothing without external:use and every enabled tool with it", async () => {
    const f = await makeEnabledExternalFixture();
    expect(
      await listInboundExternalTools(
        f.deps,
        keyActor(f.owner.userId, ["mcp:use", "content:read"]),
      ),
    ).toEqual([]);
    expect(
      await listInboundExternalTools(
        f.deps,
        keyActor(f.owner.userId, ["external:manage", "content:write"]),
      ),
    ).toEqual([]);
    expect(
      (
        await listInboundExternalTools(
          f.deps,
          keyActor(f.owner.userId, ["external:use", "content:write"]),
        )
      ).map((t) => t.name),
    ).toEqual(["ext_example__read", "ext_example__write"]);
  });

  it("lists reads with content:read and writes with content:write, whatever the project role", async () => {
    const f = await makeEnabledExternalFixture();
    await f.db.member.updateMany({
      where: { userId: f.owner.userId },
      data: { role: "viewer" },
    });
    const reader = keyActor(f.owner.userId, ["external:use"]);
    const writer = keyActor(f.owner.userId, ["external:use", "content:write"]);
    expect(
      (await listInboundExternalTools(f.deps, reader)).map((t) => t.name),
    ).toEqual(["ext_example__read"]);
    expect(
      (await listInboundExternalTools(f.deps, writer)).map((t) => t.name),
    ).toEqual(["ext_example__read", "ext_example__write"]);
    const [read] = await listInboundExternalTools(f.deps, reader);
    expect(read!.inputSchema.properties ?? {}).not.toHaveProperty(
      "weaverProjectId",
    );
    expect(
      await listInboundExternalTools(
        f.deps,
        keyActor(f.viewer.userId, ["external:use", "content:write"]),
      ),
    ).toEqual([]);
  });

  it("lists the owner's tools even for a key restricted to other projects", async () => {
    const f = await makeEnabledExternalFixture();
    const other = await makeProject("Other");
    await addMembership(other.id, f.owner.userId, "Owner");
    expect(
      (
        await listInboundExternalTools(
          f.deps,
          keyActor(f.owner.userId, ["external:use"], [other.id]),
        )
      ).map((t) => t.name),
    ).toEqual(["ext_example__read"]);
  });

  it("calls the remote tool without the project argument and records the MCP owner", async () => {
    const f = await makeEnabledExternalFixture();
    f.calls.content = [{ type: "text", text: "hello" }];
    const actor = keyActor(f.owner.userId, ["external:use"]);
    const result = await call(f, actor, "ext_example__read", {});
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
    expect(f.calls.arguments.at(-1)).toEqual({});
    const row = await f.db.externalMcpCall.findFirstOrThrow({
      where: { id: result.callId },
    });
    expect(row).toMatchObject({
      status: "completed",
      mcpCredentialId: actor.credentialId,
      mcpAuthMethod: "apiKey",
      assistantRunId: null,
      taskRunId: null,
      scopeSnapshot: expect.objectContaining({ kind: "all", projectIds: [] }),
    });
  });

  it("calls a read tool without a Weaver approval", async () => {
    const f = await makeEnabledExternalFixture();
    const actor = keyActor(f.owner.userId, ["external:use"]);
    const result = await call(f, actor, "ext_example__read", {});
    expect(result.status).toBe("completed");
    expect(await f.db.externalMcpToolApproval.count()).toBe(0);
  });

  it("keeps same-named connections of two users apart", async () => {
    const f = await makeEnabledExternalFixture();
    const theirs = await management.createExternalConnection(
      f.deps,
      f.outsider,
      {
        name: "Example",
        endpoint: "https://other.example.test/mcp",
        authMode: "none",
        enabled: true,
      },
    );
    await management.discoverExternalConnection(f.deps, f.outsider, {
      id: theirs.id,
      expectedRevision: theirs.revision,
    });
    const [read] = (
      await management.listExternalTools(f.db, f.outsider, {
        connectionId: theirs.id,
      })
    ).items.filter((tool) => tool.remoteName === "read");
    await management.reviewExternalTools(f.deps, f.outsider, {
      connectionId: theirs.id,
      items: [
        {
          toolId: read!.id,
          expectedRemoteDigest: read!.discoveredRemoteDigest,
          enabled: true,
          effect: "read",
        },
      ],
    });
    const mine = await listInboundExternalTools(
      f.deps,
      keyActor(f.owner.userId, ["external:use"]),
    );
    const others = await listInboundExternalTools(
      f.deps,
      keyActor(f.outsider.userId, ["external:use"]),
    );
    expect(mine.map((t) => [t.name, t.connectionId])).toEqual([
      ["ext_example__read", f.connectionId],
    ]);
    expect(others.map((t) => [t.name, t.connectionId])).toEqual([
      ["ext_example__read", theirs.id],
    ]);
    const opened = f.calls.opens.length;
    const theirCall = await call(
      f,
      keyActor(f.outsider.userId, ["external:use"]),
      "ext_example__read",
      {},
    );
    expect(theirCall.status).toBe("completed");
    expect(f.calls.opens.slice(opened).map((o) => o.endpoint)).toEqual([
      "https://other.example.test/mcp",
    ]);
    await expect(
      callListed(f, keyActor(f.outsider.userId, ["external:use"]), mine[0]!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("calls a write tool with content:write without a Weaver approval", async () => {
    const f = await makeEnabledExternalFixture();
    const writer = keyActor(f.owner.userId, ["external:use", "content:write"]);
    const result = await call(f, writer, "ext_example__write", {});
    expect(result.status).toBe("completed");
    expect(f.calls.tools).toEqual(["write"]);
    expect(f.calls.counter).toBe(1);
    expect(await f.db.externalMcpToolApproval.count()).toBe(0);
  });

  it("refuses an MCP invocation bound to a different credential", async () => {
    const f = await makeEnabledExternalFixture();
    const actor = keyActor(f.owner.userId, ["external:use"]);
    const tool = (await listInboundExternalTools(f.deps, actor))[0]!;
    await expect(
      prepareExternalCall(f.deps, actor, {
        owner: {
          kind: "mcp",
          requestId: randomUUID(),
          credentialId: `key-${randomUUID()}`,
          authenticationMethod: "apiKey",
        },
        scope: {
          kind: "project",
          projectIds: [f.project.id],
          documentId: null,
          tableId: null,
          resolvedAt: new Date().toISOString(),
          truncated: false,
        },
        toolId: tool.toolId,
        expectedConfigRevision: tool.configRevision,
        expectedToolDigest: tool.reviewDigest,
        arguments: {},
        deadline: new Date(Date.now() + 10_000),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.db.externalMcpCall.count()).toBe(0);
    expect(f.calls.tools).toEqual([]);
  });

  it("refuses write tools for a key without content:write", async () => {
    const f = await makeEnabledExternalFixture();
    const writer = keyActor(f.owner.userId, ["external:use", "content:write"]);
    const tool = (await listInboundExternalTools(f.deps, writer)).find(
      (t) => t.name === "ext_example__write",
    )!;
    await expect(
      callInboundExternalTool(
        f.deps,
        keyActor(f.owner.userId, ["external:use"]),
        {
          tool,
          arguments: {},
          requestId: randomUUID(),
          signal: new AbortController().signal,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports a changed remote definition and leaves in-flight calls to the deadline", async () => {
    const f = await makeEnabledExternalFixture();
    const actor = keyActor(f.owner.userId, ["external:use"]);
    f.calls.catalog.tools[0]!.description = "changed";
    const changed = await call(f, actor, "ext_example__read", {});
    expect(changed.status).toBe("unknown");
    expect(changed.error?.code).toBe("EXTERNAL_TOOL_CHANGED");
    expect(f.calls.tools).toEqual([]);
    delete f.calls.catalog.tools[0]!.description;
    let release!: () => void;
    f.calls.blocked = new Promise((resolve) => (release = resolve));
    const pending = call(f, actor, "ext_example__read", {});
    const dispatched = await waitForDispatched(f);
    await reconcileExternalMcpState(f.db, new Date());
    const inflight = await f.db.externalMcpCall.findUniqueOrThrow({
      where: { id: dispatched.id },
    });
    expect(inflight.status).toBe("dispatched");
    release();
    expect((await pending).status).toBe("completed");
  });

  it("records a cancelled dispatched call as unknown", async () => {
    const f = await makeEnabledExternalFixture();
    f.calls.callError = new ExternalMcpError("CANCELLED");
    const actor = keyActor(f.owner.userId, ["external:use"]);
    const result = await call(f, actor, "ext_example__read", {});
    expect(result.status).toBe("unknown");
    expect(result.error?.code).toBe("EXTERNAL_TIMEOUT");
    const row = await f.db.externalMcpCall.findFirstOrThrow({
      where: { id: result.callId },
    });
    expect(row.status).toBe("unknown");
  });
});

async function serveMcp(f: Fixture) {
  const handler = createMcpHttpHandler({
    db: f.db,
    verifiers: createBearerVerifiers(testAuth(), {
      issuer: TEST_ISSUER,
      audience: TEST_MCP_RESOURCE,
    }),
    config,
    external: f.deps,
    log: () => undefined,
  });
  const server = await createMcpNodeServer(handler, {
    port: 0,
    host: "127.0.0.1",
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  return server;
}

describe("external tools through the MCP server", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists and calls an approved tool for a key with external:use only", async () => {
    await ensureOAuthResource();
    const f = await makeEnabledExternalFixture();
    f.calls.content = [{ type: "text", text: "nodes" }];
    const server = await serveMcp(f);
    try {
      const owner = await f.db.user.findUniqueOrThrow({
        where: { id: f.owner.userId },
      });
      const plainKey = await callerFor(owner).apiKey.create({ name: "plain" });
      const externalKey = await callerFor(owner).apiKey.create({
        name: "external",
        capabilities: ["external:use"],
      });

      const plain = await connect(plainKey.secret, endpoint(), "2026-07-28", {
        headers: { "X-Weaver-Toolsets": "external" },
      });
      expect(
        (await plain.listTools()).tools.some((t) => t.name.startsWith("ext_")),
      ).toBe(false);

      const client = await connect(externalKey.secret);
      expect(
        (await client.listTools()).tools.some((t) => t.name.startsWith("ext_")),
      ).toBe(false);
      const external = await connect(
        externalKey.secret,
        endpoint(),
        "2026-07-28",
        { headers: { "X-Weaver-Toolsets": "external" } },
      );
      const listed = (await external.listTools()).tools.filter((t) =>
        t.name.startsWith("ext_"),
      );
      expect(listed.map((t) => t.name)).toEqual(["ext_example__read"]);
      expect(listed[0]!.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });
      expect(listed[0]!.inputSchema.properties ?? {}).not.toHaveProperty(
        "weaverProjectId",
      );
      await external.close();

      const result = await client.callTool({
        name: "ext_example__read",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "nodes" }]);

      const found = (
        (
          await client.callTool({
            name: "search_tools",
            arguments: { query: "example" },
          })
        ).structuredContent as { tools: Array<Record<string, unknown>> }
      ).tools;
      expect(found).toContainEqual(
        expect.objectContaining({
          name: "ext_example__read",
          kind: "external",
          toolsets: ["external"],
          listed: false,
          connection: "Example",
        }),
      );
      const described = (
        await client.callTool({
          name: "describe_tool",
          arguments: { name: "ext_example__read" },
        })
      ).structuredContent as {
        inputSchema: unknown;
        annotations: { openWorldHint?: boolean };
      };
      expect(described.inputSchema).toEqual(listed[0]!.inputSchema);
      expect(described.annotations.openWorldHint).toBe(true);
      const viaMeta = await client.callTool({
        name: "call_tool",
        arguments: { name: "ext_example__read", arguments: {} },
      });
      expect(viaMeta.isError).toBeFalsy();
      expect(viaMeta.content).toEqual([{ type: "text", text: "nodes" }]);

      const audit = await f.db.mcpAuditEvent.findMany({
        where: { name: "ext_example__read" },
        orderBy: { createdAt: "asc" },
      });
      expect(audit).toHaveLength(2);
      for (const row of audit)
        expect(row).toMatchObject({ outcome: "ok", projectId: null });

      const refused = await plain.callTool({
        name: "call_tool",
        arguments: { name: "ext_example__read", arguments: {} },
      });
      expect(refused.isError).toBe(true);
      expect(
        (refused.content as Array<{ type: string; text: string }>)[0]?.text,
      ).toBe("NOT_FOUND: tool not found or not accessible");
      const plainFound = (
        (
          await plain.callTool({
            name: "search_tools",
            arguments: { query: "example" },
          })
        ).structuredContent as { tools: Array<{ name: string }> }
      ).tools;
      expect(plainFound.some((t) => t.name.startsWith("ext_"))).toBe(false);
      await plain.close();
      await client.close();
    } finally {
      await server.close();
    }
  });

  it("runs a write-effect tool through call_tool exactly like a direct call", async () => {
    await ensureOAuthResource();
    const f = await makeEnabledExternalFixture();
    f.calls.content = [{ type: "text", text: "written" }];
    const server = await serveMcp(f);
    try {
      const owner = await f.db.user.findUniqueOrThrow({
        where: { id: f.owner.userId },
      });
      const writerKey = await callerFor(owner).apiKey.create({
        name: "writer",
        capabilities: ["external:use", "content:write"],
      });
      const client = await connect(writerKey.secret);

      const direct = await client.callTool({
        name: "ext_example__write",
        arguments: {},
      });
      const viaMeta = await client.callTool({
        name: "call_tool",
        arguments: { name: "ext_example__write", arguments: {} },
      });
      expect(direct.isError).toBeFalsy();
      expect(viaMeta.isError).toBe(direct.isError);
      expect(viaMeta.content).toEqual(direct.content);
      expect(f.calls.tools).toEqual(["write", "write"]);
      expect(f.calls.counter).toBe(2);

      const audit = await f.db.mcpAuditEvent.findMany({
        where: { name: { in: ["ext_example__write", "call_tool"] } },
        orderBy: { createdAt: "asc" },
      });
      expect(audit).toHaveLength(2);
      for (const row of audit)
        expect(row).toMatchObject({
          method: "tools/call",
          name: "ext_example__write",
          outcome: "ok",
          errorCode: null,
          projectId: null,
        });
      await client.close();
    } finally {
      await server.close();
    }
  });
});

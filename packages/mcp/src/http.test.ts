import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BearerVerification,
  BearerVerifiers,
  ResourceRequestInput,
} from "@weaver/auth";
import {
  ADMIN_TOOLS,
  MCP_TOOLS,
  mcpToolByName,
} from "@weaver/assistant-tools/registry";
import {
  CORE_TOOL_NAMES,
  MCP_TOOLSET_MEMBERS,
} from "@weaver/assistant-tools/toolsets";
import { DEFAULT_DIAGNOSTICS_SETTINGS } from "@weaver/core/diagnostics/settings";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import {
  invalidateDiagnosticsSettingsCache,
  primeDiagnosticsSettingsCache,
} from "@weaver/core/services/diagnosticsSettings";
import type { ExternalRuntimeDeps } from "@weaver/core/externalMcp/types";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { mcpRuntimeConfigFromEnv, type McpRuntimeConfig } from "./config";
import { createMcpHttpHandler, type McpLogLine } from "./http";

const config: McpRuntimeConfig = {
  resourceUrl: "http://127.0.0.1:3200/mcp",
  issuer: "http://localhost:3000/api/auth",
  mcpPath: "/mcp",
  metadataPath: "/.well-known/oauth-protected-resource/mcp",
  allowedHosts: ["127.0.0.1", "localhost"],
  allowedOrigins: ["127.0.0.1", "localhost"],
  maxBodyBytes: 1_024,
  maxResourceChars: 1_000,
  toolTimeoutMs: 1_000,
  rateLimitPerMinute: 2,
  anonRateLimitPerMinute: 2,
  version: "0.0.0-test",
  production: false,
};

type AuditCreateInput = {
  data: {
    method: string;
    name: string;
    outcome: string;
    errorCode: string | null;
  };
};

type DiagnosticRow = Prisma.DiagnosticEventCreateManyInput;

function fakeDb() {
  const auditCreate = vi.fn(async (_input: AuditCreateInput) => ({}));
  const diagnosticRows: DiagnosticRow[] = [];
  const diagnosticCreateMany = vi.fn(
    async ({ data }: { data: DiagnosticRow[] }) => {
      diagnosticRows.push(...data);
      return { count: data.length };
    },
  );
  return Object.assign(
    {
      user: {
        findUnique: vi.fn(async () => ({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          role: "User",
          banned: false,
          name: "U",
          email: "u@test.local",
        })),
      },
      // The live key policy the resolver reads after verification.
      $queryRaw: vi.fn(async () => [
        {
          permissions: JSON.stringify({ mcp: ["use"], content: ["read"] }),
          enabled: true,
          referenceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectIds: [],
        },
      ]),
      verification: { findFirst: vi.fn(async () => null) },
      oauthConsent: {
        findFirst: vi.fn(async () => ({
          id: "c1",
          resources: ["http://127.0.0.1:3200/mcp"],
          scopes: ["mcp:use", "content:read"],
        })),
      },
      mcpAuditEvent: { create: auditCreate },
      diagnosticEvent: { createMany: diagnosticCreateMany },
    } as unknown as PrismaClient,
    { auditCreate, diagnosticCreateMany, diagnosticRows },
  );
}

async function enableDiagnostics(db: PrismaClient) {
  primeDiagnosticsSettingsCache({
    ...DEFAULT_DIAGNOSTICS_SETTINGS,
    level: "standard",
  });
  startDiagnosticWriter({ db, runtime: "mcp", flushIntervalMs: 60_000 });
  await waitForDiagnosticWriterReady();
}

afterEach(async () => {
  await stopDiagnosticWriter();
  invalidateDiagnosticsSettingsCache();
  vi.restoreAllMocks();
});

function fakeVerifiers(): BearerVerifiers {
  return {
    verifyApiKey: vi.fn(),
    verifyAccessToken: vi.fn(),
    verifyResourceRequest: vi.fn(
      async (input: ResourceRequestInput): Promise<BearerVerification> => {
        const header = input.authorizationHeader ?? "";
        if (header === "Bearer wvr_good")
          return {
            ok: true,
            credential: {
              kind: "apiKey",
              keyId: "k1",
              userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              permissions: { mcp: ["use"], content: ["read"] },
            },
          };
        if (header === "Bearer read-only-token")
          return {
            ok: true,
            credential: {
              kind: "oauth",
              tokenId: "t1",
              userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              clientId: "client-1",
              scopes: ["content:read"],
              authorizationId: null,
            },
          };
        if (header === "Bearer mcp-only-token")
          return {
            ok: true,
            credential: {
              kind: "oauth",
              tokenId: "t2",
              userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              clientId: "client-1",
              scopes: ["mcp:use"],
              authorizationId: null,
            },
          };
        if (header.startsWith("DPoP ")) return { ok: false, reason: "dpop" };
        if (!header) return { ok: false, reason: "missing" };
        return { ok: false, reason: "invalid" };
      },
    ),
  };
}

function handler(
  options: { db?: PrismaClient; config?: McpRuntimeConfig } = {},
) {
  return createMcpHttpHandler({
    db: options.db ?? fakeDb(),
    verifiers: fakeVerifiers(),
    config: options.config ?? config,
    log: () => undefined,
  });
}

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "spec", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function post(
  body: unknown,
  headers: Record<string, string> = {},
  url = "http://127.0.0.1:3200/mcp",
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const discover = {
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: { _meta: ENVELOPE },
};
const discoverHeaders = {
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": "server/discover",
};

describe("MCP HTTP pipeline (spec §26.2 item 8)", () => {
  it("serves health and the protected-resource metadata unauthenticated, with a request id", async () => {
    const h = handler();
    const health = await h.fetch(new Request("http://127.0.0.1:3200/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      runtime: "mcp-server",
      version: "0.0.0-test",
    });
    expect(health.headers.get("x-weaver-request-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const metadata = await h.fetch(
      new Request(
        "http://127.0.0.1:3200/.well-known/oauth-protected-resource/mcp",
      ),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: "http://127.0.0.1:3200/mcp",
      authorization_servers: ["http://localhost:3000/api/auth"],
      bearer_methods_supported: ["header"],
      scopes_supported: [
        "mcp:use",
        "content:read",
        "content:propose",
        "content:write",
        "external:use",
        "external:manage",
      ],
      resource_name: "Weaver MCP",
      dpop_signing_alg_values_supported: [
        "EdDSA",
        "ES256",
        "ES512",
        "PS256",
        "RS256",
      ],
    });
    expect(
      (
        await h.fetch(
          new Request(
            "http://127.0.0.1:3200/.well-known/oauth-protected-resource/mcp",
            { method: "POST" },
          ),
        )
      ).status,
    ).toBe(405);
    expect(
      (await h.fetch(new Request("http://127.0.0.1:3200/elsewhere"))).status,
    ).toBe(404);
  });

  it("advertises and serves the same canonical base-path override", async () => {
    const canonical = mcpRuntimeConfigFromEnv(
      {
        NODE_ENV: "production",
        AUTH_URL: "https://weaver.example",
        WEAVER_MCP_RESOURCE_URL: "https://weaver.example/knowledge/mcp/",
        WEAVER_OAUTH_ISSUER: "https://weaver.example/knowledge/auth/",
        WEAVER_MCP_MAX_BODY_BYTES: 1_024,
        WEAVER_MCP_MAX_RESOURCE_CHARS: 1_000,
        WEAVER_MCP_TOOL_TIMEOUT_MS: 1_000,
        WEAVER_MCP_RATE_LIMIT_PER_MINUTE: 2,
        WEAVER_MCP_ANON_RATE_LIMIT_PER_MINUTE: 2,
      },
      { basePath: "/knowledge/", version: "0.0.0-test" },
    );
    const h = handler({ config: canonical });

    const metadata = await h.fetch(
      new Request(
        "https://weaver.example/.well-known/oauth-protected-resource/knowledge/mcp",
      ),
    );
    expect(await metadata.json()).toMatchObject({
      resource: "https://weaver.example/knowledge/mcp",
      authorization_servers: ["https://weaver.example/knowledge/auth"],
    });
    const canonicalRoute = await h.fetch(
      new Request("https://weaver.example/knowledge/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(canonicalRoute.status).toBe(401);
    const trailingRoute = await h.fetch(
      new Request("https://weaver.example/knowledge/mcp/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(trailingRoute.status).toBe(404);
    await h.close();
  });

  it("rejects GET/DELETE, non-JSON bodies, and oversized bodies before authentication", async () => {
    const h = handler();
    const get = await h.fetch(new Request("http://127.0.0.1:3200/mcp"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(
      (
        await h.fetch(
          new Request("http://127.0.0.1:3200/mcp", { method: "DELETE" }),
        )
      ).status,
    ).toBe(405);
    const text = await h.fetch(post("{}", { "content-type": "text/plain" }));
    expect(text.status).toBe(415);
    const big = await h.fetch(
      post({ pad: "x".repeat(2_000) }, discoverHeaders),
    );
    expect(big.status).toBe(413);
  });

  it("stops reading a streamed body without Content-Length once the byte cap is exceeded", async () => {
    const cancel = vi.fn();
    const payload = "€".repeat(400);
    expect(payload.length).toBeLessThan(config.maxBodyBytes);
    const first = new TextEncoder().encode(payload.slice(0, 200));
    const second = new TextEncoder().encode(payload.slice(200));
    expect(first.byteLength + second.byteLength).toBeGreaterThan(
      config.maxBodyBytes,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
      },
      cancel,
    });
    const request = new Request("http://127.0.0.1:3200/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...discoverHeaders,
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await handler().fetch(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("challenges unauthenticated and invalid requests per RFC 9728 / 6750 / 9449", async () => {
    const missing = await handler().fetch(post(discover, discoverHeaders));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://127.0.0.1:3200/.well-known/oauth-protected-resource/mcp", scope="mcp:use content:read", DPoP algs="EdDSA ES256 ES512 PS256 RS256"',
    );
    expect(await missing.json()).not.toHaveProperty("error");

    const invalid = await handler().fetch(
      post(discover, {
        ...discoverHeaders,
        authorization: "Bearer nope",
      }),
    );
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    expect(await invalid.json()).toMatchObject({ error: "invalid_token" });

    const dpop = await handler().fetch(
      post(discover, {
        ...discoverHeaders,
        authorization: "DPoP bound",
        dpop: "proof",
      }),
    );
    expect(dpop.status).toBe(401);
    expect(dpop.headers.get("www-authenticate")).toMatch(
      /^DPoP algs="EdDSA ES256 ES512 PS256 RS256", error="invalid_dpop_proof"/,
    );

    const scope = await handler().fetch(
      post(discover, {
        ...discoverHeaders,
        authorization: "Bearer read-only-token",
      }),
    );
    expect(scope.status).toBe(403);
    expect(scope.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="mcp:use", resource_metadata="http://127.0.0.1:3200/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("validates Host and Origin", async () => {
    const h = handler();
    const badOrigin = await h.fetch(
      post(discover, {
        ...discoverHeaders,
        authorization: "Bearer wvr_good",
        origin: "http://evil.example",
      }),
    );
    expect(badOrigin.status).toBe(403);
    const badHost = await h.fetch(
      post(
        discover,
        { ...discoverHeaders, authorization: "Bearer wvr_good" },
        "http://evil.example/mcp",
      ),
    );
    expect(badHost.status).toBe(403);
  });

  it("answers server/discover for an authenticated credential", async () => {
    const h = handler();
    const response = await h.fetch(
      post(discover, { ...discoverHeaders, authorization: "Bearer wvr_good" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: {
        _meta?: {
          "io.modelcontextprotocol/serverInfo"?: { name?: string };
        };
      };
    };
    expect(
      body.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name,
    ).toBe("weaver");
    expect(JSON.stringify(body)).toContain("2026-07-28");
    expect(response.headers.get("x-weaver-request-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it.each(["2025-06-18", "2025-11-25"])(
    "accepts a %s initialize request",
    async (protocolVersion) => {
      const h = handler();
      const legacy = await h.fetch(
        post(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion,
              capabilities: {},
              clientInfo: { name: "old", version: "1" },
            },
          },
          { authorization: "Bearer wvr_good" },
        ),
      );
      expect(legacy.status).toBe(200);
      const message = (await legacy.text())
        .split("\n")
        .find((line) => line.startsWith("data: "));
      expect(JSON.parse(message!.slice(6))).toMatchObject({
        id: 1,
        result: { protocolVersion, serverInfo: { name: "weaver" } },
      });
      expect(legacy.headers.get("mcp-session-id")).toBeNull();
      await h.close();
    },
  );

  it("rejects legacy batches before dispatching multiple operations", async () => {
    const h = handler();
    try {
      const response = await h.fetch(
        post(
          [
            { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          ],
          { authorization: "Bearer wvr_good" },
        ),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32600 } });
    } finally {
      await h.close();
    }
  });

  it("rejects subscriptions before entering the shared stateless event bus", async () => {
    const h = handler();
    const response = await h.fetch(
      post(
        { jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {} },
        { ...discoverHeaders, authorization: "Bearer wvr_good" },
      ),
    );
    expect(await response.json()).toMatchObject({ error: { code: -32601 } });
    await h.close();
  });

  it("bounds a repeated unrecognised credential by its source address only, rejecting before buffering or verification and preserving known clients on the address", async () => {
    const verifiers = fakeVerifiers();
    const verify = vi.spyOn(verifiers, "verifyResourceRequest");
    const h = createMcpHttpHandler({
      db: fakeDb(),
      verifiers,
      config: { ...config, rateLimitPerMinute: 10 },
      log: () => undefined,
    });
    const send = (token: string) =>
      h.fetch(
        post(discover, {
          ...discoverHeaders,
          authorization: `Bearer ${token}`,
        }),
        { clientAddress: "shared" },
      );
    expect((await send("wvr_good")).status).toBe(200);
    // No per-credential bucket: the same bad token is verified past
    // anonRateLimitPerMinute until the source budget is spent.
    const sourceLimit = config.anonRateLimitPerMinute * 5;
    for (let index = 1; index < sourceLimit; index += 1)
      expect((await send("wvr_bad")).status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(sourceLimit);
    const blocked = post(discover, {
      ...discoverHeaders,
      authorization: "Bearer wvr_bad",
    });
    const reader = vi.spyOn(blocked.body!, "getReader");
    expect((await h.fetch(blocked, { clientAddress: "shared" })).status).toBe(
      429,
    );
    expect(verify).toHaveBeenCalledTimes(sourceLimit);
    expect(reader).not.toHaveBeenCalled();
    expect((await send("wvr_other")).status).toBe(429);
    expect((await send("wvr_good")).status).toBe(200);
    await h.close();
  });

  it("charges the source address before an unverified credential can pick its own bucket", async () => {
    const verifiers = fakeVerifiers();
    const verify = vi.spyOn(verifiers, "verifyResourceRequest");
    const h = createMcpHttpHandler({
      db: fakeDb(),
      verifiers,
      config,
      log: () => undefined,
    });
    const request = (token: string) =>
      post(discover, { ...discoverHeaders, authorization: `Bearer ${token}` });
    const from = (address: string, token: string) =>
      h.fetch(request(token), { clientAddress: address });

    // A recognized credential on the same address must stay unaffected below.
    expect((await from("attacker", "wvr_good")).status).toBe(200);
    const sourceLimit = config.anonRateLimitPerMinute * 5;
    for (let index = 1; index < sourceLimit; index += 1)
      expect((await from("attacker", `wvr_rotating_${index}`)).status).toBe(
        401,
      );

    const calls = verify.mock.calls.length;
    const blocked = request("wvr_rotating_fresh");
    const reader = vi.spyOn(blocked.body!, "getReader");
    expect((await h.fetch(blocked, { clientAddress: "attacker" })).status).toBe(
      429,
    );
    expect(verify).toHaveBeenCalledTimes(calls);
    expect(reader).not.toHaveBeenCalled();

    expect((await from("attacker", "wvr_good")).status).toBe(200);
    expect((await from("elsewhere", "wvr_rotating_fresh")).status).toBe(401);
    await h.close();
  });

  it("admits a new credential after missing-credential traffic exhausts the shared address", async () => {
    const h = handler();
    const context = { clientAddress: "shared" };
    for (const status of [401, 401, 429]) {
      expect(
        (await h.fetch(post(discover, discoverHeaders), context)).status,
      ).toBe(status);
    }
    expect(
      (
        await h.fetch(
          post(discover, {
            ...discoverHeaders,
            authorization: "Bearer wvr_good",
          }),
          context,
        )
      ).status,
    ).toBe(200);
    await h.close();
  });

  it("admits a valid key's first request after a distributed flood of distinct fake tokens fills the limiter's key capacity", async () => {
    const verifiers = fakeVerifiers();
    const verify = vi.spyOn(verifiers, "verifyResourceRequest");
    const h = createMcpHttpHandler({
      db: fakeDb(),
      verifiers,
      config,
      limiterMaxKeys: 8,
      log: () => undefined,
    });
    const from = (address: string, token: string) =>
      h.fetch(
        post(discover, {
          ...discoverHeaders,
          authorization: `Bearer ${token}`,
        }),
        { clientAddress: address },
      );
    // Nine never-valid tokens from three addresses, each address inside its
    // own budget: more distinct credentials than any limiter tracks.
    for (const address of ["a", "b", "c"])
      for (let index = 0; index < 3; index += 1)
        expect(
          (await from(address, `wvr_fake_${address}_${index}`)).status,
        ).toBe(401);
    expect(verify).toHaveBeenCalledTimes(9);

    expect((await from("legit", "wvr_good")).status).toBe(200);
    expect((await from("legit", "wvr_good")).status).toBe(200);

    // Header-less traffic keeps its own bounded bucket on the address.
    const missing = () =>
      h.fetch(post(discover, discoverHeaders), { clientAddress: "legit" });
    expect((await missing()).status).toBe(401);
    expect((await missing()).status).toBe(401);
    expect((await missing()).status).toBe(429);
    await h.close();
  });

  it("logs only recognized request methods and registered tool names, ignoring routing headers", async () => {
    const log = vi.fn<(line: McpLogLine) => void>();
    const h = createMcpHttpHandler({
      db: fakeDb(),
      verifiers: fakeVerifiers(),
      config,
      log,
    });
    await h.fetch(
      post(discover, {
        ...discoverHeaders,
        authorization: "Bearer wvr_good",
        "mcp-name": "PRIVATE_HEADER_MARKER",
      }),
    );
    const requestLog = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.event === "mcp.request");
    expect(requestLog).toMatchObject({ method: "server/discover", name: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "PRIVATE_HEADER_MARKER",
    );
    await h.close();
  });

  it("rate limits per credential and per client for failures", async () => {
    const h = handler();
    const ok = () =>
      h.fetch(
        post(discover, {
          ...discoverHeaders,
          authorization: "Bearer wvr_good",
        }),
      );
    expect((await ok()).status).toBe(200);
    expect((await ok()).status).toBe(200);
    const limited = await ok();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);

    const anon = (forwarded: string) =>
      h.fetch(
        post(discover, { ...discoverHeaders, "x-forwarded-for": forwarded }),
        { clientAddress: "127.0.0.1" },
      );
    expect((await anon("192.0.2.1")).status).toBe(401);
    expect((await anon("192.0.2.2")).status).toBe(401);
    expect((await anon("192.0.2.3")).status).toBe(429);
  });

  it("audits an authenticated rate-limited tool call exactly once without its payload", async () => {
    const db = fakeDb();
    await enableDiagnostics(db);
    const h = handler({
      db,
      config: { ...config, rateLimitPerMinute: 1 },
    });
    const auth = { ...discoverHeaders, authorization: "Bearer wvr_good" };
    expect((await h.fetch(post(discover, auth))).status).toBe(200);
    const marker = "RATE-LIMITED-PAYLOAD-MUST-NOT-PERSIST";
    const response = await h.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: {
            name: "read_document",
            arguments: { projectId: marker },
            _meta: ENVELOPE,
          },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "read_document",
          authorization: "Bearer wvr_good",
        },
      ),
    );

    expect(response.status).toBe(429);
    expect(db.auditCreate).toHaveBeenCalledTimes(1);
    const audit = db.auditCreate.mock.calls[0]![0].data;
    expect(audit).toMatchObject({
      method: "tools/call",
      name: "read_document",
      outcome: "denied",
      errorCode: "RATE_LIMITED",
    });
    expect(JSON.stringify(audit)).not.toContain(marker);
    await flushDiagnostics(true);
    expect(
      db.diagnosticRows.filter((row) => row.event === "mcp.tool.called"),
    ).toEqual([
      expect.objectContaining({
        event: "mcp.tool.called",
        outcome: "denied",
        projectId: null,
        requestId: response.headers.get("x-weaver-request-id"),
        userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credentialId: "k1",
        details: {
          tool: "read_document",
          kind: "read",
          code: "RATE_LIMITED",
        },
      }),
    ]);
    expect(JSON.stringify(db.diagnosticRows)).not.toContain(marker);
  });

  it("audits an authenticated rate-limited resource read exactly once", async () => {
    const db = fakeDb();
    await enableDiagnostics(db);
    const h = handler({
      db,
      config: { ...config, rateLimitPerMinute: 1 },
    });
    const auth = { ...discoverHeaders, authorization: "Bearer wvr_good" };
    expect((await h.fetch(post(discover, auth))).status).toBe(200);
    const uri =
      "weaver://projects/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222";
    const response = await h.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 31,
          method: "resources/read",
          params: { uri, _meta: ENVELOPE },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "resources/read",
          "mcp-name": uri,
          authorization: "Bearer wvr_good",
        },
      ),
    );

    expect(response.status).toBe(429);
    expect(db.auditCreate).toHaveBeenCalledTimes(1);
    expect(db.auditCreate.mock.calls[0]![0].data).toMatchObject({
      method: "resources/read",
      name: uri,
      outcome: "denied",
      errorCode: "RATE_LIMITED",
    });
    await flushDiagnostics(true);
    expect(db.diagnosticRows).toEqual([
      expect.objectContaining({
        event: "mcp.resource.read",
        severity: "warn",
        requestId: response.headers.get("x-weaver-request-id"),
        userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credentialId: "k1",
        projectId: "11111111-1111-4111-8111-111111111111",
        documentId: "22222222-2222-4222-8222-222222222222",
        outcome: "denied",
        details: { kind: "document", uri, code: "RATE_LIMITED" },
      }),
    ]);
  });

  it("audits and stabilizes SDK pre-callback tool and resource rejections", async () => {
    const db = fakeDb();
    await enableDiagnostics(db);
    const h = handler({
      db,
      config: { ...config, rateLimitPerMinute: 10 },
    });
    const call = (name: string, args: unknown, id: number) =>
      h.fetch(
        post(
          {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args, _meta: ENVELOPE },
          },
          {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": name,
            authorization: "Bearer wvr_good",
          },
        ),
      );
    const hidden = await call("create_document", {}, 10);
    expect(hidden.status).toBe(200);
    const hiddenRequestId = hidden.headers.get("x-weaver-request-id");
    const hiddenBody = (await hidden.json()) as {
      result: { structuredContent: unknown };
    };
    expect(hiddenBody).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: { code: "NOT_FOUND", message: "not found or not accessible" },
        },
      },
    });

    const unknown = await call("guessed_private_tool", {}, 13);
    const unknownRequestId = unknown.headers.get("x-weaver-request-id");
    const unknownBody = (await unknown.json()) as {
      result: { structuredContent: unknown };
    };
    expect(unknownBody).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: { code: "NOT_FOUND", message: "not found or not accessible" },
        },
      },
    });
    expect(unknownBody.result.structuredContent).toEqual(
      hiddenBody.result.structuredContent,
    );

    const marker = "INVALID-TOOL-ARGUMENT-MUST-NOT-PERSIST";
    const invalid = await call(
      "read_document",
      { projectId: "not-a-uuid", content: marker },
      11,
    );
    const invalidRequestId = invalid.headers.get("x-weaver-request-id");
    expect(await invalid.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: { code: "BAD_REQUEST", message: "invalid tool arguments" },
        },
      },
    });

    const unmatchedUri = "weaver://projects/nope/documents/nope";
    const unmatched = await h.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "resources/read",
          params: { uri: unmatchedUri, _meta: ENVELOPE },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "resources/read",
          "mcp-name": unmatchedUri,
          authorization: "Bearer wvr_good",
        },
      ),
    );
    expect(await unmatched.json()).toMatchObject({
      error: { code: -32602 },
    });

    const projectId = "11111111-1111-4111-8111-111111111111";
    const documentId = "22222222-2222-4222-8222-222222222222";
    const deniedDb = {
      ...fakeDb(),
      project: {
        findMany: vi.fn(async () => [
          {
            id: projectId,
            organization: { members: [{ role: "viewer" }] },
          },
        ]),
        findFirst: vi.fn(async () => ({
          id: projectId,
          organization: {
            members: [
              {
                id: "membership-1",
                role: "viewer",
                userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                organizationId: "org-1",
              },
            ],
          },
        })),
      },
    } as unknown as ReturnType<typeof fakeDb>;
    const deniedUri = `weaver://projects/${projectId}/documents/${documentId}`;
    const denied = await handler({ db: deniedDb }).fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 14,
          method: "resources/read",
          params: { uri: deniedUri, _meta: ENVELOPE },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "resources/read",
          "mcp-name": deniedUri,
          authorization: "Bearer mcp-only-token",
        },
      ),
    );
    expect(await denied.json()).toMatchObject({ error: { code: -32602 } });
    const deniedAudits = deniedDb.auditCreate.mock.calls.map(
      ([input]) => input.data,
    );
    expect(deniedAudits).toContainEqual(
      expect.objectContaining({
        method: "resources/read",
        name: deniedUri,
        outcome: "denied",
        errorCode: "FORBIDDEN",
      }),
    );

    const audits = db.auditCreate.mock.calls.map(([input]) => input.data);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "tools/call",
          name: "create_document",
          outcome: "denied",
          errorCode: "FORBIDDEN",
        }),
        expect.objectContaining({
          method: "tools/call",
          name: "read_document",
          projectId: null,
          outcome: "error",
          errorCode: "BAD_REQUEST",
        }),
        expect.objectContaining({
          method: "tools/call",
          name: "guessed_private_tool",
          outcome: "error",
          errorCode: "NOT_FOUND",
        }),
        expect.objectContaining({
          method: "resources/read",
          name: unmatchedUri,
          outcome: "error",
          errorCode: "NOT_FOUND",
        }),
      ]),
    );
    await flushDiagnostics(true);
    const toolDiagnostics = db.diagnosticRows.filter(
      (row) => row.event === "mcp.tool.called",
    );
    expect(toolDiagnostics).toHaveLength(3);
    expect(toolDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "denied",
          requestId: hiddenRequestId,
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "k1",
          details: {
            tool: "create_document",
            kind: "write",
            code: "FORBIDDEN",
          },
        }),
        expect.objectContaining({
          outcome: "error",
          projectId: null,
          requestId: invalidRequestId,
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "k1",
          details: {
            tool: "read_document",
            kind: "read",
            code: "BAD_REQUEST",
          },
        }),
        expect.objectContaining({
          outcome: "error",
          requestId: unknownRequestId,
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "k1",
          details: { code: "NOT_FOUND" },
        }),
      ]),
    );
    expect(JSON.stringify(toolDiagnostics)).not.toContain(marker);
    expect(JSON.stringify(toolDiagnostics)).not.toContain(
      "guessed_private_tool",
    );
  });

  it("returns and audits stable cancellation for an already-aborted SDK request", async () => {
    const db = fakeDb();
    await enableDiagnostics(db);
    const h = handler({ db });
    const controller = new AbortController();
    const request = post(
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "list_projects", arguments: {}, _meta: ENVELOPE },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "list_projects",
        authorization: "Bearer wvr_good",
      },
    );
    const aborted = new Request(request, { signal: controller.signal });
    controller.abort();

    const response = await h.fetch(aborted);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: { code: "CANCELLED", message: "tool cancelled" },
        },
      },
    });
    const audits = db.auditCreate.mock.calls.map(([input]) => input.data);
    expect(audits).toEqual([
      expect.objectContaining({
        method: "tools/call",
        name: "list_projects",
        outcome: "error",
        errorCode: "CANCELLED",
      }),
    ]);
    await flushDiagnostics(true);
    expect(
      db.diagnosticRows.filter((row) => row.event === "mcp.tool.called"),
    ).toEqual([
      expect.objectContaining({
        event: "mcp.tool.called",
        outcome: "error",
        requestId: response.headers.get("x-weaver-request-id"),
        userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credentialId: "k1",
        details: {
          tool: "list_projects",
          kind: "read",
          code: "CANCELLED",
        },
      }),
    ]);
  });

  it.each([
    { protocolVersion: "2026-07-28", keepAliveMs: 0 },
    { protocolVersion: "2025-11-25", keepAliveMs: 0 },
    { protocolVersion: "2025-11-25", keepAliveMs: 15_000 },
  ])(
    "keeps fallback ownership when $protocolVersion cancellation wins after $keepAliveMs ms of keepalives",
    async ({ protocolVersion, keepAliveMs }) => {
      const db = fakeDb();
      await enableDiagnostics(db);
      let markFallbackAudit!: () => void;
      const fallbackAudit = new Promise<void>((resolve) => {
        markFallbackAudit = resolve;
      });
      db.auditCreate.mockImplementation(async (input) => {
        if (input.data.errorCode === "CANCELLED") markFallbackAudit();
        return {};
      });

      const contract = mcpToolByName("read_document");
      if (!contract) throw new Error("read_document contract missing");
      const originalSafeParseAsync = contract.inputSchema.safeParseAsync.bind(
        contract.inputSchema,
      );
      let markValidationStarted!: () => void;
      const validationStarted = new Promise<void>((resolve) => {
        markValidationStarted = resolve;
      });
      let releaseValidation!: () => void;
      const validationRelease = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      let markValidationFinished!: () => void;
      const validationFinished = new Promise<void>((resolve) => {
        markValidationFinished = resolve;
      });
      let safeParseCalls = 0;
      vi.spyOn(contract.inputSchema, "safeParseAsync").mockImplementation(
        async (...args) => {
          const call = ++safeParseCalls;
          if (call === 1) {
            markValidationStarted();
            await validationRelease;
          }
          const result = await originalSafeParseAsync(...args);
          if (call === 1) markValidationFinished();
          return result;
        },
      );

      const controller = new AbortController();
      const projectId = "11111111-1111-4111-8111-111111111111";
      const request = post(
        {
          jsonrpc: "2.0",
          id: 23,
          method: "tools/call",
          params: {
            name: "read_document",
            arguments: {
              projectId,
              documentId: "22222222-2222-4222-8222-222222222222",
            },
            ...(protocolVersion === "2026-07-28" ? { _meta: ENVELOPE } : {}),
          },
        },
        {
          "mcp-protocol-version": protocolVersion,
          "mcp-method": "tools/call",
          "mcp-name": "read_document",
          authorization: "Bearer wvr_good",
        },
      );
      if (keepAliveMs)
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const pending = handler({ db }).fetch(
        new Request(request, { signal: controller.signal }),
      );

      await validationStarted;
      if (keepAliveMs) {
        await vi.advanceTimersByTimeAsync(keepAliveMs);
        vi.useRealTimers();
      }
      controller.abort();
      await fallbackAudit;
      await vi.waitFor(async () => {
        await flushDiagnostics(true);
        expect(
          db.diagnosticRows.filter((row) => row.event === "mcp.tool.called"),
        ).toHaveLength(1);
      });
      releaseValidation();
      const response = await pending;
      await validationFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await flushDiagnostics(true);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: { code: "CANCELLED", message: "tool cancelled" },
          },
        },
      });
      expect(db.auditCreate).toHaveBeenCalledTimes(1);
      expect(db.auditCreate.mock.calls[0]![0].data).toMatchObject({
        method: "tools/call",
        name: "read_document",
        projectId,
        outcome: "error",
        errorCode: "CANCELLED",
      });
      expect(
        db.diagnosticRows.filter((row) => row.event === "mcp.tool.called"),
      ).toEqual([
        expect.objectContaining({
          event: "mcp.tool.called",
          requestId: response.headers.get("x-weaver-request-id"),
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "k1",
          projectId,
          outcome: "error",
          details: {
            tool: "read_document",
            kind: "read",
            code: "CANCELLED",
          },
        }),
      ]);
    },
  );

  it("leaves non-tool SDK cancellation as transport status 499", async () => {
    const db = fakeDb();
    const h = handler({ db });
    const controller = new AbortController();
    const uri =
      "weaver://projects/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222";
    const request = post(
      {
        jsonrpc: "2.0",
        id: 22,
        method: "resources/read",
        params: { uri, _meta: ENVELOPE },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "resources/read",
        "mcp-name": uri,
        authorization: "Bearer wvr_good",
      },
    );
    const aborted = new Request(request, { signal: controller.signal });
    controller.abort();

    const response = await h.fetch(aborted);

    expect(response.status).toBe(499);
    expect(db.auditCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps one correlated resource diagnostic when cancellation wins a delayed resource callback", async () => {
    const db = fakeDb();
    await enableDiagnostics(db);
    let markScopeStarted!: () => void;
    const scopeStarted = new Promise<void>((resolve) => {
      markScopeStarted = resolve;
    });
    let releaseScope!: () => void;
    const scopeRelease = new Promise<void>((resolve) => {
      releaseScope = resolve;
    });
    let markScopeFinished!: () => void;
    const scopeFinished = new Promise<void>((resolve) => {
      markScopeFinished = resolve;
    });
    Object.assign(db, {
      project: {
        findMany: vi.fn(async () => {
          markScopeStarted();
          await scopeRelease;
          markScopeFinished();
          return [];
        }),
      },
    });
    let markFallbackAudit!: () => void;
    const fallbackAudit = new Promise<void>((resolve) => {
      markFallbackAudit = resolve;
    });
    db.auditCreate.mockImplementation(async (input) => {
      if (input.data.errorCode === "CANCELLED") markFallbackAudit();
      return {};
    });

    const h = handler({ db });
    const controller = new AbortController();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const documentId = "22222222-2222-4222-8222-222222222222";
    const uri = `weaver://projects/${projectId}/documents/${documentId}`;
    const request = post(
      {
        jsonrpc: "2.0",
        id: 24,
        method: "resources/read",
        params: { uri, _meta: ENVELOPE },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "resources/read",
        "mcp-name": uri,
        authorization: "Bearer wvr_good",
      },
    );
    const pending = h.fetch(
      new Request(request, { signal: controller.signal }),
    );

    try {
      await scopeStarted;
      controller.abort();
      await fallbackAudit;
      const response = await pending;
      await flushDiagnostics(true);
      const rowsBeforeRelease = [...db.diagnosticRows];
      releaseScope();
      await scopeFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await flushDiagnostics(true);

      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");
      expect(db.auditCreate).toHaveBeenCalledTimes(1);
      expect(db.auditCreate.mock.calls[0]![0].data).toMatchObject({
        method: "resources/read",
        name: uri,
        requestId: response.headers.get("x-weaver-request-id"),
        userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credentialId: "k1",
        projectId,
        outcome: "error",
        errorCode: "CANCELLED",
      });
      expect(db.diagnosticRows).toEqual([
        expect.objectContaining({
          event: "mcp.resource.read",
          severity: "warn",
          requestId: response.headers.get("x-weaver-request-id"),
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "k1",
          projectId,
          documentId,
          outcome: "error",
          details: { kind: "document", uri, code: "CANCELLED" },
        }),
      ]);
      expect(db.diagnosticRows[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(db.diagnosticRows).toEqual(rowsBeforeRelease);
    } finally {
      releaseScope();
      await pending;
      await h.close();
    }
  });

  it.each([
    {
      name: "canonical resource",
      uri: "WEAVER://PROJECTS/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/DOCUMENTS/BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
      expectedProjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedDocumentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expectedKind: "document",
      expectedUri:
        "weaver://projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/documents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
    ...[
      "weaver://projects/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222?private=PRIVATE-URI-MARKER",
      "weaver://projects/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222#PRIVATE-URI-MARKER",
      "https://PRIVATE-URI-MARKER:password@example.com/document",
      "PRIVATE-URI-MARKER",
    ].map((uri) => ({
      name: uri,
      uri,
      expectedProjectId: null,
      expectedDocumentId: null,
      expectedKind: null,
      expectedUri: null,
    })),
  ])("uses safe URI metadata for cancelled $name", async (testCase) => {
    const db = fakeDb();
    await enableDiagnostics(db);
    const h = handler({ db });
    const controller = new AbortController();
    const request = post(
      {
        jsonrpc: "2.0",
        id: 25,
        method: "resources/read",
        params: { uri: testCase.uri, _meta: ENVELOPE },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "resources/read",
        "mcp-name": testCase.uri,
        authorization: "Bearer wvr_good",
      },
    );
    const aborted = new Request(request, { signal: controller.signal });
    controller.abort();

    try {
      const response = await h.fetch(aborted);
      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");
      expect(db.auditCreate).toHaveBeenCalledTimes(1);
      expect(db.auditCreate.mock.calls[0]![0].data).toMatchObject({
        method: "resources/read",
        outcome: "error",
        errorCode: "CANCELLED",
      });
      await flushDiagnostics(true);
      expect(db.diagnosticRows).toEqual([
        expect.objectContaining({
          event: "mcp.resource.read",
          severity: "warn",
          requestId: response.headers.get("x-weaver-request-id"),
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "k1",
          projectId: testCase.expectedProjectId,
          documentId: testCase.expectedDocumentId,
          outcome: "error",
          details: {
            kind: testCase.expectedKind,
            uri: testCase.expectedUri,
            code: "CANCELLED",
          },
        }),
      ]);
      expect(JSON.stringify(db.diagnosticRows)).not.toContain(
        "PRIVATE-URI-MARKER",
      );
      expect(JSON.stringify(db.diagnosticRows)).not.toContain("wvr_good");
    } finally {
      await h.close();
    }
  });

  it("keeps the resource callback diagnostic when it claims the audit before cancellation", async () => {
    const db = fakeDb();
    await enableDiagnostics(db);
    Object.assign(db, {
      project: { findMany: vi.fn(async () => []) },
    });
    let markAuditStarted!: () => void;
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    let releaseAudit!: () => void;
    const auditRelease = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let markAuditFinished!: () => void;
    const auditFinished = new Promise<void>((resolve) => {
      markAuditFinished = resolve;
    });
    db.auditCreate.mockImplementation(async () => {
      markAuditStarted();
      await auditRelease;
      markAuditFinished();
      return {};
    });
    const h = handler({ db });
    const controller = new AbortController();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const documentId = "22222222-2222-4222-8222-222222222222";
    const uri = `weaver://projects/${projectId}/documents/${documentId}`;
    const request = post(
      {
        jsonrpc: "2.0",
        id: 26,
        method: "resources/read",
        params: { uri, _meta: ENVELOPE },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "resources/read",
        "mcp-name": uri,
        authorization: "Bearer wvr_good",
      },
    );
    const pending = h.fetch(
      new Request(request, { signal: controller.signal }),
    );

    try {
      await auditStarted;
      controller.abort();
      const response = await pending;
      releaseAudit();
      await auditFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await flushDiagnostics(true);

      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");
      expect(db.auditCreate).toHaveBeenCalledTimes(1);
      expect(db.auditCreate.mock.calls[0]![0].data).toMatchObject({
        method: "resources/read",
        name: uri,
        outcome: "denied",
        errorCode: "FORBIDDEN",
      });
      expect(db.diagnosticRows).toEqual([
        expect.objectContaining({
          event: "mcp.resource.read",
          severity: "warn",
          requestId: response.headers.get("x-weaver-request-id"),
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "k1",
          projectId,
          documentId,
          outcome: "denied",
          details: { kind: "document", uri, code: "FORBIDDEN" },
        }),
      ]);
    } finally {
      releaseAudit();
      await pending;
      await h.close();
    }
  });

  it("normalizes late transport cancellation after the tool callback claims the audit", async () => {
    let markAuditStarted: () => void = () => undefined;
    let releaseAudit: () => void = () => undefined;
    let markAuditFinished: () => void = () => undefined;
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    const auditRelease = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const auditFinished = new Promise<void>((resolve) => {
      markAuditFinished = resolve;
    });
    const db = fakeDb();
    Object.assign(db, {
      project: { findMany: vi.fn(async () => []) },
    });
    db.auditCreate.mockImplementation(async () => {
      markAuditStarted();
      await auditRelease;
      markAuditFinished();
      return {};
    });
    const h = handler({ db });
    const controller = new AbortController();
    const request = post(
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "list_projects", arguments: {}, _meta: ENVELOPE },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "list_projects",
        authorization: "Bearer wvr_good",
      },
    );
    const pending = h.fetch(
      new Request(request, { signal: controller.signal }),
    );

    await auditStarted;
    controller.abort();
    const response = await pending;
    releaseAudit();
    await auditFinished;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: { code: "CANCELLED", message: "tool cancelled" },
        },
      },
    });
    expect(db.auditCreate).toHaveBeenCalledTimes(1);
    const audits = db.auditCreate.mock.calls.map(([input]) => input.data);
    expect(audits).toEqual([
      expect.objectContaining({
        method: "tools/call",
        name: "list_projects",
        outcome: "ok",
        errorCode: null,
      }),
    ]);
  });

  it.each(["2026-07-28", "2025-11-25"])(
    "drains %s fetches before idempotent handler shutdown",
    async (protocolVersion) => {
      let markQueryStarted: () => void = () => undefined;
      let releaseQuery: () => void = () => undefined;
      const queryStarted = new Promise<void>((resolve) => {
        markQueryStarted = resolve;
      });
      const queryRelease = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      const db = fakeDb();
      Object.assign(db, {
        project: {
          findMany: vi.fn(async () => {
            markQueryStarted();
            await queryRelease;
            return [];
          }),
        },
      });
      const h = handler({ db });
      const pending = h.fetch(
        post(
          {
            jsonrpc: "2.0",
            id: 23,
            method: "tools/call",
            params: {
              name: "list_projects",
              arguments: {},
              ...(protocolVersion === "2026-07-28" ? { _meta: ENVELOPE } : {}),
            },
          },
          {
            "mcp-protocol-version": protocolVersion,
            "mcp-method": "tools/call",
            "mcp-name": "list_projects",
            authorization: "Bearer wvr_good",
          },
        ),
      );
      let firstClose: Promise<void> | undefined;
      let secondClose: Promise<void> | undefined;

      try {
        await queryStarted;
        firstClose = h.close();
        secondClose = h.close();
        const settledBeforeRelease = await Promise.race([
          Promise.all([pending, firstClose]).then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
        ]);
        const newAdmission = await h
          .fetch(new Request("http://127.0.0.1:3200/health"))
          .catch(() => null);
        releaseQuery();
        const [response] = await Promise.all([
          pending,
          firstClose,
          secondClose,
        ]);

        expect(settledBeforeRelease).toBe(false);
        expect(secondClose).toBe(firstClose);
        expect(newAdmission).toBeInstanceOf(Response);
        expect(newAdmission?.status).toBe(503);
        expect(response.status).toBe(200);
        const body = await response.text();
        const message = response.headers
          .get("content-type")
          ?.includes("text/event-stream")
          ? body
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6)
          : body;
        expect(JSON.parse(message)).toMatchObject({
          result: { structuredContent: { projects: [] } },
        });
        expect(db.auditCreate).toHaveBeenCalledTimes(1);
        expect(db.auditCreate.mock.calls[0]?.[0].data).toMatchObject({
          name: "list_projects",
          outcome: "ok",
          errorCode: null,
        });
      } finally {
        releaseQuery();
        await Promise.allSettled([
          pending,
          firstClose ?? Promise.resolve(),
          secondClose ?? Promise.resolve(),
        ]);
      }
    },
  );
});

describe("MCP toolsets and meta-tools", () => {
  const toolsList = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: { _meta: ENVELOPE },
  };
  const listHeaders = {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/list",
    authorization: "Bearer wvr_good",
  };
  const META = ["search_tools", "describe_tool", "call_tool"];
  const CORE_READ = CORE_TOOL_NAMES.filter(
    (name) => !["create_document", "patch_document"].includes(name),
  );
  const ADMIN_NAMES = new Set(ADMIN_TOOLS.map((tool) => tool.name));

  async function listed(
    h: ReturnType<typeof handler>,
    extra: Record<string, string> = {},
  ) {
    const body = (await (
      await h.fetch(post(toolsList, { ...listHeaders, ...extra }))
    ).json()) as {
      result: { tools: Array<{ name: string } & Record<string, unknown>> };
    };
    return body.result.tools;
  }

  type ToolResult = {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
  };

  async function callTool(
    h: ReturnType<typeof handler>,
    name: string,
    args: unknown,
    id: number,
  ) {
    const response = await h.fetch(
      post(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args, _meta: ENVELOPE },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": name,
          authorization: "Bearer wvr_good",
        },
      ),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { result: ToolResult }).result;
  }

  it("lists the core toolset plus the meta-tools by default, without titles, under the budget", async () => {
    const tools = await listed(handler());
    expect(tools.map((tool) => tool.name)).toEqual([...CORE_READ, ...META]);
    expect(tools.every((tool) => !("title" in tool))).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(tools), "utf8"),
    ).toBeLessThanOrEqual(28_000);
    expect(
      tools.find((tool) => tool.name === "call_tool")!.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("adds the toolsets named in X-Weaver-Toolsets, ignores unknown names and never widens capabilities", async () => {
    const names = (
      await listed(handler(), { "x-weaver-toolsets": " Tables , bogus, admin" })
    ).map((tool) => tool.name);
    expect(names).toEqual([
      ...MCP_TOOLS.filter(
        (tool) =>
          tool.kind === "read" &&
          (CORE_TOOL_NAMES.includes(tool.name) ||
            MCP_TOOLSET_MEMBERS.tables.includes(tool.name)),
      ).map((tool) => tool.name),
      ...META,
    ]);
    expect(names.some((name) => ADMIN_NAMES.has(name))).toBe(false);
  });

  it("lists every permitted tool for all", async () => {
    const names = (await listed(handler(), { "x-weaver-toolsets": "all" })).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([
      ...MCP_TOOLS.filter(
        (tool) => tool.kind === "read" && tool.capability === "content:read",
      ).map((tool) => tool.name),
      ...META,
    ]);
  });

  it("describes a permitted tool and refuses a forbidden one with the uniform message", async () => {
    const db = fakeDb();
    const h = handler({ db, config: { ...config, rateLimitPerMinute: 10 } });

    const described = await callTool(
      h,
      "describe_tool",
      { name: "read_document" },
      40,
    );
    expect(described.isError).toBeFalsy();
    expect(
      (described.structuredContent.inputSchema as { type: string }).type,
    ).toBe("object");
    expect(described.structuredContent).toMatchObject({
      name: "read_document",
      toolsets: ["core", "documents"],
      listed: true,
    });

    const refused = await callTool(
      h,
      "describe_tool",
      { name: "list_diagnostic_events" },
      41,
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe(
      "NOT_FOUND: tool not found or not accessible",
    );
    expect(JSON.stringify(refused)).not.toContain("list_diagnostic_events");

    expect(db.auditCreate.mock.calls.map(([input]) => input.data)).toEqual([
      expect.objectContaining({
        method: "tools/call",
        name: "describe_tool",
        outcome: "ok",
        errorCode: null,
      }),
      expect.objectContaining({
        method: "tools/call",
        name: "describe_tool",
        outcome: "error",
        errorCode: "NOT_FOUND",
      }),
    ]);
  });

  it("searches the permitted catalogue and reports what is listed", async () => {
    const h = handler({ config: { ...config, rateLimitPerMinute: 10 } });

    const found = await callTool(h, "search_tools", { query: "document" }, 42);
    expect(found.isError).toBeFalsy();
    const tools = found.structuredContent.tools as Array<{
      name: string;
      listed: unknown;
    }>;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]!.name).toContain("document");
    expect(tools.every((tool) => typeof tool.listed === "boolean")).toBe(true);
    expect(tools.some((tool) => ADMIN_NAMES.has(tool.name))).toBe(false);
    expect(found.structuredContent.activeToolsets).toEqual(["core"]);
    expect(found.structuredContent.availableToolsets).toContain("documents");

    const admin = await callTool(h, "search_tools", { toolset: "admin" }, 43);
    expect(admin.isError).toBeFalsy();
    expect(admin.structuredContent.tools).toEqual([]);
  });

  it("audits and stabilizes a meta-tool call whose arguments the SDK rejects", async () => {
    const db = fakeDb();
    await enableDiagnostics(db);
    const h = handler({ db, config: { ...config, rateLimitPerMinute: 10 } });
    const rejected = {
      isError: true,
      structuredContent: {
        error: { code: "BAD_REQUEST", message: "invalid tool arguments" },
      },
    };

    const result = await callTool(h, "call_tool", { arguments: {} }, 44);
    expect(result).toMatchObject(rejected);
    // Inner arguments the inner tool would accept, but call_tool's own shape is wrong.
    const shape = await callTool(
      h,
      "call_tool",
      { name: "list_projects", arguments: "not-an-object" },
      47,
    );
    expect(shape).toMatchObject(rejected);
    // A forbidden inner name must read exactly like an unknown one.
    const forbidden = await callTool(
      h,
      "call_tool",
      { name: "list_diagnostic_events", arguments: "not-an-object" },
      48,
    );
    const unknown = await callTool(
      h,
      "call_tool",
      { name: "guessed_private_tool", arguments: "not-an-object" },
      49,
    );
    expect(forbidden).toMatchObject(rejected);
    expect(forbidden.structuredContent).toEqual(unknown.structuredContent);
    expect(db.auditCreate.mock.calls.map(([input]) => input.data)).toEqual([
      expect.objectContaining({
        method: "tools/call",
        name: "call_tool",
        outcome: "error",
        errorCode: "BAD_REQUEST",
      }),
      expect.objectContaining({
        method: "tools/call",
        name: "list_projects",
        outcome: "error",
        errorCode: "BAD_REQUEST",
      }),
      expect.objectContaining({
        method: "tools/call",
        name: "call_tool",
        outcome: "error",
        errorCode: "BAD_REQUEST",
      }),
      expect.objectContaining({
        method: "tools/call",
        name: "call_tool",
        outcome: "error",
        errorCode: "BAD_REQUEST",
      }),
    ]);
    await flushDiagnostics(true);
    expect(
      db.diagnosticRows
        .filter((row) => row.event === "mcp.tool.called")
        .map((row) => row.details),
    ).toEqual([
      { tool: "call_tool", kind: "meta", code: "BAD_REQUEST" },
      {
        tool: "list_projects",
        kind: "read",
        code: "BAD_REQUEST",
        via: "call_tool",
      },
      { tool: "call_tool", kind: "meta", code: "BAD_REQUEST" },
      { tool: "call_tool", kind: "meta", code: "BAD_REQUEST" },
    ]);
  });

  it("declares no listChanged and names connected-app tools in the instructions only for an external selection", async () => {
    const db = fakeDb();
    db.$queryRaw = vi.fn(async () => [
      {
        permissions: JSON.stringify({
          mcp: ["use"],
          content: ["read"],
          external: ["use"],
        }),
        enabled: true,
        referenceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        projectIds: [],
      },
    ]) as unknown as PrismaClient["$queryRaw"];
    const h = createMcpHttpHandler({
      db,
      verifiers: fakeVerifiers(),
      config: { ...config, rateLimitPerMinute: 10 },
      external: {} as ExternalRuntimeDeps,
      log: () => undefined,
    });
    const discovered = async (extra: Record<string, string>) =>
      (
        (await (
          await h.fetch(
            post(discover, {
              ...discoverHeaders,
              authorization: "Bearer wvr_good",
              ...extra,
            }),
          )
        ).json()) as {
          result: {
            capabilities: Record<string, unknown>;
            instructions: string;
          };
        }
      ).result;

    const plain = await discovered({});
    expect(plain.capabilities).toMatchObject({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
    expect(plain.instructions).not.toContain("ext_<connection>");
    const external = await discovered({ "x-weaver-toolsets": "external" });
    expect(external.instructions).toContain("ext_<connection>__<tool>");
  });

  it("keeps an unlisted permitted tool directly callable without the header", async () => {
    const db = fakeDb();
    Object.assign(db, { project: { findMany: vi.fn(async () => []) } });
    const h = handler({ db });

    const result = await callTool(
      h,
      "get_table",
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        tableId: "22222222-2222-4222-8222-222222222222",
      },
      45,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "SCOPE_VIOLATION" } },
    });
    expect(db.auditCreate.mock.calls.map(([input]) => input.data)).toEqual([
      expect.objectContaining({
        method: "tools/call",
        name: "get_table",
        errorCode: "SCOPE_VIOLATION",
      }),
    ]);
  });

  it("runs a permitted tool through call_tool and audits and logs the inner name", async () => {
    const db = fakeDb();
    Object.assign(db, { project: { findMany: vi.fn(async () => []) } });
    const log = vi.fn<(line: McpLogLine) => void>();
    const h = createMcpHttpHandler({
      db,
      verifiers: fakeVerifiers(),
      config,
      log,
    });

    const result = await callTool(
      h,
      "call_tool",
      { name: "list_projects", arguments: {} },
      46,
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ projects: [] });
    expect(db.auditCreate.mock.calls.map(([input]) => input.data)).toEqual([
      expect.objectContaining({
        method: "tools/call",
        name: "list_projects",
        outcome: "ok",
        errorCode: null,
      }),
    ]);
    expect(
      log.mock.calls
        .map(([line]) => line)
        .find((line) => line.event === "mcp.request"),
    ).toMatchObject({ method: "tools/call", name: "list_projects" });
  });
});

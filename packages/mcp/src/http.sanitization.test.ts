import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BearerVerification, ResourceRequestInput } from "@weaver/auth";
import type { PrismaClient } from "@weaver/db/client";
import type * as McpSdk from "@modelcontextprotocol/server";
import type { McpRuntimeConfig } from "./config";

const capture = vi.hoisted(() => ({
  request: undefined as Request | undefined,
}));

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof McpSdk>();
  return {
    ...actual,
    createMcpHandler: vi.fn(() => ({
      fetch: vi.fn(async (request: Request) => {
        capture.request = request;
        return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      }),
      close: vi.fn(async () => undefined),
    })),
  };
});

import { createMcpHttpHandler } from "./http";

const config: McpRuntimeConfig = {
  resourceUrl: "http://127.0.0.1:3200/mcp",
  issuer: "http://localhost:3000/api/auth",
  mcpPath: "/mcp",
  metadataPath: "/.well-known/oauth-protected-resource/mcp",
  allowedHosts: ["127.0.0.1"],
  allowedOrigins: ["127.0.0.1"],
  maxBodyBytes: 1_024,
  maxResourceChars: 1_000,
  toolTimeoutMs: 1_000,
  rateLimitPerMinute: 10,
  anonRateLimitPerMinute: 10,
  version: "test",
  production: false,
};

beforeEach(() => {
  capture.request = undefined;
});

function boundaryHandler() {
  return createMcpHttpHandler({
    db: {
      user: {
        findUnique: vi.fn(async () => ({
          id: "u1",
          role: "User",
          banned: false,
          name: "U",
          email: "u@test.local",
        })),
      },
      $queryRaw: vi.fn(async () => [
        {
          permissions: JSON.stringify({
            mcp: ["use"],
            content: ["read", "write"],
          }),
          enabled: true,
          referenceId: "u1",
          projectIds: [],
        },
      ]),
      mcpAuditEvent: { create: vi.fn(async () => ({})) },
    } as unknown as PrismaClient,
    verifiers: {
      verifyApiKey: vi.fn(),
      verifyAccessToken: vi.fn(),
      verifyResourceRequest: vi.fn(
        async (_input: ResourceRequestInput): Promise<BearerVerification> => ({
          ok: true,
          credential: {
            kind: "apiKey",
            keyId: "k1",
            userId: "u1",
            permissions: {
              mcp: ["use"],
              content: ["read", "write"],
            },
          },
        }),
      ),
    },
    config,
    log: () => undefined,
  });
}

describe("MCP SDK request boundary", () => {
  it("strips bearer and DPoP credentials while preserving protocol input", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {},
    });
    const controller = new AbortController();
    const handler = boundaryHandler();
    const response = await handler.fetch(
      new Request("http://127.0.0.1:3200/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
          authorization: "Bearer super-secret",
          dpop: "proof-secret",
          "x-custom": "preserved",
        },
        body,
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(capture.request).toBeDefined();
    expect(capture.request?.headers.get("authorization")).toBeNull();
    expect(capture.request?.headers.get("dpop")).toBeNull();
    expect(capture.request?.headers.get("mcp-method")).toBe("server/discover");
    expect(capture.request?.headers.get("x-custom")).toBe("preserved");
    expect(capture.request?.url).toBe("http://127.0.0.1:3200/mcp");
    expect(capture.request?.method).toBe("POST");
    expect(await capture.request?.text()).toBe(body);
    controller.abort();
    expect(capture.request?.signal.aborted).toBe(true);
  });

  it("keeps a write body and protocol headers while shielding SDK teardown", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_document",
        arguments: {},
      },
    });
    const controller = new AbortController();
    const handler = boundaryHandler();
    const response = await handler.fetch(
      new Request("http://127.0.0.1:3200/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "create_document",
          authorization: "Bearer write-secret",
          dpop: "write-proof-secret",
          "x-custom": "preserved-write",
        },
        body,
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(capture.request?.headers.get("authorization")).toBeNull();
    expect(capture.request?.headers.get("dpop")).toBeNull();
    expect(capture.request?.headers.get("mcp-name")).toBe("create_document");
    expect(capture.request?.headers.get("x-custom")).toBe("preserved-write");
    expect(await capture.request?.text()).toBe(body);
    controller.abort();
    expect(capture.request?.signal.aborted).toBe(false);
  });

  it.each([
    { inner: "create_document", shielded: true },
    { inner: "read_document", shielded: false },
  ])(
    "shields call_tool teardown exactly when its inner tool $inner is a permitted write",
    async ({ inner, shielded }) => {
      const controller = new AbortController();
      const response = await boundaryHandler().fetch(
        new Request("http://127.0.0.1:3200/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "call_tool",
            authorization: "Bearer write-secret",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "call_tool",
              arguments: { name: inner, arguments: {} },
            },
          }),
          signal: controller.signal,
        }),
      );

      expect(response.status).toBe(200);
      controller.abort();
      expect(capture.request?.signal.aborted).toBe(!shielded);
    },
  );
});

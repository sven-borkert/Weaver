import { expect, it, vi } from "vitest";
import { startMcpFixture } from "./testing/server";
import { createExternalMcpTransport } from "./client";

it("negotiates the legacy JSON/no-session server through the real SDK", async () => {
  const server = await startMcpFixture({
    protocolVersion: "2024-11-05",
    toolCount: 186,
  });
  const transport = createExternalMcpTransport({ fetchImpl: fetch });
  const session = await transport.open({
    endpoint: server.url,
    token: async () => "test-only",
    signal: AbortSignal.timeout(5000),
    timeoutMs: 5000,
  });
  try {
    expect((await session.discover()).tools).toHaveLength(186);
    expect(
      (await session.call({ name: "read_counter", arguments: {} })).isError,
    ).toBe(false);
  } finally {
    await session.close();
    await server.close();
  }
});

async function connect(
  options: Parameters<typeof startMcpFixture>[0] = {},
  signal = new AbortController().signal,
) {
  const server = await startMcpFixture(options);
  try {
    const session = await createExternalMcpTransport({ fetchImpl: fetch }).open(
      {
        endpoint: server.url,
        token: async () => null,
        signal,
        timeoutMs: 5000,
      },
    );
    return {
      server,
      session,
      close: async () => {
        await session.close();
        await server.close();
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
it("uses SSE results, session headers and bounded catalog pagination", async () => {
  const fixture = await connect({
    responseMode: "sse",
    requireSession: true,
    toolCount: 186,
    pageSize: 30,
  });
  try {
    const catalog = await fixture.session.discover();
    expect(catalog.tools).toHaveLength(186);
    expect(catalog.tools.every((tool) => tool.annotations === undefined)).toBe(
      true,
    );
    expect(catalog.protocolVersion).toBe("2025-03-26");
    await fixture.session.call({
      name: "set_counter",
      arguments: { value: 42 },
    });
    expect(
      await fixture.session.call({ name: "read_counter", arguments: {} }),
    ).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "42" }],
      structuredContent: { counter: 42 },
      truncated: false,
    });
    expect(
      fixture.server.requests.filter(
        (request) => request.rpcMethod === "tools/list",
      ),
    ).toHaveLength(7);
    expect(
      fixture.server.requests
        .filter((request) => request.rpcMethod === "tools/call")
        .every(
          (request) =>
            request.session === "fixture-session" &&
            request.protocolVersion === "2025-03-26",
        ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});
it.each([
  { cyclicCursor: true },
  { toolCount: 501 },
  { toolCount: 30, pageSize: 1 },
])("rejects invalid catalog bounds %j", async (options) => {
  const fixture = await connect(options);
  try {
    await expect(fixture.session.discover()).rejects.toThrow("INVALID_CATALOG");
    expect(fixture.server.calls).toEqual([]);
  } finally {
    await fixture.close();
  }
});
it.each(["401", "overflow", "invalid-json", "redirect"] as const)(
  "rejects %s without replay",
  async (mode) => {
    await expect(connect({ mode })).rejects.toThrow();
  },
);
it("rejects unsupported negotiated protocol versions", async () => {
  await expect(connect({ protocolVersion: "1900-01-01" })).rejects.toThrow(
    "UNSUPPORTED_PROTOCOL",
  );
});
it("returns MCP isError and truncates model-visible output", async () => {
  const fixture = await connect({
    onCall: () => ({
      isError: true,
      content: [
        { type: "text", text: "x".repeat(20000) },
        {
          type: "resource_link",
          uri: "https://no-fetch.test/private",
          name: "link",
        },
      ],
    }),
  });
  try {
    const result = await fixture.session.call({
      name: "read_counter",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.content)).toContain("x".repeat(16000));
    expect(result.responseBytes).toBeGreaterThan(20000);
    expect(fixture.server.calls).toHaveLength(1);
    expect(
      fixture.server.requests.some(
        (request) => request.rpcMethod === "resources/read",
      ),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});
it("caps call responses separately from catalogs", async () => {
  const fixture = await connect({
    onCall: () => ({ content: [{ type: "text", text: "x".repeat(270000) }] }),
  });
  try {
    await fixture.session.discover();
    await expect(
      fixture.session.call({ name: "read_counter", arguments: {} }),
    ).rejects.toThrow();
    expect(fixture.server.calls).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
it("rejects invalid arguments without sending a tool call", async () => {
  const fixture = await connect();
  try {
    await expect(
      fixture.session.call({
        name: "set_counter",
        arguments: { value: "invalid" },
      }),
    ).rejects.toThrow("INVALID_ARGUMENTS");
    expect(fixture.server.calls).toEqual([]);
  } finally {
    await fixture.close();
  }
});
it.each(["abort", "close"] as const)(
  "cancels a dispatched call on %s without replay",
  async (mode) => {
    let started!: () => void;
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const fixture = await connect(
      {
        onCall: async () => {
          started();
          await pending;
          return { content: [] };
        },
      },
      controller.signal,
    );
    try {
      await fixture.session.discover();
      const operation = fixture.session.call({
        name: "read_counter",
        arguments: {},
      });
      const assertion = expect(operation).rejects.toThrow();
      await called;
      if (mode === "abort") controller.abort();
      else await fixture.session.close();
      await assertion;
      release();
      expect(fixture.server.calls).toHaveLength(1);
      if (mode === "close")
        await expect(fixture.session.discover()).rejects.toThrow("CLOSED");
    } finally {
      release();
      await fixture.close();
    }
  },
);
it("uses rotated tokens across real SDK HTTP requests", async () => {
  const server = await startMcpFixture();
  const seen: (string | null)[] = [];
  let version = "first";
  const session = await createExternalMcpTransport({
    fetchImpl: async (url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return fetch(url, init);
    },
  }).open({
    endpoint: server.url,
    token: async () => version,
    signal: AbortSignal.timeout(5000),
    timeoutMs: 5000,
  });
  try {
    version = "second";
    await session.discover();
    await session.call({ name: "read_counter", arguments: {} });
    expect(seen[0]).toBe("Bearer first");
    expect(seen.at(-1)).toBe("Bearer second");
    expect(JSON.stringify(server.requests)).not.toContain("Bearer");
  } finally {
    await session.close();
    await server.close();
  }
});
it("honors cancellation while resolving credentials", async () => {
  const controller = new AbortController();
  const transport = createExternalMcpTransport({ fetchImpl: fetch });
  const promise = transport.open({
    endpoint: "http://127.0.0.1:1/mcp",
    token: () => new Promise(() => undefined),
    signal: controller.signal,
    timeoutMs: 5000,
  });
  const assertion = expect(promise).rejects.toThrow("CANCELLED");
  controller.abort();
  await assertion;
});
it("aborts HTTP work when the per-operation timeout expires", async () => {
  const fixture = await connect({ onCall: () => new Promise(() => undefined) });
  try {
    await fixture.session.discover();
    await expect(
      fixture.session.call({ name: "read_counter", arguments: {} }),
    ).rejects.toThrow("CANCELLED");
    expect(fixture.server.calls).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 7000);
it("keeps unsupported remote schemas visible and blocks execution", async () => {
  const fixture = await connect({
    tools: [
      {
        name: "custom",
        description: "Review this tool",
        inputSchema: {
          type: "object",
          properties: { x: { pattern: "unsafe" } },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  });
  try {
    const catalog = await fixture.session.discover();
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]).toMatchObject({
      name: "custom",
      description: "Review this tool",
      supportStatus: { available: false, reason: "UNSUPPORTED_SCHEMA" },
      annotations: { readOnlyHint: true },
    });
    await expect(
      fixture.session.call({ name: "custom", arguments: {} }),
    ).rejects.toThrow("UNSUPPORTED_SCHEMA");
    expect(fixture.server.calls).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
it("validates structured output schemas without weakening the contract", async () => {
  const fixture = await connect({
    tools: [
      {
        name: "custom",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    ],
    onCall: () => ({ content: [], structuredContent: { count: "wrong" } }),
  });
  try {
    await expect(
      fixture.session.call({ name: "custom", arguments: {} }),
    ).rejects.toThrow("INVALID_RESULT");
    expect(fixture.server.calls).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
it("exposes the canonical endpoint after successful same-origin discovery redirects", async () => {
  const server = await startMcpFixture();
  const session = await createExternalMcpTransport({
    fetchImpl: async (url, init) => {
      if (
        new URL(
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        ).pathname === "/mcp"
      )
        return new Response(null, {
          status: 307,
          headers: { location: "/canonical?tenant=one" },
        });
      return fetch(url, init);
    },
  }).open({
    endpoint: server.url,
    token: async () => "bearer-only",
    signal: AbortSignal.timeout(5000),
    timeoutMs: 5000,
  });
  try {
    const catalog = await session.discover();
    expect(catalog.canonicalEndpoint).toBe(
      new URL("/canonical?tenant=one", server.url).href,
    );
    expect(catalog.tools).toHaveLength(2);
    expect(JSON.stringify(catalog)).not.toContain("bearer-only");
  } finally {
    await session.close();
    await server.close();
  }
});

it("classifies forbidden HTTP without inspecting response text", async () => {
  await expect(
    createExternalMcpTransport({
      fetchImpl: async () => new Response("private token", { status: 403 }),
    }).open({
      endpoint: "http://127.0.0.1:3210/mcp",
      token: async () => null,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("classifies malformed SDK tool results without inspecting exception text", async () => {
  const fixture = await connect({ onCall: () => ({ content: 42 }) });
  try {
    await expect(
      fixture.session.call({ name: "read_counter", arguments: {} }),
    ).rejects.toMatchObject({ code: "INVALID_RESULT" });
    expect(fixture.server.calls).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

// Self-signed test-only certificate for 127.0.0.1, valid 2026-2036. Same
// fixture as packages/config/src/outboundFetch.test.ts.
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUbeP9PMSdqeUKCwXhJycP6jBgZewwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDkzMDE0MDk1NloXDTM2MDky
NzE0MDk1NlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqsRCBApXQw5DQA41qRaABjkHDtEDeprLYtw8B38UxEas
NcswGF7a8yEHr/KB4cBBmF7bYsp9fpKdAMxu7uD6geyIH5q4AFcUCVDI7WbNzvm+
pPHu/nGBm+sEu83zQBT0hi7Wl0aahjxaysJcEWSDgRAPD5E0AHa3562ugc6bvY47
2tgu9fBLaqKhHkTIYeczalIdAjW9sgMYUJgbbgo0eROZ/wfrb8Cs9SWkCD5iYVrM
2eOY3zWnbZPbqZxOxbIaCb8WudAxoE4PSptconcNzhtpEx+MbU6388gJSfvywMIQ
lqci3mf5fQgxvUbb0p5Erz2K0SaoI1+BdwyFAtwMzwIDAQABo2QwYjAdBgNVHQ4E
FgQUvCg597FY242vqA8yQMwMUped9nQwHwYDVR0jBBgwFoAUvCg597FY242vqA8y
QMwMUped9nQwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQBnRXU014Ao5pCEzikMo1JGoiUwgmmMZyQePs0mAcSJXw7H
ZAmmFArMeHf5eao4uAugTKzohV2WqBnei7TWO+/vtZZReNhs9ezPvciytRG1Cclc
AwlkiiSPRtNKsPgbrFznZjNKe0DX55RGRrtcHBCF3/9vFYntRnX30o6NBepphZQC
NJ1iq91qOUSybDV4huCZ48nEPK/6QGhfSDbc+xGb73DbSE9Ll6iUVi1KntIGkECJ
68ZuhE7oqGCI+dEyVAtbVUOb/XG9/RhaFyxn+vXgs8QCI2FTqd155PE5pumUOIg0
U8JpkVPU4B6vgod9PnTnXJx0AREUn6R7qUmXy+lk
-----END CERTIFICATE-----`;
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCqxEIECldDDkNA
DjWpFoAGOQcO0QN6msti3DwHfxTERqw1yzAYXtrzIQev8oHhwEGYXttiyn1+kp0A
zG7u4PqB7IgfmrgAVxQJUMjtZs3O+b6k8e7+cYGb6wS7zfNAFPSGLtaXRpqGPFrK
wlwRZIOBEA8PkTQAdrfnra6Bzpu9jjva2C718EtqoqEeRMhh5zNqUh0CNb2yAxhQ
mBtuCjR5E5n/B+tvwKz1JaQIPmJhWszZ45jfNadtk9upnE7FshoJvxa50DGgTg9K
m1yidw3OG2kTH4xtTrfzyAlJ+/LAwhCWpyLeZ/l9CDG9RtvSnkSvPYrRJqgjX4F3
DIUC3AzPAgMBAAECggEANBPvOBE5RINsgfPzbHImr/8jRmL6xyC/BxK4IechG6yb
5znknIINDtmTYRa5gnHh70h6annrZLbst6og6Kvm6cmLR+wk0kG8JA0lgbT47faf
K+l2Y9WU28qEIowv82qQmf1dxzuqc2ajn7M/ZbR8IFeX6Dz1mXCbLEX88qxiNZ/T
v+wAkocISRVa5kk22sqqC6HvFAx5rR+FMdENrJ+s5TQC/AAFygrtlbm1PpOSxfg4
AoIdFIfMsebWPfknBbO99cdM7igUUMWe23kbKftmwKdC6rvkW7C3rmpzy4CaSr2u
s0wfDLZamH4k7V6n1V1UPfHrGNtTIQ/jROaK8HNvmQKBgQDaENm40fFEB4/pgwm1
76/+Lcj82OEqIbzgANUgovNHQ+Gep9NCHqw4W/YPco/Bj2A2+CRVxU1ONC52X26Q
JKiNXg7acAOKvhDxVVcXbXn3Fr9TGNlAUdAs4g0roPUf8cmMEhEQvNkW8oqEe/8R
/8Dntqq/HWGi787BiBD+JdhaqQKBgQDIeQb9+3mG2Ce3msSngbbAi8BAV+iIWSzm
TMYoBLRr5KzE/KySfan9BXQerxI666XBC0cO6RhsQv1FuAiMY5WdygW5YMjPRXSQ
YgZ+E4TQAwbPt0MgP+H41MwpRtSaeL5IrRosvJ1MD4FxjB0m9iTfWmQYSBackAmH
8XhFsw4OtwKBgG0uVKRZ0S+bja1/42PJb1eXOvOF7y62F6gcIpmlnKLI1PUn1/lZ
/CZ3vLo9RMbH74d2NFMRZ0RJkh3IaEYZZJ7rQgqSXOOhiEAc128ubAuPwxlq7pNq
ow1l3OxEOZbV63CLNyonM5Zut3Xf03UClWYuqkzn/BOld+KkKsXk0u+JAoGAfwTP
/VS8p0eFwrt5Jnj1hgIGCb6pQtrdq/2w/+IbPtFg9l7yKM8eSYaPEHH0pwhvuWSf
3T6rjszTFL2KDQl73sIF5nMASPPE60Zwvqk3WWTRiAKhsWlIkBSkVvLd+hHO3tVu
5DGNqIeaiIsyXWFP84SeLxRd300T/OJuRhsxKPkCgYEApGsvZ6o3/3tQjnTAfUSS
LLFZ1/EPCHL3kpfYZHplqj7SNxc/1EGtuEN4tofnuzWTJbd0FP5w0n7fujk+H6wD
l3BfwD46aKIVP5DD+er2dXKAhMItmmWNor6ua2K2Z/XF2Iu3AGfBilzElKN9ErSk
0UU6l73CF12Mhnp3wBA3zLs=
-----END PRIVATE KEY-----`;

it("rejects a self-signed server by default and connects when insecureTls is set", async () => {
  const server = await startMcpFixture({
    tls: { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
  });
  const transport = createExternalMcpTransport({ fetchImpl: fetch });
  try {
    await expect(
      transport.open({
        endpoint: server.url,
        token: async () => null,
        signal: AbortSignal.timeout(5000),
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    const session = await transport.open({
      endpoint: server.url,
      token: async () => null,
      signal: AbortSignal.timeout(5000),
      timeoutMs: 5000,
      insecureTls: true,
    });
    expect((await session.discover()).tools.length).toBeGreaterThan(0);
    await session.close();
  } finally {
    await server.close();
  }
});

function causeCodes(error: unknown): unknown[] {
  const codes: unknown[] = [];
  for (let e = error; e instanceof Error; e = e.cause)
    codes.push((e as { code?: unknown }).code);
  return codes;
}

it("reaches allowlisted private origins and refuses others", async () => {
  const server = await startMcpFixture();
  vi.stubEnv("NODE_ENV", "production");
  const transport = createExternalMcpTransport({ fetchImpl: fetch });
  const open = () =>
    transport.open({
      endpoint: server.url,
      token: async () => null,
      signal: AbortSignal.timeout(5000),
      timeoutMs: 5000,
    });
  try {
    vi.stubEnv("WEAVER_OUTBOUND_ALLOWED_ORIGINS", "");
    const error = await open().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(causeCodes(error)).toContain("OUTBOUND_NOT_ALLOWED");
    expect(server.requests).toHaveLength(0);
    vi.stubEnv("WEAVER_OUTBOUND_ALLOWED_ORIGINS", new URL(server.url).origin);
    const session = await open();
    expect((await session.discover()).tools.length).toBeGreaterThan(0);
    await session.close();
  } finally {
    vi.unstubAllEnvs();
    await server.close();
  }
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BearerVerification, BearerVerifiers } from "@weaver/auth";
import { DEFAULT_DIAGNOSTICS_SETTINGS } from "@weaver/core/diagnostics/settings";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import { CoreError } from "@weaver/core/errors";
import {
  invalidateDiagnosticsSettingsCache,
  primeDiagnosticsSettingsCache,
} from "@weaver/core/services/diagnosticsSettings";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { resolveApiKeySecurityContext, resolveMcpPrincipal } from "./bearer";

type DiagnosticRow = Prisma.DiagnosticEventCreateManyInput;
const MCP_URL = "http://localhost:3200/mcp";

function fixture(input: {
  scopes: string[];
  consent: { resources: string[]; scopes: string[] } | null;
}) {
  const rows: DiagnosticRow[] = [];
  const db = {
    verification: { findFirst: vi.fn(async () => null) },
    user: {
      findUnique: vi.fn(async () => ({
        id: "u1",
        role: "User",
        banned: false,
        name: "User",
        email: "user@example.test",
      })),
    },
    oauthConsent: {
      findFirst: vi.fn(async () =>
        input.consent ? { id: "consent-1", ...input.consent } : null,
      ),
    },
    diagnosticEvent: {
      createMany: vi.fn(async ({ data }: { data: DiagnosticRow[] }) => {
        rows.push(...data);
        return { count: data.length };
      }),
    },
  } as unknown as PrismaClient;
  const verifiers: BearerVerifiers = {
    verifyApiKey: vi.fn(),
    verifyAccessToken: vi.fn(),
    verifyResourceRequest: vi.fn(async (): Promise<BearerVerification> => ({
      ok: true,
      credential: {
        kind: "oauth",
        tokenId: "token-1",
        userId: "u1",
        clientId: "client-1",
        scopes: input.scopes,
        authorizationId: "authorization-1",
      },
    })),
  };
  return { db, rows, verifiers };
}

async function enableDiagnostics(db: PrismaClient) {
  primeDiagnosticsSettingsCache({
    ...DEFAULT_DIAGNOSTICS_SETTINGS,
    level: "standard",
  });
  startDiagnosticWriter({ db, runtime: "mcp", flushIntervalMs: 60_000 });
  await waitForDiagnosticWriterReady();
}

async function rejectionOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

afterEach(async () => {
  await stopDiagnosticWriter();
  invalidateDiagnosticsSettingsCache();
});

describe("MCP principal diagnostics", () => {
  it("logs revoked consent without changing the authorization error", async () => {
    const { db, rows, verifiers } = fixture({
      scopes: ["mcp:use", "content:read"],
      consent: null,
    });
    await enableDiagnostics(db);

    const error = await rejectionOf(() =>
      resolveMcpPrincipal(db, verifiers, {
        authorizationHeader: "Bearer private-token",
        dpopProofJwt: null,
        method: "POST",
        url: MCP_URL,
      }),
    );
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Consent for this client was revoked",
      details: { reason: "consent_revoked" },
    });

    await flushDiagnostics(true);
    expect(rows).toEqual([
      expect.objectContaining({
        event: "auth.bearer.rejected",
        severity: "warn",
        outcome: "denied",
        details: { reason: "consent_revoked", prefix: null },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("private-token");
  });

  it("logs a missing mcp:use scope without changing the forbidden error", async () => {
    const { db, rows, verifiers } = fixture({
      scopes: ["content:read"],
      consent: { resources: [MCP_URL], scopes: ["content:read"] },
    });
    await enableDiagnostics(db);

    const error = await rejectionOf(() =>
      resolveMcpPrincipal(db, verifiers, {
        authorizationHeader: "Bearer private-token",
        dpopProofJwt: null,
        method: "POST",
        url: MCP_URL,
      }),
    );
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      message: "The mcp:use scope is required",
      details: { reason: "insufficient_scope", scope: "mcp:use" },
    });

    await flushDiagnostics(true);
    expect(rows).toEqual([
      expect.objectContaining({
        event: "auth.bearer.rejected",
        severity: "warn",
        outcome: "denied",
        details: { reason: "insufficient_scope", prefix: null },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("private-token");
  });
});

describe("resolveApiKeySecurityContext (Phase 5 spec §8)", () => {
  function apiKeyFixture(input?: {
    user?: {
      id: string;
      role: "Admin" | "User";
      banned: boolean;
      banExpires: Date | null;
      name: string;
      email: string;
    } | null;
    policy?: {
      permissions: string | null;
      enabled: boolean | null;
      referenceId: string;
      projectIds: string[];
    } | null;
  }) {
    const db = {
      user: {
        findUnique: vi.fn(async () =>
          input?.user === undefined
            ? {
                id: "u1",
                role: "User" as const,
                banned: false,
                banExpires: null,
                name: "User",
                email: "user@example.test",
              }
            : input.user,
        ),
      },
      $queryRaw: vi.fn(async () =>
        input?.policy === null
          ? []
          : [
              input?.policy ?? {
                permissions: JSON.stringify({
                  mcp: ["use"],
                  content: ["read"],
                  ingest: ["external"],
                }),
                enabled: true,
                referenceId: "u1",
                projectIds: ["p1"],
              },
            ],
      ),
    } as unknown as PrismaClient;
    const verifyApiKey = vi.fn(async (): Promise<BearerVerification> => ({
      ok: true,
      credential: {
        kind: "apiKey",
        keyId: "k1",
        userId: "u1",
        permissions: {
          mcp: ["use"],
          content: ["read"],
          ingest: ["external"],
        },
      },
    }));
    const verifyAccessToken = vi.fn();
    const verifyResourceRequest = vi.fn();
    const verifiers: BearerVerifiers = {
      verifyApiKey,
      verifyAccessToken,
      verifyResourceRequest,
    };
    return {
      db,
      verifiers,
      verifyApiKey,
      verifyAccessToken,
      verifyResourceRequest,
    };
  }

  it("builds a restricted API-key context that carries ingest:external", async () => {
    const { db, verifiers, verifyApiKey } = apiKeyFixture();

    const security = await resolveApiKeySecurityContext(
      db,
      verifiers,
      "Bearer wvr_feedkey123",
    );

    expect(security.authenticationMethod).toBe("apiKey");
    expect(security.credentialId).toBe("k1");
    expect(security.capabilities.has("ingest:external")).toBe(true);
    expect(security.capabilities.has("content:write")).toBe(false);
    expect(security.allowedProjectIds).toEqual(new Set(["p1"]));
    expect(verifyApiKey).toHaveBeenCalledWith("wvr_feedkey123");
  });

  it.each([
    ["revoked after verification", null],
    [
      "disabled after verification",
      { permissions: "{}", enabled: false, referenceId: "u1", projectIds: [] },
    ],
    [
      "owned by someone else",
      { permissions: "{}", enabled: true, referenceId: "u2", projectIds: [] },
    ],
  ])(
    "rejects a key %s instead of treating it as unrestricted",
    async (_n, policy) => {
      const { db, verifiers } = apiKeyFixture({ policy });
      await expect(
        resolveApiKeySecurityContext(db, verifiers, "Bearer wvr_feedkey123"),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    },
  );

  it("takes permissions and restrictions from the same current key row", async () => {
    // The verifier saw write access; the key was edited to read-only on p2 since.
    const { db, verifiers } = apiKeyFixture({
      policy: {
        permissions: JSON.stringify({ mcp: ["use"], content: ["read"] }),
        enabled: true,
        referenceId: "u1",
        projectIds: ["p2"],
      },
    });
    const security = await resolveApiKeySecurityContext(
      db,
      verifiers,
      "Bearer wvr_feedkey123",
    );
    expect(security.capabilities.has("ingest:external")).toBe(false);
    expect(security.allowedProjectIds).toEqual(new Set(["p2"]));
  });

  it("rejects missing, malformed, and non-API-key bearer tokens before verifying", async () => {
    const {
      db,
      verifiers,
      verifyApiKey,
      verifyAccessToken,
      verifyResourceRequest,
    } = apiKeyFixture();

    for (const header of [
      null,
      "",
      "Basic d3ZyXzp4",
      "Bearer eyJhbGciOiJFZERTQSJ9.e30.c2ln",
    ]) {
      const error = await rejectionOf(() =>
        resolveApiKeySecurityContext(db, verifiers, header),
      );
      expect(error).toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(verifyResourceRequest).not.toHaveBeenCalled();
  });

  it("maps the key's rate limit to TOO_MANY_REQUESTS and rejections to UNAUTHORIZED", async () => {
    const { db, verifiers, verifyApiKey } = apiKeyFixture();
    verifyApiKey.mockResolvedValueOnce({
      ok: false,
      reason: "rate_limited",
    });
    await expect(
      resolveApiKeySecurityContext(db, verifiers, "Bearer wvr_feedkey123"),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    verifyApiKey.mockResolvedValueOnce({
      ok: false,
      reason: "revoked",
    });
    await expect(
      resolveApiKeySecurityContext(db, verifiers, "Bearer wvr_feedkey123"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it.each([
    ["banned", { banned: true, banExpires: null }],
    ["deleted", null],
  ])(
    "rejects a %s key owner through shared verification",
    async (_name, owner) => {
      const { db, verifiers } = apiKeyFixture({
        user:
          owner === null
            ? null
            : {
                id: "u1",
                role: "User",
                name: "User",
                email: "user@example.test",
                ...owner,
              },
      });

      await expect(
        resolveApiKeySecurityContext(db, verifiers, "Bearer wvr_feedkey123"),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    },
  );
});

it("rejects existing bearer credentials while the owner must change their password", async () => {
  const { db, verifiers } = fixture({
    scopes: ["mcp:use"],
    consent: { resources: [MCP_URL], scopes: ["mcp:use"] },
  });
  const user = await db.user.findUnique({ where: { id: "u1" } });
  vi.spyOn(db.user, "findUnique").mockResolvedValue({
    ...user!,
    mustChangePassword: true,
  });
  await expect(
    resolveMcpPrincipal(db, verifiers, {
      authorizationHeader: "Bearer token",
      dpopProofJwt: null,
      method: "POST",
      url: MCP_URL,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
it("distinguishes a missing resource grant from revoked consent", async () => {
  const { db, verifiers } = fixture({
    scopes: ["mcp:use"],
    consent: { resources: [], scopes: ["mcp:use"] },
  });
  await expect(
    resolveMcpPrincipal(db, verifiers, {
      authorizationHeader: "Bearer token",
      dpopProofJwt: null,
      method: "POST",
      url: MCP_URL,
    }),
  ).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    details: { reason: "resource_mismatch" },
  });
});

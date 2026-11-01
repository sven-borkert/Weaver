import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBearerVerifiers } from "@weaver/auth";
import { resolveMcpPrincipal } from "@weaver/core/security/bearer";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import {
  acquireOAuthCutoverBarrier,
  inspectOAuthCutoverState,
  type MigrationSqlClient,
} from "@weaver/db/oauth-cutover";
import {
  callerFor,
  callerWithSecurity,
  ensureOAuthResource,
  getPrisma,
  makeUser,
  resetDb,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  testAuth,
} from "./_harness";
import {
  authorizeUrl,
  pkce,
  redirectTargetOf,
  TEST_ORIGIN,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  insertOAuthClient,
  obtainAuthorizationCode,
  obtainAccessToken,
  sessionCookieFor,
  TEST_OAUTH_CLIENT_ID,
} from "./_oauth";

const legacyFamilyRepairMigrationPath = path.join(
  process.cwd(),
  "packages/db/prisma/migrations/20260906120000_oauth_legacy_family_fail_closed/migration.sql",
);
const oauthCutoverMigrationPath = path.join(
  process.cwd(),
  "packages/db/prisma/migrations/20260906130000_oauth_generation_cutover/migration.sql",
);

const verifiers = () =>
  createBearerVerifiers(testAuth(), {
    issuer: TEST_ISSUER,
    audience: TEST_MCP_RESOURCE,
  });

const request = (token: string) => ({
  authorizationHeader: `Bearer ${token}`,
  dpopProofJwt: null,
  method: "POST",
  url: TEST_MCP_RESOURCE,
});

describe("oauthConsent router (spec §26.2 item 14)", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
    await insertOAuthClient();
  });

  it("rejects JWTs when their refresh authorization is revoked", async () => {
    const user = await makeUser("User", "refresh-family-revoke");
    const tokens = await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read offline_access",
    );
    const response = await testAuth().handler(
      new Request(`${TEST_ISSUER}/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: TEST_OAUTH_CLIENT_ID,
          token: tokens.refresh_token!,
          token_type_hint: "refresh_token",
        }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(tokens.access_token),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "revoked" },
    });
  });

  it("honors RFC 7009 revocation of a JWT while preserving the consent", async () => {
    const user = await makeUser("User", "jwt-revoke");
    const tokens = await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read offline_access",
    );
    const response = await testAuth().handler(
      new Request(`${TEST_ISSUER}/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: TEST_OAUTH_CLIENT_ID,
          token: tokens.access_token,
          token_type_hint: "access_token",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await callerFor(user).oauthConsent.list()).toHaveLength(1);
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(tokens.access_token),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "revoked" },
    });
  });

  it.each(["token", "consent"])(
    "introspects a revoked %s as inactive",
    async (kind) => {
      const user = await makeUser("User", `introspect-${kind}`);
      const tokens = await obtainAccessToken(
        await sessionCookieFor(user.email),
        "mcp:use content:read",
      );
      const secret = "test-confidential-client-secret";
      await getPrisma().oauthClient.update({
        where: { clientId: TEST_OAUTH_CLIENT_ID },
        data: {
          tokenEndpointAuthMethod: "client_secret_post",
          clientSecret: createHash("sha256").update(secret).digest("base64url"),
        },
      });
      const post = (endpoint: string) =>
        testAuth().handler(
          new Request(`${TEST_ISSUER}/oauth2/${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: TEST_OAUTH_CLIENT_ID,
              client_secret: secret,
              token: tokens.access_token,
              token_type_hint: "access_token",
            }),
          }),
        );
      expect(await (await post("introspect")).json()).toMatchObject({
        active: true,
      });
      if (kind === "token") expect((await post("revoke")).status).toBe(200);
      else
        await getPrisma().oauthConsent.deleteMany({
          where: { userId: user.id },
        });
      expect(await (await post("introspect")).json()).toEqual({
        active: false,
      });
    },
  );

  it("does not create a consent after its captured session is revoked", async () => {
    const user = await makeUser("User", "consent-race");
    const cookie = await sessionCookieFor(user.email);
    const { challenge } = pkce();
    const target = await redirectTargetOf(
      await testAuth().handler(
        new Request(authorizeUrl(challenge, "mcp:use content:read"), {
          headers: { cookie },
        }),
      ),
    );
    const context = await testAuth().$context;
    const original = context.adapter.findOne.bind(context.adapter);
    let reached!: () => void;
    let resume!: () => void;
    const captured = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = vi
      .spyOn(context.adapter, "findOne")
      .mockImplementation(async (input) => {
        if (input.model === "oauthConsent") {
          reached();
          await gate;
        }
        return original(input);
      });
    const response = testAuth().handler(
      new Request(`${TEST_ISSUER}/oauth2/consent`, {
        method: "POST",
        headers: {
          cookie,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(target, TEST_ORIGIN).search.slice(1),
        }),
      }),
    );
    await captured;
    await getPrisma().session.deleteMany({ where: { userId: user.id } });
    resume();
    try {
      expect((await response).status).toBe(403);
      expect(
        await getPrisma().oauthConsent.count({ where: { userId: user.id } }),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects both JWT generations after refresh-token reuse detection", async () => {
    const user = await makeUser("User", "jwt-refresh-reuse");
    const tokens = await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read offline_access",
    );
    const rotated = await exchangeRefreshToken(tokens.refresh_token!);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string };
    await expect(
      resolveMcpPrincipal(getPrisma(), verifiers(), request(next.access_token)),
    ).resolves.toBeDefined();
    await getPrisma().oauthRefreshToken.updateMany({
      where: { userId: user.id, rotatedAt: { not: null } },
      data: { rotationReplayExpiresAt: new Date(0) },
    });
    expect((await exchangeRefreshToken(tokens.refresh_token!)).status).toBe(
      400,
    );
    await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read offline_access",
      true,
    );
    for (const accessToken of [tokens.access_token, next.access_token]) {
      await expect(
        resolveMcpPrincipal(getPrisma(), verifiers(), request(accessToken)),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        details: { reason: "consent_revoked" },
      });
    }
  });

  it("does not let another registered client revoke a JWT", async () => {
    const user = await makeUser("User", "jwt-wrong-client");
    const tokens = await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read",
    );
    const client = await getPrisma().oauthClient.findUniqueOrThrow({
      where: { clientId: TEST_OAUTH_CLIENT_ID },
    });
    await getPrisma().oauthClient.create({
      data: {
        ...client,
        metadata: client.metadata ?? undefined,
        id: randomUUID(),
        clientId: "other-revoke-client",
      },
    });
    await testAuth().handler(
      new Request(`${TEST_ISSUER}/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "other-revoke-client",
          token: tokens.access_token,
          token_type_hint: "access_token",
        }),
      }),
    );
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(tokens.access_token),
      ),
    ).resolves.toBeDefined();
  });

  it("lists the consent a flow created and revokes it, ending live tokens", async () => {
    const user = await makeUser("User", "consent-1");
    const cookie = await sessionCookieFor(user.email);
    const tokens = await obtainAccessToken(
      cookie,
      "mcp:use content:read offline_access",
    );

    const listed = await callerFor(user).oauthConsent.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      clientId: TEST_OAUTH_CLIENT_ID,
      clientName: "Test MCP client",
    });
    expect(listed[0]!.scopes).toEqual(
      expect.arrayContaining(["mcp:use", "content:read"]),
    );
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(tokens.access_token),
      ),
    ).resolves.toMatchObject({ clientId: TEST_OAUTH_CLIENT_ID });

    await callerFor(user).oauthConsent.revoke({ consentId: listed[0]!.id });
    expect(await callerFor(user).oauthConsent.list()).toEqual([]);
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(tokens.access_token),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "consent_revoked" },
    });
    const refresh = await getPrisma().oauthRefreshToken.findMany({
      where: { userId: user.id, clientId: TEST_OAUTH_CLIENT_ID },
    });
    expect(refresh.length).toBeGreaterThan(0);
    expect(refresh.every((row) => row.revoked !== null)).toBe(true);
  });

  it("neither reveals nor revokes another user's consent", async () => {
    const alice = await makeUser("User", "consent-a");
    const bob = await makeUser("User", "consent-b");
    await obtainAccessToken(
      await sessionCookieFor(alice.email),
      "mcp:use content:read",
    );
    const [consent] = await callerFor(alice).oauthConsent.list();
    expect(await callerFor(bob).oauthConsent.list()).toEqual([]);
    await expect(
      callerFor(bob).oauthConsent.revoke({ consentId: consent!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await callerFor(alice).oauthConsent.list()).toHaveLength(1);
  });

  it("does not revive an old broader token after narrower re-consent", async () => {
    const user = await makeUser("User", "consent-generation");
    const cookie = await sessionCookieFor(user.email);
    const oldTokens = await obtainAccessToken(
      cookie,
      "mcp:use content:read content:write",
    );
    const [oldConsent] = await callerFor(user).oauthConsent.list();

    await callerFor(user).oauthConsent.revoke({
      consentId: oldConsent!.id,
    });
    const newTokens = await obtainAccessToken(cookie, "mcp:use content:read");

    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(newTokens.access_token),
      ),
    ).resolves.toMatchObject({ clientId: TEST_OAUTH_CLIENT_ID });
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(oldTokens.access_token),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "consent_revoked" },
    });
  });

  it("rejects a stale broad authorization code persisted after narrower re-consent", async () => {
    const user = await makeUser("User", "consent-code-race");
    const cookie = await sessionCookieFor(user.email);
    const broadScope = "mcp:use content:read content:write";
    const staleCode = await obtainAuthorizationCode(cookie, broadScope);
    const verificationRows = await getPrisma().verification.findMany();
    const staleVerification = verificationRows.find((row) => {
      const value = JSON.parse(row.value) as {
        type?: string;
        userId?: string;
        query?: { scope?: string };
      };
      return (
        value.type === "authorization_code" &&
        value.userId === user.id &&
        value.query?.scope === broadScope
      );
    });
    expect(staleVerification).toBeDefined();
    const stalePayload = JSON.parse(staleVerification!.value) as Record<
      string,
      unknown
    >;
    delete stalePayload.referenceId;
    await getPrisma().verification.delete({
      where: { id: staleVerification!.id },
    });

    const [broadConsent] = await callerFor(user).oauthConsent.list();
    await callerFor(user).oauthConsent.revoke({
      consentId: broadConsent!.id,
    });
    await obtainAccessToken(cookie, "mcp:use content:read");

    const recreated = await getPrisma().verification.create({
      data: {
        id: staleVerification!.id,
        identifier: staleVerification!.identifier,
        value: JSON.stringify(stalePayload),
        expiresAt: staleVerification!.expiresAt,
        createdAt: staleVerification!.createdAt,
        updatedAt: staleVerification!.updatedAt,
      },
    });
    expect(JSON.parse(recreated.value)).not.toHaveProperty("referenceId");
    const exchange = await exchangeAuthorizationCode(
      staleCode.code,
      staleCode.verifier,
    );
    expect(exchange.status).toBe(200);
    const tokens = (await exchange.json()) as { access_token: string };
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(tokens.access_token),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "consent_revoked" },
    });
  });

  it("allows only one live consent for a user and client", async () => {
    const user = await makeUser("User", "consent-unique");
    const now = new Date();
    const attempts = await Promise.allSettled([
      getPrisma().oauthConsent.create({
        data: {
          clientId: TEST_OAUTH_CLIENT_ID,
          userId: user.id,
          resources: [TEST_MCP_RESOURCE],
          requestedUserInfoClaims: [],
          scopes: ["mcp:use", "content:read"],
          createdAt: now,
          updatedAt: now,
        },
      }),
      getPrisma().oauthConsent.create({
        data: {
          clientId: TEST_OAUTH_CLIENT_ID,
          userId: user.id,
          resources: [TEST_MCP_RESOURCE],
          requestedUserInfoClaims: [],
          scopes: ["mcp:use"],
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await getPrisma().oauthConsent.count({
        where: { userId: user.id, clientId: TEST_OAUTH_CLIENT_ID },
      }),
    ).toBe(1);
  });

  it("repairs ambiguously bound legacy families without revoking current single-consent families", async () => {
    const legacyUser = await makeUser("User", "consent-legacy-repair");
    const currentUser = await makeUser("User", "consent-current-family");
    const migrationSql = await readFile(
      legacyFamilyRepairMigrationPath,
      "utf8",
    );
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("BEGIN");
    try {
      const cutoffResult = await client.query<{ finished_at: Date }>(
        `SELECT finished_at
         FROM "_prisma_migrations"
         WHERE migration_name = '20260906110000_oauth_consent_generation_safety'
           AND rolled_back_at IS NULL
           AND finished_at IS NOT NULL
         ORDER BY finished_at DESC
         LIMIT 1`,
      );
      const cutoff = cutoffResult.rows[0]?.finished_at;
      expect(cutoff).toBeInstanceOf(Date);
      const legacyTime = new Date(cutoff!.getTime() - 1_000);
      const currentTime = new Date(cutoff!.getTime() + 1_000);
      const legacySurvivorId = randomUUID();
      const legacyLoserId = randomUUID();
      const legacySurvivorGeneration = randomUUID();
      const legacyLoserGeneration = randomUUID();
      const legacyBoundRefreshId = randomUUID();
      const legacyUnboundRefreshId = randomUUID();
      const legacyAccessId = randomUUID();
      const currentConsentId = randomUUID();
      const currentGeneration = randomUUID();
      const currentRefreshId = randomUUID();
      const currentAccessId = randomUUID();

      await client.query('DROP INDEX "OauthConsent_userId_clientId_key"');
      await client.query(
        `INSERT INTO "OauthConsent" (
          "id", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "scopes", "createdAt", "updatedAt"
        ) VALUES
          ($1::uuid, $2, $3::uuid, $4, ARRAY[$5], ARRAY[]::text[], ARRAY['mcp:use'], $6, $6),
          ($7::uuid, $2, $3::uuid, $8, ARRAY[$5], ARRAY[]::text[], ARRAY['mcp:use'], $6, $6)`,
        [
          legacySurvivorId,
          TEST_OAUTH_CLIENT_ID,
          legacyUser.id,
          legacySurvivorGeneration,
          TEST_MCP_RESOURCE,
          legacyTime,
          legacyLoserId,
          legacyLoserGeneration,
        ],
      );
      await client.query(
        'ALTER TABLE "OauthRefreshToken" DISABLE TRIGGER "OauthRefreshToken_validate_generation"',
      );
      await client.query(
        `INSERT INTO "OauthRefreshToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES
          ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $8, ARRAY['mcp:use']),
          ($9::uuid, $10, $3, $4::uuid, NULL, ARRAY[$6], ARRAY[]::text[], $7, $8, ARRAY['mcp:use'])`,
        [
          legacyBoundRefreshId,
          `legacy-bound-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          legacyUser.id,
          legacySurvivorGeneration,
          TEST_MCP_RESOURCE,
          new Date(Date.now() + 60_000),
          legacyTime,
          legacyUnboundRefreshId,
          `legacy-unbound-${randomUUID()}`,
        ],
      );
      await client.query(
        'ALTER TABLE "OauthRefreshToken" ENABLE TRIGGER "OauthRefreshToken_validate_generation"',
      );
      await client.query(
        `INSERT INTO "OauthAccessToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $8, ARRAY['mcp:use'])`,
        [
          legacyAccessId,
          `legacy-access-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          legacyUser.id,
          legacySurvivorGeneration,
          TEST_MCP_RESOURCE,
          new Date(Date.now() + 60_000),
          legacyTime,
        ],
      );

      // Model the ambiguous row binding to the generation deduplication retained.
      await client.query('DELETE FROM "OauthConsent" WHERE "id" = $1::uuid', [
        legacyLoserId,
      ]);
      await client.query(
        'CREATE UNIQUE INDEX "OauthConsent_userId_clientId_key" ON "OauthConsent"("userId", "clientId")',
      );

      await client.query(
        `INSERT INTO "OauthConsent" (
          "id", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "scopes", "createdAt", "updatedAt"
        ) VALUES ($1::uuid, $2, $3::uuid, $4, ARRAY[$5], ARRAY[]::text[], ARRAY['mcp:use'], $6, $6)`,
        [
          currentConsentId,
          TEST_OAUTH_CLIENT_ID,
          currentUser.id,
          currentGeneration,
          TEST_MCP_RESOURCE,
          currentTime,
        ],
      );
      await client.query(
        `INSERT INTO "OauthRefreshToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $8, ARRAY['mcp:use'])`,
        [
          currentRefreshId,
          `current-refresh-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          currentUser.id,
          currentGeneration,
          TEST_MCP_RESOURCE,
          new Date(Date.now() + 60_000),
          currentTime,
        ],
      );
      await client.query(
        `INSERT INTO "OauthAccessToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $8, ARRAY['mcp:use'])`,
        [
          currentAccessId,
          `current-access-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          currentUser.id,
          currentGeneration,
          TEST_MCP_RESOURCE,
          new Date(Date.now() + 60_000),
          currentTime,
        ],
      );

      const unsafeLegacyState = await client.query<{
        referenceId: string | null;
        revoked: Date | null;
      }>(
        `SELECT "referenceId", "revoked"
         FROM "OauthRefreshToken"
         WHERE "id" = ANY($1::uuid[])
         ORDER BY "id"`,
        [[legacyBoundRefreshId, legacyUnboundRefreshId]],
      );
      expect(unsafeLegacyState.rows).toHaveLength(2);
      expect(unsafeLegacyState.rows.every((row) => row.revoked === null)).toBe(
        true,
      );
      expect(
        unsafeLegacyState.rows.map((row) => row.referenceId).sort(),
      ).toEqual([legacySurvivorGeneration, null].sort());

      const migrationBody = migrationSql
        .replace(/^BEGIN;\s*/u, "")
        .replace(/\s*COMMIT;\s*$/u, "");
      expect(migrationBody).not.toBe(migrationSql);
      await client.query(migrationBody);
      const repaired = await client.query<{
        id: string;
        revoked: Date | null;
      }>(
        `SELECT "id"::text, "revoked"
         FROM "OauthRefreshToken"
         WHERE "id" = ANY($1::uuid[])
         UNION ALL
         SELECT "id"::text, "revoked"
         FROM "OauthAccessToken"
         WHERE "id" = ANY($1::uuid[])`,
        [
          [
            legacyBoundRefreshId,
            legacyUnboundRefreshId,
            legacyAccessId,
            currentRefreshId,
            currentAccessId,
          ],
        ],
      );
      const revokedById = new Map(
        repaired.rows.map((row) => [row.id, row.revoked]),
      );
      expect(revokedById.get(legacyBoundRefreshId)).toBeInstanceOf(Date);
      expect(revokedById.get(legacyUnboundRefreshId)).toBeInstanceOf(Date);
      expect(revokedById.get(legacyAccessId)).toBeInstanceOf(Date);
      expect(revokedById.get(currentRefreshId)).toBeNull();
      expect(revokedById.get(currentAccessId)).toBeNull();
      const generations = await client.query<{
        userId: string;
        referenceId: string;
      }>(
        `SELECT "userId"::text AS "userId", "referenceId"
         FROM "OauthConsent"
         WHERE "userId" = ANY($1::uuid[])`,
        [[legacyUser.id, currentUser.id]],
      );
      const generationByUser = new Map(
        generations.rows.map((row) => [row.userId, row.referenceId]),
      );
      expect(generationByUser.get(legacyUser.id)).not.toBe(
        legacySurvivorGeneration,
      );
      expect(generationByUser.get(currentUser.id)).toBe(currentGeneration);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("rotates every cutover generation regardless of timestamp and restores validation triggers", async () => {
    const sameSecondUser = await makeUser("User", "consent-cutover-same");
    const skewedUser = await makeUser("User", "consent-cutover-skewed");
    const newUser = await makeUser("User", "consent-cutover-new");
    const migrationSql = await readFile(oauthCutoverMigrationPath, "utf8");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("BEGIN");
    try {
      const safety = await client.query<{ finished_at: Date }>(
        `SELECT finished_at
         FROM "_prisma_migrations"
         WHERE migration_name = '20260906110000_oauth_consent_generation_safety'
           AND rolled_back_at IS NULL
           AND finished_at IS NOT NULL
         ORDER BY finished_at DESC
         LIMIT 1`,
      );
      const sameSecond = safety.rows[0]!.finished_at;
      const skewedFuture = new Date("2099-01-01T00:00:00.000Z");
      const sameGeneration = randomUUID();
      const skewedGeneration = randomUUID();
      const sameConsentId = randomUUID();
      const skewedConsentId = randomUUID();
      const sameRefreshId = randomUUID();
      const skewedAccessId = randomUUID();
      await client.query(
        `INSERT INTO "OauthConsent" (
          "id", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "scopes", "createdAt", "updatedAt"
        ) VALUES
          ($1::uuid, $2, $3::uuid, $4, ARRAY[$5], ARRAY[]::text[], ARRAY['mcp:use'], $6, $6),
          ($7::uuid, $2, $8::uuid, $9, ARRAY[$5], ARRAY[]::text[], ARRAY['mcp:use'], $10, $10)`,
        [
          sameConsentId,
          TEST_OAUTH_CLIENT_ID,
          sameSecondUser.id,
          sameGeneration,
          TEST_MCP_RESOURCE,
          sameSecond,
          skewedConsentId,
          skewedUser.id,
          skewedGeneration,
          skewedFuture,
        ],
      );
      await client.query(
        `INSERT INTO "OauthRefreshToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $8, ARRAY['mcp:use'])`,
        [
          sameRefreshId,
          `same-second-refresh-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          sameSecondUser.id,
          sameGeneration,
          TEST_MCP_RESOURCE,
          skewedFuture,
          sameSecond,
        ],
      );
      await client.query(
        `INSERT INTO "OauthAccessToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $8, ARRAY['mcp:use'])`,
        [
          skewedAccessId,
          `skewed-access-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          skewedUser.id,
          skewedGeneration,
          TEST_MCP_RESOURCE,
          skewedFuture,
          skewedFuture,
        ],
      );

      const migrationBody = migrationSql
        .replace(/^BEGIN;\s*/u, "")
        .replace(/\s*COMMIT;\s*$/u, "");
      expect(migrationBody).not.toBe(migrationSql);
      await client.query(migrationBody);

      const cutoverConsents = await client.query<{
        id: string;
        referenceId: string;
      }>(
        `SELECT "id"::text, "referenceId"
         FROM "OauthConsent"
         WHERE "id" = ANY($1::uuid[])`,
        [[sameConsentId, skewedConsentId]],
      );
      const cutoverGenerationById = new Map(
        cutoverConsents.rows.map((row) => [row.id, row.referenceId]),
      );
      expect(cutoverGenerationById.get(sameConsentId)).not.toBe(sameGeneration);
      expect(cutoverGenerationById.get(skewedConsentId)).not.toBe(
        skewedGeneration,
      );
      const cutoverTokens = await client.query<{
        id: string;
        revoked: Date | null;
      }>(
        `SELECT "id"::text, "revoked" FROM "OauthRefreshToken"
         WHERE "id" = $1::uuid
         UNION ALL
         SELECT "id"::text, "revoked" FROM "OauthAccessToken"
         WHERE "id" = $2::uuid`,
        [sameRefreshId, skewedAccessId],
      );
      expect(
        cutoverTokens.rows.every((row) => row.revoked instanceof Date),
      ).toBe(true);

      const assigned = await client.query<{ referenceId: string }>(
        `INSERT INTO "OauthConsent" (
          "id", "clientId", "userId", "resources",
          "requestedUserInfoClaims", "scopes", "createdAt", "updatedAt"
        ) VALUES ($1::uuid, $2, $3::uuid, ARRAY[$4], ARRAY[]::text[], ARRAY['mcp:use'], now(), now())
        RETURNING "referenceId"`,
        [randomUUID(), TEST_OAUTH_CLIENT_ID, newUser.id, TEST_MCP_RESOURCE],
      );
      expect(assigned.rows[0]?.referenceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      const attemptedGeneration = randomUUID();
      const immutable = await client.query<{ referenceId: string }>(
        `UPDATE "OauthConsent"
         SET "referenceId" = $1
         WHERE "id" = $2::uuid
         RETURNING "referenceId"`,
        [attemptedGeneration, sameConsentId],
      );
      expect(immutable.rows[0]?.referenceId).toBe(
        cutoverGenerationById.get(sameConsentId),
      );

      const lateRefreshId = randomUUID();
      const lateAccessId = randomUUID();
      await client.query(
        `INSERT INTO "OauthRefreshToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $7, ARRAY['mcp:use'])`,
        [
          lateRefreshId,
          `late-refresh-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          sameSecondUser.id,
          sameGeneration,
          TEST_MCP_RESOURCE,
          skewedFuture,
        ],
      );
      await client.query(
        `INSERT INTO "OauthAccessToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $7, ARRAY['mcp:use'])`,
        [
          lateAccessId,
          `late-access-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          sameSecondUser.id,
          sameGeneration,
          TEST_MCP_RESOURCE,
          skewedFuture,
        ],
      );
      const lateRows = await client.query<{ revoked: Date | null }>(
        `SELECT "revoked" FROM "OauthRefreshToken" WHERE "id" = $1::uuid
         UNION ALL
         SELECT "revoked" FROM "OauthAccessToken" WHERE "id" = $2::uuid`,
        [lateRefreshId, lateAccessId],
      );
      expect(lateRows.rows.every((row) => row.revoked instanceof Date)).toBe(
        true,
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("blocks concurrent OAuth writes at cutover and rejects their old generation", async () => {
    const user = await makeUser("User", "consent-cutover-lock");
    await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read",
    );
    const consent = await getPrisma().oauthConsent.findFirstOrThrow({
      where: { userId: user.id, clientId: TEST_OAUTH_CLIENT_ID },
      select: { id: true, referenceId: true },
    });
    const oldGeneration = consent.referenceId!;
    const migrationSql = await readFile(oauthCutoverMigrationPath, "utf8");
    const pauseKey = 1_306_004;
    const lockStatement = `LOCK TABLE
  "OauthConsent",
  "OauthRefreshToken",
  "OauthAccessToken"
IN SHARE MODE;`;
    const pausedMigrationSql = migrationSql.replace(
      lockStatement,
      `${lockStatement}\nSELECT pg_advisory_xact_lock(${pauseKey});`,
    );
    expect(pausedMigrationSql).not.toBe(migrationSql);

    const makeClient = (applicationName: string) =>
      new Client({
        connectionString: process.env.DATABASE_URL,
        application_name: applicationName,
      });
    const blocker = makeClient("oauth-cutover-blocker");
    const migrator = makeClient("oauth-cutover-migrator");
    const refreshWriter = makeClient("oauth-cutover-refresh-writer");
    const accessWriter = makeClient("oauth-cutover-access-writer");
    const consentWriter = makeClient("oauth-cutover-consent-writer");
    const clients = [
      blocker,
      migrator,
      refreshWriter,
      accessWriter,
      consentWriter,
    ];
    await Promise.all(clients.map((client) => client.connect()));
    let migration: Promise<unknown> | undefined;
    let refreshWrite: Promise<unknown> | undefined;
    let accessWrite: Promise<unknown> | undefined;
    let consentWrite: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1)", [pauseKey]);
      migration = migrator.query(pausedMigrationSql);

      const waitForApplications = async (names: string[]) => {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const waiting = await getPrisma().$queryRaw<
            Array<{ applicationName: string }>
          >`SELECT DISTINCT activity.application_name AS "applicationName"
            FROM pg_locks AS lock
            JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
            WHERE lock.granted = false
              AND activity.application_name = ANY(${names}::text[])`;
          if (waiting.length === names.length) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(
          `Expected blocked database clients: ${names.join(", ")}`,
        );
      };
      await waitForApplications(["oauth-cutover-migrator"]);

      const future = new Date("2099-01-01T00:00:00.000Z");
      const refreshId = randomUUID();
      const accessId = randomUUID();
      refreshWrite = refreshWriter.query(
        `INSERT INTO "OauthRefreshToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $7, ARRAY['mcp:use'])`,
        [
          refreshId,
          `blocked-refresh-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          user.id,
          oldGeneration,
          TEST_MCP_RESOURCE,
          future,
        ],
      );
      accessWrite = accessWriter.query(
        `INSERT INTO "OauthAccessToken" (
          "id", "token", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "expiresAt", "createdAt", "scopes"
        ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, ARRAY[$6], ARRAY[]::text[], $7, $7, ARRAY['mcp:use'])`,
        [
          accessId,
          `blocked-access-${randomUUID()}`,
          TEST_OAUTH_CLIENT_ID,
          user.id,
          oldGeneration,
          TEST_MCP_RESOURCE,
          future,
        ],
      );
      consentWrite = consentWriter.query(
        `UPDATE "OauthConsent"
         SET "scopes" = ARRAY['mcp:use']
         WHERE "id" = $1::uuid`,
        [consent.id],
      );
      await waitForApplications([
        "oauth-cutover-refresh-writer",
        "oauth-cutover-access-writer",
        "oauth-cutover-consent-writer",
      ]);

      await blocker.query("COMMIT");
      await migration;
      await Promise.all([refreshWrite, accessWrite, consentWrite]);

      const result = await getPrisma().oauthConsent.findUniqueOrThrow({
        where: { id: consent.id },
        select: { referenceId: true, scopes: true },
      });
      expect(result.referenceId).not.toBe(oldGeneration);
      expect(result.scopes).toEqual(["mcp:use"]);
      const escaped = await getPrisma().$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM (
          SELECT "id" FROM "OauthRefreshToken"
          WHERE "referenceId" = ${oldGeneration} AND "revoked" IS NULL
          UNION ALL
          SELECT "id" FROM "OauthAccessToken"
          WHERE "referenceId" = ${oldGeneration} AND "revoked" IS NULL
        ) AS live_old_generation
      `;
      expect(escaped[0]?.count ?? 0n).toBe(0n);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled(
        [migration, refreshWrite, accessWrite, consentWrite].filter(
          (operation): operation is Promise<unknown> => operation !== undefined,
        ),
      );
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it("lets a row-first revocation settle before handing the cutover barrier to migration", async () => {
    const user = await makeUser("User", "consent-cutover-row-first");
    await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read offline_access",
    );
    const consent = await getPrisma().oauthConsent.findFirstOrThrow({
      where: { userId: user.id, clientId: TEST_OAUTH_CLIENT_ID },
      select: { id: true },
    });
    const migrationSql = await readFile(oauthCutoverMigrationPath, "utf8");
    const makeClient = (applicationName: string) =>
      new Client({
        connectionString: process.env.DATABASE_URL,
        application_name: applicationName,
        statement_timeout: 5_000,
      });
    const revoker = makeClient("oauth-row-first-revoker");
    const barrier = makeClient("oauth-row-first-barrier");
    const migrator = makeClient("oauth-row-first-migrator");
    await Promise.all([
      revoker.connect(),
      barrier.connect(),
      migrator.connect(),
    ]);
    const waitUntilBlocked = async (applicationName: string) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const result = await getPrisma().$queryRaw<Array<{ waiting: bigint }>>`
            SELECT count(*)::bigint AS waiting
            FROM pg_locks AS lock
            JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
            WHERE lock.granted = false
              AND activity.application_name = ${applicationName}
          `;
        if ((result[0]?.waiting ?? 0n) > 0n) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Expected ${applicationName} to wait for a lock`);
    };
    let barrierOpen = false;
    let migration: Promise<unknown> | undefined;
    try {
      const state = await inspectOAuthCutoverState(
        barrier as unknown as MigrationSqlClient,
      );
      expect(state.consentRelationOid).not.toBeNull();
      await revoker.query("BEGIN");
      await revoker.query(
        `SELECT "id" FROM "OauthConsent" WHERE "id" = $1::uuid FOR UPDATE`,
        [consent.id],
      );

      const barrierAcquired = acquireOAuthCutoverBarrier(
        barrier as unknown as MigrationSqlClient,
        state.consentRelationOid!,
        { enforceQuiescence: false },
      ).then(() => {
        barrierOpen = true;
      });
      await waitUntilBlocked("oauth-row-first-barrier");

      const revocation = (async () => {
        await revoker.query(
          `UPDATE "OauthRefreshToken"
             SET "revoked" = clock_timestamp()
             WHERE "userId" = $1::uuid AND "clientId" = $2`,
          [user.id, TEST_OAUTH_CLIENT_ID],
        );
        await revoker.query(
          `UPDATE "OauthAccessToken"
             SET "revoked" = clock_timestamp()
             WHERE "userId" = $1::uuid AND "clientId" = $2`,
          [user.id, TEST_OAUTH_CLIENT_ID],
        );
        await revoker.query(
          `DELETE FROM "OauthConsent" WHERE "id" = $1::uuid`,
          [consent.id],
        );
        await revoker.query("COMMIT");
      })();
      const firstResults = await Promise.allSettled([
        revocation,
        barrierAcquired,
      ]);
      expect(firstResults.every(({ status }) => status === "fulfilled")).toBe(
        true,
      );

      migration = migrator.query(migrationSql);
      await waitUntilBlocked("oauth-row-first-migrator");
      await barrier.query("COMMIT");
      barrierOpen = false;
      await expect(migration).resolves.toBeDefined();
    } finally {
      await revoker.query("ROLLBACK").catch(() => undefined);
      if (barrierOpen) {
        await barrier.query("ROLLBACK").catch(() => undefined);
      }
      await migration?.catch(() => undefined);
      await Promise.all([revoker.end(), barrier.end(), migrator.end()]);
    }
  }, 15_000);

  it("keeps an escaped old refresh family revoked after re-consent", async () => {
    const user = await makeUser("User", "consent-refresh-race");
    const cookie = await sessionCookieFor(user.email);
    const oldTokens = await obtainAccessToken(
      cookie,
      "mcp:use content:read content:write offline_access",
    );
    const oldRefresh = await getPrisma().oauthRefreshToken.findFirstOrThrow({
      where: { userId: user.id, clientId: TEST_OAUTH_CLIENT_ID },
      select: { id: true, referenceId: true },
    });
    const [oldConsent] = await callerFor(user).oauthConsent.list();

    await callerFor(user).oauthConsent.revoke({
      consentId: oldConsent!.id,
    });
    await obtainAccessToken(cookie, "mcp:use content:read");

    // Model the race loser: a pre-revoke family row committed after updateMany.
    await getPrisma().oauthRefreshToken.update({
      where: { id: oldRefresh.id },
      data: { revoked: null },
    });
    const refreshResponse = await exchangeRefreshToken(
      oldTokens.refresh_token!,
    );
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as {
      access_token: string;
    };
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(refreshed.access_token),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "consent_revoked" },
    });
    expect(oldRefresh.referenceId).not.toBeNull();
    const oldFamily = await getPrisma().oauthRefreshToken.findMany({
      where: { referenceId: oldRefresh.referenceId },
      select: { revoked: true },
    });
    expect(oldFamily.length).toBeGreaterThan(1);
    expect(oldFamily.every((row) => row.revoked !== null)).toBe(true);
  });

  it("serializes a concurrent refresh insert before revocation", async () => {
    const user = await makeUser("User", "consent-refresh-lock");
    const cookie = await sessionCookieFor(user.email);
    await obtainAccessToken(cookie, "mcp:use content:read");
    const [listed] = await callerFor(user).oauthConsent.list();
    const consent = await getPrisma().oauthConsent.findUniqueOrThrow({
      where: { id: listed!.id },
      select: { referenceId: true },
    });
    expect(consent.referenceId).not.toBeNull();

    let releaseInsert!: () => void;
    const holdInsert = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let markInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      markInserted = resolve;
    });
    const refreshId = randomUUID();
    const insert = getPrisma().$transaction(async (tx) => {
      await tx.oauthRefreshToken.create({
        data: {
          id: refreshId,
          token: `refresh-race-${randomUUID()}`,
          clientId: TEST_OAUTH_CLIENT_ID,
          userId: user.id,
          referenceId: consent.referenceId,
          resources: [TEST_MCP_RESOURCE],
          requestedUserInfoClaims: [],
          scopes: ["mcp:use", "content:read"],
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      markInserted();
      await holdInsert;
    });
    await inserted;
    const revoke = callerFor(user).oauthConsent.revoke({
      consentId: listed!.id,
    });

    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const [locks] = await getPrisma().$queryRaw<
          Array<{ waiting: bigint }>
        >`SELECT count(*)::bigint AS waiting
          FROM pg_locks
          WHERE granted = false`;
        if ((locks?.waiting ?? 0n) > 0n) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const [locks] = await getPrisma().$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*)::bigint AS waiting
        FROM pg_locks
        WHERE granted = false
      `;
      expect(locks?.waiting ?? 0n).toBeGreaterThan(0n);
    } finally {
      releaseInsert();
    }
    await Promise.all([insert, revoke]);

    const racedRefresh = await getPrisma().oauthRefreshToken.findUniqueOrThrow({
      where: { id: refreshId },
      select: { revoked: true },
    });
    expect(racedRefresh.revoked).not.toBeNull();
  });

  it("uses one row-lock order for a concurrent consent update and revoke", async () => {
    const user = await makeUser("User", "consent-update-lock");
    await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read",
    );
    const [listed] = await callerFor(user).oauthConsent.list();
    const consent = await getPrisma().oauthConsent.findUniqueOrThrow({
      where: { id: listed!.id },
      select: { referenceId: true },
    });
    expect(consent.referenceId).not.toBeNull();

    let releaseAdvisory!: () => void;
    const holdAdvisory = new Promise<void>((resolve) => {
      releaseAdvisory = resolve;
    });
    let markAdvisoryHeld!: () => void;
    const advisoryHeld = new Promise<void>((resolve) => {
      markAdvisoryHeld = resolve;
    });
    const advisory = getPrisma().$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'weaver:oauth-authorization:' || ${consent.referenceId},
            0
          )
        )::text
      `;
      markAdvisoryHeld();
      await holdAdvisory;
    });
    await advisoryHeld;

    let allowUpdate!: () => void;
    const updateAllowed = new Promise<void>((resolve) => {
      allowUpdate = resolve;
    });
    let markRowHeld!: () => void;
    const rowHeld = new Promise<void>((resolve) => {
      markRowHeld = resolve;
    });
    let updaterSettled = false;
    const updater = getPrisma()
      .$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id"::text
          FROM "OauthConsent"
          WHERE "id" = ${listed!.id}::uuid
          FOR UPDATE
        `;
        markRowHeld();
        await updateAllowed;
        await tx.oauthConsent.update({
          where: { id: listed!.id },
          data: { scopes: ["mcp:use", "content:read"] },
        });
      })
      .finally(() => {
        updaterSettled = true;
      });
    await rowHeld;
    const revoke = callerFor(user).oauthConsent.revoke({
      consentId: listed!.id,
    });

    try {
      const waitForBlockedLock = async (minimum: bigint) => {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const [locks] = await getPrisma().$queryRaw<
            Array<{ waiting: bigint }>
          >`SELECT count(*)::bigint AS waiting
            FROM pg_locks
            WHERE granted = false`;
          if ((locks?.waiting ?? 0n) >= minimum) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Expected ${minimum} blocked database lock(s)`);
      };
      await waitForBlockedLock(1n);
      allowUpdate();

      const deadline = Date.now() + 2_000;
      while (!updaterSettled && Date.now() < deadline) {
        const [locks] = await getPrisma().$queryRaw<
          Array<{ waiting: bigint }>
        >`SELECT count(*)::bigint AS waiting
          FROM pg_locks
          WHERE locktype = 'advisory' AND granted = false`;
        if ((locks?.waiting ?? 0n) >= 2n) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      allowUpdate();
      releaseAdvisory();
    }

    const results = await Promise.allSettled([updater, revoke, advisory]);
    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    expect(
      await getPrisma().oauthConsent.findUnique({
        where: { id: listed!.id },
      }),
    ).toBeNull();
  });

  it("refuses key and token actors", async () => {
    const user = await makeUser("User", "consent-key");
    const security = createApiKeySecurityContext({
      userId: user.id,
      globalRole: user.role,
      keyId: "k",
      permissions: { mcp: ["use"], content: ["read"] },
      projectIds: [],
    });
    await expect(
      callerWithSecurity(user, security).oauthConsent.list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

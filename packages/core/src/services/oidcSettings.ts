import { randomUUID } from "node:crypto";
import type {
  OidcDiscoveryResult,
  OidcProviderOptions,
} from "@weaver/config/oidc";
import {
  discoverOidcProvider,
  OidcDiscoveryError,
} from "@weaver/config/oidcDiscovery";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { assertSystemAdmin, type SecurityContext } from "../security/context";
import type { EncryptionKeyRing } from "../security/encryption";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { setSystemSetting } from "./systemSettings";
import { decryptOidcSecret, encryptOidcSecret } from "./oidc/credentials";
import {
  OIDC_SETTING_KEY,
  oidcSettingsInput,
  readStoredOidc,
  type OidcSettingsInput,
  type StoredOidcSettings,
} from "./oidc/schemas";

export type OidcSettingsDeps = {
  ring: EncryptionKeyRing | null;
  fetchImpl: typeof fetch;
  fallback?: OidcProviderOptions;
  callbackUrl: string;
};
export type OidcSettingsView = {
  enabled: boolean;
  displayName: string;
  discoveryUrl: string;
  clientId: string;
  hasClientSecret: boolean;
  revision: string | null;
  source: "database" | "environment" | "none";
  encryptionConfigured: boolean;
  callbackUrl: string;
  discovery: OidcDiscoveryResult | null;
};

function authenticationMetadata(discovery: OidcDiscoveryResult | null) {
  if (!discovery) return null;
  const { metadata } = discovery;
  return JSON.stringify([
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.jwks_uri,
    [...new Set(discovery.signingAlgorithms)].sort(),
    discovery.tokenEndpointAuthMethod,
  ]);
}

function view(
  row: StoredOidcSettings | null,
  deps: OidcSettingsDeps,
): OidcSettingsView {
  return {
    enabled: row?.enabled ?? Boolean(deps.fallback),
    displayName:
      row?.displayName ?? deps.fallback?.displayName ?? "OpenID Connect",
    discoveryUrl: row?.discoveryUrl ?? deps.fallback?.discoveryUrl ?? "",
    clientId: row?.clientId ?? deps.fallback?.clientId ?? "",
    hasClientSecret: row
      ? Boolean(row.secret)
      : Boolean(deps.fallback?.clientSecret),
    revision: row?.revision ?? null,
    source: row ? "database" : deps.fallback ? "environment" : "none",
    encryptionConfigured: Boolean(deps.ring),
    callbackUrl: deps.callbackUrl,
    discovery: row?.discovery ?? null,
  };
}
export async function getOidcSettingsAsAdmin(
  db: PrismaClient,
  actor: SecurityContext,
  deps: OidcSettingsDeps,
): Promise<OidcSettingsView> {
  assertSystemAdmin(actor);
  return view(await readStoredOidc(db), deps);
}
export async function testOidcConnectionAsAdmin(
  actor: SecurityContext,
  discoveryUrl: string,
  deps: OidcSettingsDeps,
): Promise<OidcDiscoveryResult> {
  assertSystemAdmin(actor);
  try {
    return await discoverOidcProvider(discoveryUrl, deps);
  } catch (error) {
    const reason =
      error instanceof OidcDiscoveryError ? error.reason : "network";
    const message =
      reason === "policy"
        ? "OIDC origin is not allowed. For a private identity provider, configure its exact origin in WEAVER_OUTBOUND_ALLOWED_ORIGINS."
        : reason === "timeout"
          ? "The OIDC server did not respond within five seconds."
          : `Could not validate OIDC discovery (${reason}). Check the discovery URL and server metadata.`;
    throw new CoreError("BAD_REQUEST", message, { field: "discoveryUrl" });
  }
}
export async function updateOidcSettings(
  db: PrismaClient,
  actor: SecurityContext,
  raw: OidcSettingsInput,
  deps: OidcSettingsDeps,
): Promise<OidcSettingsView> {
  assertSystemAdmin(actor);
  const parsed = oidcSettingsInput.safeParse(raw);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid OIDC settings", {
      field: String(parsed.error.issues[0]?.path[0] ?? "displayName"),
    });
  const input = parsed.data;
  const before = await readStoredOidc(db);
  const assertRevision = (row: StoredOidcSettings | null) => {
    if ((row?.revision ?? null) !== input.expectedRevision)
      throw new CoreError(
        "CONFLICT",
        "OIDC settings changed. Reload the latest settings before saving.",
      );
  };
  assertRevision(before);
  const retainedSecret = before
    ? decryptOidcSecret(deps.ring, before.secret)
    : deps.fallback?.clientSecret;
  const replacementSecret =
    input.clientSecret === "" ? undefined : input.clientSecret;
  const secret = replacementSecret ?? retainedSecret ?? "";
  if (secret && !deps.ring)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Configure WEAVER_ENCRYPTION_KEYS before saving an OIDC client secret.",
    );
  if (input.enabled)
    for (const field of ["discoveryUrl", "clientId", "clientSecret"] as const) {
      if (!(field === "clientSecret" ? secret : input[field]))
        throw new CoreError(
          "BAD_REQUEST",
          "This field is required to enable OIDC.",
          { field },
        );
    }
  const discovery = input.enabled
    ? await testOidcConnectionAsAdmin(actor, input.discoveryUrl, deps)
    : before?.discoveryUrl === input.discoveryUrl
      ? before.discovery
      : null;
  if (input.enabled && !discovery?.compatible)
    throw new CoreError(
      "BAD_REQUEST",
      discovery?.issues[0] ?? "OIDC metadata is incompatible.",
      { field: "discoveryUrl" },
    );
  const oldSecret = before
    ? decryptOidcSecret(deps.ring, before.secret)
    : (deps.fallback?.clientSecret ?? "");
  const materialChanged = before
    ? before.enabled !== input.enabled ||
      before.discoveryUrl !== input.discoveryUrl ||
      before.clientId !== input.clientId ||
      oldSecret !== secret ||
      authenticationMetadata(before.discovery) !==
        authenticationMetadata(discovery)
    : true;
  const saved = await db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('weaver:oidc-settings', 0))::text`,
    );
    assertRevision(await readStoredOidc(tx));
    if (input.enabled && discovery) {
      const otherIdentity = await tx.account.findFirst({
        where: {
          providerId: "oidc",
          issuer: { not: discovery.metadata.issuer },
        },
        select: { id: true },
      });
      if (otherIdentity)
        throw new CoreError(
          "PRECONDITION_FAILED",
          "This issuer differs from existing OIDC accounts. Replacing the identity provider requires an account migration.",
          { field: "discoveryUrl" },
        );
    }
    const row: StoredOidcSettings = {
      schemaVersion: 1,
      revision: randomUUID(),
      generation: materialChanged ? randomUUID() : before!.generation,
      enabled: input.enabled,
      displayName: input.displayName,
      discoveryUrl: input.discoveryUrl,
      clientId: input.clientId,
      secret: secret ? encryptOidcSecret(deps.ring!, secret) : null,
      discovery,
    };
    await setSystemSetting(tx, {
      key: OIDC_SETTING_KEY,
      value: row,
      updatedById: actor.userId,
    });
    return row;
  });
  emitDiagnostic({
    event: "settings.changed",
    message: "OIDC settings updated",
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: { setting: OIDC_SETTING_KEY, enabled: saved.enabled },
  });
  return view(saved, deps);
}

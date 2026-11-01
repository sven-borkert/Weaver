import { createHash } from "node:crypto";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { decodeJwt } from "jose";

export const OAUTH_REVOCATION_PREFIX = "oauth-revoked:";
export function oauthRevocationIdentifier(tokenId: string): string {
  return `${OAUTH_REVOCATION_PREFIX}${createHash("sha256").update(tokenId).digest("hex")}`;
}

function requestingClient(
  body: { client_id?: unknown },
  headers?: Headers,
): string | null {
  if (typeof body.client_id === "string") return body.client_id;
  const match = /^Basic (\S+)$/i.exec(headers?.get("authorization") ?? "");
  if (!match) return null;
  try {
    return decodeURIComponent(
      Buffer.from(match[1]!, "base64").toString("utf8").split(":")[0]!,
    );
  } catch {
    return null;
  }
}

export const revokeSelfContainedToken = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/oauth2/introspect") {
    const result = ctx.context.returned as { active?: boolean } | undefined;
    const token = (ctx.body as { token?: unknown })?.token;
    if (
      !result?.active ||
      typeof token !== "string" ||
      token.split(".").length !== 3
    )
      return;
    // The provider has authenticated the client and verified this JWT before this hook.
    const payload = decodeJwt(token.replace(/^(?:Bearer|DPoP)\s+/i, ""));
    const generation = payload.weaver_authorization_id;
    if (
      typeof payload.jti !== "string" ||
      typeof payload.sub !== "string" ||
      typeof payload.azp !== "string" ||
      typeof generation !== "string"
    )
      return ctx.json({ active: false });
    const revoked = await ctx.context.adapter.findOne({
      model: "verification",
      where: [
        { field: "identifier", value: oauthRevocationIdentifier(payload.jti) },
        { field: "expiresAt", operator: "gt", value: new Date() },
      ],
    });
    const consent = await ctx.context.adapter.findOne<{
      scopes: string[];
      resources: string[];
    }>({
      model: "oauthConsent",
      where: [
        { field: "clientId", value: payload.azp },
        { field: "userId", value: payload.sub },
        { field: "referenceId", value: generation },
      ],
    });
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      revoked ||
      !consent ||
      typeof payload.scope !== "string" ||
      payload.scope
        .split(" ")
        .some((scope) => !consent.scopes.includes(scope)) ||
      audiences.some(
        (audience) =>
          typeof audience !== "string" || !consent.resources.includes(audience),
      )
    )
      return ctx.json({ active: false });
    if (consent.scopes.includes("offline_access")) {
      const where = [
        { field: "clientId", value: payload.azp },
        { field: "userId", value: payload.sub },
        { field: "referenceId", value: generation },
      ];
      const live = await ctx.context.adapter.findOne({
        model: "oauthRefreshToken",
        where: [
          ...where,
          { field: "revoked", value: null },
          { field: "expiresAt", operator: "gt", value: new Date() },
        ],
      });
      const revokedFamily = await ctx.context.adapter.findOne({
        model: "oauthRefreshToken",
        where: [
          ...where,
          { field: "revoked", operator: "ne", value: null },
          { field: "rotatedAt", value: null },
        ],
      });
      if (!live || revokedFamily) return ctx.json({ active: false });
    }

    return;
  }
  if (ctx.path !== "/oauth2/revoke") return;
  const result = ctx.context.returned;
  if (!isAPIError(result) || result.body?.error !== "unsupported_token_type")
    return;
  // This error is emitted only after Better Auth authenticates the client and verifies the JWT.
  const body = ctx.body as { token?: unknown; client_id?: unknown };
  if (typeof body.token !== "string") return;
  const payload = decodeJwt(body.token.replace(/^(?:Bearer|DPoP)\s+/i, ""));
  const clientId = requestingClient(body, ctx.headers);
  if (
    !clientId ||
    payload.client_id !== clientId ||
    payload.azp !== clientId ||
    typeof payload.jti !== "string" ||
    typeof payload.exp !== "number"
  )
    return;
  await ctx.context.adapter.deleteMany({
    model: "verification",
    where: [
      {
        field: "identifier",
        operator: "starts_with",
        value: OAUTH_REVOCATION_PREFIX,
      },
      { field: "expiresAt", operator: "lt", value: new Date() },
    ],
  });
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: oauthRevocationIdentifier(payload.jti),
    value: "revoked",
    expiresAt: new Date(payload.exp * 1000),
  });
  return new Response(null, { status: 200 });
});

import { createPinnedFetch } from "@weaver/config/outboundFetch";
import { getOidcProvider } from "@weaver/config/server";
import { oauthIssuerUrl } from "@weaver/config/publicUrls";
import { loadEncryptionKeyRing } from "@weaver/core/security/encryption";
import {
  readOidcLoginPresentation,
  resolveOidcRuntime,
} from "@weaver/core/services/oidc/runtime";
import type { OidcSettingsDeps } from "@weaver/core/services/oidcSettings";
import { db } from "@weaver/db";
import { env } from "~/env";

export function oidcSettingsDeps(
  input: Omit<OidcSettingsDeps, "callbackUrl">,
): OidcSettingsDeps {
  return { ...input, callbackUrl: `${oauthIssuerUrl(env)}/callback/oidc` };
}
function webDeps(): OidcSettingsDeps {
  return oidcSettingsDeps({
    ring: loadEncryptionKeyRing(),
    fetchImpl: createPinnedFetch(),
    fallback: getOidcProvider(env),
  });
}
export function getOidcLoginPresentation() {
  return readOidcLoginPresentation(db, webDeps());
}
export function resolveWebOidcProvider() {
  return resolveOidcRuntime(db, webDeps());
}

import { createHash } from "node:crypto";
import type {
  OidcProviderOptions,
  OidcRuntimeSnapshot,
} from "@weaver/config/oidc";
import { discoverOidcProvider } from "@weaver/config/oidcDiscovery";
import type { PrismaClient } from "@weaver/db/client";
import type { OidcSettingsDeps } from "../oidcSettings";
import { decryptOidcSecret } from "./credentials";
import { readStoredOidc } from "./schemas";

export function fallbackOidcGeneration(options: OidcProviderOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        options.discoveryUrl,
        options.clientId,
        options.clientSecret,
      ]),
    )
    .digest("hex");
}
const fallbackDiscovery = new Map<string, Promise<OidcRuntimeSnapshot>>();
export async function resolveOidcRuntime(
  db: PrismaClient,
  deps: OidcSettingsDeps,
): Promise<OidcRuntimeSnapshot | null> {
  const row = await readStoredOidc(db);
  if (row) {
    if (!row.enabled) return null;
    return {
      discoveryUrl: row.discoveryUrl,
      clientId: row.clientId,
      displayName: row.displayName,
      clientSecret: decryptOidcSecret(deps.ring, row.secret)!,
      generation: row.generation,
      discovery: row.discovery!,
    };
  }
  const options = deps.fallback;
  if (!options) return null;
  const generation = fallbackOidcGeneration(options);
  const key = `${generation}:${options.displayName}`;
  let pending = fallbackDiscovery.get(key);
  if (!pending) {
    pending = (async () => {
      const discovery = await discoverOidcProvider(options.discoveryUrl, deps);
      if (!discovery.compatible)
        throw new Error("OIDC discovery is incompatible");
      return { ...options, generation, discovery };
    })();
    fallbackDiscovery.set(key, pending);
    if (fallbackDiscovery.size > 8)
      fallbackDiscovery.delete(fallbackDiscovery.keys().next().value!);
    void pending.catch(() => {
      if (fallbackDiscovery.get(key) === pending) fallbackDiscovery.delete(key);
    });
  }
  return pending;
}
export async function readOidcLoginPresentation(
  db: PrismaClient,
  deps: OidcSettingsDeps,
): Promise<{ displayName: string } | null> {
  const row = await readStoredOidc(db);
  if (row) return row.enabled ? { displayName: row.displayName } : null;
  return deps.fallback ? { displayName: deps.fallback.displayName } : null;
}

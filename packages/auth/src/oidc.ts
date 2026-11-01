import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
} from "better-auth/api";
import type { OAuthProvider } from "@better-auth/core/oauth2";
import type {
  OidcProviderOptions,
  OidcResolver,
  OidcRuntimeSnapshot,
} from "@weaver/config/oidc";
import { discoverOidcProvider } from "@weaver/config/oidcDiscovery";
import { createOidcProvider, OIDC_GENERATION_STATE_KEY } from "./oidcProvider";
import { OIDC_PROVIDER_ID } from "./constants";

export type WeaverOidcOptions = OidcProviderOptions;
function socialBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
export function oidcPlugin(options: {
  provider?: OidcProviderOptions;
  resolve?: OidcResolver;
  fetchImpl: typeof fetch;
  onUnavailable?: (error: unknown) => void;
}): BetterAuthPlugin {
  if (Boolean(options.provider) === Boolean(options.resolve))
    throw new Error("Configure either a static OIDC provider or a resolver");
  let staticSnapshot: Promise<OidcRuntimeSnapshot> | undefined;
  const resolve: OidcResolver =
    options.resolve ??
    (() => {
      const provider = options.provider!;
      if (!staticSnapshot) {
        staticSnapshot = (async () => ({
          ...provider,
          generation: createHash("sha256")
            .update(
              JSON.stringify([
                provider.discoveryUrl,
                provider.clientId,
                provider.clientSecret,
              ]),
            )
            .digest("hex"),
          discovery: await discoverOidcProvider(provider.discoveryUrl, options),
        }))();
        void staticSnapshot.catch(() => {
          staticSnapshot = undefined;
        });
      }
      return staticSnapshot;
    });
  const providers = new Map<string, OAuthProvider>();
  return {
    id: "weaver-oidc",
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            (ctx.path === "/sign-in/social" &&
              socialBody(ctx.body).provider === OIDC_PROVIDER_ID) ||
            (ctx.path === "/callback/:id" &&
              ctx.params?.id === OIDC_PROVIDER_ID),
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/sign-in/social" && socialBody(ctx.body).idToken)
              throw new APIError("BAD_REQUEST", {
                message: "OIDC sign-in requires the authorization-code flow",
              });
            let provider: OAuthProvider | undefined;
            try {
              const snapshot = await resolve();
              if (snapshot) {
                let cached = providers.get(snapshot.generation);
                if (!cached) {
                  cached = createOidcProvider(snapshot, options);
                  providers.set(snapshot.generation, cached);
                  if (providers.size > 8)
                    providers.delete(providers.keys().next().value!);
                }
                provider = { ...cached, name: snapshot.displayName };
                if (ctx.path === "/sign-in/social")
                  await addOAuthServerContext({
                    [OIDC_GENERATION_STATE_KEY]: snapshot.generation,
                  });
              }
            } catch {
              try {
                options.onUnavailable?.(new Error("OIDC sign-in unavailable"));
              } catch {}
              ctx.context.logger.warn(
                "OIDC sign-in unavailable; check the provider configuration",
              );
            }
            const others = ctx.context.socialProviders.filter(
              (p) => p.id !== OIDC_PROVIDER_ID,
            );
            return {
              context: {
                context: {
                  socialProviders: provider ? [...others, provider] : others,
                },
              },
            };
          }),
        },
      ],
    },
  };
}

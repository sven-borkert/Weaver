import type { WeaverAuth } from "./index";

export type IssueApiKeyInput = {
  userId: string;
  name: string;
  /** Better Auth statements: resource → actions (e.g. { content: ["read"], mcp: ["use"] }). */
  permissions: Record<string, string[]>;
  expiresInSeconds: number | null;
  rateLimit: { maxRequests: number; windowMs: number } | null;
};

export type IssuedApiKey = { id: string; key: string };

/** Mints keys through Better Auth (generation + hashing); Weaver owns the policy around it. */
export type ApiKeyIssuer = {
  issue(input: IssueApiKeyInput): Promise<IssuedApiKey>;
};

export function createApiKeyIssuer(auth: WeaverAuth): ApiKeyIssuer {
  return {
    async issue(input) {
      // No request headers: Better Auth treats this as a server call and accepts userId.
      const created = await auth.api.createApiKey({
        body: {
          userId: input.userId,
          name: input.name,
          permissions: input.permissions,
          expiresIn: input.expiresInSeconds,
          ...(input.rateLimit
            ? {
                rateLimitEnabled: true,
                rateLimitMax: input.rateLimit.maxRequests,
                rateLimitTimeWindow: input.rateLimit.windowMs,
              }
            : {}),
        },
      });
      return { id: created.id, key: created.key };
    },
  };
}

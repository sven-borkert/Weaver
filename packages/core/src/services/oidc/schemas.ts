import { z } from "zod";
import { oidcDiscoveryResultSchema, oidcUrlSchema } from "@weaver/config/oidc";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";

export const OIDC_SETTING_KEY = "auth.oidc";
export const oidcSettingsInput = z
  .object({
    expectedRevision: z.uuid().nullable(),
    enabled: z.boolean(),
    displayName: z.string().trim().min(1).max(120),
    discoveryUrl: z.union([z.literal(""), oidcUrlSchema]),
    clientId: z.string().trim().max(1024),
    clientSecret: z.string().max(16384).optional(),
  })
  .strict();
export const testOidcConnectionInput = z
  .object({ discoveryUrl: oidcUrlSchema })
  .strict();
export type OidcSettingsInput = z.infer<typeof oidcSettingsInput>;
const base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const oidcSecretSchema = z
  .object({
    ciphertext: base64.min(4),
    nonce: base64.length(16),
    tag: base64.length(24),
    keyVersion: z.number().int().positive(),
  })
  .strict()
  .nullable();
export const storedOidcSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.uuid(),
    generation: z.string().min(1).max(128),
    enabled: z.boolean(),
    displayName: z.string().trim().min(1).max(120),
    discoveryUrl: z.union([z.literal(""), oidcUrlSchema]),
    clientId: z.string().max(1024),
    secret: oidcSecretSchema,
    discovery: oidcDiscoveryResultSchema.nullable(),
  })
  .strict()
  .refine(
    (s) =>
      !s.enabled ||
      Boolean(
        s.discoveryUrl &&
        s.clientId &&
        s.secret &&
        s.discovery?.compatible &&
        s.discovery.signingAlgorithms.length &&
        s.discovery.tokenEndpointAuthMethod,
      ),
    "Invalid enabled OIDC configuration",
  );
export type StoredOidcSettings = z.infer<typeof storedOidcSettingsSchema>;
export type OidcDb = PrismaClient | Prisma.TransactionClient;

export async function readStoredOidc(
  db: OidcDb,
): Promise<StoredOidcSettings | null> {
  const row = await db.systemSetting.findUnique({
    where: { key: OIDC_SETTING_KEY },
    select: { value: true },
  });
  if (!row) return null;
  const parsed = storedOidcSettingsSchema.safeParse(row.value);
  if (!parsed.success)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Saved OIDC configuration is invalid. Restore valid settings before enabling OIDC.",
    );
  return parsed.data;
}

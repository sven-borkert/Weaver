import {
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
} from "@weaver/auth/constants";
import { z } from "zod";

/** Capabilities a user may add beyond the read/MCP defaults (spec §8; system:admin for Admins only; ingest:external per Phase 5 §8). */
export const API_KEY_GRANTABLE_CAPABILITIES = [
  "content:propose",
  "content:write",
  "system:admin",
  "ingest:external",
  "external:use",
  "external:manage",
] as const;

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH),
  capabilities: z
    .array(z.enum(API_KEY_GRANTABLE_CAPABILITIES))
    .max(API_KEY_GRANTABLE_CAPABILITIES.length)
    .default([]),
  projectIds: z.array(z.uuid()).max(100).default([]),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(API_KEY_MAX_EXPIRY_DAYS)
    .nullable()
    .default(null),
  rateLimitPerMinute: z
    .number()
    .int()
    .min(1)
    .max(API_KEY_MAX_RATE_LIMIT_PER_MINUTE)
    .nullable()
    .default(null),
});

export const apiKeyIdInput = z.object({ keyId: z.uuid() });

/** Expiry is fixed at creation; changing it means a new key. */
export const updateApiKeyInput = createApiKeyInput
  .omit({ expiresInDays: true })
  .extend({ keyId: z.uuid() });

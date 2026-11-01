import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { rawCommonSchema } from "./jobs";
import { parseEncryptionKeyRing } from "./encryptionKeys";
import { DEFAULT_WORKER_ROLES, parseWorkerRoles } from "./workerRoles";

const boundedInt = (minimum: number, maximum: number, fallback: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

function workspaceRootFrom(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

// Turbo runs each package in its own directory; anchor relative paths at the workspace root.
function resolveDataDir(value: string): string {
  return path.isAbsolute(value)
    ? value
    : path.resolve(workspaceRootFrom(process.cwd()), value);
}

export const serverEnvShape = {
  ...rawCommonSchema.shape,
  DATABASE_URL: z.url(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  AUTH_SECRET: z
    .string()
    .min(32)
    .refine(
      (value) => value !== "run-openssl-rand-base64-32-and-paste-here",
      "Replace the example AUTH_SECRET with a generated secret",
    ),
  AUTH_URL: z.url().optional(),
  WEAVER_OIDC_DISCOVERY_URL: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      const localHttp =
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (
        (url.protocol === "https:" || localHttp) &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    }, "OIDC discovery requires HTTPS (HTTP only on loopback), without credentials or a fragment")
    .optional(),
  WEAVER_OIDC_CLIENT_ID: z.string().trim().min(1).optional(),
  WEAVER_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  WEAVER_OIDC_DISPLAY_NAME: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .default("OpenID Connect"),
  WEAVER_GIT_ALLOWED_SSH_TARGETS: z.string().max(8192).default(""),
  WEAVER_OUTBOUND_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .refine(
      (value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
          .every((origin) => {
            try {
              const url = new URL(origin);
              return (
                ["http:", "https:"].includes(url.protocol) &&
                url.origin === origin
              );
            } catch {
              return false;
            }
          }),
      "Outbound allowlist must contain exact HTTP(S) origins",
    ),

  DATABASE_POOL_MAX: boundedInt(1, 1_000, 10),
  DATABASE_STATEMENT_TIMEOUT_MS: boundedInt(0, 86_400_000, 0),
  WEAVER_DATA_DIR: z.string().min(1).transform(resolveDataDir),
  WEAVER_GIT_LOCK_TIMEOUT_MS: boundedInt(1, 120_000, 10_000),
  WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX: boundedInt(1, 128, 2),
  WEAVER_GIT_LOCK_POOL_MAX: boundedInt(1, 32, 4),
  /** Largest single upload accepted by the ingestion route (spec §4). */
  WEAVER_INGESTION_PROJECT_QUOTA_BYTES: boundedInt(
    1_024,
    Number.MAX_SAFE_INTEGER,
    5 * 1024 ** 3,
  ),
  WEAVER_INGESTION_MIN_FREE_BYTES: boundedInt(
    0,
    Number.MAX_SAFE_INTEGER,
    1024 ** 3,
  ),
  WEAVER_INGESTION_MAX_FILE_BYTES: boundedInt(1_024, 268_435_456, 52_428_800),
  // Matches the OneNote reader's 512 MiB source cap (onenote-reader MAX_SOURCE_BYTES).
  WEAVER_ARTIFACT_MAX_FILE_BYTES: boundedInt(1_024, 536_870_912, 536_870_912),
  WEAVER_ONENOTE_READER_PATH: z.string().min(1).optional(),
  /** Largest image accepted by the document image upload route. */
  WEAVER_DOCUMENT_IMAGE_MAX_BYTES: boundedInt(1_024, 104_857_600, 10_485_760),
  /** PDF export: Chromium render cap, browser path in the image, and its sandbox flag. */
  WEAVER_PDF_TIMEOUT_MS: boundedInt(5_000, 120_000, 30_000),
  WEAVER_CHROMIUM_PATH: z.string().min(1).optional(),
  WEAVER_CHROMIUM_NO_SANDBOX: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Vision calls per file for scanned pages and images (spec §6); 0 disables OCR. */
  WEAVER_INGESTION_MAX_OCR_PAGES: boundedInt(0, 500, 50),
  /** Submissions per minute one API key may push to the external feed (Phase 5 §8). */
  WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE: boundedInt(1, 100_000, 60),
  /** pg-boss consumers this worker registers (spec §3.1). */
  WEAVER_WORKER_ROLES: z
    .string()
    .default(DEFAULT_WORKER_ROLES)
    .transform((value, ctx) => {
      try {
        return parseWorkerRoles(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
      }
    }),
  WEAVER_ENABLED_WORKER_ROLES: z
    .string()
    .default(DEFAULT_WORKER_ROLES)
    .transform((value, ctx) => {
      try {
        return parseWorkerRoles(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
      }
    }),
  WEAVER_WORKER_HEALTH_PORT: boundedInt(1, 65_535, 3101),
  WEAVER_AUTH_RATE_LIMIT_ENABLED: z.enum(["true", "false"]).optional(),
  /** Canonical MCP protected-resource URL; defaults to <AUTH_URL><base path>/api/mcp. */
  WEAVER_MCP_RESOURCE_URL: z.url().optional(),
  /** Expected OAuth issuer (JWT `iss`); defaults to <AUTH_URL origin><base path>/api/auth (spec §26.6). */
  WEAVER_OAUTH_ISSUER: z.url().optional(),
  WEAVER_MCP_OPERATION_LOCK_POOL_MAX: boundedInt(1, 128, 16),
  WEAVER_MCP_PORT: boundedInt(1, 65_535, 3200),
  /** Enables trusted-proxy client-address handling only for a private listener topology. */
  WEAVER_AUTH_TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WEAVER_MCP_TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Comma-separated extra hostnames accepted in Host / Origin headers by the MCP runtime. */
  WEAVER_MCP_ALLOWED_HOSTS: z.string().optional(),
  WEAVER_MCP_ALLOWED_ORIGINS: z.string().optional(),
  WEAVER_MCP_MAX_BODY_BYTES: boundedInt(1_024, 16_777_216, 1_048_576),
  WEAVER_MCP_MAX_RESOURCE_CHARS: boundedInt(1_000, 2_000_000, 200_000),
  WEAVER_MCP_TOOL_TIMEOUT_MS: boundedInt(1_000, 120_000, 30_000),
  WEAVER_MCP_RATE_LIMIT_PER_MINUTE: boundedInt(1, 100_000, 600),
  WEAVER_MCP_ANON_RATE_LIMIT_PER_MINUTE: boundedInt(1, 100_000, 60),
  /** Versioned AES-256-GCM key ring: "<version>:<base64 32 bytes>,..."; highest version encrypts. */
  WEAVER_ENCRYPTION_KEYS: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      try {
        parseEncryptionKeyRing(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
} satisfies z.ZodRawShape;

const serverEnvSchema = z.object(serverEnvShape);
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(input: Record<string, unknown>): ServerEnv {
  const withoutBlanks = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== ""),
  );
  const parsed = serverEnvSchema.parse(withoutBlanks);
  assertProductionAuthUrl(parsed);
  getOidcProvider(parsed);
  return parsed;
}

export function getOidcProvider(
  env: Pick<
    ServerEnv,
    | "WEAVER_OIDC_DISCOVERY_URL"
    | "WEAVER_OIDC_CLIENT_ID"
    | "WEAVER_OIDC_CLIENT_SECRET"
    | "WEAVER_OIDC_DISPLAY_NAME"
  >,
) {
  const discoveryUrl = env.WEAVER_OIDC_DISCOVERY_URL;
  const clientId = env.WEAVER_OIDC_CLIENT_ID;
  const clientSecret = env.WEAVER_OIDC_CLIENT_SECRET;
  if (!discoveryUrl && !clientId && !clientSecret) return undefined;
  if (!discoveryUrl || !clientId || !clientSecret) {
    throw new Error(
      "OIDC requires WEAVER_OIDC_DISCOVERY_URL, WEAVER_OIDC_CLIENT_ID and WEAVER_OIDC_CLIENT_SECRET together",
    );
  }
  return {
    discoveryUrl,
    clientId,
    clientSecret,
    displayName: env.WEAVER_OIDC_DISPLAY_NAME,
  };
}

export function assertProductionAuthUrl(env: {
  NODE_ENV?: string;
  AUTH_URL?: string;
}): void {
  if (env.NODE_ENV !== "production") return;
  const url = env.AUTH_URL ? new URL(env.AUTH_URL) : null;
  const localHttp =
    url?.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!localHttp && url?.protocol !== "https:") ||
    !url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Production requires AUTH_URL with HTTPS (HTTP only on loopback) and no credentials, query or fragment",
    );
  }
}

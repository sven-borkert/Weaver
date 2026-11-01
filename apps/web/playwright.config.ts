import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolveE2eDataDir } from "./playwright-runtime";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const serverPort = new URL(baseURL).port || "3000";
const aiPort = process.env.WEAVER_E2E_AI_PORT ?? "4010";
const aiBaseUrl = `http://127.0.0.1:${aiPort}`;
process.env.WEAVER_E2E_AI_BASE_URL = aiBaseUrl;
const externalMcpPort = process.env.WEAVER_E2E_EXTERNAL_MCP_PORT ?? "4011";
const externalMcpBaseUrl = `http://127.0.0.1:${externalMcpPort}`;
process.env.WEAVER_E2E_EXTERNAL_MCP_BASE_URL = externalMcpBaseUrl;
const mcpPort = process.env.WEAVER_E2E_MCP_PORT ?? "3200";
const workerPort = process.env.WEAVER_E2E_WORKER_PORT ?? "3101";
const mcpResourceUrl = `http://127.0.0.1:${mcpPort}/mcp`;
process.env.WEAVER_MCP_RESOURCE_URL = mcpResourceUrl;
const workerHealthUrl = `http://127.0.0.1:${workerPort}/health`;
const e2eDataDir = resolveE2eDataDir(process.env.WEAVER_DATA_DIR!);
const e2eRuntimeEnv = {
  ...(process.env.DATABASE_URL
    ? { DATABASE_URL: process.env.DATABASE_URL }
    : {}),
  WEAVER_DATA_DIR: e2eDataDir,
  // `pnpm e2e` loads .env.e2e via dotenv-cli, which sets
  // NODE_ENV="development" (.env.e2e is a copy of .env). Inheriting that into
  // `next build`/`next start` crashes prerendering (useContext of null on
  // /_global-error), so pin the production value the build wants.
  NODE_ENV: "production",
  // Better Auth uses this public origin for browser requests.
  AUTH_URL: baseURL,
  PORT: serverPort,
  // The suite signs in many times from 127.0.0.1 within seconds; Better Auth's
  // production-only rate limiter (3 sign-ins/10s per IP) would 429 the rest.
  WEAVER_AUTH_RATE_LIMIT_ENABLED: "false",
  WEAVER_ENCRYPTION_KEYS: process.env.WEAVER_ENCRYPTION_KEYS!,
  // Web mints tokens for, and the suite's clients call, the mcp-server directly.
  WEAVER_MCP_RESOURCE_URL: mcpResourceUrl,
  // Production runtimes only reach loopback fixtures that are listed explicitly.
  WEAVER_OUTBOUND_ALLOWED_ORIGINS: `${aiBaseUrl},${externalMcpBaseUrl}`,
};

export default defineConfig({
  outputDir: fileURLToPath(new URL("../../test-results", import.meta.url)),
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  // One retry on CI absorbs occasional flakes without masking real failures
  // locally (where a flake should be investigated immediately).
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/e2e/mock-mcp-server.mjs",
      url: `${externalMcpBaseUrl}/health`,
      reuseExistingServer: false,
      env: { WEAVER_E2E_EXTERNAL_MCP_PORT: externalMcpPort },
    },
    {
      command:
        "pnpm exec tsx tests/e2e/prepare.ts && node tests/e2e/mock-ai-server.mjs",
      url: `${aiBaseUrl}/health`,
      reuseExistingServer: false,
      env: {
        ...e2eRuntimeEnv,
        WEAVER_E2E_AI_PORT: aiPort,
        WEAVER_E2E_AI_BASE_URL: aiBaseUrl,
      },
    },
    {
      // Production build + start so `pnpm e2e` keeps covering `next build`
      // and prerendering, not just the dev server. Root scripts need the
      // workspace root cwd (playwright defaults to the config directory).
      command: "pnpm build && pnpm --dir apps/web start",
      cwd: workspaceRoot,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 300_000,
      // Forward the DATABASE_URL chosen by `pnpm e2e` (which loads .env.e2e via
      // dotenv-cli) so both runtimes stay paired with weaver_e2e instead of
      // reading the development values from .env.
      env: e2eRuntimeEnv,
    },
    {
      command: "pnpm --dir apps/agent-worker start",
      cwd: workspaceRoot,
      url: workerHealthUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...e2eRuntimeEnv,
        WEAVER_WORKER_HEALTH_PORT: workerPort,
      },
    },
    {
      command: "pnpm --dir apps/mcp-server start",
      cwd: workspaceRoot,
      url: `http://127.0.0.1:${mcpPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...e2eRuntimeEnv,
        WEAVER_MCP_PORT: mcpPort,
        WEAVER_MCP_TRUST_PROXY: "false",
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

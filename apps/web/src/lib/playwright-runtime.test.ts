import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Playwright runtime paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("forwards the repository-root e2e data directory to every app runtime", async () => {
    vi.stubEnv("WEAVER_DATA_DIR", "./data-e2e");
    const config = (await import("../../playwright.config")).default;
    const webServers = Array.isArray(config.webServer)
      ? config.webServer
      : [config.webServer];
    const repositoryRoot = fileURLToPath(
      new URL("../../../../", import.meta.url),
    );
    const expectedDataDir = path.join(repositoryRoot, "data-e2e");
    const { resolveE2eGitDir } = await import("../../playwright-runtime");

    expect(
      webServers
        .filter((server) => server?.command?.includes(" start"))
        .map((server) => server?.env?.WEAVER_DATA_DIR),
    ).toEqual([expectedDataDir, expectedDataDir, expectedDataDir]);
    const fixture = webServers.find(
      (server) => server?.command === "node tests/e2e/mock-mcp-server.mjs",
    );
    expect(fixture?.reuseExistingServer).toBe(false);
    expect(fixture?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/);
    expect(fixture?.env?.WEAVER_DATA_DIR).toBeUndefined();
    expect(resolveE2eGitDir("./data-e2e")).toBe(
      path.join(expectedDataDir, "git"),
    );
  });

  it("keeps alternate runtime readiness URLs and child ports aligned", async () => {
    vi.stubEnv("WEAVER_DATA_DIR", "./data-e2e");
    vi.stubEnv("PLAYWRIGHT_BASE_URL", "http://localhost:3300");
    vi.stubEnv("WEAVER_E2E_WORKER_PORT", "3301");
    vi.stubEnv("WEAVER_E2E_MCP_PORT", "3302");
    const config = (await import("../../playwright.config")).default;
    const servers = Array.isArray(config.webServer)
      ? config.webServer
      : [config.webServer];
    const worker = servers.find((server) =>
      server?.command?.includes("agent-worker start"),
    );
    const mcp = servers.find((server) =>
      server?.command?.includes("mcp-server start"),
    );
    expect(worker?.url).toBe("http://127.0.0.1:3301/health");
    expect(worker?.env?.WEAVER_WORKER_HEALTH_PORT).toBe("3301");
    expect(mcp?.url).toBe("http://127.0.0.1:3302/health");
    expect(mcp?.env?.WEAVER_MCP_PORT).toBe("3302");
    for (const server of servers.filter((entry) =>
      entry?.command?.includes(" start"),
    )) {
      expect(server?.env?.WEAVER_MCP_RESOURCE_URL).toBe(
        "http://127.0.0.1:3302/mcp",
      );
      expect(server?.env?.AUTH_URL).toBe("http://localhost:3300");
      expect(server?.env?.WEAVER_DATA_DIR).toMatch(/\/data-e2e$/);
      expect(server?.reuseExistingServer).toBe(false);
    }
  });
});

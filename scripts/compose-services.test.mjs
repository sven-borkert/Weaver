import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function mappingBlock(source, key, indent) {
  const lines = source.split("\n");
  const prefix = " ".repeat(indent);
  const start = lines.findIndex((line) => line === `${prefix}${key}:`);

  assert.notEqual(start, -1, `missing ${key} mapping at indentation ${indent}`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}

// Assert only the decisions this test protects, not compose file spelling.
test("compose defines a private agent worker with its runtime dependencies", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const services = mappingBlock(compose, "services", 0);
  const worker = mappingBlock(services, "agent-worker", 2);

  assert.match(
    worker,
    /migrations:\s*\n\s+condition: service_completed_successfully/,
    "worker must wait for completed migrations",
  );
  assert.match(worker, /healthcheck:/, "worker must define a healthcheck");
  assert.match(
    worker,
    /r\.ok|response\.ok/,
    "healthcheck must fail on non-2xx so worker readiness is honored",
  );
  assert.match(worker, /:\/data$/m, "worker must mount the shared /data store");
  assert.match(worker, /networks: \[internal\]/);
  assert.doesNotMatch(worker, /^    ports:/m, "worker must not publish ports");
  assert.doesNotMatch(worker, /^    labels:/m, "worker must not join traefik");
  assert.doesNotMatch(worker, /ingress|traefik\./);
});

function dockerignorePatterns() {
  return new Set(
    readFileSync(".dockerignore", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
}

test("docker build context excludes test programs independent of language", () => {
  const patterns = dockerignorePatterns();

  assert.ok(
    patterns.has("**/*.test.*"),
    "missing language-independent test glob",
  );
  assert.ok(
    patterns.has("**/*.spec.*"),
    "missing language-independent spec glob",
  );
});

test("docker build context excludes agent instructions and internal documentation", () => {
  const patterns = dockerignorePatterns();

  for (const internal of [
    "**/.claude",
    "**/.codex",
    "**/CLAUDE.md",
    "**/AGENTS.md",
    "/docs",
    "/deploy",
  ]) {
    assert.ok(patterns.has(internal), `build context must exclude ${internal}`);
  }
});

test("the published tools image never descends from a stage that copies the repository", () => {
  const stages = new Map();
  let current;
  for (const line of readFileSync("docker/web.Dockerfile", "utf8").split(
    "\n",
  )) {
    const from = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (from) {
      current = { parent: from[1], lines: [] };
      stages.set(from[2], current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  assert.ok(stages.has("tools"), "missing tools stage");
  for (let name = "tools"; stages.has(name); name = stages.get(name).parent) {
    assert.ok(
      !stages.get(name).lines.some((line) => /^COPY \. /.test(line)),
      `tools inherits the whole build context through the ${name} stage`,
    );
  }
});

test("compose exposes the MCP runtime only through Traefik on its own path", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const services = mappingBlock(compose, "services", 0);
  const mcp = mappingBlock(services, "mcp-server", 2);

  assert.match(
    mcp,
    /migrations:\s*\n\s+condition: service_completed_successfully/,
    "mcp-server must wait for completed migrations",
  );
  assert.match(mcp, /healthcheck:/, "mcp-server must define a healthcheck");
  assert.match(mcp, /r\.ok|response\.ok/);
  assert.match(mcp, /:\/data$/m, "mcp-server commits to project repositories");
  assert.match(mcp, /networks: \[internal, ingress\]/);
  assert.doesNotMatch(mcp, /^    ports:/m, "mcp-server must not publish ports");
  assert.match(
    mcp,
    /PathPrefix\(`\$\{WEAVER_BASE_PATH:-\/weaver\}\/api\/mcp`\)/,
  );
  assert.match(
    mcp,
    /Path\(`\/\.well-known\/oauth-protected-resource\$\{WEAVER_BASE_PATH:-\/weaver\}\/api\/mcp`\)/,
  );
  assert.match(mcp, /loadbalancer\.server\.port=3200/);
  assert.match(
    mcp,
    /WEAVER_MCP_TRUST_PROXY:\s*true/,
    "the proxy-only Compose topology must opt in explicitly",
  );
  assert.match(
    readFileSync("apps/mcp-server/src/index.ts", "utf8"),
    /trustProxy:\s*env\.WEAVER_MCP_TRUST_PROXY/,
    "the listener must use the explicit default-off proxy trust flag",
  );

  const web = mappingBlock(services, "web", 2);
  assert.match(
    web,
    /PathPrefix\(`\/\.well-known\/oauth-authorization-server\$\{WEAVER_BASE_PATH:-\/weaver\}\/`\)/,
    "issuer discovery must reach web without claiming the shared host's /.well-known/",
  );
  assert.doesNotMatch(web, /PathPrefix\(`\/\.well-known\/`\)/);
  assert.match(web, /addprefix\.prefix=\$\{WEAVER_BASE_PATH:-\/weaver\}/);
});

test("compose routes by the deploy env's host and base path on a shared Traefik", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const services = mappingBlock(compose, "services", 0);
  for (const name of ["web", "mcp-server"]) {
    const service = mappingBlock(services, name, 2);
    assert.match(service, /Host\(`\$\{WEAVER_PUBLIC_HOST:\?/);
    assert.match(
      service,
      /NEXT_PUBLIC_BASE_PATH: \$\{WEAVER_BASE_PATH:-\/weaver\}/,
    );
    assert.doesNotMatch(service, /HOSTNAME_TO_BE_CONFIGURED|\/knowledge/);
  }
  assert.match(
    mappingBlock(compose, "networks", 0),
    /ingress:\s*\n\s+name: \$\{WEAVER_TRAEFIK_NETWORK:-ingress\}\s*\n\s+external: true/,
  );
  assert.doesNotMatch(compose, /ollama/i);
  assert.match(
    mappingBlock(services, "web", 2),
    /networks: \[internal, ingress\]/,
  );
});

test("both worker containers cap memory so a decompression bomb cannot take the host", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const services = mappingBlock(compose, "services", 0);
  for (const name of ["agent-worker", "ingestion-worker"]) {
    assert.match(
      mappingBlock(services, name, 2),
      /^    mem_limit: \d+[kmg]?$/im,
      `${name} must declare a memory limit`,
    );
  }
});

test("runtime drain budgets fit inside container grace periods", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  assert.match(
    mappingBlock(compose, "agent-worker", 2),
    /stop_grace_period: 45s/,
  );
  assert.match(
    mappingBlock(compose, "mcp-server", 2),
    /stop_grace_period: 135s/,
  );
});
test("Playwright owns each runtime once and resets before starting servers", () => {
  const config = readFileSync("apps/web/playwright.config.ts", "utf8");
  assert.doesNotMatch(config, /pnpm build && pnpm start"/);
  assert.match(config, /prepare.ts && node tests\/e2e\/mock-ai-server.mjs/);
  assert.doesNotMatch(config, /globalSetup:/);
});

test("compose splits the worker image into knowledge/assistant and ingestion roles", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const services = mappingBlock(compose, "services", 0);
  const worker = mappingBlock(services, "agent-worker", 2);
  const ingestion = mappingBlock(services, "ingestion-worker", 2);
  assert.match(worker, /WEAVER_WORKER_ROLES:\s*knowledge,assistant/);
  assert.match(ingestion, /WEAVER_WORKER_ROLES:\s*ingestion/);
  assert.match(ingestion, /image: .*\/worker:/);
  assert.match(ingestion, /WEAVER_WORKER_HEALTH_PORT:\s*3102/);
  assert.match(ingestion, /127\.0\.0\.1:3102\/ready/);
  assert.match(ingestion, /r\.ok|response\.ok/);
  assert.match(
    ingestion,
    /:\/data$/m,
    "the ingestion worker reads uploads from the shared store",
  );
  assert.match(
    ingestion,
    /networks: \[internal\]/,
    "the ingestion worker never embeds, so it stays off the shared Ollama network",
  );
  assert.match(ingestion, /stop_grace_period: 45s/);
  assert.doesNotMatch(ingestion, /^    ports:/m);
  assert.doesNotMatch(ingestion, /traefik/);
});

test("the deployable compose file pulls registry images and never builds", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  assert.doesNotMatch(
    compose,
    /^\s+build:/m,
    "docker-compose.yml must not build",
  );
  assert.doesNotMatch(compose, /x-tools-build/);
  const services = mappingBlock(compose, "services", 0);
  const expected = {
    migrations: "tools",
    web: "web",
    "agent-worker": "worker",
    "ingestion-worker": "worker",
    "mcp-server": "mcp",
  };
  for (const [service, image] of Object.entries(expected)) {
    assert.match(
      mappingBlock(services, service, 2),
      new RegExp(
        `image: \\$\\{WEAVER_IMAGE_PREFIX:-weaver\\}/${image}:\\$\\{WEAVER_IMAGE_TAG:-latest\\}`,
      ),
      `${service} must run the registry ${image} image`,
    );
  }
});

test("the build overlay carries exactly the four image builds", () => {
  const overlay = readFileSync("docker-compose.build.yml", "utf8");
  const services = mappingBlock(overlay, "services", 0);
  assert.equal(
    (overlay.match(/^    build:/gm) ?? []).length,
    5,
    "migrations, web, agent-worker, ingestion-worker, mcp-server",
  );
  assert.match(mappingBlock(services, "migrations", 2), /target: tools/);
  assert.match(
    mappingBlock(services, "web", 2),
    /dockerfile: docker\/web\.Dockerfile/,
  );
  assert.match(
    mappingBlock(services, "web", 2),
    /NEXT_PUBLIC_BASE_PATH: \$\{WEAVER_BASE_PATH:-\/weaver\}/,
  );
  assert.match(
    mappingBlock(services, "agent-worker", 2),
    /dockerfile: docker\/worker\.Dockerfile/,
  );
  assert.match(
    mappingBlock(services, "ingestion-worker", 2),
    /dockerfile: docker\/worker\.Dockerfile/,
  );
  assert.match(
    mappingBlock(services, "mcp-server", 2),
    /dockerfile: docker\/mcp\.Dockerfile/,
  );
  assert.doesNotMatch(
    overlay,
    /image:/,
    "the overlay adds builds only; image names stay in docker-compose.yml",
  );
});

test("the generic example runs every service from registry images on one host", () => {
  const example = readFileSync("deploy/examples/docker-compose.yml", "utf8");
  const services = mappingBlock(example, "services", 0);
  for (const name of [
    "postgres",
    "migrations",
    "web",
    "agent-worker",
    "ingestion-worker",
    "mcp-server",
  ]) {
    mappingBlock(services, name, 2);
  }
  assert.doesNotMatch(example, /build:|traefik|external: true|ollama/);
  assert.match(
    mappingBlock(services, "web", 2),
    /ports:\s*\n\s+- "\$\{WEAVER_WEB_PORT:-3000\}:3000"/,
  );
  assert.match(
    mappingBlock(services, "mcp-server", 2),
    /ports:\s*\n\s+- "\$\{WEAVER_MCP_PORT:-3200\}:3200"/,
  );
  assert.equal((example.match(/WEAVER_IMAGE_PREFIX:-/g) ?? []).length, 5);
  assert.match(
    mappingBlock(services, "ingestion-worker", 2),
    /WEAVER_WORKER_ROLES:\s*ingestion/,
  );
  assert.match(
    mappingBlock(services, "agent-worker", 2),
    /WEAVER_WORKER_ROLES:\s*knowledge,assistant,tasks,git/,
  );
  assert.match(example, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/pg_password/);
});

test("the quick start builds locally and publishes only on loopback", () => {
  const quickstart = readFileSync("docker-compose.quickstart.yml", "utf8");
  const services = mappingBlock(quickstart, "services", 0);
  assert.doesNotMatch(quickstart, /traefik|external: true/);
  for (const name of [
    "data-permissions",
    "migrations",
    "bootstrap-admin",
    "web",
    "agent-worker",
    "ingestion-worker",
    "mcp-server",
  ]) {
    assert.match(mappingBlock(services, name, 2), /^    build:/m);
  }
  const published = quickstart.match(/^      - "[^"]*:\d+"$/gm) ?? [];
  assert.equal(published.length, 2, "only web and mcp-server publish ports");
  for (const port of published) assert.match(port, /"127\.0\.0\.1:/);
  assert.match(
    mappingBlock(services, "web", 2),
    /args:\s*\n\s+NEXT_PUBLIC_BASE_PATH: ""/,
    "the root-served quick start must not inherit the /weaver build default",
  );
  assert.match(readFileSync(".gitignore", "utf8"), /^\.env\.quickstart$/m);
});

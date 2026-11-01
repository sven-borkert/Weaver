import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import test from "node:test";

const files = globSync("packages/**/*.{ts,tsx,js,mjs}", {
  exclude: ["**/node_modules/**", "**/generated/**"],
});

test("shared packages do not import application or transport-only modules", () => {
  const violations = files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [
      source.includes("apps/web") ? `${file}: apps/web` : null,
      source.includes('from "@trpc/server"') ? `${file}: @trpc/server` : null,
      source.includes('import "server-only"') ? `${file}: server-only` : null,
      /from ["']~\//.test(source) ? `${file}: web alias` : null,
    ].filter(Boolean);
  });
  assert.deepEqual(violations, []);
  assert.equal(globSync("apps/web/src/server/services/*.ts").length, 0);
  assert.ok(globSync("packages/core/src/services/*.ts").length > 0);
});

test("assistant packages exist and the web app only reaches the assistant through core", () => {
  assert.ok(globSync("packages/assistant-tools/src/tools/*.ts").length > 0);
  assert.ok(globSync("packages/ai/src/runner.ts").length === 1);
  const webSources = globSync("apps/web/src/**/*.{ts,tsx}");
  // toolsetNames is a dependency-free constants module the API keys UI may import.
  const offenders = webSources.filter((file) =>
    /from ["']@weaver\/(ai|assistant-tools(?!\/toolsetNames["']))/.test(
      readFileSync(file, "utf8"),
    ),
  );
  assert.deepEqual(offenders, []);
  const aiSources = globSync("packages/ai/src/**/*.ts").filter(
    (file) => !file.endsWith(".test.ts"),
  );
  const mastra = aiSources.filter((file) =>
    /@mastra\//.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    mastra,
    [],
    "Mastra is deferred (plan 4D decision 1); add it deliberately, never incidentally",
  );
});

test("the MCP package and runtime respect the dependency direction", () => {
  const webSources = globSync("apps/web/src/**/*.{ts,tsx}");
  assert.deepEqual(
    webSources.filter((file) =>
      /from ["']@weaver\/mcp/.test(readFileSync(file, "utf8")),
    ),
    [],
    "the web app never imports the MCP package",
  );
  const mcpSources = globSync("packages/mcp/src/**/*.ts");
  assert.ok(mcpSources.length > 0);
  assert.deepEqual(
    mcpSources.filter((file) =>
      /from ["'](@weaver\/ai|next|react)/.test(readFileSync(file, "utf8")),
    ),
    [],
  );
  assert.deepEqual(
    files.filter((file) =>
      readFileSync(file, "utf8").includes("apps/mcp-server"),
    ),
    [],
    "no shared package imports the MCP application",
  );
  assert.equal(globSync("apps/mcp-server/src/index.ts").length, 1);
  assert.equal(
    globSync("apps/agent-worker/src/lifecycle.ts").length,
    0,
    "the lifecycle lives in @weaver/core/runtime",
  );
});

// Browser bundles reach shared code through client components and their lib
// helpers. A value import of a service module drags Node-only dependencies
// (git-store → simple-git → child_process) into the client graph, which Next
// only reports at build time.
const SERVER_ONLY_SPECIFIERS = [
  /^@weaver\/external-mcp/,
  // userSchemas is the browser-safe half of the users service contract
  // (zod schemas + a plain constant, no git-store/db/node imports) — same
  // exception shape as scopeSchema.ts below, verified the same way.
  /^@weaver\/core\/services\/(?!userSchemas$)/,
  /^@weaver\/core\/assistant\/scope$/,
  /^@weaver\/core\/dashboard\/(?!schema$)/,
  // scheduleSchema is the browser-safe half of the scheduled-tasks contract;
  // context.ts and tick.ts behind the same wildcard reach git-store and the db.
  /^@weaver\/core\/scheduledTasks\/(?!scheduleSchema$)/,
  /^@weaver\/core\/jobs\/(?!backgroundWorkSchema$)/,
  /^@weaver\/core\/security\/encryption$/,
  /^@weaver\/git-store/,
  /^@weaver\/db/,
  /^@weaver\/auth$/,
  /^server-only$/,
];

function valueImportSpecifiers(source) {
  const specifiers = [];
  const pattern =
    /^\s*(import|export)\s+(type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[2]) continue;
    specifiers.push(match[3]);
  }
  return specifiers;
}

test("browser-reachable web code only type-imports server modules", () => {
  const isServerFile = (file) =>
    file.startsWith("apps/web/src/server/") ||
    file === "apps/web/src/instrumentation.ts" ||
    /\/(page|layout|route|loading|error|not-found|template|default)\.tsx?$/.test(
      file,
    ) ||
    /\.test\.tsx?$/.test(file);
  const clientFiles = globSync("apps/web/src/**/*.{ts,tsx}").filter(
    (file) => !isServerFile(file),
  );
  assert.ok(clientFiles.length > 0);
  const offenders = clientFiles.flatMap((file) =>
    valueImportSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) =>
        SERVER_ONLY_SPECIFIERS.some((pattern) => pattern.test(specifier)),
      )
      .map((specifier) => `${file}: ${specifier}`),
  );
  assert.deepEqual(offenders, []);

  assert.deepEqual(
    valueImportSpecifiers(
      readFileSync("packages/core/src/jobs/backgroundWorkSchema.ts", "utf8"),
    ),
    ["zod"],
    "backgroundWorkSchema stays browser-safe and imports only zod",
  );

  const scopeSchema = readFileSync(
    "packages/core/src/assistant/scopeSchema.ts",
    "utf8",
  );
  assert.deepEqual(
    valueImportSpecifiers(scopeSchema).filter((specifier) =>
      /services|git-store|@weaver\/db|node:/.test(specifier),
    ),
    [],
    "scopeSchema.ts is the browser-safe half of the scope contract",
  );

  const userSchemas = readFileSync(
    "packages/core/src/services/userSchemas.ts",
    "utf8",
  );
  assert.deepEqual(
    valueImportSpecifiers(userSchemas).filter((specifier) =>
      /services|git-store|@weaver\/db|node:/.test(specifier),
    ),
    [],
    "userSchemas.ts is the browser-safe half of the users service contract",
  );

  const scheduleSchema = readFileSync(
    "packages/core/src/scheduledTasks/scheduleSchema.ts",
    "utf8",
  );
  assert.deepEqual(
    valueImportSpecifiers(scheduleSchema).filter((specifier) =>
      /services|git-store|@weaver\/db|node:/.test(specifier),
    ),
    [],
    "scheduleSchema.ts is the browser-safe half of the scheduled-tasks contract",
  );

  assert.deepEqual(
    valueImportSpecifiers(
      readFileSync("packages/core/src/dashboard/schema.ts", "utf8"),
    ),
    ["zod"],
    "dashboard/schema stays browser-safe and imports only zod values",
  );
});

test("the ingestion package keeps parser dependencies out of core and web", () => {
  assert.equal(globSync("packages/ingestion/src/parseStage.ts").length, 1);
  const webSources = globSync("apps/web/src/**/*.{ts,tsx}");
  assert.deepEqual(
    webSources.filter((file) =>
      /from ["']@weaver\/ingestion/.test(readFileSync(file, "utf8")),
    ),
    [],
    "the web app never imports the ingestion package",
  );
  const coreSources = globSync("packages/core/src/**/*.ts");
  assert.deepEqual(
    coreSources.filter((file) =>
      /from ["'](@weaver\/ingestion|@weaver\/ai|mammoth|exceljs|unpdf|pdfjs-dist|turndown|@napi-rs\/canvas)/.test(
        readFileSync(file, "utf8"),
      ),
    ),
    [],
    "core never depends on parsers or the AI SDK layer",
  );
  const ingestionSources = globSync("packages/ingestion/src/**/*.ts");
  assert.ok(ingestionSources.length > 0);
  assert.deepEqual(
    ingestionSources.filter((file) =>
      /from ["'](next|react|@weaver\/mcp|@weaver\/assistant-tools|@weaver\/git-store)/.test(
        readFileSync(file, "utf8"),
      ),
    ),
    [],
  );
});

test("outbound MCP isolates the SDK and synthetic fixture from browser/runtime consumers", () => {
  const manifest = JSON.parse(
    readFileSync("packages/external-mcp/package.json", "utf8"),
  );
  assert.equal(manifest.exports["."], "./src/index.ts");
  assert.equal(manifest.exports["./testing"], "./src/testing/server.ts");
  assert.equal(manifest.dependencies["@modelcontextprotocol/client"], "2.0.0");
  assert.equal(
    manifest.dependencies["@modelcontextprotocol/server"],
    undefined,
  );
  const runtime = globSync("packages/external-mcp/src/**/*.ts").filter(
    (file) => !file.endsWith(".test.ts") && !file.includes("/testing/"),
  );
  assert.ok(runtime.length > 0);
  assert.deepEqual(
    runtime.filter((file) =>
      /from ["'](?:.*testing|node:http|@modelcontextprotocol\/server|@weaver\/(?!config\/outboundFetch["\'])|next|react)/.test(
        readFileSync(file, "utf8"),
      ),
    ),
    [],
  );
});

function dynamicImportSpecifiers(source) {
  return [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => match[1],
  );
}

// The readers drag exceljs/unpdf/pdfjs-dist/@xmldom into whatever loads them.
// Only the forked child may do that; the parent side keeps the operation map.
test("the readers are reachable only from the reader child process", () => {
  const webSources = globSync("apps/web/src/**/*.{ts,tsx}");
  assert.deepEqual(
    webSources.filter((file) =>
      /@weaver\/artifact-readers|@weaver\/core\/artifacts\/reader(Process|Child)|@weaver\/core\/services\/artifactReads/.test(
        readFileSync(file, "utf8"),
      ),
    ),
    [],
    "the web app never imports the readers, the reader runner, or artifactReads (which imports the runner)",
  );
  const coreSources = globSync("packages/core/src/**/*.ts").filter(
    (file) => !file.endsWith(".test.ts"),
  );
  assert.ok(coreSources.length > 0);
  const readerImports = (file) => {
    const source = readFileSync(file, "utf8");
    return [
      ...valueImportSpecifiers(source),
      ...dynamicImportSpecifiers(source),
    ].filter((specifier) => /^@weaver\/artifact-readers(\/|$)/.test(specifier));
  };
  const toolSources = globSync("packages/assistant-tools/src/**/*.ts").filter(
    (file) => !file.endsWith(".test.ts"),
  );
  assert.deepEqual(
    toolSources.filter((file) => readerImports(file).length > 0),
    [],
    "shared assistant/MCP tools never import pure readers at runtime",
  );
  // The archive guard is zlib and buffer arithmetic only, so it may run in
  // process; every parser stays in the child.
  const archiveOnly = (specifier) =>
    specifier === "@weaver/artifact-readers/archive";
  assert.deepEqual(
    coreSources.filter((file) =>
      readerImports(file).some((specifier) => !archiveOnly(specifier)),
    ),
    ["packages/core/src/artifacts/readerChild.ts"],
    "only the forked child loads a parsing reader at runtime; everywhere else is type-only",
  );
  assert.deepEqual(
    coreSources.filter((file) => readerImports(file).some(archiveOnly)),
    ["packages/core/src/artifacts/wordImages.ts"],
    "the archive guard is imported in process only by the Word image lookup",
  );
  assert.deepEqual(
    coreSources.filter(
      (file) =>
        file !== "packages/core/src/services/artifactReads.ts" &&
        /(?:from|import\()\s*["'](?:[.\w/-]*\/)?artifactReads["']|@weaver\/core\/services\/artifactReads/.test(
          readFileSync(file, "utf8"),
        ),
    ),
    [],
    "services/artifactReads.ts (which imports the runner) is reachable only from itself — in particular not services/artifacts.ts, which the web app bundles",
  );
});

test("artifact readers stay pure: no Weaver, web-alias, transport-node, or framework imports", () => {
  const runtime = globSync("packages/artifact-readers/src/**/*.ts").filter(
    (file) => !file.endsWith(".test.ts"),
  );
  assert.ok(runtime.length > 0);
  assert.deepEqual(
    runtime.filter((file) =>
      /from ["'](?:@weaver\/|~\/|node:(?:fs|child_process|net|http|https|dgram|tls|worker_threads)|next|react)/.test(
        readFileSync(file, "utf8"),
      ),
    ),
    [],
  );
});

// The archive guard runs inside the web server on uploaded files.
test("the archive guard itself imports only zlib and the error class", () => {
  const specifiers = (file) => {
    const source = readFileSync(file, "utf8");
    return [
      ...valueImportSpecifiers(source),
      ...dynamicImportSpecifiers(source),
    ];
  };
  assert.deepEqual(specifiers("packages/artifact-readers/src/archive.ts"), [
    "node:zlib",
    "./errors",
  ]);
  assert.deepEqual(specifiers("packages/artifact-readers/src/errors.ts"), []);
});

// jszip (docxFixture) is only a devDependency of @weaver/artifact-readers, so
// runtime code that pulled in a testing fixture would drag a missing
// production dependency along with it.
// pdfReadersInteropFixture.ts is the one pre-existing, legitimate exception:
// test support shared between two sibling *.test.ts files (see the
// weaver-artifacts skill), not itself a *.test.ts file or under testing/.
const ARTIFACT_READERS_TESTING_ALLOWLIST = [
  "packages/ingestion/src/native/pdfReadersInteropFixture.ts",
];
test("only test files import the artifact-readers testing fixtures", () => {
  const candidates = [...files, ...globSync("apps/*/src/**/*.{ts,tsx}")];
  const offenders = candidates.filter((file) => {
    if (/\.test\.tsx?$/.test(file)) return false;
    if (file.includes("/testing/")) return false;
    if (ARTIFACT_READERS_TESTING_ALLOWLIST.includes(file)) return false;
    return /@weaver\/artifact-readers\/testing\//.test(
      readFileSync(file, "utf8"),
    );
  });
  assert.deepEqual(offenders, []);
});

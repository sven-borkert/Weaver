/**
 * SKIP_ENV_VALIDATION is honored only during a production build. This is useful
 * for Docker builds.
 */
import type { NextConfig } from "next";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./src/env.ts";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

const require = createRequire(import.meta.url);

const { version } = require("../../package.json") as {
  version: string;
};

// pnpm links packages, and an include only helps at the real path the server loads from.
const playwrightCoreDir = path.relative(
  appDir,
  path.dirname(require.resolve("playwright-core/package.json")),
);

const buildTime =
  firstNonEmpty(
    process.env.APP_BUILD_TIME,
    process.env.NEXT_PUBLIC_BUILD_TIME,
  ) ?? new Date().toISOString();

const commitSha =
  firstNonEmpty(
    process.env.APP_COMMIT_SHA,
    process.env.NEXT_PUBLIC_COMMIT_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.GIT_COMMIT_SHA,
  ) ?? "";

/**
 * @param {...(string | undefined)} values
 * @returns {string | undefined}
 */
function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

const config: NextConfig = {
  // Only the Docker image consumes .next/standalone; `next start` (pnpm start,
  // the Playwright web server) warns and ignores it, so keep it opt-in.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: {
    "/*": [
      // The PDF route reads the Mermaid bundle from the app's node_modules at runtime.
      "./node_modules/mermaid/dist/mermaid.min.js",
      // The same route inlines the KaTeX stylesheet and fonts into printed formulas.
      "./node_modules/katex/dist/katex.min.css",
      "./node_modules/katex/dist/fonts/*.woff2",
      // playwright-core requires browsers.json when it loads; the tracer misses it.
      `${playwrightCoreDir}/browsers.json`,
    ],
  },
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  env: {
    // getClientBuildInfo() adds the "v" prefix; keep the raw package version here.
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_BUILD_TIME: buildTime,
    NEXT_PUBLIC_COMMIT_SHA: commitSha,
  },
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
  async headers() {
    const headers = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()",
      },
    ];
    return [{ source: "/:path*", headers }];
  },
};

export default config;

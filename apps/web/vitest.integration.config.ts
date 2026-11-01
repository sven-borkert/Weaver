import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    env: { NODE_ENV: "test", WEAVER_INGESTION_MAX_FILE_BYTES: "1024" },
    include: ["tests/integration/**/*.spec.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    setupFiles: ["tests/integration/_setup.ts"],
    globals: false,
    testTimeout: 30_000,
    pool: "forks",
    // Vitest 4 removed test.poolOptions; singleFork is now the top-level
    // pair maxWorkers: 1 + isolate: false. Keeps every spec file serial
    // in one fork, since resetDb() TRUNCATEs the single shared test DB.
    maxWorkers: 1,
    isolate: false,
  },
});

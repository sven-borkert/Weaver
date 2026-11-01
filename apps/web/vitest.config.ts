import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["tests/integration/**", "tests/e2e/**", "node_modules/**"],
    globals: false,
  },
});

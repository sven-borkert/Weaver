import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "pnpm --filter @weaver/core exec tsx scripts/seed.ts",
  },
  datasource: { url: env("DATABASE_URL") },
});

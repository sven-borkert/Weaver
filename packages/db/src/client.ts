import { parseServerEnv } from "@weaver/config/server";
import type { PrismaClient } from "../generated/prisma/client";
import { createPrismaClient } from "./factory";

const env = parseServerEnv(process.env);
const globalForPrisma = globalThis as typeof globalThis & {
  weaverDb?: PrismaClient;
};

export const db =
  globalForPrisma.weaverDb ??
  createPrismaClient({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    log: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (env.NODE_ENV !== "production") globalForPrisma.weaverDb = db;

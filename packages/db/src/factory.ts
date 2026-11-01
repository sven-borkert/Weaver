import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export type PrismaClientOptions = {
  connectionString: string;
  max: number;
  statementTimeoutMs: number;
  log: Array<"error" | "warn">;
};

export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: options.connectionString,
      max: options.max,
      options: "-c timezone=UTC",
      statement_timeout: options.statementTimeoutMs,
    }),
    log: options.log,
  });
}

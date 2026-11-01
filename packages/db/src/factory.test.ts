import { describe, expect, it } from "vitest";
import { createPrismaClient } from "./factory";

describe("database package", () => {
  it("constructs a Prisma client from explicit pool settings", () => {
    const client = createPrismaClient({
      connectionString: "postgresql://weaver:test@127.0.0.1:5432/weaver_test",
      max: 3,
      statementTimeoutMs: 2_000,
      log: ["error"],
    });
    expect(client).toBeDefined();
    return client.$disconnect();
  });
});

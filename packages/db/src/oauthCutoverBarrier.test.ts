import { describe, expect, it, vi } from "vitest";
import {
  acquireOAuthCutoverBarrier,
  inspectOAuthCutoverState,
  waitForOAuthCutoverMigrator,
  type MigrationSqlClient,
} from "./oauthCutoverBarrier";

function fakeClient(
  resolve: (sql: string, values: readonly unknown[]) => { rows: unknown[] },
): { client: MigrationSqlClient; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    client: {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push(sql.trim());
        return resolve(sql, values);
      }),
    },
  };
}

describe("OAuth generation cutover migration barrier", () => {
  it("recognizes an existing consent table with an unapplied cutover", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("to_regclass")) {
        return { rows: [{ consentOid: 42, migrationsOid: 43 }] };
      }
      return { rows: [{ applied: false }] };
    });

    await expect(inspectOAuthCutoverState(client)).resolves.toEqual({
      needsBarrier: true,
      consentRelationOid: 42,
    });
  });

  it("skips the barrier when the consent relation does not exist yet", async () => {
    const { client } = fakeClient(() => ({
      rows: [{ consentOid: null, migrationsOid: null }],
    }));

    await expect(inspectOAuthCutoverState(client)).resolves.toEqual({
      needsBarrier: false,
      consentRelationOid: null,
    });
  });

  it("takes the writer-conflicting consent relation lock first", async () => {
    const { client, queries } = fakeClient((sql) => ({
      rows: sql.includes("pg_stat_activity") ? [{ otherClients: 0n }] : [],
    }));

    await acquireOAuthCutoverBarrier(client, 42);

    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toBe('LOCK TABLE "OauthConsent" IN EXCLUSIVE MODE');
    expect(queries[2]).toContain("pg_stat_activity");
  });

  it("rolls back and refuses cutover while another client is connected", async () => {
    const { client, queries } = fakeClient((sql) => ({
      rows: sql.includes("pg_stat_activity") ? [{ otherClients: 1n }] : [],
    }));

    await expect(acquireOAuthCutoverBarrier(client, 42)).rejects.toThrow(
      "Stop all Weaver runtime processes",
    );
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("waits for the named Prisma process to queue on the consent relation", async () => {
    let checks = 0;
    const { client } = fakeClient((_sql, values) => {
      expect(values).toEqual([42, "cutover-migrator"]);
      checks += 1;
      return { rows: [{ waiting: checks === 2 }] };
    });

    await expect(
      waitForOAuthCutoverMigrator(client, 42, "cutover-migrator", {
        hasExited: () => false,
        pollMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("waiting");
    expect(checks).toBe(2);
  });
});

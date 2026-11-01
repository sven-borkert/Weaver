import { describe, expect, it } from "vitest";

import { invalidateTableCaches } from "./table-cache-invalidation";

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";
const TABLE_ID = "11111111-1111-4111-8111-111111111111";

type CacheInput = { projectId: string; tableId?: string };

function cacheUtils(calls: string[]) {
  const record = (name: string, input?: CacheInput) => {
    calls.push(
      `${name}:${input?.projectId ?? "all"}:${input?.tableId ?? "all"}`,
    );
    return Promise.resolve();
  };

  return {
    table: {
      list: { invalidate: (input: CacheInput) => record("list", input) },
      get: { invalidate: (input?: CacheInput) => record("get", input) },
      history: {
        invalidate: (input?: CacheInput) => record("history", input),
      },
      diff: { invalidate: (input?: CacheInput) => record("diff", input) },
      backlinks: {
        invalidate: (input?: CacheInput) => record("backlinks", input),
      },
    },
    tableFolder: {
      tree: { invalidate: (input: CacheInput) => record("tree", input) },
    },
    document: {
      resolveRefs: {
        invalidate: (input?: CacheInput) => record("resolveRefs", input),
      },
    },
  };
}

describe("invalidateTableCaches", () => {
  it("invalidates every table projection broadly when no table is supplied", async () => {
    const calls: string[] = [];

    await invalidateTableCaches(cacheUtils(calls), PROJECT_ID);

    expect(calls.sort()).toEqual(
      [
        `list:${PROJECT_ID}:all`,
        `tree:${PROJECT_ID}:all`,
        "get:all:all",
        "history:all:all",
        "diff:all:all",
        "backlinks:all:all",
        "resolveRefs:all:all",
      ].sort(),
    );
  });

  it("scopes identity readers to a table while keeping diff invalidation broad", async () => {
    const calls: string[] = [];

    await invalidateTableCaches(cacheUtils(calls), PROJECT_ID, TABLE_ID);

    expect(calls.sort()).toEqual(
      [
        `list:${PROJECT_ID}:all`,
        `tree:${PROJECT_ID}:all`,
        `get:${PROJECT_ID}:${TABLE_ID}`,
        `history:${PROJECT_ID}:${TABLE_ID}`,
        "diff:all:all",
        `backlinks:${PROJECT_ID}:${TABLE_ID}`,
        "resolveRefs:all:all",
      ].sort(),
    );
  });
});

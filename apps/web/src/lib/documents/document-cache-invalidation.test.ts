import { describe, expect, it } from "vitest";

import {
  invalidateDocumentCachesAfterRebuild,
  invalidateDocumentReferenceCaches,
} from "./document-cache-invalidation";

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";

function cacheUtils(invalidated: string[]) {
  const record = (name: string, input?: { projectId: string }) => {
    invalidated.push(`${name}:${input?.projectId ?? "all"}`);
    return Promise.resolve();
  };

  return {
    document: {
      list: {
        invalidate: (input: { projectId: string }) => record("list", input),
      },
      get: { invalidate: () => record("get") },
      history: { invalidate: () => record("history") },
      backlinks: { invalidate: () => record("backlinks") },
      resolveRefs: { invalidate: () => record("resolveRefs") },
    },
    folder: {
      tree: {
        invalidate: (input: { projectId: string }) => record("tree", input),
      },
    },
    table: {
      list: {
        invalidate: (input: { projectId: string }) =>
          record("table.list", input),
      },
      get: { invalidate: () => record("table.get") },
      backlinks: { invalidate: () => record("table.backlinks") },
    },
  };
}

describe("invalidateDocumentCachesAfterRebuild", () => {
  it("refreshes every projection-backed reader cache including references", async () => {
    const invalidated: string[] = [];
    await invalidateDocumentCachesAfterRebuild(
      cacheUtils(invalidated),
      PROJECT_ID,
    );

    expect(invalidated.sort()).toEqual(
      [
        `list:${PROJECT_ID}`,
        `tree:${PROJECT_ID}`,
        "get:all",
        "history:all",
        "backlinks:all",
        "resolveRefs:all",
        "table.get:all",
        "table.backlinks:all",
        `table.list:${PROJECT_ID}`,
      ].sort(),
    );
  });

  it("refreshes table backlink and identity consumers after document changes", async () => {
    const invalidated: string[] = [];

    await invalidateDocumentReferenceCaches(
      cacheUtils(invalidated),
      PROJECT_ID,
    );

    expect(invalidated.sort()).toEqual(
      [
        "resolveRefs:all",
        "table.get:all",
        "table.backlinks:all",
        `table.list:${PROJECT_ID}`,
      ].sort(),
    );
  });
});

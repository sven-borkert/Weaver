import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { captureError } from "../diagnostics/writer";
vi.mock("../diagnostics/writer", () => ({ captureError: vi.fn() }));
vi.mock("./projectMetadata", () => ({
  PROJECT_METADATA_PATH: "project.json",
  composeProjectMetadataFor: vi.fn(async () => "{}\n"),
}));
import { describe, expect, it, vi } from "vitest";
import {
  hasCaseCollidingPaths,
  mergeFetchedBranch,
} from "./projectGitRemoteMerge";

describe("portable pull tree paths", () => {
  it("rejects aliases in filenames and parent directories", () => {
    expect(hasCaseCollidingPaths(["Foo.md", "foo.md"])).toBe(true);
    expect(hasCaseCollidingPaths(["Docs/a.md", "docs/b.md"])).toBe(true);
    expect(hasCaseCollidingPaths(["café.md", "cafe\u0301.md"])).toBe(true);
    expect(
      hasCaseCollidingPaths(["same.md", "same.md", "docs/a.md", "docs/b.md"]),
    ).toBe(false);
  });
});

it("reports transient-ref cleanup failure without replacing the accepted pull", async () => {
  const head = "a".repeat(40);
  const cleanup = new Error("ref cleanup failed");
  const repo = {
    resolveHead: vi.fn(async () => head),
    fetchLocalRef: vi.fn(async () => head),
    listTreeEntries: vi.fn(async () => []),
    listTrackedFiles: vi.fn(async () => []),
    isAncestor: vi.fn(async () => true),
    fileExistsInWorktree: vi.fn(async () => true),
    readFileFromWorktree: vi.fn(async () => "{}\n"),
    deleteRef: vi.fn(async () => {
      throw cleanup;
    }),
  } as unknown as ProjectRepoWriter;
  const result = await mergeFetchedBranch({} as PrismaClient, repo, {
    projectId: "project",
    bareDirectory: "/unused",
    branch: "main",
    remoteHead: head,
    author: { name: "Author", email: "author@test", userId: "author" },
  });
  expect(result.mergedSha).toBe(head);
  expect(captureError).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "git.remote.pull_cleanup_failed",
      projectId: "project",
      error: cleanup,
    }),
  );
});

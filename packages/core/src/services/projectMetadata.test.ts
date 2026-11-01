import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { syncProjectMetadata } from "./projectMetadata";

const repository = vi.hoisted(() => ({ file: "" }));
vi.mock("./projectRepo", () => ({
  withProjectRepo: async (
    _id: string,
    callback: (repo: unknown) => Promise<unknown>,
  ) =>
    callback({
      fileExistsInWorktree: async () => Boolean(repository.file),
      readFileFromWorktree: async () => repository.file,
      writeFileAtomic: async (_path: string, file: string) => {
        repository.file = file;
      },
      commitAll: async () => "commit",
    }),
}));

describe("syncProjectMetadata", () => {
  it("reads live metadata after an older sync waits for actor lookup", async () => {
    let release!: () => void;
    let paused!: () => void;
    const actorLookup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pauseObserved = new Promise<void>((resolve) => {
      paused = resolve;
    });
    let name = "Old name";
    let first = true;
    const db = {
      project: {
        findFirst: async () => ({
          id: "project",
          name,
          description: null,
          createdAt: new Date(0),
          defaultReviewEveryMonths: 12,
          organization: { members: [] },
        }),
      },
      reviewerGroup: { findMany: async () => [] },
      projectTrainingRole: { findMany: async () => [] },
      projectDefaultReviewer: { findMany: async () => [] },
      user: {
        findUnique: async () => {
          if (first) {
            first = false;
            paused();
            await actorLookup;
          }
          return { name: "Actor", email: "actor@example.test" };
        },
      },
    } as unknown as PrismaClient;
    const actor = { userId: "actor" } as Parameters<
      typeof syncProjectMetadata
    >[2];
    const older = syncProjectMetadata(db, "project", actor);
    await pauseObserved;
    name = "New name";
    await syncProjectMetadata(db, "project", actor);
    release();
    await older;
    expect(JSON.parse(repository.file)).toMatchObject({ name: "New name" });
  });
});

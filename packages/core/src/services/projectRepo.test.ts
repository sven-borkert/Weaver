import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoLockTimeoutError } from "@weaver/git-store/advisory-lock";

const gitStoreDoubles = vi.hoisted(() => ({
  withProjectRepo: vi.fn(),
  withExistingProjectRepo: vi.fn(),
  withExistingProjectRepoReader: vi.fn(),
}));

vi.mock("@weaver/git-store", () => gitStoreDoubles);

import {
  withExistingProjectRepo,
  withExistingProjectRepoReader,
  withProjectRepo,
} from "./projectRepo";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("core project repository boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["creating", withProjectRepo, gitStoreDoubles.withProjectRepo],
    [
      "opening",
      withExistingProjectRepo,
      gitStoreDoubles.withExistingProjectRepo,
    ],
    [
      "reading under a lock",
      withExistingProjectRepoReader,
      gitStoreDoubles.withExistingProjectRepoReader,
    ],
  ])("maps only a lock timeout while %s a writer", async (_name, call, raw) => {
    raw.mockRejectedValueOnce(new RepoLockTimeoutError(PROJECT_ID));

    await expect(call(PROJECT_ID, async () => undefined)).rejects.toMatchObject(
      {
        name: "CoreError",
        code: "CONFLICT",
        message: "project repository is busy",
        details: { retryable: true, reason: "BUSY" },
      },
    );
  });

  it("preserves unrelated repository errors", async () => {
    const databaseError = new Error("database connection failed");
    gitStoreDoubles.withProjectRepo.mockRejectedValueOnce(databaseError);

    await expect(
      withProjectRepo(PROJECT_ID, async () => undefined),
    ).rejects.toBe(databaseError);
  });
});

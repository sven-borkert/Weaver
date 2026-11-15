import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { composeDocumentFile } from "../documents/frontmatter";
import { deleteDocumentInRepo, type EnrichedActor } from "./documents";

const REQUESTED = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(40);

describe("document deletion Git identity", () => {
  it.each([
    {
      content: composeDocumentFile(
        {
          id: REPLACEMENT,
          title: "Replacement",
          created: "2026-11-14T00:00:00.000Z",
          updated: "2026-11-14T00:00:00.000Z",
          createdBy: null,
          updatedBy: null,
          review: null,
        },
        "replacement body",
        "markdown",
      ),
      code: "CONFLICT",
    },
    { content: "malformed document", code: "PRECONDITION_FAILED" },
    { content: null, code: "NOT_FOUND" },
  ])(
    "leaves files and assets intact when committed content requires $code",
    async ({ content, code }) => {
      const files = new Set([
        "guide.md",
        "guide.assets/image.png",
        "guide-2.md",
      ]);
      const db = {
        document: {
          findFirst: async () => ({
            id: REQUESTED,
            projectId: PROJECT,
            path: "guide.md",
          }),
        },
      } as unknown as PrismaClient;
      const repo = {
        resolveHead: async () => SHA,
        readCommittedFileAt: async () =>
          content === null ? null : { content, baseCommitSha: SHA },
        fileExistsInWorktree: async () => true,
        rmDir: async () => {
          files.delete("guide.assets/image.png");
        },
        rm: async (path: string) => {
          files.delete(path);
          throw new Error("deleted content before checking identity");
        },
      } as unknown as ProjectRepoWriter;
      await expect(
        deleteDocumentInRepo(
          db,
          repo,
          {
            projectId: PROJECT,
            documentId: REQUESTED,
          },
          {} as EnrichedActor,
        ),
      ).rejects.toMatchObject({ code });
      expect([...files]).toEqual([
        "guide.md",
        "guide.assets/image.png",
        "guide-2.md",
      ]);
    },
  );
});

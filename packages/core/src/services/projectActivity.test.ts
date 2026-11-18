import type { PrismaClient } from "@weaver/db/client";
import {
  openProjectRepo,
  type GitChangeEntry,
  type ProjectRepoReader,
} from "@weaver/git-store";
import { expect, it, vi } from "vitest";
import { composeDocumentFile } from "../documents/frontmatter";
import { createTaskSecurityContext } from "../security/context";
import { serializeSchemaFile } from "../tables/jsonl";
import { projectChangesSince } from "./projectActivity";

vi.mock("@weaver/git-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openProjectRepo: vi.fn(),
}));
vi.mock("./projectAccess", () => ({ assertProjectRole: vi.fn() }));

const selectedId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const date = new Date("2026-11-18T10:00:00Z");

it.each(["document", "table"] as const)(
  "verifies a selected %s against its historical Git identity",
  async (kind) => {
    const selectedTitle = "Reviewed resource";
    const otherTitle = "Different resource";
    const fileFor = (id: string, title: string) =>
      kind === "document"
        ? composeDocumentFile(
            {
              id,
              title,
              created: date.toISOString(),
              updated: date.toISOString(),
              createdBy: null,
              updatedBy: null,
              review: null,
            },
            "Body",
            "markdown",
          )
        : serializeSchemaFile({
            id,
            title,
            created: date.toISOString(),
            updated: date.toISOString(),
            sourceOfTruth: "git",
            columns: [],
          });
    const selectedPath =
      kind === "document" ? "current.md" : "tables/current.table";
    const historicalPath =
      kind === "document" ? "historical.md" : "tables/historical.table";
    const pathFor = (path: string) =>
      kind === "document" ? path : `${path}/schema.json`;
    const commit = (
      sha: string,
      path: string,
      message: string,
    ): GitChangeEntry => ({
      sha,
      date,
      message,
      authorEmail: "editor@example.test",
      authorName: "Editor",
      userId: null,
      operationId: null,
      runId: null,
      changes: [{ status: "M", path: pathFor(path), oldPath: null }],
    });
    const git = {
      resolveHead: async () => "head",
      firstParentTrustedBefore: async () => null,
      listCommitShas: async () => ["reused", "earlier"],
      logChangesForShas: async () => [
        commit("reused", selectedPath, otherTitle),
        commit("earlier", historicalPath, selectedTitle),
      ],
      readBlobsAt: vi.fn(
        async (sha: string) =>
          new Map(
            sha === "reused"
              ? [[pathFor(selectedPath), fileFor(otherId, otherTitle)]]
              : [[pathFor(historicalPath), fileFor(selectedId, selectedTitle)]],
          ),
      ),
    };
    vi.mocked(openProjectRepo).mockResolvedValue(
      git as unknown as ProjectRepoReader,
    );
    const projected = {
      id: selectedId,
      title: selectedTitle,
      path: selectedPath,
    };
    const db = {
      document: {
        findMany: async () => (kind === "document" ? [projected] : []),
      },
      dataTable: {
        findMany: async () => (kind === "table" ? [projected] : []),
      },
      documentChangeSummary: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const actor = createTaskSecurityContext({
      userId: "editor",
      globalRole: "User",
      runId: "run",
    });
    const input = {
      projectId: "project",
      sinceDate: date,
      fromSha: null,
      limit: 10,
      historicalResource: { kind, id: selectedId },
    };

    const result = await projectChangesSince(db, actor, input);
    expect(result.commits.map((entry) => entry.sha)).toEqual(["earlier"]);
    expect(
      result.commits[0]?.[kind === "document" ? "documents" : "tables"],
    ).toEqual([
      {
        id: selectedId,
        path: historicalPath,
        title: selectedTitle,
        status: "M",
      },
    ]);
  },
);

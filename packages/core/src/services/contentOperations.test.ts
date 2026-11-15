import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "../errors";
import type { PrismaClient } from "@weaver/db/client";
import type { GitLogEntry, ProjectRepoWriter } from "@weaver/git-store";
import { composeDocumentFile } from "../documents/frontmatter";
import type { EnrichedActor } from "./documents";
import {
  assertLifecycleShape,
  contentOperationSchema,
  type ContentOperation,
  matchesRecoveryIdentity,
  recoverPriorOperation,
  applyOperationInRepo,
} from "./contentOperations";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(40);

describe("deleted-document asset budgets", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { budget: "count", count: 101, size: 1_024 },
    { budget: "aggregate", count: 2, size: 33 * 1024 ** 2 },
    { budget: "per-image", count: 1, size: 51 * 1024 ** 2 },
  ])(
    "rejects the $budget limit before buffering historical assets",
    async ({ count, size }) => {
      vi.stubEnv("DATABASE_URL", "postgresql://localhost/weaver_test");
      vi.stubEnv("AUTH_SECRET", "test-only-asset-budget-secret-value");
      vi.stubEnv("WEAVER_DATA_DIR", "./data-test");
      vi.stubEnv("WEAVER_DOCUMENT_IMAGE_MAX_BYTES", String(50 * 1024 ** 2));
      const sourceSha = "b".repeat(40);
      const files = Array.from(
        { length: count },
        (_, index) => `gone.assets/${index}.png`,
      );
      const stored = composeDocumentFile(
        {
          id: RESOURCE,
          title: "Gone",
          created: "2026-11-14T00:00:00.000Z",
          updated: "2026-11-14T00:00:00.000Z",
          createdBy: null,
          updatedBy: null,
          review: {
            reviewers: [],
            everyMonths: 12,
            since: "2026-11-14T00:00:00.000Z",
            lastReviewed: null,
            reviewedBy: null,
          },
        },
        "body\n",
        "markdown",
      );
      const db = {
        document: { findFirst: async () => null, findUnique: async () => null },
        dataTable: { findFirst: async () => null },
      } as unknown as PrismaClient;
      let buffered = 0;
      const repo = {
        resolveHead: async () => SHA,
        listTrackedFiles: async (sha: string) =>
          sha === sourceSha ? files : [],
        logChangesBefore: async () => [
          { sha: SHA, changes: [{ status: "D", path: "gone.md" }] },
        ],
        showFileAt: async () => stored,
        blobSizeAt: async () => size,
        readCommittedBlobAt: async () => {
          buffered++;
          throw new Error("buffered an over-budget historical asset");
        },
      } as unknown as ProjectRepoWriter;
      await expect(
        applyOperationInRepo(
          db,
          repo,
          {
            kind: "content.restore",
            projectId: PROJECT,
            resourceType: "document",
            resourceId: RESOURCE,
            mode: "deleted",
            sourceSha,
            deletedAtSha: SHA,
          },
          {} as EnrichedActor,
          { table: null, summary: "Recover", operationId: "asset-budget" },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(buffered).toBe(0);
    },
  );
});

describe("MCP recovery trust", () => {
  const identity = {
    requestHash: "b".repeat(64),
    toolName: "apply_content_lifecycle",
  };
  const entry: GitLogEntry = {
    sha: SHA,
    pathAtSha: ".",
    authorName: "Imported author",
    authorEmail: "imported@example.test",
    userId: null,
    operationId: "mcp:operation",
    mcpRequestHash: identity.requestHash,
    mcpToolName: identity.toolName,
    runId: null,
    date: new Date("2026-11-14T00:00:00Z"),
    message: "imported matching trailers",
  };

  it.each([false, undefined])(
    "rejects matching trailers without local trust (%s)",
    (trustedAuthor) => {
      expect(
        matchesRecoveryIdentity({ ...entry, trustedAuthor }, identity),
      ).toBe(false);
    },
  );

  it("accepts a locally trusted commit only for the matching request and tool", () => {
    const trusted = { ...entry, trustedAuthor: true };
    expect(matchesRecoveryIdentity(trusted, identity)).toBe(true);
    expect(
      matchesRecoveryIdentity(trusted, {
        ...identity,
        requestHash: "c".repeat(64),
      }),
    ).toBe(false);
    expect(
      matchesRecoveryIdentity(trusted, { ...identity, toolName: "other" }),
    ).toBe(false);
  });

  it("cannot recover a fabricated folder success from imported history", async () => {
    const repo = {
      logForPath: async () => [{ ...entry, trustedAuthor: false }],
    } as unknown as ProjectRepoWriter;
    await expect(
      recoverPriorOperation(
        {} as PrismaClient,
        repo,
        lifecycle({
          action: "folder_create",
          parentPath: [],
          name: "Never created",
          baseProjectCommitSha: SHA,
        }),
        entry.operationId!,
        identity,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

const lifecycle = (
  extra: Partial<Extract<ContentOperation, { kind: "content.lifecycle" }>>,
): ContentOperation =>
  ({
    kind: "content.lifecycle",
    projectId: PROJECT,
    resourceType: "document",
    ...extra,
  }) as ContentOperation;

describe("content.lifecycle schema", () => {
  it("sits at index 8 in the union, so persisted operations keep parsing", () => {
    const kinds = contentOperationSchema.options.map(
      (option) => option.shape.kind.value,
    );
    // Pinned by index, not by being last: later slices append after it, and no
    // existing variant may shift (a persisted proposal is parsed by position in
    // the union's discriminator).
    expect(kinds.indexOf("content.lifecycle")).toBe(8);
    expect(kinds.slice(0, 8)).toEqual([
      "document.create",
      "document.edit",
      "document.patch",
      "table.create",
      "table.schema",
      "table.rows",
      "table.change",
      "content.restore",
    ]);
  });

  it("rejects a root path, so a root can never be renamed, moved or deleted", () => {
    const parsed = contentOperationSchema.safeParse(
      lifecycle({
        action: "folder_delete",
        baseProjectCommitSha: SHA,
        path: [],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts an empty parentPath, so a top-level folder can be created", () => {
    expect(
      contentOperationSchema.safeParse(
        lifecycle({
          action: "folder_create",
          baseProjectCommitSha: SHA,
          parentPath: [],
          name: "Archive",
        }),
      ).success,
    ).toBe(true);
  });
});

describe("assertLifecycleShape", () => {
  it("passes every action given exactly its own fields", () => {
    const valid: ContentOperation[] = [
      lifecycle({
        action: "folder_create",
        baseProjectCommitSha: SHA,
        parentPath: [],
        name: "Archive",
      }),
      lifecycle({
        action: "folder_rename",
        baseProjectCommitSha: SHA,
        path: ["archive"],
        name: "Old",
      }),
      lifecycle({
        action: "folder_move",
        baseProjectCommitSha: SHA,
        path: ["archive"],
        newParentPath: ["store"],
      }),
      lifecycle({
        action: "folder_delete",
        baseProjectCommitSha: SHA,
        path: ["archive"],
      }),
      lifecycle({
        action: "item_move",
        resourceId: RESOURCE,
        expectedHeadCommitSha: SHA,
        folderPath: ["archive"],
      }),
      lifecycle({
        action: "item_delete",
        resourceId: RESOURCE,
        expectedHeadCommitSha: SHA,
      }),
    ];
    for (const operation of valid)
      expect(() => assertLifecycleShape(operation)).not.toThrow();
  });

  it("names the missing field when an action's guard is absent", () => {
    expect(() =>
      assertLifecycleShape(
        lifecycle({ action: "item_delete", resourceId: RESOURCE }),
      ),
    ).toThrow(/expectedHeadCommitSha/);
    expect(() =>
      assertLifecycleShape(
        lifecycle({ action: "folder_delete", path: ["archive"] }),
      ),
    ).toThrow(/baseProjectCommitSha/);
  });

  it("names a field that does not belong to the action", () => {
    let thrown: unknown;
    try {
      assertLifecycleShape(
        lifecycle({
          action: "folder_delete",
          baseProjectCommitSha: SHA,
          path: ["archive"],
          name: "stray",
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreError);
    expect((thrown as CoreError).code).toBe("BAD_REQUEST");
    expect((thrown as CoreError).details).toMatchObject({ field: "name" });
    expect((thrown as CoreError).message).toMatch(/does not accept name/);
  });

  it("rejects an item guard on a folder action and vice versa", () => {
    expect(() =>
      assertLifecycleShape(
        lifecycle({
          action: "folder_delete",
          baseProjectCommitSha: SHA,
          path: ["archive"],
          expectedHeadCommitSha: SHA,
        }),
      ),
    ).toThrow(/does not accept expectedHeadCommitSha/);
    expect(() =>
      assertLifecycleShape(
        lifecycle({
          action: "item_delete",
          resourceId: RESOURCE,
          expectedHeadCommitSha: SHA,
          baseProjectCommitSha: SHA,
        }),
      ),
    ).toThrow(/does not accept baseProjectCommitSha/);
  });

  it("ignores operations of every other kind", () => {
    expect(() =>
      assertLifecycleShape({
        kind: "document.create",
        projectId: PROJECT,
        folderPath: [],
        title: "T",
        markdown: "x",
      }),
    ).not.toThrow();
  });
});

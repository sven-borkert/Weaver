import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { expect, it, vi } from "vitest";
import { composeDocumentFile } from "../documents/frontmatter";
import { MAX_IMPORT_IMAGE_BYTES } from "../documents/limits";
import { parseDocumentBody } from "../editor/markdown";
import { CoreError } from "../errors";
import { createSessionSecurityContext } from "../security/context";
import { serializeRows, serializeSchemaFile } from "../tables/jsonl";
import {
  applyOperationInRepo,
  createdResourceId,
  matchesLegacyIngestionCreate,
} from "./contentOperations";
import { resolveImageReferences } from "./documentImageImports";
import { acceptDraft } from "./ingestionAccept";
import type { EnrichedActor } from "./documents";
import { withProjectRepo } from "./projectRepo";

vi.mock("./projectRepo", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withProjectRepo: vi.fn(),
}));
vi.mock("./ingestion", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadIngestionFile: async (db: { ingestionFile: { read: () => unknown } }) =>
    db.ingestionFile.read(),
  toFileDetail: (file: unknown) => file,
}));
vi.mock("./contentOperations", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyOperationInRepo: vi.fn(),
}));
vi.mock("./projectGitRemoteJobs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyProjectContentChanged: vi.fn(),
}));
vi.mock("./tables", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTableInRepo: vi.fn(async () => {
    throw new CoreError("NOT_FOUND");
  }),
}));
vi.mock("./documentImageImports", () => ({ resolveImageReferences: vi.fn() }));

const fileId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const actor: EnrichedActor = {
  ...createSessionSecurityContext({
    userId: "user",
    globalRole: "User",
    sessionId: "session",
  }),
  name: "Editor",
  email: "editor@example.test",
};
const operationId = `ingestion:${fileId}`;
const resourceId = createdResourceId(operationId);
const commitSha = "a".repeat(40);
const path = "tables/reviewed.table";

function importFixture() {
  const file = {
    id: fileId,
    projectId,
    status: "ready",
    contentDigest: "b".repeat(64),
    draft: {
      targetKind: "table",
      proposedTitle: "Reviewed",
      proposedFolderPath: "",
      markdown: null,
      revision: 3,
      proposedLinks: [],
      tableSchema: { columns: [{ name: "Amount", type: "text" }] },
      tableRows: [["100"]],
      acceptedResourceId: null,
      acceptedCommitSha: null,
    },
  };
  const repo = {
    logForPath: vi.fn(
      async () =>
        [] as Array<{
          sha: string;
          operationId: string;
          trustedAuthor: boolean;
          ingestionRequestHash?: string;
        }>,
    ),
    logChangesBefore: vi.fn(async () => [
      {
        sha: commitSha,
        changes: [{ status: "A", path: `${path}/schema.json` }],
      },
    ]),
    blobSizeAt: vi.fn(async () => 100),
    showFileAt: vi.fn(async () => JSON.stringify({ id: resourceId })),
  };
  vi.mocked(withProjectRepo).mockImplementation(async (_, work) =>
    work(repo as unknown as ProjectRepoWriter),
  );
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: fileId }]),
    ingestionFile: {
      read: () => ({ ...file, draft: { ...file.draft } }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status: string };
          data: { status: string };
        }) => {
          if (where.status !== file.status) return { count: 0 };
          file.status = data.status;
          return { count: 1 };
        },
      ),
    },
    ingestionDraft: {
      update: vi.fn(
        async ({
          data,
        }: {
          data: { acceptedResourceId: string; acceptedCommitSha: string };
        }) => {
          Object.assign(file.draft, data);
        },
      ),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(
      async <T>(work: (transaction: typeof tx) => Promise<T>) => {
        const before = tx.ingestionFile.read();
        try {
          return await work(tx);
        } catch (error) {
          Object.assign(file, before);
          throw error;
        }
      },
    ),
    document: { findUnique: async () => null },
    dataTable: { findUnique: async () => null, findFirst: async () => null },
  };
  return { repo, file, tx, db: db as unknown as PrismaClient };
}

it("releases a claim when only untrusted history mentions its operation", async () => {
  const { db, file, repo } = importFixture();
  repo.logForPath.mockResolvedValue([
    { sha: commitSha, operationId, trustedAuthor: false },
  ]);

  await expect(acceptDraft(db, actor, { fileId })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(file.status).toBe("ready");
  expect(file.draft.acceptedCommitSha).toBeNull();
});

it("checks the acceptance bound against trusted history", async () => {
  const { db, file, repo } = importFixture();
  const history = Array.from({ length: 11 }, (_, index) => ({
    sha: String(index).padStart(40, "0"),
    operationId,
    trustedAuthor: false,
  }));
  repo.logForPath.mockImplementation(
    async (_path?: string, options?: { trustedOperationsOnly?: boolean }) =>
      options?.trustedOperationsOnly ? [] : history,
  );
  await expect(acceptDraft(db, actor, { fileId })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(file.status).toBe("ready");
});

it.each([true, false])(
  "verifies the bytes of legacy imported images (matches=%s)",
  async (matches) => {
    const file = "reviewed.md";
    const markdown = "![Evidence](reviewed.assets/example.png)";
    const bytes = Buffer.from("approved");
    const date = new Date().toISOString();
    vi.mocked(resolveImageReferences).mockResolvedValue({
      contentJson: parseDocumentBody(markdown),
      assets: [{ name: "example.png", bytes }],
    });
    const repo = {
      logChangesBefore: async () => [
        { sha: commitSha, changes: [{ status: "A", path: file }] },
      ],
      blobSizeAt: async () => 100,
      showFileAt: async () =>
        composeDocumentFile(
          {
            id: resourceId,
            title: "Reviewed",
            created: date,
            updated: date,
            review: null,
            createdBy: null,
            updatedBy: null,
          },
          markdown,
          "markdown",
        ),
      readCommittedBlobAt: vi.fn(async () => ({
        bytes: matches ? bytes : Buffer.from("altered!"),
      })),
    };
    await expect(
      matchesLegacyIngestionCreate(
        {} as PrismaClient,
        repo as unknown as ProjectRepoWriter,
        {
          kind: "document.create",
          projectId,
          folderPath: [],
          title: "Reviewed",
          markdown,
        },
        operationId,
        actor,
        commitSha,
      ),
    ).resolves.toBe(matches);
    expect(resolveImageReferences).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ maxTotalBytes: MAX_IMPORT_IMAGE_BYTES }),
    );
    expect(repo.readCommittedBlobAt).toHaveBeenCalledWith(
      commitSha,
      "reviewed.assets/example.png",
      bytes.length,
    );
  },
);

it("resumes an authentic, reviewed creation after losing its acknowledgement", async () => {
  const { db, file, tx, repo } = importFixture();
  const apply = vi.mocked(applyOperationInRepo);
  apply.mockClear();
  apply.mockImplementationOnce(
    async (_db, _repo, _operation, _actor, options) => {
      const { ingestionRequestHash } = options;
      expect(ingestionRequestHash).toMatch(/^[0-9a-f]{64}$/u);
      repo.logForPath.mockResolvedValue([
        {
          sha: commitSha,
          operationId,
          trustedAuthor: true,
          ingestionRequestHash,
        },
      ]);
      return { commitSha, resourceId, path };
    },
  );
  tx.ingestionDraft.update.mockRejectedValueOnce(
    new Error("acknowledgement unavailable"),
  );

  await expect(acceptDraft(db, actor, { fileId })).rejects.toThrow(
    "acknowledgement unavailable",
  );
  expect(file.status).toBe("accepting");
  await expect(acceptDraft(db, actor, { fileId })).resolves.toMatchObject({
    commitSha,
    resourceId,
  });
  expect(file.status).toBe("accepted");
  expect(apply).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "verifies the contents of a legacy local create (matches=%s)",
  async (matches) => {
    const { db, file, repo } = importFixture();
    const columns = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Amount",
        type: "text" as const,
      },
    ];
    const at = new Date().toISOString();
    const schema = serializeSchemaFile({
      id: resourceId,
      title: "Reviewed",
      sourceOfTruth: "git",
      columns,
      created: at,
      updated: at,
    });
    const rows = serializeRows(columns, [
      {
        id: "44444444-4444-4444-8444-444444444444",
        cells: { [columns[0]!.id]: matches ? "100" : "200" },
      },
    ]);
    file.status = "accepting";
    repo.logForPath.mockResolvedValue([
      { sha: commitSha, operationId, trustedAuthor: true },
    ]);
    repo.showFileAt.mockImplementation(async (_sha?: string, file?: string) =>
      file?.endsWith(".jsonl") ? rows : schema,
    );

    const attempt = acceptDraft(db, actor, { fileId });
    if (matches) {
      await expect(attempt).resolves.toMatchObject({ commitSha, resourceId });
      expect(file.status).toBe("accepted");
    } else {
      await expect(attempt).rejects.toMatchObject({ code: "CONFLICT" });
      expect(file.status).toBe("ready");
      expect(file.draft.acceptedCommitSha).toBeNull();
    }
  },
);

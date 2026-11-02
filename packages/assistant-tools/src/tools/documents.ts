import { invalidCursorError } from "@weaver/core/services/contentCursors";
import {
  getDocumentAtSnapshot,
  listDocuments,
} from "@weaver/core/services/documents";
import { z } from "zod";
import {
  boundItems,
  defineSharedReadTool,
  newOutputBudget,
  requireScope,
} from "../contract";
import {
  atCommitShaInput,
  continuationCursor,
  cursorInput,
  fitTextChunk,
  resolvePinnedRequest,
  textChunkBudget,
} from "./snapshotReads";

const MAX_CHUNK = 8_000;

export const listDocumentsTool = defineSharedReadTool({
  name: "list_documents",
  kind: "read",
  capability: "content:read",
  description:
    "List documents in a project (paged, optional folder and title search) with their created/updated time, author and review due date. Returns ids for read_document, which resolves the current commit revision. If truncated is true, lower pageSize and page through the rest.",
  inputSchema: z.object({
    projectId: z.uuid(),
    folderPath: z.array(z.string()).max(10).optional(),
    search: z.string().max(200).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(25),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const result = await listDocuments(
      ctx.db,
      {
        projectId: input.projectId,
        page: input.page,
        pageSize: input.pageSize,
        search: input.search,
        folderPath: input.folderPath,
        sort: "lastEditedAt",
        dir: "desc",
      },
      ctx.actor,
    );
    // listDocuments' select does not include headCommitSha (documents.ts:1272-1287);
    // read_document resolves the current commit fresh, so it is not needed here.
    const mapped = result.items.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      excerpt: row.excerpt,
      lastEditedAt: row.lastEditedAt,
      created: row.createdAt,
      createdBy: row.createdBy,
      updated: row.updatedAt,
      updatedBy: row.updatedBy,
      reviewDueAt: row.reviewDueAt,
    }));
    const { items: documents, truncated } = boundItems(
      mapped,
      newOutputBudget(),
    );
    return {
      output: {
        page: input.page,
        total: result.total,
        truncated,
        documents,
      },
    };
  },
});

export const readDocumentTool = defineSharedReadTool({
  name: "read_document",
  kind: "read",
  capability: "content:read",
  description:
    "Reads a document's body at one snapshot: Markdown for a Markdown document, the source text for a Python file (kind tells which), with its metadata (created, createdBy, updated, updatedBy) and review status. Returns snapshotCommitSha (project) and baseCommitSha (this revision; alias commitSha) — cite it and use it as propose_document_edit's base. Chunked: nextCursor continues at the same snapshot; atCommitSha reads an earlier one.",
  inputSchema: z.object({
    projectId: z.uuid(),
    documentId: z.uuid(),
    atCommitSha: atCommitShaInput,
    cursor: cursorInput,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Legacy character offset; prefer cursor."),
    maxChars: z.number().int().min(500).max(MAX_CHUNK).default(MAX_CHUNK),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const pinned = resolvePinnedRequest({
      kind: "document",
      projectId: input.projectId,
      resourceId: input.documentId,
      atCommitSha: input.atCommitSha,
      cursor: input.cursor,
      query: {},
    });
    if (
      input.cursor !== undefined &&
      input.offset !== 0 &&
      input.offset !== pinned.position
    )
      throw invalidCursorError();
    const position =
      input.cursor === undefined ? input.offset : pinned.position;
    const document = await getDocumentAtSnapshot(
      ctx.db,
      {
        projectId: input.projectId,
        documentId: input.documentId,
        atCommitSha: pinned.atCommitSha,
      },
      ctx.actor,
    );
    const markdown = document.markdown;
    const binding = {
      kind: "document" as const,
      projectId: input.projectId,
      resourceId: input.documentId,
      snapshotCommitSha: document.snapshotCommitSha,
      query: pinned.query,
    };
    const envelope = {
      id: document.id,
      title: document.title,
      kind: document.kind,
      path: document.path,
      snapshotCommitSha: document.snapshotCommitSha,
      baseCommitSha: document.baseCommitSha,
      commitSha: document.baseCommitSha,
      metadata: {
        created: document.metadata.createdAt,
        createdBy: document.metadata.createdBy,
        updated: document.metadata.updatedAt,
        updatedBy: document.metadata.updatedBy,
      },
      review: document.review && {
        reviewers: document.review.reviewers.map(({ type, id, name }) => ({
          type,
          id,
          name,
        })),
        everyMonths: document.review.everyMonths,
        lastReviewed: document.review.lastReviewedAt,
        reviewedBy: document.review.reviewedBy,
        dueAt: document.review.dueAt,
      },
      offset: position,
      totalChars: markdown.length,
    };
    const { text: slice, end } = fitTextChunk(
      markdown,
      position,
      input.maxChars,
      textChunkBudget({
        ...envelope,
        nextOffset: markdown.length,
        nextCursor: continuationCursor(binding, markdown.length),
        hasMore: false,
        markdown: "",
      }),
    );
    const nextOffset = end < markdown.length ? end : null;
    const nextCursor = continuationCursor(binding, nextOffset);
    return {
      output: {
        ...envelope,
        nextOffset,
        nextCursor,
        hasMore: nextCursor !== null,
        markdown: slice,
      },
      citations: [
        {
          kind: "document",
          projectId: input.projectId,
          documentId: document.id,
          commitSha: document.baseCommitSha,
          headingPath: [],
          excerpt: null,
        },
      ],
    };
  },
});

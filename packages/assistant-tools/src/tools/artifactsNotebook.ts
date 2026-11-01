import { notebookIdSchema } from "@weaver/core/artifacts/notebookSchema";
import { isCoreError } from "@weaver/core/errors";
import {
  decodeArtifactCursor,
  encodeArtifactCursor,
} from "@weaver/core/services/artifactCursors";
import type { ArtifactEnvelope } from "@weaver/core/services/artifactReads";
import {
  listArtifactNotebookPages,
  prepareArtifactNotebook,
  readArtifactNotebookPage,
} from "@weaver/core/services/artifactNotebooks";
import { z } from "zod";
import {
  boundItems,
  defineTool,
  ToolError,
  type ToolContext,
  type ToolOutcome,
} from "../contract";
import {
  artifactEnvelope,
  artifactTarget,
  assertSameContent,
  budgetAfter,
  cursorBinding,
  describeFor,
  positionIndex,
  wrongFormat,
} from "./artifactsShared";
import { cursorInput, fitTextChunk, textChunkBudget } from "./snapshotReads";
import { notebookPageText } from "./notebookText";

function headText(value: string): string {
  return fitTextChunk(value, 0, 500, 500).text;
}

type NotebookOverview = Awaited<ReturnType<typeof prepareArtifactNotebook>>;

const CACHE_RECOVERY_HINT =
  'Notebook cache is missing or damaged. Call read_onenote with the same projectId/filename, action="sections", retry=true now. Report queued/running and read again when ready. Then repeat the original request. If rebuilding fails, report the failure instead of looping.';
const retryLaterHint = (allowedAt: string) =>
  `A rebuild (read_onenote with action="sections", retry=true) is allowed after ${allowedAt}; report the failure now instead of retrying before then.`;

async function notebookRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      isCoreError(error) &&
      error.code === "PRECONDITION_FAILED" &&
      error.details?.reason === "SNAPSHOT_UNAVAILABLE"
    )
      throw new ToolError(
        "CONFLICT",
        CACHE_RECOVERY_HINT,
        "SNAPSHOT_UNAVAILABLE",
      );
    throw error;
  }
}

async function prepare(
  ctx: ToolContext,
  artifact: ArtifactEnvelope,
  retry = false,
): Promise<NotebookOverview> {
  const result = await prepareArtifactNotebook(ctx.db, ctx.actor, {
    projectId: artifact.projectId,
    artifactId: artifact.id,
    retry,
  });
  assertSameContent(artifact.sha256, {
    ...artifact,
    sha256: result.contentDigest,
  });
  return result;
}

function failedHint(notebook: NotebookOverview): string {
  if (notebook.retryRefused && notebook.retryAllowedAt)
    return `Rebuild refused: the last preparation failed too recently. ${retryLaterHint(notebook.retryAllowedAt)}`;
  if (notebook.retryAllowedAt)
    return `Notebook preparation failed. ${retryLaterHint(notebook.retryAllowedAt)}`;
  return notebook.error === "snapshot_unavailable"
    ? CACHE_RECOVERY_HINT
    : 'Notebook preparation failed. Call read_onenote with the same projectId/filename, action="sections", retry=true once. If it fails again, report the failure instead of looping.';
}

function statusHead(notebook: NotebookOverview) {
  return {
    readable: true as const,
    format: "onenote" as const,
    status: notebook.status,
    error: notebook.error,
    retryAllowedAt: notebook.retryAllowedAt,
    retryRefused: notebook.retryRefused,
    warnings: notebook.warnings.slice(0, 5).map(headText),
    warningsTruncated:
      notebook.warnings.length > 5 ||
      notebook.warnings.some((warning) => headText(warning) !== warning),
    hint:
      notebook.status === "ready"
        ? "Use read_onenote to list sections/pages, search, and read a page. Images appear as ![alt](weaver-image:…) references; keep them in a document's Markdown to copy the image into it. Attachments are described; nothing is OCR-transcribed."
        : notebook.status === "failed"
          ? failedHint(notebook)
          : "Notebook preparation runs in the background. Do not retry while queued/running; report the status and read again after preparation completes.",
  };
}

function sectionSummary(section: NotebookOverview["sections"][number]) {
  return {
    id: section.id,
    title: headText(section.title),
    path: headText(section.path.join(" / ")),
    pageCount: section.pageCount,
    warnings: section.warnings.slice(0, 2).map(headText),
  };
}

export async function notebookOverviewFor(
  ctx: ToolContext,
  artifact: ArtifactEnvelope,
) {
  const notebook = await prepare(ctx, artifact);
  const file = artifactEnvelope(artifact);
  const head = {
    ...statusHead(notebook),
    sectionCount: notebook.sections.length,
    pageCount: notebook.sections.reduce(
      (sum, section) => sum + section.pageCount,
      0,
    ),
  };
  const sections = boundItems(
    notebook.sections.map(sectionSummary),
    budgetAfter({ artifact: file, result: head }),
  );
  return {
    artifact: file,
    result: {
      ...head,
      sections: sections.items,
      sectionsTruncated: sections.truncated,
    },
  };
}

export async function notebookSearchFor(
  ctx: ToolContext,
  artifact: ArtifactEnvelope,
  query: string,
  limit: number,
  matchCase = false,
) {
  const notebook = await prepare(ctx, artifact);
  const file = artifactEnvelope(artifact);
  const head = { ...statusHead(notebook), query };
  if (notebook.status !== "ready")
    return {
      artifact: file,
      result: { ...head, matches: [], total: 0, truncated: false },
    };
  const result = await notebookRead(() =>
    listArtifactNotebookPages(ctx.db, ctx.actor, {
      projectId: artifact.projectId,
      artifactId: artifact.id,
      contentDigest: artifact.sha256,
      query,
      limit: Math.min(limit, 100),
      matchCase,
    }),
  );
  const matches = boundItems(
    result.items.map((item) => ({
      pageId: item.id,
      sectionId: item.sectionId,
      title: headText(item.title),
      snippet: headText(item.snippet ?? ""),
    })),
    budgetAfter({ artifact: file, result: head }),
  );
  return {
    artifact: file,
    result: {
      ...head,
      matches: matches.items,
      total: result.total,
      truncated: matches.truncated || matches.items.length < result.total,
    },
  };
}

export const readOneNoteTool = defineTool({
  name: "read_onenote",
  kind: "read",
  capability: "content:read",
  // Reading a notebook enqueues its preparation and can re-arm a failed
  // cache, so it is not read-only to an MCP client; repeating it is harmless.
  annotations: { readOnlyHint: false, idempotentHint: true },
  description:
    "Read .onepkg/.one. Actions: sections; pages (optional sectionId); search (query); page (pageId). Follow nextCursor with the same inputs. Missing cache: retry=true now; failed: retry=true after retryAllowedAt. Queued/running: wait. Returns text, tables and image/attachment descriptions; no OCR.",
  inputSchema: z.object({
    ...artifactTarget,
    action: z.enum(["sections", "pages", "search", "page"]),
    sectionId: notebookIdSchema.optional(),
    pageId: notebookIdSchema.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    cursor: cursorInput,
    retry: z
      .boolean()
      .optional()
      .describe(
        "Rebuild a missing cache now, or a failed preparation once retryAllowedAt has passed; omit while queued/running. Report a refused or failed rebuild instead of looping.",
      ),
  }),
  async execute(input, ctx): Promise<ToolOutcome<unknown>> {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "onenote") throw wrongFormat(format, "read_onenote");
    if (input.action === "page" && !input.pageId)
      throw new ToolError("BAD_REQUEST", "pageId is required for action=page");
    if (input.action === "search" && !input.query)
      throw new ToolError("BAD_REQUEST", "query is required for action=search");
    const binding = cursorBinding("read_onenote", artifact, {
      action: input.action,
      sectionId: input.sectionId ?? null,
      pageId: input.pageId ?? null,
      query: input.query ?? null,
    });
    const offset = input.cursor
      ? positionIndex(decodeArtifactCursor(input.cursor, binding))
      : 0;
    const notebook = await prepare(ctx, artifact, input.retry);
    const file = artifactEnvelope(artifact);
    const head = statusHead(notebook);
    if (notebook.status !== "ready")
      return { output: { artifact: file, result: head } };
    const nextCursor = (position: number | null) =>
      position === null
        ? null
        : encodeArtifactCursor(binding, String(position));

    if (input.action === "page") {
      const page = await notebookRead(() =>
        readArtifactNotebookPage(ctx.db, ctx.actor, {
          projectId: artifact.projectId,
          artifactId: artifact.id,
          contentDigest: artifact.sha256,
          pageId: input.pageId!,
        }),
      );
      const text = notebookPageText(page.blocks, artifact.id);
      if (offset > text.length)
        throw new ToolError(
          "BAD_REQUEST",
          "page cursor is out of range",
          "INVALID_CURSOR",
        );
      const pageHead = {
        ...head,
        pageId: page.id,
        sectionId: page.sectionId,
        title: headText(page.title),
        pageWarnings: page.warnings.slice(0, 5).map(headText),
        pageWarningsTruncated:
          page.warnings.length > 5 ||
          page.warnings.some((warning) => headText(warning) !== warning),
        offset,
      };
      const envelope = {
        artifact: file,
        result: {
          ...pageHead,
          text: "",
          hasMore: true,
          nextCursor: nextCursor(text.length),
        },
      };
      const chunk = fitTextChunk(
        text,
        offset,
        8_000,
        textChunkBudget(envelope),
      );
      const hasMore = chunk.end < text.length;
      return {
        output: {
          artifact: file,
          result: {
            ...pageHead,
            text: chunk.text,
            hasMore,
            nextCursor: nextCursor(hasMore ? chunk.end : null),
          },
        },
      };
    }

    if (input.action === "sections") {
      const total = notebook.sections.length;
      const items = boundItems(
        notebook.sections.slice(offset, offset + 50).map(sectionSummary),
        budgetAfter({
          artifact: file,
          result: {
            ...head,
            total,
            sections: [],
            hasMore: true,
            nextCursor: nextCursor(total),
          },
        }),
      );
      const next = offset + items.items.length;
      return {
        output: {
          artifact: file,
          result: {
            ...head,
            total,
            sections: items.items,
            hasMore: next < total,
            nextCursor: nextCursor(next < total ? next : null),
          },
        },
      };
    }

    const result = await notebookRead(() =>
      listArtifactNotebookPages(ctx.db, ctx.actor, {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        contentDigest: artifact.sha256,
        sectionId: input.sectionId,
        query: input.action === "search" ? input.query : undefined,
        offset,
        limit: 50,
      }),
    );
    const items = boundItems(
      result.items.map((item) => ({
        ...item,
        title: headText(item.title),
        ...(item.snippet === undefined
          ? {}
          : { snippet: headText(item.snippet) }),
      })),
      budgetAfter({
        artifact: file,
        result: {
          ...head,
          total: result.total,
          pages: [],
          hasMore: true,
          nextCursor: nextCursor(result.total),
        },
      }),
    );
    const next = offset + items.items.length;
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          total: result.total,
          pages: items.items,
          hasMore: next < result.total,
          nextCursor: nextCursor(next < result.total ? next : null),
        },
      },
    };
  },
});

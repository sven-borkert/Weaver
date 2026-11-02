import type { SourceLocator } from "@weaver/core/assistant/citations";
import {
  documentOutlineFor,
  findSection,
  type DocumentSection,
} from "@weaver/core/documents/outline";
import { CoreError } from "@weaver/core/errors";
import { getDocumentAtSnapshot } from "@weaver/core/services/documents";
import { z } from "zod";
import {
  boundItems,
  defineSharedReadTool,
  newPageBudget,
  requireScope,
  type ToolOutcome,
} from "../contract";
import {
  atCommitShaInput,
  continuationCursor,
  cursorInput,
  fitTextChunk,
  resolvePinnedRequest,
  sliceTextChunk,
  textChunkBudget,
} from "./snapshotReads";

const MAX_SECTION_CHARS = 8_000;
const OUTLINE_PAGE = 100;
const FIND_PAGE = 20;
const EXCERPT_CONTEXT = 80;
const MAX_LOCATOR_HEADINGS = 10;
const MAX_LOCATOR_HEADING_CHARS = 200;
const MAX_LOCATOR_EXCERPT_CHARS = 500;

/** Ancestor chain plus the section's own heading, clamped to the locator schema: validateSourceLocators drops a whole locator on any violation. */
export function sectionHeadingPath(
  sections: readonly DocumentSection[],
  sectionId: string | null,
): string[] {
  const index = sections.findIndex((section) => section.id === sectionId);
  if (index === -1) return [];
  const path: string[] = [];
  let depth = Infinity;
  for (let i = index; i >= 0 && depth > 1; i--) {
    const section = sections[i]!;
    if (section.depth >= depth) continue;
    depth = section.depth;
    path.unshift(
      sliceTextChunk(section.heading, 0, MAX_LOCATOR_HEADING_CHARS).text,
    );
  }
  return path.slice(-MAX_LOCATOR_HEADINGS);
}

/** One locator per distinct section: identical sections collapse on purpose, since the citation dedupe key includes the label. */
export function findCitations(
  base: { projectId: string; documentId: string; commitSha: string },
  sections: readonly DocumentSection[],
  matches: readonly { sectionId: string | null; excerpt: string }[],
): SourceLocator[] {
  const seen = new Set<string | null>();
  const citations: SourceLocator[] = [];
  for (const match of matches) {
    if (seen.has(match.sectionId)) continue;
    seen.add(match.sectionId);
    citations.push({
      kind: "document",
      ...base,
      headingPath: sectionHeadingPath(sections, match.sectionId),
      excerpt: sliceTextChunk(match.excerpt, 0, MAX_LOCATOR_EXCERPT_CHARS).text,
    });
  }
  return citations;
}

type Revisions = {
  snapshotCommitSha: string;
  baseCommitSha: string;
  commitSha: string;
};

type NavigateDocumentOutput =
  | (Revisions & {
      sections: { id: string; heading: string; depth: number }[];
      truncated: boolean;
      hasMore: boolean;
      nextCursor: string | null;
    })
  | (Revisions & {
      sectionId: string;
      heading: string;
      depth: number;
      text: string;
      hasMore: boolean;
      nextCursor: string | null;
    })
  | (Revisions & {
      matches: { sectionId: string | null; excerpt: string }[];
      total: number;
      truncated: boolean;
      hasMore: boolean;
      nextCursor: string | null;
    });

export const navigateDocumentTool = defineSharedReadTool({
  name: "navigate_document",
  kind: "read",
  capability: "content:read",
  description:
    "Navigate one document at a snapshot. mode=outline lists heading ids/depths (def/class groups for a Python file); mode=section reads one section (heading plus descendants); mode=find locates literal text. The text returned by mode=section INCLUDES the section's own heading line, but a section-scoped edit matches only the section body, so never use the heading line as a find/anchor for a sectionId-scoped patch action. Section ids are valid only for the returned revision — pass them to propose_document_patch.",
  inputSchema: z.object({
    projectId: z.uuid(),
    documentId: z.uuid(),
    mode: z.enum(["outline", "section", "find"]),
    sectionId: z
      .string()
      .max(200)
      .optional()
      .describe("Required for mode=section; scopes mode=find."),
    find: z
      .string()
      .min(1)
      .max(1_000)
      .optional()
      .describe("Required for mode=find."),
    atCommitSha: atCommitShaInput,
    cursor: cursorInput,
  }),
  async execute(input, ctx): Promise<ToolOutcome<NavigateDocumentOutput>> {
    requireScope(ctx, input.projectId);
    const pinned = resolvePinnedRequest({
      kind: "document",
      projectId: input.projectId,
      resourceId: input.documentId,
      atCommitSha: input.atCommitSha,
      cursor: input.cursor,
      query: {
        mode: input.mode,
        sectionId: input.sectionId ?? null,
        find: input.find ?? null,
      },
    });
    const document = await getDocumentAtSnapshot(
      ctx.db,
      {
        projectId: input.projectId,
        documentId: input.documentId,
        atCommitSha: pinned.atCommitSha,
      },
      ctx.actor,
    );
    const sections = documentOutlineFor(document.kind, document.markdown);
    const binding = {
      kind: "document" as const,
      projectId: input.projectId,
      resourceId: input.documentId,
      snapshotCommitSha: document.snapshotCommitSha,
      query: pinned.query,
    };
    const revisions = {
      snapshotCommitSha: document.snapshotCommitSha,
      baseCommitSha: document.baseCommitSha,
      commitSha: document.baseCommitSha,
    };
    const locatorBase = {
      projectId: input.projectId,
      documentId: document.id,
      commitSha: document.baseCommitSha,
    };

    if (input.mode === "outline") {
      const page = sections
        .slice(pinned.position, pinned.position + OUTLINE_PAGE)
        .map((section) => ({
          id: section.id,
          heading: section.heading,
          depth: section.depth,
        }));
      const { items, truncated } = boundItems(page, newPageBudget());
      const next = pinned.position + items.length;
      const hasMore = next < sections.length;
      return {
        output: {
          ...revisions,
          sections: items,
          truncated,
          hasMore,
          nextCursor: continuationCursor(binding, hasMore ? next : null),
        },
      };
    }

    if (input.mode === "section") {
      if (!input.sectionId)
        throw new CoreError("BAD_REQUEST", "mode=section requires sectionId");
      const section = findSection(sections, input.sectionId);
      if (!section)
        throw new CoreError(
          "BAD_REQUEST",
          `unknown section ${input.sectionId}; re-read the outline`,
          { reason: "AMBIGUOUS_MATCH" },
        );
      const body = document.markdown.slice(section.start, section.end);
      const envelope = {
        ...revisions,
        sectionId: section.id,
        heading: section.heading,
        depth: section.depth,
      };
      const citations: SourceLocator[] = [
        {
          kind: "document",
          ...locatorBase,
          headingPath: sectionHeadingPath(sections, section.id),
          excerpt: null,
        },
      ];
      const { text, end } = fitTextChunk(
        body,
        pinned.position,
        MAX_SECTION_CHARS,
        textChunkBudget({
          output: {
            ...envelope,
            text: "",
            hasMore: false,
            nextCursor: continuationCursor(binding, body.length),
          },
          citations,
        }),
      );
      const hasMore = end < body.length;
      return {
        output: {
          ...envelope,
          text,
          hasMore,
          nextCursor: continuationCursor(binding, hasMore ? end : null),
        },
        citations,
      };
    }

    if (!input.find)
      throw new CoreError("BAD_REQUEST", "mode=find requires find");
    const scope = input.sectionId
      ? (() => {
          const section = findSection(sections, input.sectionId);
          if (!section)
            throw new CoreError(
              "BAD_REQUEST",
              `unknown section ${input.sectionId}; re-read the outline`,
              { reason: "AMBIGUOUS_MATCH" },
            );
          return { from: section.bodyStart, to: section.end };
        })()
      : { from: 0, to: document.markdown.length };
    const hits: number[] = [];
    let at = document.markdown.indexOf(input.find, scope.from);
    while (at !== -1 && at + input.find.length <= scope.to) {
      hits.push(at);
      at = document.markdown.indexOf(input.find, at + 1);
    }
    const sectionAt = (offset: number) =>
      [...sections].reverse().find((section) => section.start <= offset)?.id ??
      null;
    const page = hits
      .slice(pinned.position, pinned.position + FIND_PAGE)
      .map((offset) => ({
        sectionId: sectionAt(offset),
        excerpt: document.markdown.slice(
          Math.max(0, offset - EXCERPT_CONTEXT),
          Math.min(
            document.markdown.length,
            offset + input.find!.length + EXCERPT_CONTEXT,
          ),
        ),
      }));
    const { items, truncated } = boundItems(page, newPageBudget());
    const next = pinned.position + items.length;
    const hasMore = next < hits.length;
    return {
      output: {
        ...revisions,
        matches: items,
        total: hits.length,
        truncated,
        hasMore,
        nextCursor: continuationCursor(binding, hasMore ? next : null),
      },
      citations: findCitations(locatorBase, sections, items),
    };
  },
});

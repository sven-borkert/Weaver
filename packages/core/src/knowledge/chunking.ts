import { createHash } from "node:crypto";

import {
  MAX_DOCUMENT_SECTION_HEADING_CHARACTERS,
  projectDocumentSectionAnchors,
} from "./sectionAnchors";

export type KnowledgeChunk = {
  id: string;
  ordinal: number;
  contentHash: string;
  headingPath: string[];
  navigationAnchor: string | null;
  content: string;
};

export type ChunkMarkdownInput = {
  documentId: string;
  sourceCommitSha: string;
  title: string;
  markdown: string;
  maxChars: number;
  overlapChars: number;
  maxChunks?: number;
};

type MarkdownBlock = {
  content: string;
  headingPath: string[];
  navigationAnchor: string | null;
  plainText: boolean;
};

type PendingChunk = {
  content: string;
  headingPath: string[];
  navigationAnchor: string | null;
  plainText: string;
};

const fenceStartPattern = /^ {0,3}(`{3,}|~{3,})/;

export const MAX_KNOWLEDGE_CHUNK_CHARACTERS = 9_000;
export const MAX_KNOWLEDGE_CHUNKS = 256;
export const MAX_KNOWLEDGE_HEADING_DEPTH = 6;
export const MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS =
  MAX_DOCUMENT_SECTION_HEADING_CHARACTERS;

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chunkMarkdown(input: ChunkMarkdownInput): KnowledgeChunk[] {
  if (!Number.isInteger(input.maxChars) || input.maxChars <= 0) {
    throw new RangeError("maxChars must be a positive integer");
  }
  if (input.maxChars > MAX_KNOWLEDGE_CHUNK_CHARACTERS) {
    throw new RangeError(
      `maxChars must not exceed ${MAX_KNOWLEDGE_CHUNK_CHARACTERS}`,
    );
  }
  if (!Number.isInteger(input.overlapChars) || input.overlapChars < 0) {
    throw new RangeError("overlapChars must be a non-negative integer");
  }
  const maxChunks = input.maxChunks ?? MAX_KNOWLEDGE_CHUNKS;
  if (
    !Number.isInteger(maxChunks) ||
    maxChunks <= 0 ||
    maxChunks > MAX_KNOWLEDGE_CHUNKS
  ) {
    throw new RangeError(
      `maxChunks must be between 1 and ${MAX_KNOWLEDGE_CHUNKS}`,
    );
  }

  const blocks = markdownBlocks(input.markdown, input.title);
  const chunks: PendingChunk[] = [];
  let current: PendingChunk | undefined;
  let previousPlainText = "";

  const finishCurrent = () => {
    if (!current) return;
    chunks.push(current);
    if (chunks.length > maxChunks) {
      throw new RangeError(
        "Markdown exceeds the maximum knowledge chunk count",
      );
    }
    previousPlainText = current.plainText;
    current = undefined;
  };

  const startChunk = (
    headingPath: string[],
    navigationAnchor: string | null,
    contentLength: number,
    includeOverlap = true,
  ) => {
    const overlapLength = Math.min(
      includeOverlap ? input.overlapChars : 0,
      previousPlainText.length,
      Math.max(input.maxChars - contentLength - 2, 0),
    );
    const overlap =
      overlapLength === 0 ? "" : previousPlainText.slice(-overlapLength);
    current = {
      content: overlap,
      headingPath,
      navigationAnchor,
      plainText: "",
    };
  };

  const append = (content: string, plainText: boolean) => {
    if (!current) throw new Error("Cannot append without a chunk");
    current.content +=
      current.content.length === 0 ? content : `\n\n${content}`;
    if (plainText) current.plainText += content;
  };

  for (const block of blocks) {
    if (
      current &&
      (!sameHeadingPath(current.headingPath, block.headingPath) ||
        current.navigationAnchor !== block.navigationAnchor)
    ) {
      finishCurrent();
    }

    if (block.plainText) {
      const separatorLength = current?.content.length ? 2 : 0;
      const fitsAsWholeParagraph = block.content.length <= input.maxChars;
      const fitsCurrentChunk =
        current &&
        current.content.length + separatorLength + block.content.length <=
          input.maxChars;

      if (fitsAsWholeParagraph) {
        if (current && !fitsCurrentChunk) finishCurrent();
        if (!current)
          startChunk(
            block.headingPath,
            block.navigationAnchor,
            block.content.length,
          );
        append(block.content, true);
        continue;
      }

      let remaining = block.content;
      while (remaining.length > 0) {
        if (!current) startChunk(block.headingPath, block.navigationAnchor, 1);
        const activeChunk = current;
        if (!activeChunk) throw new Error("Cannot start a chunk");
        const separatorLength = activeChunk.content.length === 0 ? 0 : 2;
        const available =
          input.maxChars - activeChunk.content.length - separatorLength;

        if (available <= 0) {
          finishCurrent();
          continue;
        }

        const piece = remaining.slice(0, available);
        append(piece, true);
        remaining = remaining.slice(piece.length);

        if (remaining.length > 0) finishCurrent();
      }
      continue;
    }

    if (block.content.length > input.maxChars) {
      finishCurrent();
      let remaining = block.content;
      while (remaining.length > 0) {
        startChunk(block.headingPath, block.navigationAnchor, 1, false);
        const piece = remaining.slice(0, input.maxChars);
        append(piece, false);
        remaining = remaining.slice(piece.length);
        finishCurrent();
      }
      continue;
    }

    if (!current)
      startChunk(
        block.headingPath,
        block.navigationAnchor,
        block.content.length,
      );
    const activeChunk = current;
    if (!activeChunk) throw new Error("Cannot start a chunk");
    const separatorLength = activeChunk.content.length === 0 ? 0 : 2;
    if (
      activeChunk.content.length > 0 &&
      activeChunk.content.length + separatorLength + block.content.length >
        input.maxChars
    ) {
      finishCurrent();
      startChunk(
        block.headingPath,
        block.navigationAnchor,
        block.content.length,
      );
    }
    append(block.content, false);
  }

  finishCurrent();

  return chunks.map((chunk, ordinal) => {
    const id = createHash("sha256")
      .update(input.documentId)
      .update("\0")
      .update(input.sourceCommitSha)
      .update("\0")
      .update(String(ordinal))
      .update("\0")
      .update(chunk.content)
      .digest("hex");

    return {
      id,
      ordinal,
      contentHash: contentHash(chunk.content),
      headingPath: chunk.headingPath,
      navigationAnchor: chunk.navigationAnchor,
      content: chunk.content,
    };
  });
}

function markdownBlocks(markdown: string, title: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const titleHeading = boundedHeadingComponent(title);
  const headingLevels: string[] = [];
  let navigationAnchor: string | null = null;
  let paragraph: string[] = [];
  let emptyHeading: string | null = null;
  let fence: { marker: "`" | "~"; length: number; lines: string[] } | undefined;
  const normalizedMarkdown = markdown.replace(/\r\n?/g, "\n");
  const projectedHeadingByLine = new Map(
    projectDocumentSectionAnchors(normalizedMarkdown).map((heading) => [
      heading.lineIndex,
      heading,
    ]),
  );

  const headingPath = () =>
    [titleHeading, ...headingLevels.filter((heading) => heading.length > 0)]
      .filter(
        (heading, index, headings) =>
          heading.length > 0 && (index !== 1 || heading !== headings[0]),
      )
      .slice(0, MAX_KNOWLEDGE_HEADING_DEPTH);
  const flushEmptyHeading = () => {
    if (emptyHeading !== null) {
      blocks.push({
        content: emptyHeading,
        headingPath: headingPath(),
        navigationAnchor,
        plainText: true,
      });
      emptyHeading = null;
    }
  };
  const flushParagraph = () => {
    const content = paragraph.join("\n").trim();
    if (content) {
      emptyHeading = null;
      blocks.push({
        content,
        headingPath: headingPath(),
        navigationAnchor,
        plainText: true,
      });
    }
    paragraph = [];
  };

  for (const [lineIndex, line] of normalizedMarkdown.split("\n").entries()) {
    if (fence) {
      fence.lines.push(line);
      if (isFenceEnd(line, fence.marker, fence.length)) {
        blocks.push({
          content: fence.lines.join("\n"),
          headingPath: headingPath(),
          navigationAnchor,
          plainText: false,
        });
        fence = undefined;
      }
      continue;
    }

    const fenceMatch = fenceStartPattern.exec(line);
    if (fenceMatch) {
      flushParagraph();
      emptyHeading = null;
      const marker = fenceMatch[1]?.[0] as "`" | "~";
      fence = {
        marker,
        length: fenceMatch[1]?.length ?? 3,
        lines: [line],
      };
      continue;
    }

    const projectedHeading = projectedHeadingByLine.get(lineIndex);
    if (projectedHeading) {
      flushParagraph();
      flushEmptyHeading();
      const { level } = projectedHeading;
      const heading = projectedHeading.heading;
      headingLevels[level - 1] = heading;
      headingLevels.length = level;
      navigationAnchor = projectedHeading.anchor;
      emptyHeading = heading;
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }

  if (fence) {
    blocks.push({
      content: fence.lines.join("\n"),
      headingPath: headingPath(),
      navigationAnchor,
      plainText: false,
    });
  }
  flushParagraph();
  flushEmptyHeading();

  return blocks;
}

function boundedHeadingComponent(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS);
}

function isFenceEnd(line: string, marker: "`" | "~", length: number): boolean {
  return new RegExp(`^ {0,3}${marker}{${length},}[ \\t]*$`).test(line);
}

function sameHeadingPath(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

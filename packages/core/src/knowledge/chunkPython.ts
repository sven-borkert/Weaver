import { createHash } from "node:crypto";
import { pythonDefinitions } from "../documents/pythonOutline";
import {
  MAX_KNOWLEDGE_CHUNK_CHARACTERS,
  MAX_KNOWLEDGE_CHUNKS,
  MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS,
  contentHash,
  type KnowledgeChunk,
} from "./chunking";

export type ChunkPythonInput = {
  documentId: string;
  sourceCommitSha: string;
  title: string;
  text: string;
  maxChars: number;
  overlapChars: number;
  maxChunks?: number;
};

type Group = { headingPath: string[]; lines: string[] };

function bounded(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS);
}

function trimBlankEdges(lines: string[]): string[] {
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim() === "") from++;
  while (to > from && lines[to - 1]!.trim() === "") to--;
  return lines.slice(from, to);
}

/** Groups in file order: module-level code under the title, one group per top-level definition. */
function pythonGroups(text: string, title: string): Group[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const root = bounded(title);
  const groups: Group[] = [];
  const push = (headingPath: string[], from: number, to: number) => {
    const body = trimBlankEdges(lines.slice(from, to));
    if (body.length) groups.push({ headingPath, lines: body });
  };
  let cursor = 0;
  for (const definition of pythonDefinitions(text)) {
    push([root], cursor, definition.start);
    push(
      [root, bounded(`${definition.kind} ${definition.name}`)],
      definition.start,
      definition.end,
    );
    cursor = definition.end;
  }
  push([root], cursor, lines.length);
  return groups;
}

/** Windows of whole lines within maxChars; a longer line is hard-split. */
function lineWindows(
  lines: string[],
  maxChars: number,
  overlapChars: number,
): string[] {
  const pieces: string[] = [];
  for (const line of lines) {
    if (line.length <= maxChars) pieces.push(line);
    else
      for (let at = 0; at < line.length; at += maxChars)
        pieces.push(line.slice(at, at + maxChars));
  }
  const windows: string[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    windows.push(current.join("\n"));
    // Overlap: the trailing lines of this window that fit into overlapChars.
    const carried: string[] = [];
    let carriedLength = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const next =
        carriedLength + current[i]!.length + (carried.length ? 1 : 0);
      if (next > overlapChars) break;
      carried.unshift(current[i]!);
      carriedLength = next;
    }
    current = carried;
    length = carriedLength;
  };
  for (const piece of pieces) {
    const next = length + piece.length + (current.length ? 1 : 0);
    if (next > maxChars && current.length) flush();
    current.push(piece);
    length = current.length === 1 ? piece.length : length + piece.length + 1;
    // Carried overlap plus this piece may still overflow; drop the oldest carried lines.
    while (length > maxChars && current.length > 1)
      length -= current.shift()!.length + 1;
  }
  if (current.length) windows.push(current.join("\n"));
  return windows;
}

export function chunkPython(input: ChunkPythonInput): KnowledgeChunk[] {
  if (
    !Number.isInteger(input.maxChars) ||
    input.maxChars <= 0 ||
    input.maxChars > MAX_KNOWLEDGE_CHUNK_CHARACTERS
  )
    throw new RangeError(
      `maxChars must be between 1 and ${MAX_KNOWLEDGE_CHUNK_CHARACTERS}`,
    );
  if (!Number.isInteger(input.overlapChars) || input.overlapChars < 0)
    throw new RangeError("overlapChars must be a non-negative integer");
  const maxChunks = input.maxChunks ?? MAX_KNOWLEDGE_CHUNKS;
  if (
    !Number.isInteger(maxChunks) ||
    maxChunks <= 0 ||
    maxChunks > MAX_KNOWLEDGE_CHUNKS
  )
    throw new RangeError(
      `maxChunks must be between 1 and ${MAX_KNOWLEDGE_CHUNKS}`,
    );
  const overlap = Math.min(input.overlapChars, Math.floor(input.maxChars / 2));
  const pending: Array<{ headingPath: string[]; content: string }> = [];
  for (const group of pythonGroups(input.text, input.title)) {
    const whole = group.lines.join("\n");
    const contents =
      whole.length <= input.maxChars
        ? [whole]
        : lineWindows(group.lines, input.maxChars, overlap);
    for (const content of contents) {
      pending.push({ headingPath: group.headingPath, content });
      if (pending.length > maxChunks)
        throw new RangeError(
          "Python source exceeds the maximum knowledge chunk count",
        );
    }
  }
  return pending.map((chunk, ordinal) => ({
    id: createHash("sha256")
      .update(input.documentId)
      .update("\0")
      .update(input.sourceCommitSha)
      .update("\0")
      .update(String(ordinal))
      .update("\0")
      .update(chunk.content)
      .digest("hex"),
    ordinal,
    contentHash: contentHash(chunk.content),
    headingPath: chunk.headingPath,
    navigationAnchor: null,
    content: chunk.content,
  }));
}

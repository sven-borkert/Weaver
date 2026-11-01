import type { DocumentKind } from "../documents/kinds";
import { chunkMarkdown, type KnowledgeChunk } from "./chunking";
import { chunkPython } from "./chunkPython";

export type ChunkableDocument = {
  title: string;
  kind: DocumentKind;
  body: string;
};

export function chunkDocumentSource(input: {
  documentId: string;
  sourceCommitSha: string;
  source: ChunkableDocument;
  maxChars: number;
  overlapChars: number;
  maxChunks?: number;
}): KnowledgeChunk[] {
  const { source, ...rest } = input;
  return source.kind === "python"
    ? chunkPython({ ...rest, title: source.title, text: source.body })
    : chunkMarkdown({ ...rest, title: source.title, markdown: source.body });
}

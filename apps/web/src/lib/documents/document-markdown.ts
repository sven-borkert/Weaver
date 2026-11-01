import type { JSONContent } from "@tiptap/core";
import type { Node, Schema } from "@tiptap/pm/model";
import {
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "@weaver/core/editor/markdown";
import { documentEditingContent } from "~/lib/editor/document-editing-content";

const MAX_MARKDOWN_BYTES = 2_000_000;
const encoder = new TextEncoder();

export function parseDocumentMarkdown(schema: Schema, text: string): Node {
  if (
    text.length > MAX_MARKDOWN_BYTES ||
    encoder.encode(text).byteLength > MAX_MARKDOWN_BYTES
  )
    throw new Error("Markdown exceeds the document size limit.");
  try {
    const parsed = parseDocumentBody(text);
    validateDocumentContent(parsed);
    const content = schema.nodeFromJSON(documentEditingContent(parsed));
    content.check();
    return content;
  } catch {
    throw new Error("Markdown contains content that cannot be saved.");
  }
}

export function serializeDocumentMarkdown(content: Node): string {
  try {
    return serializeDocumentBody(content.toJSON() as JSONContent);
  } catch {
    throw new Error("Markdown contains content that cannot be saved.");
  }
}

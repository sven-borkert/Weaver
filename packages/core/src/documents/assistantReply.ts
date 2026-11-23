import { normalizeLatexDelimiters } from "../editor/latex-delimiters";

/** How the editor applies Markdown the document assistant proposed. */
export type DocumentAssistantAction = "insert" | "replace";

export type DocumentAssistantReply = {
  /** Answer or explanation for the user; Markdown, possibly empty. */
  reply: string;
  /** Markdown proposed for the document, or null for a plain answer. */
  markdown: string | null;
  action: DocumentAssistantAction | null;
};

/** The document text a request is about: the selection (empty for a cursor) and its surroundings. */
export type DocumentAssistantContext = {
  before: string;
  selection: string;
  after: string;
};

export type DocumentAssistantTurn = {
  role: "user" | "assistant";
  text: string;
};

const TAG: Record<DocumentAssistantAction, string> = {
  insert: "insert",
  replace: "replace_selection",
};
const BLOCK_RE = /<(insert|replace_selection)>([\s\S]*?)(?:<\/\1>|$)/i;
const STRAY_TAG_RE = /<\/?(?:insert|replace_selection)>/gi;
const MARKDOWN_FENCE_RE =
  /^(`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i;

function documentMarkdown(raw: string): string {
  const trimmed = raw.replace(/^\s*\n/, "").trimEnd();
  // Models like to wrap the fragment in a Markdown fence despite the instructions.
  return MARKDOWN_FENCE_RE.exec(trimmed)?.[2] ?? trimmed;
}

/** Splits a model reply into the answer and the tagged Markdown for the document. */
export function parseDocumentAssistantReply(
  text: string,
): DocumentAssistantReply {
  const match = BLOCK_RE.exec(text);
  const markdown = match ? documentMarkdown(match[2] ?? "") : "";
  const reply = (
    match
      ? [text.slice(0, match.index), text.slice(match.index + match[0].length)]
      : [text]
  )
    .map((part) => part.replace(STRAY_TAG_RE, "").trim())
    .filter(Boolean)
    .join("\n\n");
  const action =
    match?.[1]?.toLowerCase() === TAG.replace ? "replace" : "insert";
  return {
    reply: normalizeLatexDelimiters(reply),
    markdown: markdown.trim() ? normalizeLatexDelimiters(markdown) : null,
    action: markdown.trim() ? action : null,
  };
}

/** The reply as the model wrote it, for replaying earlier turns. */
export function formatDocumentAssistantReply(
  reply: DocumentAssistantReply,
): string {
  if (!reply.markdown || !reply.action) return reply.reply;
  const tag = TAG[reply.action];
  return `${reply.reply}\n\n<${tag}>\n${reply.markdown}\n</${tag}>`.trim();
}

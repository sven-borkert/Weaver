"use client";

import { useMemo } from "react";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { renderDocumentContent } from "~/lib/editor/render";

/**
 * Tool results link to app-relative paths (`/projects/<id>/artifacts?file=…`):
 * a tool has no base path to build an absolute link with, so the transcript
 * adds the deployment's own. `withBasePath` is idempotent and leaves absolute,
 * protocol-relative and already-prefixed hrefs alone.
 */
export { withDocumentBasePath as withAssistantBasePath } from "~/lib/editor/link-base-path";

/**
 * Assistant text is Markdown; render it through the same static renderer as
 * documents. `prose-weaver` doesn't exist — `document-prose` (DocumentViewer.tsx)
 * is the class that gives headings, lists, and code blocks their typography,
 * so the content is wrapped the same way here.
 */
export function AssistantMarkdown({ text }: { text: string }) {
  const content = useMemo(
    () => renderDocumentContent(parseDocumentBody(text)),
    [text],
  );
  return (
    <div className="document-prose text-text text-[14px] leading-relaxed">
      <div>{content}</div>
    </div>
  );
}

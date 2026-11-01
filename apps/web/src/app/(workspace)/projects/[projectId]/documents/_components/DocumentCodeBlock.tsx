"use client";

import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { MarkdownCodeBlock } from "@weaver/core/editor/extensions";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import type { RenderMappings } from "~/lib/editor/render";

const COPIED_MS = 2000;
const WRAPPER = "group/code relative";

const languageClass = (language: unknown) =>
  typeof language === "string" && language ? `language-${language}` : undefined;

/** `getText` is read on click, so the editor copies the block's current text. */
export function CodeBlockCopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const label = copied ? "Copied" : "Copy code";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      contentEditable={false}
      aria-label={label}
      title={label}
      className="bg-surface-2 text-text-2 absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      // Keeps the editor selection where it is.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!navigator.clipboard) {
          toast.error("Copy failed — clipboard is not available here");
          return;
        }
        void navigator.clipboard
          .writeText(getText())
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), COPIED_MS);
          })
          .catch(() => toast.error("Copy failed"));
      }}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </Button>
  );
}

export const documentCodeBlockMapping: RenderMappings = {
  codeBlock: ({ node, children }) => (
    <div className={WRAPPER}>
      <pre>
        <code className={languageClass(node.attrs.language)}>{children}</code>
      </pre>
      <CodeBlockCopyButton getText={() => node.textContent} />
    </div>
  ),
};

function CodeBlockNodeView({ node }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper className={WRAPPER}>
      <pre>
        <NodeViewContent<"code">
          as="code"
          className={languageClass(node.attrs.language)}
        />
      </pre>
      <CodeBlockCopyButton getText={() => node.textContent} />
    </NodeViewWrapper>
  );
}

/** Client-only: adds the copy button without changing the stored document. */
export const CodeBlockWithCopy = MarkdownCodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
});

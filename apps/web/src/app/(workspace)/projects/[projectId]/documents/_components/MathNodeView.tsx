"use client";

import {
  NodeViewWrapper,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { useId, useMemo, useState } from "react";

import { Label } from "~/components/ui/label";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";
import { mathSource, renderMathHtml } from "~/lib/editor/math-render";
import { useDocumentEditingDisabled } from "./DocumentEditingContext";

function Formula({ source, display }: { source: string; display: boolean }) {
  const html = useMemo(
    () => renderMathHtml(source, display),
    [source, display],
  );
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MathNodeView({
  node,
  editor,
  updateAttributes,
}: ReactNodeViewProps) {
  const sourceId = useId();
  const [editing, setEditing] = useState(false);
  const parentDisabled = useDocumentEditingDisabled();
  const editable = useEditorState({
    editor,
    selector: ({ editor: current }) => current.isEditable,
  });
  const disabled = parentDisabled || !editable;
  const display = node.type.name === "mathBlock";
  const source = mathSource(node.attrs);
  const empty = source.trim() === "";
  const wrapperProps = display
    ? { as: "div" as const, "data-math-block": "" }
    : { as: "span" as const, "data-inline-math": "" };

  if (disabled)
    return (
      <NodeViewWrapper {...wrapperProps} contentEditable={false}>
        <Formula source={source} display={display} />
      </NodeViewWrapper>
    );

  return (
    <NodeViewWrapper {...wrapperProps} contentEditable={false}>
      <Popover open={editing} onOpenChange={setEditing}>
        <PopoverAnchor asChild>
          <button
            type="button"
            aria-label="Edit formula"
            aria-expanded={editing}
            className={`hover:bg-subtle focus-visible:ring-brand cursor-pointer rounded-[4px] text-inherit focus-visible:ring-2 focus-visible:outline-none ${display ? "block w-full" : "inline"}`}
            onClick={() => setEditing(true)}
          >
            {empty ? (
              <span className="text-text-2 text-sm italic">Empty formula</span>
            ) : (
              <Formula source={source} display={display} />
            )}
          </button>
        </PopoverAnchor>
        {editing ? (
          <PopoverContent align="start" className="w-[min(28rem,90vw)]">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={sourceId}>LaTeX source</Label>
              <Textarea
                id={sourceId}
                value={source}
                rows={3}
                spellCheck={false}
                autoFocus
                className="resize-y font-mono text-[12px] leading-5"
                onChange={(event) => {
                  if (editor.isEditable && !editor.isDestroyed)
                    updateAttributes({ source: event.target.value });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(false);
                }}
              />
            </div>
          </PopoverContent>
        ) : null}
      </Popover>
    </NodeViewWrapper>
  );
}

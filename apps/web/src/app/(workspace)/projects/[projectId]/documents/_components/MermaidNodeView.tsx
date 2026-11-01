"use client";

import {
  NodeViewWrapper,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { useId, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { MermaidRenderer } from "./MermaidRenderer";
import { useDocumentEditingDisabled } from "./DocumentEditingContext";

export function MermaidNodeView({
  node,
  editor,
  updateAttributes,
}: ReactNodeViewProps) {
  const sourceId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const parentDisabled = useDocumentEditingDisabled();
  const editable = useEditorState({
    editor,
    selector: ({ editor: current }) => current.isEditable,
  });
  const disabled = parentDisabled || !editable;
  const source = typeof node.attrs.source === "string" ? node.attrs.source : "";

  return (
    <NodeViewWrapper contentEditable={false} className="my-5">
      <MermaidRenderer source={source} />
      {editable || editing ? (
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 min-h-10"
          aria-label={editing ? "Close Mermaid source" : "Edit Mermaid source"}
          aria-expanded={editing}
          aria-controls={sourceId}
          disabled={!editing && disabled}
          onClick={() => {
            if (editing || (!disabled && editor.isEditable))
              setEditing(!editing);
          }}
        >
          {editing ? "Close source" : "Edit diagram"}
        </Button>
      ) : null}
      {editing ? (
        <div className="border-line bg-surface-2 mt-2 rounded-lg border p-4">
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor={sourceId}>Mermaid source</Label>
            <Textarea
              id={sourceId}
              value={source}
              disabled={disabled}
              rows={9}
              spellCheck={false}
              className="min-h-52 resize-y font-mono text-[12px] leading-5"
              onChange={(event) => {
                if (!disabled && editor.isEditable && !editor.isDestroyed)
                  updateAttributes({ source: event.target.value });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
                trigger.current?.focus({ preventScroll: true });
              }}
            />
          </div>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

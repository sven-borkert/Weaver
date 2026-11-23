"use client";

import { parsePlotSpec } from "@weaver/core/editor/plot-spec";
import {
  NodeViewWrapper,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { useDeferredValue, useId, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { MathPlot } from "~/lib/editor/MathPlot";
import { useFigureNodeView } from "~/lib/editor/figure-node-view";
import { useDocumentEditingDisabled } from "./DocumentEditingContext";
import { MATH_PLOT_EXAMPLES } from "./math-plot-examples";

type PlotDraft = { original: string; source: string };

export function MathPlotNodeView({
  node,
  editor,
  getPos,
  selected,
  updateAttributes,
}: ReactNodeViewProps) {
  const panelId = useId();
  const sourceId = `${panelId}-source`;
  const trigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<PlotDraft | null>(null);
  const parentDisabled = useDocumentEditingDisabled();
  const editable = useEditorState({
    editor,
    selector: ({ editor: current }) => current.isEditable,
  });
  const disabled = parentDisabled || !editable;
  const { wrapperProps, frameProps } = useFigureNodeView({
    editor,
    getPos,
    selected,
  });
  const source = typeof node.attrs.source === "string" ? node.attrs.source : "";
  const preview = useDeferredValue(draft?.source ?? source);
  const parsed = useMemo(
    () => (draft ? parsePlotSpec(draft.source) : null),
    [draft],
  );
  const changedExternally = draft !== null && draft.original !== source;
  const mayApply = !disabled && !changedExternally && parsed?.ok === true;

  const canEdit = () => !disabled && editor.isEditable && !editor.isDestroyed;
  const close = () => {
    setDraft(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const change = (next: string) => {
    if (canEdit())
      setDraft((current) => current && { ...current, source: next });
  };

  return (
    <NodeViewWrapper contentEditable={false} className="my-5" {...wrapperProps}>
      <div {...frameProps} className="rounded-lg">
        <MathPlot source={draft ? preview : source} />
      </div>
      {draft ? (
        <div
          id={panelId}
          className="border-line bg-surface-2 mt-2 flex min-w-0 flex-col gap-2 rounded-lg border p-4"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <div
            className="flex flex-wrap items-center gap-2"
            aria-label="Plot examples"
            role="group"
          >
            <span className="text-text-2 text-sm">Load example</span>
            {MATH_PLOT_EXAMPLES.map((example) => (
              <Button
                key={example.label}
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => change(example.source)}
              >
                {example.label}
              </Button>
            ))}
          </div>
          <Label htmlFor={sourceId}>Plot source (JSON)</Label>
          <Textarea
            id={sourceId}
            value={draft.source}
            disabled={disabled}
            aria-invalid={parsed?.ok === false}
            rows={9}
            spellCheck={false}
            autoFocus
            className="field-sizing-fixed resize-y font-mono text-[12px] leading-5"
            onChange={(event) => change(event.target.value)}
          />
          {changedExternally ? (
            <p role="status" className="text-danger m-0 text-sm">
              The plot changed while you were editing. Reopen the editor to load
              its current source.
            </p>
          ) : null}
        </div>
      ) : null}
      {editable || draft ? (
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-10"
            aria-expanded={draft !== null}
            aria-controls={draft ? panelId : undefined}
            disabled={!draft && disabled}
            onClick={() => {
              if (draft) close();
              else if (canEdit()) setDraft({ original: source, source });
            }}
          >
            {draft ? "Cancel" : "Edit plot"}
          </Button>
          {draft ? (
            <Button
              type="button"
              size="sm"
              className="min-h-10"
              disabled={!mayApply}
              onClick={() => {
                if (!mayApply || !canEdit()) return;
                if (draft.source !== source)
                  updateAttributes({ source: draft.source });
                close();
              }}
            >
              Apply plot
            </Button>
          ) : null}
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type MouseEvent,
} from "react";

const FIELD = "input, textarea, select";
const CONTROL = `${FIELD}, button, a[href], label, [role='button'], [role='slider']`;

const elementOf = (target: EventTarget | null): Element | null =>
  target && "closest" in target ? (target as Element) : null;

/** Whether `target` sits in an element matching `selector` inside its own node view, not in the editor around it. */
function withinView(target: EventTarget | null, selector: string): boolean {
  const element = elementOf(target);
  const root = element?.closest("[data-node-view-wrapper]");
  const match = element?.closest(selector);
  return Boolean(root && match && root.contains(match));
}

/** Whether the page selection is a text range inside the node view `target` belongs to. */
export function textSelectedWithin(target: EventTarget | null): boolean {
  const element = elementOf(target);
  const root = element?.closest("[data-node-view-wrapper]");
  const selection = element?.ownerDocument.getSelection();
  return Boolean(
    root &&
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    selection.focusNode &&
    root.contains(selection.anchorNode) &&
    root.contains(selection.focusNode),
  );
}

/** `stopEvent` for plot and diagram node views: presses and drags stay inside, drops and node clipboard actions go to ProseMirror. */
export function stopFigureNodeViewEvent({ event }: { event: Event }): boolean {
  switch (event.type) {
    case "dragstart":
      if (!withinView(event.target, FIELD)) event.preventDefault();
      return true;
    case "dragover":
    case "dragenter":
    case "drop":
      return false;
    case "copy":
    case "cut":
    case "paste":
      return (
        withinView(event.target, FIELD) || textSelectedWithin(event.target)
      );
    default:
      return true;
  }
}

/** Press, focus and clipboard handling that keeps text in a figure node view selectable. */
export function useFigureNodeView({
  editor,
  getPos,
  selected,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  selected: boolean;
}) {
  const [textSelection, setTextSelection] = useState(false);
  const wasSelected = useRef(selected);
  useEffect(() => {
    // TipTap reports `selected` a frame late, so only a deselection ends text selection.
    if (wasSelected.current && !selected) setTextSelection(false);
    wasSelected.current = selected;
  }, [selected]);

  return {
    wrapperProps: {
      onCut: (event: ClipboardEvent) => {
        if (!textSelectedWithin(event.target)) return;
        // The figure is read-only, so cutting its text copies it.
        const text = event.currentTarget.ownerDocument
          .getSelection()
          ?.toString();
        if (text) event.clipboardData.setData("text/plain", text);
        event.preventDefault();
      },
      onPaste: (event: ClipboardEvent) => {
        if (textSelectedWithin(event.target)) event.preventDefault();
      },
    },
    frameProps: {
      "data-figure-frame": "",
      "data-figure-text-selection": textSelection ? "" : undefined,
      onMouseDown: (event: MouseEvent<HTMLElement>) => {
        if (event.button !== 0 || withinView(event.target, CONTROL)) return;
        const pos = getPos();
        if (typeof pos !== "number" || editor.isDestroyed) return;
        const { state, view } = editor;
        if (
          !(state.selection instanceof NodeSelection) ||
          state.selection.from !== pos
        )
          view.dispatch(
            state.tr.setSelection(NodeSelection.create(state.doc, pos)),
          );
        const frame = event.currentTarget;
        const page = frame.ownerDocument;
        // A press inside the node range ProseMirror just selected would drag it.
        if (!event.shiftKey) page.getSelection()?.removeAllRanges();
        setTextSelection(true);
        // Pressing non-editable content blurs the editor; focus it again like ProseMirror's own click.
        page.defaultView?.addEventListener(
          "mouseup",
          (release) => {
            if (editor.isDestroyed) return;
            const selection = page.getSelection();
            const text =
              selection?.anchorNode &&
              selection.focusNode &&
              !selection.isCollapsed
                ? ([
                    selection.anchorNode,
                    selection.anchorOffset,
                    selection.focusNode,
                    selection.focusOffset,
                  ] as const)
                : null;
            setTextSelection(
              Boolean(
                text && frame.contains(text[0]) && frame.contains(text[2]),
              ),
            );
            // A release elsewhere must not take focus from another field.
            const { view } = editor;
            if (view.hasFocus() || !view.dom.contains(release.target as Node))
              return;
            view.focus();
            if (text) selection?.setBaseAndExtent(...text);
          },
          { once: true, capture: true },
        );
      },
    },
  };
}

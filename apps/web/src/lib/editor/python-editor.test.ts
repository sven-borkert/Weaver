import { undoDepth } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  createPythonEditorState,
  pythonEditorResetSpecs,
} from "./python-editor";

const apply = (state: EditorState, text: string) =>
  pythonEditorResetSpecs(state, text).reduce(
    (current, spec) => current.update(spec).state,
    state,
  );

describe("pythonEditorResetSpecs", () => {
  const initial = createPythonEditorState({
    doc: "a = 1\n",
    editable: true,
    onChange: () => undefined,
  });

  it("clears undo history without a change when the text already matches", () => {
    const typed = initial.update({
      changes: { from: 6, insert: "b = 2\n" },
    }).state;
    const specs = pythonEditorResetSpecs(typed, "a = 1\nb = 2\n");
    expect(specs.some((spec) => spec.changes)).toBe(false);
    const reset = apply(typed, "a = 1\nb = 2\n");
    expect(reset.doc.toString()).toBe("a = 1\nb = 2\n");
    expect(undoDepth(reset)).toBe(0);
  });

  it("replaces the text and clears undo history", () => {
    const typed = initial.update({
      changes: { from: 6, insert: "b = 2\n" },
    }).state;
    expect(undoDepth(typed)).toBe(1);
    const reset = apply(typed, "a = 1\n");
    expect(reset.doc.toString()).toBe("a = 1\n");
    expect(undoDepth(reset)).toBe(0);
  });

  it("changes only the differing tail and keeps the selection in place", () => {
    const unterminated = createPythonEditorState({
      doc: "a = 1\nb = 2",
      editable: true,
      onChange: () => undefined,
    }).update({ selection: { anchor: 3 } }).state;
    const [change] = pythonEditorResetSpecs(unterminated, "a = 1\nb = 2\n");
    expect(change?.changes).toEqual({ from: 11, to: 11, insert: "\n" });
    const reset = apply(unterminated, "a = 1\nb = 2\n");
    expect(reset.doc.toString()).toBe("a = 1\nb = 2\n");
    expect(reset.selection.main.anchor).toBe(3);
    expect(undoDepth(reset)).toBe(0);
  });

  it("replaces a changed middle without touching the shared prefix and suffix", () => {
    const [change] = pythonEditorResetSpecs(initial, "a = 42\n");
    expect(change?.changes).toEqual({ from: 4, to: 5, insert: "42" });
  });

  it("keeps the replacement itself out of undo history", () => {
    const reset = apply(initial, "c = 3\n");
    expect(reset.doc.toString()).toBe("c = 3\n");
    expect(undoDepth(reset)).toBe(0);
  });
});

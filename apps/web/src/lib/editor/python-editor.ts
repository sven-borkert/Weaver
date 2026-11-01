import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Compartment,
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

const pythonHighlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword],
    color: "var(--code-keyword)",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--code-string)",
  },
  {
    tag: [tags.comment, tags.docString],
    color: "var(--code-comment)",
    fontStyle: "italic",
  },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-number)" },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.definition(tags.variableName)),
    ],
    color: "var(--code-function)",
  },
  {
    tag: [tags.className, tags.definition(tags.className), tags.typeName],
    color: "var(--code-class)",
  },
  { tag: [tags.operator, tags.punctuation], color: "var(--code-operator)" },
  { tag: [tags.meta, tags.annotation], color: "var(--code-decorator)" },
]);

const editableCompartment = new Compartment();
const historyCompartment = new Compartment();

function editableExtensions(editable: boolean) {
  return [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];
}

export function createPythonEditorState(input: {
  doc: string;
  editable: boolean;
  onChange: (text: string) => void;
}): EditorState {
  return EditorState.create({
    doc: input.doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      historyCompartment.of(history()),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      python(),
      syntaxHighlighting(pythonHighlight),
      // Cmd/Ctrl+S is handled by the surrounding editor article.
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      editableCompartment.of(editableExtensions(input.editable)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) input.onChange(update.state.doc.toString());
      }),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "Python source",
        "aria-multiline": "true",
        role: "textbox",
      }),
    ],
  });
}

export function setPythonEditorEditable(
  view: EditorView,
  editable: boolean,
): void {
  view.dispatch({
    effects: editableCompartment.reconfigure(editableExtensions(editable)),
  });
}

/** Replaces only the differing middle of the text outside undo history, then clears history. */
export function pythonEditorResetSpecs(
  state: EditorState,
  text: string,
): TransactionSpec[] {
  const current = state.doc.toString();
  const clearHistory: TransactionSpec[] = [
    { effects: historyCompartment.reconfigure([]) },
    { effects: historyCompartment.reconfigure(history()) },
  ];
  if (current === text) return clearHistory;
  const limit = Math.min(current.length, text.length);
  let prefix = 0;
  while (prefix < limit && current[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    current[current.length - 1 - suffix] === text[text.length - 1 - suffix]
  )
    suffix++;
  return [
    {
      changes: {
        from: prefix,
        to: current.length - suffix,
        insert: text.slice(prefix, text.length - suffix),
      },
      annotations: Transaction.addToHistory.of(false),
    },
    ...clearHistory,
  ];
}

export function replacePythonEditorText(view: EditorView, text: string): void {
  for (const spec of pythonEditorResetSpecs(view.state, text))
    view.dispatch(spec);
}

export function scrollPythonEditorToLine(view: EditorView, line: number): void {
  const target = view.state.doc.line(
    Math.min(Math.max(line + 1, 1), view.state.doc.lines),
  );
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, {
      y: "start",
      yMargin: 48,
    }),
  });
  view.focus();
}

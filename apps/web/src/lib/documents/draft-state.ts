import type { Node } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { serializeDocumentMarkdown } from "./document-markdown";

export type DocumentDraftSnapshot = {
  title: string;
  content: Node;
  path: string;
  slug: string;
  baseCommitSha: string;
};

export type DocumentDraftState = {
  baseline: DocumentDraftSnapshot;
  title: string;
  content: Node;
  sourceText: string;
  sourceBaseline: string;
  sourceError: string | null;
  revision: number;
};

type DocumentDraftAction =
  | { type: "title"; title: string }
  | { type: "content"; content: Node }
  | {
      type: "source";
      sourceText: string;
      content?: Node;
      sourceError: string | null;
    }
  | { type: "discard" }
  | {
      type: "saved";
      submittedRevision: number;
      snapshot: DocumentDraftSnapshot;
    }
  | {
      type: "refresh";
      requestedRevision: number;
      expectedBaseCommitSha: string;
      snapshot: DocumentDraftSnapshot;
    }
  | { type: "reload"; snapshot: DocumentDraftSnapshot };

export function createDocumentDraft(
  baseline: DocumentDraftSnapshot,
): DocumentDraftState {
  const sourceText = serializeDocumentMarkdown(baseline.content);
  return {
    baseline,
    title: baseline.title,
    content: baseline.content,
    sourceText,
    sourceBaseline: sourceText,
    sourceError: null,
    revision: 0,
  };
}

export function isDocumentDraftDirty(draft: DocumentDraftState): boolean {
  return (
    draft.title !== draft.baseline.title ||
    draft.sourceText !== draft.sourceBaseline ||
    !draft.content.eq(draft.baseline.content)
  );
}

export function documentDraftReducer(
  state: DocumentDraftState,
  action: DocumentDraftAction,
): DocumentDraftState {
  switch (action.type) {
    case "title":
      return action.title === state.title
        ? state
        : { ...state, title: action.title, revision: state.revision + 1 };
    case "content":
      return action.content.eq(state.content)
        ? state
        : {
            ...state,
            content: action.content,
            sourceText: serializeDocumentMarkdown(action.content),
            sourceError: null,
            revision: state.revision + 1,
          };
    case "source": {
      const content = action.content ?? state.content;
      if (
        action.sourceText === state.sourceText &&
        action.sourceError === state.sourceError &&
        content.eq(state.content)
      )
        return state;
      return {
        ...state,
        content,
        sourceText: action.sourceText,
        sourceError: action.sourceError,
        revision: state.revision + 1,
      };
    }
    case "discard":
      return {
        ...createDocumentDraft(state.baseline),
        revision: state.revision + 1,
      };
    case "saved":
      return state.revision === action.submittedRevision
        ? {
            ...createDocumentDraft(action.snapshot),
            revision: state.revision + 1,
          }
        : {
            ...state,
            baseline: action.snapshot,
            sourceBaseline: serializeDocumentMarkdown(action.snapshot.content),
          };
    case "refresh":
      if (
        isDocumentDraftDirty(state) ||
        state.revision !== action.requestedRevision ||
        state.baseline.baseCommitSha !== action.expectedBaseCommitSha
      )
        return state;
      return {
        ...createDocumentDraft(action.snapshot),
        revision: state.revision + 1,
      };
    case "reload":
      return {
        ...createDocumentDraft(action.snapshot),
        revision: state.revision + 1,
      };
  }
}

export function resetDocumentHistory(
  state: EditorState,
  content: Node,
): EditorState {
  return EditorState.create({
    schema: state.schema,
    doc: content,
    selection: TextSelection.near(
      content.resolve(Math.min(state.selection.from, content.content.size)),
    ),
    plugins: state.plugins,
  });
}

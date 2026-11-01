import { getSchema } from "@tiptap/core";
import { history, undo, undoDepth } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { documentExtensions } from "@weaver/core/editor/extensions";
import {
  createDocumentDraft,
  documentDraftReducer,
  isDocumentDraftDirty,
  resetDocumentHistory,
} from "./draft-state";

const schema = getSchema(documentExtensions());
const content = (text: string) =>
  schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
const snapshot = {
  title: "Overview",
  content: content("Saved text"),
  path: "overview.md",
  slug: "overview",
  baseCommitSha: "a".repeat(40),
};

describe("document draft lifecycle", () => {
  it("returns to clean when content and title are undone to the saved values", () => {
    let draft = createDocumentDraft(snapshot);
    expect(isDocumentDraftDirty(draft)).toBe(false);
    draft = documentDraftReducer(draft, {
      type: "content",
      content: content("An edit"),
    });
    draft = documentDraftReducer(draft, { type: "title", title: "New title" });
    expect(isDocumentDraftDirty(draft)).toBe(true);
    draft = documentDraftReducer(draft, {
      type: "content",
      content: content("Saved text"),
    });
    expect(isDocumentDraftDirty(draft)).toBe(true);
    draft = documentDraftReducer(draft, { type: "title", title: "Overview" });
    expect(isDocumentDraftDirty(draft)).toBe(false);
  });

  it("discards title and content together, leaving the saved revision intact", () => {
    let draft = createDocumentDraft(snapshot);
    draft = documentDraftReducer(draft, {
      type: "title",
      title: "Unsaved title",
    });
    draft = documentDraftReducer(draft, {
      type: "content",
      content: content("Unsaved text"),
    });
    draft = documentDraftReducer(draft, { type: "discard" });
    expect(draft.title).toBe("Overview");
    expect(draft.content.textContent).toBe("Saved text");
    expect(draft.baseline.baseCommitSha).toBe("a".repeat(40));
    expect(isDocumentDraftDirty(draft)).toBe(false);
  });

  it("acknowledges a save but retains edits made after the submitted snapshot", () => {
    let draft = documentDraftReducer(createDocumentDraft(snapshot), {
      type: "content",
      content: content("Submitted text"),
    });
    const submittedRevision = draft.revision;
    draft = documentDraftReducer(draft, {
      type: "content",
      content: content("Later text"),
    });
    draft = documentDraftReducer(draft, {
      type: "saved",
      submittedRevision,
      snapshot: {
        ...snapshot,
        content: content("Submitted text"),
        baseCommitSha: "b".repeat(40),
      },
    });
    expect(draft.content.textContent).toBe("Later text");
    expect(draft.baseline.content.textContent).toBe("Submitted text");
    expect(draft.baseline.baseCommitSha).toBe("b".repeat(40));
    expect(isDocumentDraftDirty(draft)).toBe(true);
  });

  it("adopts a new head commit with identical content as a clean draft", () => {
    const draft = documentDraftReducer(createDocumentDraft(snapshot), {
      type: "refresh",
      requestedRevision: 0,
      expectedBaseCommitSha: snapshot.baseCommitSha,
      snapshot: { ...snapshot, baseCommitSha: "b".repeat(40) },
    });
    expect(draft.baseline.baseCommitSha).toBe("b".repeat(40));
    expect(isDocumentDraftDirty(draft)).toBe(false);
  });

  it("ignores refreshes requested before a later edit, even after undo", () => {
    let draft = createDocumentDraft(snapshot);
    const requestedRevision = draft.revision;
    draft = documentDraftReducer(draft, { type: "title", title: "Temporary" });
    draft = documentDraftReducer(draft, { type: "title", title: "Overview" });
    draft = documentDraftReducer(draft, {
      type: "refresh",
      requestedRevision,
      expectedBaseCommitSha: snapshot.baseCommitSha,
      snapshot: {
        ...snapshot,
        content: content("Outdated refresh"),
        baseCommitSha: "b".repeat(40),
      },
    });
    expect(draft.content.textContent).toBe("Saved text");
    expect(draft.baseline.baseCommitSha).toBe("a".repeat(40));
  });

  it("adopts normalized saved content only for the unchanged submitted draft", () => {
    let draft = documentDraftReducer(createDocumentDraft(snapshot), {
      type: "title",
      title: "Renamed",
    });
    draft = documentDraftReducer(draft, {
      type: "saved",
      submittedRevision: draft.revision,
      snapshot: {
        ...snapshot,
        title: "Renamed",
        path: "renamed.md",
        slug: "renamed",
        baseCommitSha: "b".repeat(40),
      },
    });
    expect(draft.title).toBe("Renamed");
    expect(draft.baseline.path).toBe("renamed.md");
    expect(isDocumentDraftDirty(draft)).toBe(false);
  });

  it("clears undo history when discarded content is restored", () => {
    let state = EditorState.create({
      schema,
      doc: snapshot.content,
      plugins: [history()],
    });
    state = state.apply(state.tr.insertText("Unwanted ", 1));
    expect(undoDepth(state)).toBe(1);
    state = resetDocumentHistory(state, snapshot.content);
    expect(state.doc.textContent).toBe("Saved text");
    expect(undoDepth(state)).toBe(0);
    expect(undo(state)).toBe(false);
    expect(state.selection).toBeInstanceOf(TextSelection);
  });
});

describe("Markdown document drafts", () => {
  it("starts with canonical source matching the clean baseline", () => {
    const draft = createDocumentDraft(snapshot);
    expect(draft.sourceText).toBe("Saved text\n");
    expect(draft.sourceBaseline).toBe("Saved text\n");
    expect(draft.sourceError).toBeNull();
    expect(isDocumentDraftDirty(draft)).toBe(false);
  });

  it("tracks lexical edits even when the parsed document is unchanged", () => {
    const initial = createDocumentDraft(snapshot);
    const changed = documentDraftReducer(initial, {
      type: "source",
      sourceText: "Saved text\n\n",
      content: snapshot.content,
      sourceError: null,
    });
    expect(changed.content.eq(initial.content)).toBe(true);
    expect(changed.sourceText).toBe("Saved text\n\n");
    expect(changed.sourceBaseline).toBe("Saved text\n");
    expect(changed.revision).toBe(initial.revision + 1);
    expect(isDocumentDraftDirty(changed)).toBe(true);
    const undone = documentDraftReducer(changed, {
      type: "source",
      sourceText: "Saved text\n",
      content: snapshot.content,
      sourceError: null,
    });
    expect(isDocumentDraftDirty(undone)).toBe(false);
    expect(undone.revision).toBe(changed.revision + 1);
  });

  it("preserves invalid raw text and the last valid parsed content", () => {
    const initial = createDocumentDraft(snapshot);
    const invalid = documentDraftReducer(initial, {
      type: "source",
      sourceText: "![private](data:image/png;base64,secret)",
      sourceError: "Markdown contains content that cannot be saved.",
    });
    expect(invalid.content).toBe(initial.content);
    expect(invalid.sourceText).toBe("![private](data:image/png;base64,secret)");
    expect(invalid.sourceError).toBe(
      "Markdown contains content that cannot be saved.",
    );
    expect(invalid.revision).toBe(initial.revision + 1);
    expect(isDocumentDraftDirty(invalid)).toBe(true);
    const valid = documentDraftReducer(invalid, {
      type: "source",
      sourceText: "Recovered text",
      content: content("Recovered text"),
      sourceError: null,
    });
    expect(valid.content.textContent).toBe("Recovered text");
    expect(valid.sourceText).toBe("Recovered text");
    expect(valid.sourceError).toBeNull();
  });

  it("does not replace raw lexical edits or errors for an unchanged editor event", () => {
    const invalid = documentDraftReducer(createDocumentDraft(snapshot), {
      type: "source",
      sourceText: "invalid draft",
      sourceError: "Markdown contains content that cannot be saved.",
    });
    expect(
      documentDraftReducer(invalid, {
        type: "content",
        content: content("Saved text"),
      }),
    ).toBe(invalid);
    expect(
      documentDraftReducer(invalid, {
        type: "source",
        sourceText: invalid.sourceText,
        sourceError: invalid.sourceError,
      }),
    ).toBe(invalid);
    const edited = documentDraftReducer(invalid, {
      type: "content",
      content: content("Editor edit"),
    });
    expect(edited.sourceText).toBe("Editor edit\n");
    expect(edited.sourceError).toBeNull();
    expect(edited.sourceBaseline).toBe("Saved text\n");
  });

  it("canonicalizes lexical-only edits when their save is acknowledged", () => {
    const submitted = documentDraftReducer(createDocumentDraft(snapshot), {
      type: "source",
      sourceText: "Saved text\n\n",
      content: snapshot.content,
      sourceError: null,
    });
    const saved = documentDraftReducer(submitted, {
      type: "saved",
      submittedRevision: submitted.revision,
      snapshot: { ...snapshot, baseCommitSha: "b".repeat(40) },
    });
    expect(saved.sourceText).toBe("Saved text\n");
    expect(saved.sourceBaseline).toBe("Saved text\n");
    expect(saved.sourceError).toBeNull();
    expect(isDocumentDraftDirty(saved)).toBe(false);
  });

  it("retains later lexical edits while advancing the saved source baseline", () => {
    const submitted = documentDraftReducer(createDocumentDraft(snapshot), {
      type: "source",
      sourceText: "Submitted text",
      content: content("Submitted text"),
      sourceError: null,
    });
    const later = documentDraftReducer(submitted, {
      type: "source",
      sourceText: "Submitted text\n\n",
      content: submitted.content,
      sourceError: null,
    });
    const saved = documentDraftReducer(later, {
      type: "saved",
      submittedRevision: submitted.revision,
      snapshot: {
        ...snapshot,
        content: submitted.content,
        baseCommitSha: "b".repeat(40),
      },
    });
    expect(saved.sourceText).toBe("Submitted text\n\n");
    expect(saved.sourceBaseline).toBe("Submitted text\n");
    expect(saved.revision).toBe(later.revision);
    expect(saved.content.eq(saved.baseline.content)).toBe(true);
    expect(isDocumentDraftDirty(saved)).toBe(true);
  });

  it("protects raw-only edits from refreshes, including stale refreshes after lexical undo", () => {
    const initial = createDocumentDraft(snapshot);
    const refresh = {
      type: "refresh" as const,
      requestedRevision: initial.revision,
      expectedBaseCommitSha: snapshot.baseCommitSha,
      snapshot: {
        ...snapshot,
        content: content("Server text"),
        baseCommitSha: "b".repeat(40),
      },
    };
    const edited = documentDraftReducer(initial, {
      type: "source",
      sourceText: "Saved text\n\n",
      sourceError: null,
    });
    expect(
      documentDraftReducer(edited, {
        ...refresh,
        requestedRevision: edited.revision,
      }),
    ).toBe(edited);
    const undone = documentDraftReducer(edited, {
      type: "source",
      sourceText: "Saved text\n",
      sourceError: null,
    });
    expect(isDocumentDraftDirty(undone)).toBe(false);
    expect(documentDraftReducer(undone, refresh)).toBe(undone);
    const refreshed = documentDraftReducer(undone, {
      ...refresh,
      requestedRevision: undone.revision,
    });
    expect(refreshed.sourceText).toBe("Server text\n");
    expect(refreshed.sourceBaseline).toBe("Server text\n");
    expect(refreshed.sourceError).toBeNull();
  });

  it("resets invalid raw text coherently on discard and reload", () => {
    const invalid = documentDraftReducer(createDocumentDraft(snapshot), {
      type: "source",
      sourceText: "Invalid raw text",
      sourceError: "Markdown contains content that cannot be saved.",
    });
    const discarded = documentDraftReducer(invalid, { type: "discard" });
    expect(discarded.sourceText).toBe("Saved text\n");
    expect(discarded.sourceBaseline).toBe("Saved text\n");
    expect(discarded.sourceError).toBeNull();
    expect(isDocumentDraftDirty(discarded)).toBe(false);
    const reloaded = documentDraftReducer(invalid, {
      type: "reload",
      snapshot: {
        ...snapshot,
        content: content("Server text"),
        baseCommitSha: "b".repeat(40),
      },
    });
    expect(reloaded.sourceText).toBe("Server text\n");
    expect(reloaded.sourceBaseline).toBe("Server text\n");
    expect(reloaded.sourceError).toBeNull();
    expect(isDocumentDraftDirty(reloaded)).toBe(false);
  });
});

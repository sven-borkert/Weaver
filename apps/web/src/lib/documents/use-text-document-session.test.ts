import { describe, expect, it } from "vitest";
import {
  isTextDraftDirty,
  textDraftReducer,
  type TextDraftBaseline,
  type TextDraftState,
} from "./use-text-document-session";

const baseline: TextDraftBaseline = {
  title: "Script",
  text: "print('hi')\n",
  path: "script.py",
  slug: "script",
  baseCommitSha: "a".repeat(40),
};
const clean: TextDraftState = {
  title: baseline.title,
  text: baseline.text,
  baseline,
  revision: 0,
  textResetKey: 0,
};
const next: TextDraftBaseline = {
  ...baseline,
  text: "print('saved')\n",
  baseCommitSha: "b".repeat(40),
};

describe("text draft lifecycle", () => {
  it("bumps the reset key on external replacements only", () => {
    const edited = textDraftReducer(clean, { type: "text", text: "x = 1\n" });
    expect(edited.textResetKey).toBe(0);
    const titled = textDraftReducer(edited, { type: "title", title: "T" });
    expect(titled.textResetKey).toBe(0);
    expect(textDraftReducer(edited, { type: "discard" }).textResetKey).toBe(1);
    expect(
      textDraftReducer(edited, { type: "reload", baseline: next }).textResetKey,
    ).toBe(1);
    expect(
      textDraftReducer(clean, {
        type: "refresh",
        baseline: next,
        expectedBaseCommitSha: baseline.baseCommitSha,
      }).textResetKey,
    ).toBe(1);
  });

  it("bumps the reset key after a save only when normalization changed the text", () => {
    const unchanged = textDraftReducer(clean, {
      type: "text",
      text: "print('saved')\n",
    });
    expect(
      textDraftReducer(unchanged, {
        type: "saved",
        submittedRevision: unchanged.revision,
        baseline: next,
      }).textResetKey,
    ).toBe(0);
    const unterminated = textDraftReducer(clean, {
      type: "text",
      text: "print('saved')",
    });
    expect(
      textDraftReducer(unterminated, {
        type: "saved",
        submittedRevision: unterminated.revision,
        baseline: next,
      }).textResetKey,
    ).toBe(1);
  });

  it("is dirty after a text edit and clean after discard", () => {
    const edited = textDraftReducer(clean, { type: "text", text: "x = 1\n" });
    expect(isTextDraftDirty(edited)).toBe(true);
    expect(edited.revision).toBe(1);
    const discarded = textDraftReducer(edited, { type: "discard" });
    expect(isTextDraftDirty(discarded)).toBe(false);
    expect(discarded.text).toBe(baseline.text);
  });

  it("is dirty after a title edit and clean when the title returns", () => {
    let draft = textDraftReducer(clean, { type: "title", title: "Other" });
    expect(isTextDraftDirty(draft)).toBe(true);
    draft = textDraftReducer(draft, { type: "title", title: "Script" });
    expect(isTextDraftDirty(draft)).toBe(false);
  });

  it("adopts the saved baseline when nothing changed during the save", () => {
    const edited = textDraftReducer(clean, {
      type: "text",
      text: "print('saved')",
    });
    const saved = textDraftReducer(edited, {
      type: "saved",
      submittedRevision: edited.revision,
      baseline: next,
    });
    expect(isTextDraftDirty(saved)).toBe(false);
    expect(saved.text).toBe(next.text);
    expect(saved.baseline.baseCommitSha).toBe(next.baseCommitSha);
  });

  it("keeps edits made while saving dirty against the new baseline", () => {
    const edited = textDraftReducer(clean, {
      type: "text",
      text: "print('saved')\n",
    });
    const typedMore = textDraftReducer(edited, {
      type: "text",
      text: "print('saved')\nmore\n",
    });
    const saved = textDraftReducer(typedMore, {
      type: "saved",
      submittedRevision: edited.revision,
      baseline: next,
    });
    expect(isTextDraftDirty(saved)).toBe(true);
    expect(saved.text).toBe("print('saved')\nmore\n");
    expect(saved.baseline).toEqual(next);
  });

  it("ignores a refresh while dirty", () => {
    const edited = textDraftReducer(clean, { type: "text", text: "x = 1\n" });
    const refreshed = textDraftReducer(edited, {
      type: "refresh",
      baseline: next,
      expectedBaseCommitSha: baseline.baseCommitSha,
    });
    expect(refreshed).toBe(edited);
  });

  it("ignores a refresh based on a different commit", () => {
    const refreshed = textDraftReducer(clean, {
      type: "refresh",
      baseline: next,
      expectedBaseCommitSha: "c".repeat(40),
    });
    expect(refreshed).toBe(clean);
  });

  it("applies a refresh to a clean draft", () => {
    const refreshed = textDraftReducer(clean, {
      type: "refresh",
      baseline: next,
      expectedBaseCommitSha: baseline.baseCommitSha,
    });
    expect(refreshed.text).toBe(next.text);
    expect(isTextDraftDirty(refreshed)).toBe(false);
  });

  it("replaces draft and baseline on reload", () => {
    const edited = textDraftReducer(clean, { type: "text", text: "x = 1\n" });
    const reloaded = textDraftReducer(edited, {
      type: "reload",
      baseline: next,
    });
    expect(reloaded.text).toBe(next.text);
    expect(isTextDraftDirty(reloaded)).toBe(false);
  });
});

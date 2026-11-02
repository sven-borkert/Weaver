import { Editor } from "@tiptap/react";
import { history } from "@tiptap/pm/history";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDocumentSession,
  type MarkdownDocument,
} from "./use-document-session";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  fetch: vi.fn(),
  invalidate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      document: {
        get: { invalidate: mocks.invalidate, fetch: mocks.fetch },
        list: { invalidate: mocks.invalidate },
        history: { invalidate: mocks.invalidate },
        backlinks: { invalidate: mocks.invalidate },
        resolveRefs: { invalidate: mocks.invalidate },
      },
      table: {
        get: { invalidate: mocks.invalidate },
        list: { invalidate: mocks.invalidate },
        backlinks: { invalidate: mocks.invalidate },
      },
      folder: { tree: { invalidate: mocks.invalidate } },
    }),
    document: {
      update: { useMutation: () => ({ mutateAsync: mocks.mutateAsync }) },
    },
  },
}));

const content = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const initialDocument: MarkdownDocument = {
  id: "document",
  path: "overview.md",
  slug: "overview",
  title: "Overview",
  baseCommitSha: "a".repeat(40),
  kind: "markdown",
  content: { kind: "markdown", contentJson: content("Saved text") },
  lastEditedAt: new Date("2026-09-14T12:00:00Z"),
  lastEditedById: null,
  lastEditedBy: null,
  machineEditor: null,
  createdAt: new Date("2026-09-14T12:00:00Z"),
  createdBy: null,
  updatedAt: new Date("2026-09-14T12:00:00Z"),
  updatedBy: null,
  appearance: null,
  review: null,
};
const savedDocument: MarkdownDocument = {
  ...initialDocument,
  baseCommitSha: "b".repeat(40),
  content: { kind: "markdown", contentJson: content("Submitted text") },
};
const savedResult = {
  id: initialDocument.id,
  path: initialDocument.path,
  slug: initialDocument.slug,
  title: initialDocument.title,
  headCommitSha: savedDocument.baseCommitSha,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const cleanups: (() => void)[] = [];

async function mountSession() {
  const editor = new Editor({
    element: null,
    extensions: documentExtensions(),
    content: initialDocument.content.contentJson,
  });
  // Keep real TipTap state and transactions while simulating a live view in Node.
  vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
  let session!: ReturnType<typeof useDocumentSession>;
  let renderer!: ReactTestRenderer;
  let canEdit = true;
  let uploadsPending = false;
  let document = initialDocument;
  const cancelUploads = vi.fn(() => {
    uploadsPending = false;
  });
  function Harness() {
    session = useDocumentSession({
      editor,
      document,
      projectId: "project",
      canEdit,
      hasPendingUploads: () => uploadsPending,
      cancelUploads,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  cleanups.push(() => {
    renderer.unmount();
    editor.destroy();
  });
  return {
    editor,
    get session() {
      return session;
    },
    setUploadsPending(value: boolean) {
      uploadsPending = value;
    },
    async edit(text = "Submitted text") {
      await act(async () => {
        editor.commands.setContent(content(text));
      });
    },
    async rerender(options: {
      canEdit?: boolean;
      document?: MarkdownDocument;
    }) {
      canEdit = options.canEdit ?? canEdit;
      document = options.document ?? document;
      await act(async () => {
        renderer.update(<Harness />);
      });
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(savedDocument);
  mocks.mutateAsync.mockResolvedValue(savedResult);
});

afterEach(async () => {
  await act(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("document session save lifecycle", () => {
  it("saves raw input supplied in the same event before React rerenders", async () => {
    const mounted = await mountSession();
    await act(async () => {
      mounted.session.setSourceText("Same-event raw text\n");
      await mounted.session.save();
    });
    expect(mocks.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          kind: "markdown",
          contentJson: content("Same-event raw text"),
        },
      }),
    );
  });

  it("keeps source and dirty state coherent through formatted undo and redo of raw edits", async () => {
    const mounted = await mountSession();
    mounted.editor.view.updateState(
      mounted.editor.state.reconfigure({ plugins: [history()] }),
    );
    const baseline = mounted.session.draft.sourceText;
    await act(() => mounted.session.setSourceText("__Raw undo text__\n"));
    const reset = mounted.session.sourceResetKey;
    await act(() => {
      mounted.editor.commands.undo();
    });
    expect(mounted.editor.state.doc.textContent).toBe("Saved text");
    expect(mounted.session.draft.sourceText).toBe(baseline);
    expect(mounted.session.dirty).toBe(false);
    expect(mounted.session.sourceResetKey).toBeGreaterThan(reset);
    await act(() => {
      mounted.editor.commands.redo();
    });
    expect(mounted.editor.state.doc.textContent).toBe("Raw undo text");
    expect(mounted.session.draft.sourceText).toBe("**Raw undo text**\n");
    expect(mounted.session.dirty).toBe(true);
  });

  it("keeps typed Markdown literal while updating formatted content and saving one snapshot", async () => {
    const mounted = await mountSession();
    await act(() =>
      mounted.session.setSourceText("## Raw heading\n\n**Raw text**\n"),
    );
    expect(mounted.session.draft.sourceText).toBe(
      "## Raw heading\n\n**Raw text**\n",
    );
    expect(mounted.editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(mounted.editor.state.doc.textContent).toBe("Raw headingRaw text");
    expect(mounted.session.dirty).toBe(true);
    mocks.fetch.mockRejectedValue(new Error("offline after save"));
    await act(() => mounted.session.save());
    expect(mocks.mutateAsync).toHaveBeenCalledOnce();
    expect(mounted.session.dirty).toBe(false);
    expect(mounted.session.draft.sourceText).toContain("**Raw text**");
  });

  it("tracks lexical-only drafts through refresh protection, native undo and discard", async () => {
    const mounted = await mountSession();
    const baseline = mounted.session.draft.sourceText;
    await act(() => mounted.session.setSourceText(`${baseline}\n`));
    expect(mounted.session.dirty).toBe(true);
    await mounted.rerender({ document: savedDocument });
    expect(mounted.session.draft.sourceText).toBe(`${baseline}\n`);
    expect(mounted.session.draft.baseline.baseCommitSha).toBe(
      initialDocument.baseCommitSha,
    );
    await act(() => mounted.session.setSourceText(baseline));
    expect(mounted.session.dirty).toBe(false);
    await act(() => mounted.session.setSourceText("Discard this raw draft"));
    const reset = mounted.session.sourceResetKey;
    await act(() => mounted.session.discard());
    expect(mounted.session.draft.sourceText).toBe(baseline);
    expect(mounted.session.sourceResetKey).toBeGreaterThan(reset);
    expect(mounted.session.dirty).toBe(false);
  });

  it("preserves invalid raw input, blocks save and formatted mode, and accepts a correction", async () => {
    const mounted = await mountSession();
    const invalid = "![bad](data:image/png;base64,AAAA)";
    await act(() => mounted.session.setSourceText(invalid));
    expect(mounted.session.draft.sourceText).toBe(invalid);
    expect(mounted.editor.state.doc.textContent).toBe("Saved text");
    expect(mounted.session.dirty).toBe(true);
    await act(() => mounted.session.save());
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(mounted.session.sourceError).toBe(
      "Markdown contains content that cannot be saved.",
    );
    let valid = true;
    await act(() => {
      valid = mounted.session.validateSource();
    });
    expect(valid).toBe(false);
    await act(() => mounted.session.setSourceText("Corrected Markdown\n"));
    expect(mounted.session.draft.sourceError).toBeNull();
    await act(() => {
      valid = mounted.session.validateSource();
    });
    expect(valid).toBe(true);
    expect(mounted.editor.state.doc.textContent).toBe("Corrected Markdown");
  });

  it("locks raw input for uploads, saves and permission loss", async () => {
    const mounted = await mountSession();
    const baseline = mounted.session.draft.sourceText;
    mounted.setUploadsPending(true);
    await act(() => mounted.session.setSourceText("Cannot race the upload"));
    expect(mounted.session.draft.sourceText).toBe(baseline);
    mounted.setUploadsPending(false);
    await act(() => mounted.session.setSourceText("Submitted raw\n"));
    const pending = deferred<typeof savedResult>();
    mocks.mutateAsync.mockReturnValue(pending.promise);
    let saving!: Promise<void>;
    await act(() => {
      saving = mounted.session.save();
    });
    await act(() => mounted.session.setSourceText("Too late"));
    expect(mounted.session.draft.sourceText).toBe("Submitted raw\n");
    await act(async () => {
      pending.resolve(savedResult);
      await saving;
    });
    await mounted.rerender({ canEdit: false });
    const retained = mounted.session.draft.sourceText;
    await act(() => mounted.session.setSourceText("Forbidden"));
    expect(mounted.session.draft.sourceText).toBe(retained);
  });

  it("serializes same-tick saves before React can render pending state", async () => {
    const pending = deferred<typeof savedResult>();
    mocks.mutateAsync.mockReturnValue(pending.promise);
    const mounted = await mountSession();
    await mounted.edit();
    let first!: Promise<void>;
    await act(async () => {
      first = mounted.session.save();
      await mounted.session.save();
    });
    expect(mocks.mutateAsync).toHaveBeenCalledOnce();
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      projectId: "project",
      documentId: initialDocument.id,
      baseCommitSha: initialDocument.baseCommitSha,
      title: "Overview",
      content: { kind: "markdown", contentJson: content("Submitted text") },
    });
    expect(mounted.session.activity).toBe("save");
    expect(mounted.editor.isEditable).toBe(false);
    await act(async () => {
      pending.resolve(savedResult);
      await first;
    });
    expect(mounted.session.dirty).toBe(false);
    expect(mounted.session.activity).toBeNull();
    expect(mounted.editor.isEditable).toBe(true);
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it("blocks save while an upload is pending and saves the latest content after completion", async () => {
    const mounted = await mountSession();
    await mounted.edit();
    mounted.setUploadsPending(true);
    await act(async () => {
      await mounted.session.save();
    });
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(mounted.session.dirty).toBe(true);
    mounted.setUploadsPending(false);
    await act(async () => {
      await mounted.session.save();
    });
    expect(mocks.mutateAsync).toHaveBeenCalledOnce();
    expect(mounted.session.dirty).toBe(false);
  });

  it("preserves a dirty draft on permission loss while disabling the editor and save", async () => {
    const mounted = await mountSession();
    await mounted.edit();
    await act(async () => {
      mounted.session.setTitle("Draft title");
    });
    await mounted.rerender({
      canEdit: false,
      document: {
        ...savedDocument,
        title: "Remote title",
        content: { kind: "markdown", contentJson: content("Remote text") },
      },
    });
    await act(async () => {
      await mounted.session.save();
    });
    expect(mounted.editor.isEditable).toBe(false);
    expect(mounted.session.draft.title).toBe("Draft title");
    expect(mounted.session.draft.content.textContent).toBe("Submitted text");
    expect(mounted.session.draft.baseline.baseCommitSha).toBe(
      initialDocument.baseCommitSha,
    );
    expect(mounted.session.dirty).toBe(true);
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it.each(["fetch", "invalidation"])(
    "keeps a committed save successful when the follow-up %s fails",
    async (failure) => {
      if (failure === "fetch")
        mocks.fetch.mockRejectedValue(new Error("Refresh failed"));
      else mocks.invalidate.mockRejectedValue(new Error("Invalidation failed"));
      const mounted = await mountSession();
      await mounted.edit();
      await act(async () => {
        await mounted.session.save();
      });
      expect(mounted.session.draft.baseline.baseCommitSha).toBe(
        savedDocument.baseCommitSha,
      );
      expect(mounted.session.dirty).toBe(false);
      expect(mounted.session.saveError).toBeUndefined();
      expect(mounted.session.refreshError).toMatch(/saved/i);
      expect(mounted.session.activity).toBeNull();
      expect(mocks.success).toHaveBeenCalledWith("Document saved");
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );

  it("does not replace edits made while the saved document refresh is in flight", async () => {
    const refresh = deferred<MarkdownDocument>();
    mocks.fetch.mockReturnValue(refresh.promise);
    const mounted = await mountSession();
    await mounted.edit();
    await act(async () => {
      await mounted.session.save();
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mounted.editor.isEditable).toBe(true);
    await mounted.edit("A subsequent unsaved edit");
    await act(async () => {
      refresh.resolve(savedDocument);
      await refresh.promise;
    });
    expect(mounted.session.draft.content.textContent).toBe(
      "A subsequent unsaved edit",
    );
    expect(mounted.editor.state.doc.textContent).toBe(
      "A subsequent unsaved edit",
    );
    expect(mounted.session.draft.baseline.content.textContent).toBe(
      "Submitted text",
    );
    expect(mounted.session.draft.baseline.baseCommitSha).toBe(
      savedDocument.baseCommitSha,
    );
    expect(mounted.session.dirty).toBe(true);
  });

  it("keeps local content and its base revision when save encounters a conflict", async () => {
    mocks.mutateAsync.mockRejectedValue({ data: { code: "CONFLICT" } });
    const mounted = await mountSession();
    await mounted.edit();
    await act(async () => {
      await mounted.session.save();
    });
    expect(mounted.session.conflictOpen).toBe(true);
    expect(mounted.session.draft.content.textContent).toBe("Submitted text");
    expect(mounted.session.draft.baseline.baseCommitSha).toBe(
      initialDocument.baseCommitSha,
    );
    expect(mounted.session.dirty).toBe(true);
    expect(mounted.session.activity).toBeNull();
    expect(mounted.editor.isEditable).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("stays read-only when permission is lost during an in-flight save", async () => {
    const pending = deferred<typeof savedResult>();
    mocks.mutateAsync.mockReturnValue(pending.promise);
    const mounted = await mountSession();
    await mounted.edit();
    let saving!: Promise<void>;
    await act(async () => {
      saving = mounted.session.save();
    });
    await mounted.rerender({ canEdit: false });
    await act(async () => {
      pending.resolve(savedResult);
      await saving;
    });
    expect(mounted.session.activity).toBeNull();
    expect(mounted.editor.isEditable).toBe(false);
    expect(mounted.session.dirty).toBe(false);
  });
});

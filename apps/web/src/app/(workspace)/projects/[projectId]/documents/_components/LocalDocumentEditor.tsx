"use client";

import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { documentTitleSchema } from "@weaver/core/documents/title";
import { documentExtensions } from "@weaver/core/editor/extensions";
import {
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "@weaver/core/editor/markdown";
import { FileCode2, FileText, Save } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { resetDocumentHistory } from "~/lib/documents/draft-state";
import {
  parseDocumentMarkdown,
  serializeDocumentMarkdown,
} from "~/lib/documents/document-markdown";
import { documentEditingContent } from "~/lib/editor/document-editing-content";
import { DocumentImage } from "~/lib/editor/document-image";
import { classifyDocumentShortcut } from "~/lib/editor/document-shortcuts";
import { useDocumentSourceView } from "~/lib/editor/use-document-source-view";
import { useDocumentViewShortcuts } from "~/lib/editor/use-document-view-shortcuts";
import { queryErrorCode } from "~/lib/query-presentation";
import { useUnsavedChangesGuard } from "~/lib/use-unsaved-changes-guard";
import { api, type RouterOutputs } from "~/trpc/react";
import { DocumentDraftDialogs } from "./DocumentDraftDialogs";
import { DocumentEditingProvider } from "./DocumentEditingContext";
import { EditorToolbar } from "./EditorToolbar";
import { DocumentSourceView } from "./DocumentSourceView";
import {
  documentRichExtensions,
  insertDocumentMath,
  insertDocumentMermaid,
} from "./document-rich-extensions";

type LocalEntry = RouterOutputs["localDocument"]["get"];

function LocalImagePlaceholder({ node }: ReactNodeViewProps) {
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  return (
    <NodeViewWrapper className="border-line text-text-3 rounded-md border px-3 py-2 text-sm">
      {alt || "Image"}
    </NodeViewWrapper>
  );
}

const image = DocumentImage.configure({ resolveSrc: () => undefined }).extend({
  addNodeView() {
    return ReactNodeViewRenderer(LocalImagePlaceholder);
  },
});
const extensions = documentExtensions({ ...documentRichExtensions, image });

const readDraft = (entry: LocalEntry) => ({
  title: entry.title,
  markdown: entry.markdown ?? "",
});

function richContent(markdown: string) {
  try {
    const parsed = parseDocumentBody(markdown);
    validateDocumentContent(parsed);
    return { content: documentEditingContent(parsed), error: undefined };
  } catch {
    return {
      content: documentEditingContent({ type: "doc" }),
      error: "This Markdown could not be displayed in the formatted editor.",
    };
  }
}

export function LocalDocumentEditor({
  projectId,
  entry,
  canEdit,
}: {
  projectId: string;
  entry: LocalEntry;
  canEdit: boolean;
}) {
  const utils = api.useUtils();
  const update = api.localDocument.update.useMutation();
  const queryInput = { projectId, entryId: entry.id };
  const articleRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const locked = useRef(false);
  const [baseline, setBaseline] = useState(entry);
  const [draft, setDraft] = useState(() => readDraft(entry));
  const [initial] = useState(() => {
    const result = richContent(draft.markdown);
    return { ...result, canonical: serializeDocumentBody(result.content) };
  });
  const [sourceError, setSourceError] = useState(initial.error);
  const [sourceFallback, setSourceFallback] = useState(Boolean(initial.error));
  const [saveError, setSaveError] = useState<string>();
  const [titleError, setTitleError] = useState<string>();
  const [conflictError, setConflictError] = useState<string>();
  const [discardOpen, setDiscardOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [transientOpen, setTransientOpen] = useState(false);
  const [activity, setActivity] = useState<
    "save" | "reload" | "overwrite" | null
  >(null);
  const provenance = useRef({
    canonical: initial.canonical,
    markdown: draft.markdown,
  });
  const busy = activity !== null;
  const disabled = !canEdit || busy;
  const { sourceOpen, setSourceOpen, sourceRef, sourceInputRef } =
    useDocumentSourceView({ articleRef });
  const showingSource = sourceOpen || sourceFallback;
  const dirty =
    draft.title !== baseline.title ||
    draft.markdown !== (baseline.markdown ?? "") ||
    Boolean(sourceError && !showingSource);
  const editor = useEditor({
    extensions,
    content: initial.content,
    editable: canEdit,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "document-prose min-h-[420px] outline-none",
        "aria-label": "Document content",
        "aria-multiline": "true",
        role: "textbox",
      },
    },
    onUpdate: ({ editor: updated }) => {
      if (locked.current) return;
      try {
        const canonical = serializeDocumentMarkdown(updated.state.doc);
        const markdown =
          canonical === provenance.current.canonical
            ? provenance.current.markdown
            : canonical;
        setDraft((current) => ({ ...current, markdown }));
        setSourceError(undefined);
      } catch {
        setSourceError(
          "The formatted content could not be converted to Markdown.",
        );
      }
    },
  });

  useUnsavedChangesGuard(dirty || busy);
  useLayoutEffect(() => {
    editor?.setEditable(canEdit && !busy && !showingSource, false);
    editor?.view.dom.setAttribute("aria-readonly", String(!canEdit || busy));
  }, [editor, canEdit, busy, showingSource]);

  function resetDraft(latest: LocalEntry) {
    if (!editor || editor.isDestroyed) return;
    const next = readDraft(latest);
    const { content, error } = richContent(next.markdown);
    const node = editor.schema.nodeFromJSON(content);
    editor.view.updateState(resetDocumentHistory(editor.state, node));
    provenance.current = {
      canonical: serializeDocumentMarkdown(node),
      markdown: next.markdown,
    };
    setSourceFallback(Boolean(error));
    setBaseline(latest);
    setDraft(next);
    setSourceError(error);
    setTitleError(undefined);
    setSaveError(undefined);
    setConflictError(undefined);
  }

  const receiveLatest = useEffectEvent(() => {
    if (
      !dirty &&
      !busy &&
      !editor?.isFocused &&
      entry.revision > baseline.revision
    )
      resetDraft(entry);
  });
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => receiveLatest());
    return () => window.cancelAnimationFrame(frame);
  }, [entry, dirty, busy, editor]);

  const toggleSource = () => {
    if (!editor || busy) return;
    if (!showingSource) {
      if (!sourceError) setSourceOpen(true);
      return;
    }
    try {
      const content = parseDocumentMarkdown(editor.schema, draft.markdown);
      provenance.current = {
        canonical: serializeDocumentMarkdown(content),
        markdown: draft.markdown,
      };
      if (!editor.state.doc.eq(content))
        editor.commands.setContent(content, { emitUpdate: false });
      setSourceError(undefined);
      setSourceFallback(false);
      setSourceOpen(false);
    } catch {
      setSourceError(
        "This Markdown could not be displayed in the formatted editor.",
      );
    }
  };

  useDocumentViewShortcuts({
    articleRef,
    titleRef,
    sourceRef,
    blocked: busy || discardOpen || conflictOpen || transientOpen,
    onToggleSource: toggleSource,
  });

  async function fetchLatest() {
    await utils.localDocument.get.invalidate(queryInput, {
      refetchType: "none",
    });
    return utils.localDocument.get.fetch(queryInput);
  }

  const reload = async () => {
    if (!editor || locked.current) return;
    locked.current = true;
    setActivity("reload");
    setConflictError(undefined);
    try {
      const latest = await fetchLatest();
      resetDraft(latest);
      setConflictOpen(false);
    } catch {
      setConflictError(
        "Could not reload the latest version. Your draft is still here.",
      );
    } finally {
      locked.current = false;
      setActivity(null);
    }
  };

  const save = async (overwrite = false) => {
    if (!editor || !canEdit || !dirty || locked.current) return;
    const title = documentTitleSchema.safeParse(draft.title);
    if (!title.success) {
      setTitleError("Enter a title of 1 to 200 characters on a single line.");
      titleRef.current?.focus();
      return;
    }
    setSaveError(undefined);
    setTitleError(undefined);
    setConflictError(undefined);
    if (sourceError && !showingSource) return;
    const titleChanged = overwrite || title.data !== baseline.title;
    const markdownChanged =
      overwrite || draft.markdown !== (baseline.markdown ?? "");
    if (!titleChanged && !markdownChanged) {
      setDraft(readDraft(baseline));
      return;
    }
    if (markdownChanged) {
      if (draft.markdown.length > MAX_MARKDOWN_CHARS) {
        setSaveError("Markdown exceeds the document size limit.");
        return;
      }
      try {
        parseDocumentMarkdown(editor.schema, draft.markdown);
      } catch {
        setSaveError("Review the Markdown before saving.");
        return;
      }
    }

    locked.current = true;
    editor.setEditable(false, false);
    setActivity(overwrite ? "overwrite" : "save");
    try {
      const revision = overwrite
        ? (await fetchLatest()).revision
        : baseline.revision;
      const saved = await update.mutateAsync({
        ...queryInput,
        revision,
        ...(titleChanged ? { title: title.data } : {}),
        ...(markdownChanged ? { markdown: draft.markdown } : {}),
      });
      setBaseline(saved);
      setDraft(readDraft(saved));
      if (!showingSource)
        provenance.current = {
          canonical:
            draft.markdown === provenance.current.markdown
              ? provenance.current.canonical
              : draft.markdown,
          markdown: saved.markdown ?? "",
        };
      utils.localDocument.get.setData(queryInput, saved);
      void utils.localDocument.list.invalidate({ projectId });
      setConflictOpen(false);
      toast.success("Document saved");
    } catch (error) {
      const data = (error as { data?: { field?: string } }).data;
      if (queryErrorCode(error) === "CONFLICT" && data?.field === "title") {
        setTitleError("This folder already contains an item with that name.");
        setConflictOpen(false);
      } else if (data?.field === "markdown") {
        setSaveError("Review the Markdown before saving.");
        setConflictOpen(false);
      } else if (queryErrorCode(error) === "CONFLICT") {
        setConflictError(
          overwrite ? "The document changed again. Try again." : undefined,
        );
        setConflictOpen(true);
      } else {
        const message =
          "Could not save the document. Your draft is still here.";
        if (overwrite) setConflictError(message);
        else setSaveError(message);
      }
    } finally {
      locked.current = false;
      setActivity(null);
    }
  };

  if (!canEdit && (discardOpen || conflictOpen)) {
    setDiscardOpen(false);
    setConflictOpen(false);
  }

  return (
    <article
      ref={articleRef}
      className="mt-4 min-w-0"
      aria-busy={busy}
      onKeyDownCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || event.defaultPrevented) return;
        const context = target.closest(
          "[role='dialog'],[role='alertdialog'],[role='menu']",
        )
          ? "overlay"
          : target === titleRef.current
            ? "title"
            : sourceRef.current?.contains(target)
              ? "source"
              : target.closest("input, textarea, select")
                ? "unrelated-input"
                : "document";
        if (
          !canEdit ||
          classifyDocumentShortcut(event.nativeEvent, context) !== "save"
        )
          return;
        event.preventDefault();
        if (!discardOpen && !conflictOpen && !transientOpen) void save();
      }}
    >
      <div className="mb-4">
        {canEdit ? (
          <>
            <h1 className="sr-only">Edit document</h1>
            <label htmlFor={titleId} className="sr-only">
              Document title
            </label>
            <Input
              ref={titleRef}
              id={titleId}
              value={draft.title}
              disabled={disabled}
              aria-invalid={Boolean(titleError)}
              aria-describedby={titleError ? `${titleId}-error` : undefined}
              className="h-auto px-2 py-1.5 text-xl font-semibold md:text-xl"
              onChange={(event) => {
                const title = event.target.value;
                setTitleError(undefined);
                setDraft((current) => ({ ...current, title }));
              }}
            />
            {titleError ? (
              <p
                id={`${titleId}-error`}
                role="alert"
                className="text-danger mt-1 text-sm"
              >
                {titleError}
              </p>
            ) : null}
          </>
        ) : (
          <h1 className="text-text text-2xl font-semibold wrap-break-word">
            {baseline.title}
          </h1>
        )}
      </div>
      <div className="border-line bg-surface-2 mb-4 flex min-w-0 flex-col justify-between gap-2 rounded-md border p-1.5 sm:flex-row sm:items-center">
        {editor && canEdit ? (
          <EditorToolbar
            editor={editor}
            disabled={disabled}
            sourceOpen={showingSource}
            projectId={projectId}
            allowImages={false}
            onMermaid={() => insertDocumentMermaid(editor)}
            onMath={(type) => insertDocumentMath(editor, type)}
            onTransientOpenChange={setTransientOpen}
            onViewSource={toggleSource}
          />
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={showingSource}
            onClick={toggleSource}
            disabled={!editor}
          >
            {showingSource ? (
              <FileText data-icon="inline-start" />
            ) : (
              <FileCode2 data-icon="inline-start" />
            )}
            {showingSource ? "Formatted" : "Source"}
          </Button>
        )}
        {canEdit ? (
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!dirty || disabled}
              onClick={() => setDiscardOpen(true)}
            >
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!editor || !dirty || disabled}
              onClick={() => void save()}
            >
              <Save data-icon="inline-start" />
              {activity === "save" ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </div>
      {saveError || sourceError ? (
        <p role="alert" className="text-danger mb-3 text-sm">
          {saveError ?? sourceError}
        </p>
      ) : null}
      <div hidden={showingSource} inert={showingSource}>
        <DocumentEditingProvider disabled={disabled || showingSource}>
          <EditorContent editor={editor} />
        </DocumentEditingProvider>
      </div>
      <DocumentSourceView
        value={draft.markdown}
        onChange={(markdown) => {
          setSaveError(undefined);
          setSourceError(undefined);
          setDraft((current) => ({ ...current, markdown }));
        }}
        readOnly={disabled || !editor}
        open={showingSource}
        regionRef={sourceRef}
        inputRef={sourceInputRef}
      />
      {canEdit ? (
        <DocumentDraftDialogs
          discardOpen={discardOpen}
          onDiscardOpenChange={setDiscardOpen}
          onDiscard={() => {
            resetDraft(baseline);
            setDiscardOpen(false);
          }}
          conflictOpen={conflictOpen}
          onConflictOpenChange={setConflictOpen}
          conflictError={conflictError}
          busy={busy}
          activity={activity}
          canEdit={canEdit}
          onOverwrite={() => void save(true)}
          onReload={() => void reload()}
        />
      ) : null}
    </article>
  );
}

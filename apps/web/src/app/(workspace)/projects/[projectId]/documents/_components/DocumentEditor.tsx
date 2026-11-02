"use client";

import {
  EditorContent,
  ReactNodeViewRenderer,
  useEditor,
  type Editor,
  type JSONContent,
} from "@tiptap/react";
import { Save } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { InlineMath, MathBlock } from "@weaver/core/editor/math";
import { Mermaid } from "@weaver/core/editor/mermaid";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { isDocumentImageFile } from "~/lib/documents/image-upload";
import { useDocumentImages } from "~/lib/documents/use-document-images";
import {
  useDocumentSession,
  type MarkdownDocument,
} from "~/lib/documents/use-document-session";
import type { DocumentSectionNavigation } from "~/lib/documents/section-navigation";
import { createCrossrefTrigger } from "~/lib/editor/crossref-trigger";
import { documentEditingContent } from "~/lib/editor/document-editing-content";
import { DocumentImage } from "~/lib/editor/document-image";
import { DocumentSectionAnchors } from "~/lib/editor/document-section-anchors";
import { classifyDocumentShortcut } from "~/lib/editor/document-shortcuts";
import { useDocumentViewShortcuts } from "~/lib/editor/use-document-view-shortcuts";
import { useDocumentSourceView } from "~/lib/editor/use-document-source-view";
import { useUnsavedChangesGuard } from "~/lib/use-unsaved-changes-guard";
import { EditorToolbar } from "./EditorToolbar";
import { DocumentWorkspaceToolbar } from "./DocumentsWorkspace";
import {
  DocumentCrossref,
  DocumentReferenceProvider,
} from "./DocumentCrossref";
import { DocumentEditingProvider } from "./DocumentEditingContext";
import {
  DocumentImageNodeView,
  DocumentImageProvider,
} from "./DocumentImageNodeView";
import { DocumentActionsMenu } from "./DocumentActionsMenu";
import { DocumentDraftDialogs } from "./DocumentDraftDialogs";
import { CodeBlockWithCopy } from "./DocumentCodeBlock";
import { DocumentHeader } from "./DocumentHeader";
import { DocumentSectionStatus } from "./DocumentSectionStatus";
import { DocumentSourceView } from "./DocumentSourceView";
import { MathNodeView } from "./MathNodeView";
import { MermaidNodeView } from "./MermaidNodeView";
import { useDocumentPresentation } from "./useDocumentPresentation";

const ImageWithNodeView = DocumentImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentImageNodeView);
  },
});

const MermaidWithNodeView = Mermaid.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },
});

const InlineMathWithNodeView = InlineMath.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView, { as: "span" });
  },
});

const MathBlockWithNodeView = MathBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },
});

type DocumentEditorProps = {
  projectId: string;
  document: MarkdownDocument;
  canEdit: boolean;
  sectionNavigation?: DocumentSectionNavigation;
  onDirtyChange: (dirty: boolean) => void;
  /** Receives the live editor (null once it is gone) for the Contents outline. */
  onEditorChange?: (editor: Editor | null) => void;
};
type UploadHandler = (files: File[], position?: number) => Promise<void>;

export function DocumentEditor(props: DocumentEditorProps) {
  const { document, canEdit, onEditorChange } = props;
  const uploadRef = useRef<UploadHandler | null>(null);
  const [crossReferenceOpen, setCrossReferenceOpen] = useState(false);
  const openReference = useCallback(() => setCrossReferenceOpen(true), []);
  const extensions = useMemo(
    () => [
      ...documentExtensions({
        mermaid: MermaidWithNodeView,
        inlineMath: InlineMathWithNodeView,
        mathBlock: MathBlockWithNodeView,
        crossref: DocumentCrossref,
        image: ImageWithNodeView,
        codeBlock: CodeBlockWithCopy,
      }),
      DocumentSectionAnchors,
      createCrossrefTrigger(openReference),
    ],
    [openReference],
  );
  const editor = useEditor(
    {
      extensions,
      content: documentEditingContent(document.content.contentJson),
      editable: canEdit,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "document-prose min-h-[420px] outline-none",
          "aria-label": "Document content",
          "aria-multiline": "true",
          role: "textbox",
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter(
            isDocumentImageFile,
          );
          if (!files.length || !uploadRef.current) return false;
          event.preventDefault();
          void uploadRef.current(files);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter(
            isDocumentImageFile,
          );
          if (moved || !files.length || !uploadRef.current) return false;
          event.preventDefault();
          void uploadRef.current(
            files,
            view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos,
          );
          return true;
        },
      },
    },
    [document.id],
  );
  useEffect(() => {
    onEditorChange?.(editor);
    return () => onEditorChange?.(null);
  }, [editor, onEditorChange]);

  if (!editor)
    return (
      <article className="document-prose w-full px-6 py-8">
        <DocumentHeader document={document} />
        <div role="status" aria-label="Preparing document editor">
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="mt-4 h-5 w-full" />
          <Skeleton className="mt-4 h-32 w-full" />
        </div>
      </article>
    );
  return (
    <DocumentDraftEditor
      {...props}
      editor={editor}
      uploadRef={uploadRef}
      crossReferenceOpen={crossReferenceOpen}
      setCrossReferenceOpen={setCrossReferenceOpen}
    />
  );
}

function DocumentDraftEditor({
  projectId,
  document,
  canEdit,
  sectionNavigation,
  onDirtyChange,
  editor,
  uploadRef,
  crossReferenceOpen,
  setCrossReferenceOpen,
}: DocumentEditorProps & {
  editor: Editor;
  uploadRef: RefObject<UploadHandler | null>;
  crossReferenceOpen: boolean;
  setCrossReferenceOpen: (open: boolean) => void;
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [transientOpen, setTransientOpen] = useState(false);
  const images = useDocumentImages({
    editor,
    projectId,
    documentId: document.id,
    canEdit,
  });
  const session = useDocumentSession({
    editor,
    document,
    projectId,
    canEdit,
    hasPendingUploads: images.hasPending,
    cancelUploads: images.cancel,
  });
  const { draft, activity } = session;
  const busy = activity !== null;
  const disabled = !canEdit || busy;
  const hasChanges = session.dirty || images.pending > 0;
  const {
    articleRef,
    titleRef: sectionTitleRef,
    referenceState,
    referenceStatus,
    sectionAnnouncement,
    sectionNavigationKey,
  } = useDocumentPresentation({
    projectId,
    document: {
      ...document,
      ...draft.baseline,
      content: {
        kind: "markdown",
        contentJson: draft.baseline.content.toJSON() as JSONContent,
      },
    },
    editor,
    sectionNavigation,
    sectionNavigationReady: !draft.sourceError,
  });
  const { sourceOpen, setSourceOpen, sourceRef, sourceInputRef } =
    useDocumentSourceView({
      articleRef,
      navigationKey: sectionNavigationKey,
      canShowFormatted: !draft.sourceError,
    });
  const toggleSource = () => {
    if (sourceOpen && !session.validateSource()) return;
    setSourceOpen((open) => !open);
  };
  useDocumentViewShortcuts({
    articleRef,
    titleRef,
    sourceRef,
    blocked: transientOpen || discardOpen || session.conflictOpen,
    onToggleSource: toggleSource,
  });
  useUnsavedChangesGuard(hasChanges);

  useEffect(() => {
    onDirtyChange(hasChanges);
  }, [hasChanges, onDirtyChange]);
  useLayoutEffect(() => {
    uploadRef.current = images.upload;
    return () => {
      uploadRef.current = null;
    };
  }, [images.upload, uploadRef]);
  useLayoutEffect(() => {
    const input = titleRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(input);
    return () => observer.disconnect();
  }, [draft.title]);
  useLayoutEffect(() => {
    const article = articleRef.current;
    const header = article?.querySelector<HTMLElement>(":scope > header");
    if (!article || !header) return;
    // Section jumps stop below the sticky title (see globals.css).
    const measure = () =>
      article.style.setProperty(
        "--document-sticky-header-h",
        `${header.offsetHeight}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [articleRef]);

  const saveFromKeyboard = async (target: HTMLElement) => {
    const owner = target.ownerDocument;
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
    };
    owner.addEventListener("pointerdown", interrupt, {
      once: true,
      capture: true,
    });
    try {
      await session.save();
    } finally {
      owner.removeEventListener("pointerdown", interrupt, true);
    }
    window.requestAnimationFrame(() => {
      if (
        interrupted ||
        !target.isConnected ||
        target.closest("[hidden], [inert]") ||
        editor.isDestroyed ||
        !editor.isEditable
      )
        return;
      if (owner.activeElement !== owner.body && owner.activeElement !== target)
        return;
      if (target === editor.view.dom)
        editor.commands.focus(undefined, { scrollIntoView: false });
      else target.focus({ preventScroll: true });
    });
  };

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    // Toolbar menus only choose commands, so saving from them stays safe.
    const toolbarMenu = target.closest("[data-document-toolbar-menu]") !== null;
    if (
      !toolbarMenu &&
      target.closest("[role='dialog'],[role='alertdialog'],[role='menu']")
    )
      return;
    const context = toolbarMenu
      ? "document"
      : target === titleRef.current
        ? "title"
        : sourceRef.current?.contains(target)
          ? "source"
          : target.closest("input, textarea, select")
            ? "unrelated-input"
            : "document";
    if (classifyDocumentShortcut(event.nativeEvent, context) === "save") {
      event.preventDefault();
      if (
        !disabled &&
        !session.conflictOpen &&
        !discardOpen &&
        (!transientOpen || toolbarMenu)
      )
        void saveFromKeyboard(target);
    } else if (
      !toolbarMenu &&
      event.key === "Escape" &&
      !transientOpen &&
      !session.conflictOpen &&
      !discardOpen
    ) {
      if (sourceRef.current?.contains(target)) return;
      if (
        target !== titleRef.current &&
        target.closest("input, textarea, select")
      )
        return;
      if (editor.isFocused) {
        event.preventDefault();
        event.stopPropagation();
        editor.commands.blur();
      } else if (target === titleRef.current) {
        event.preventDefault();
        event.stopPropagation();
        target.blur();
      }
    }
  };
  const insertMermaid = () => {
    if (!editor.isEditable) return;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "mermaid",
        attrs: { source: "flowchart TD\n  A[Start] --> B[End]" },
      })
      .run();
  };
  const insertMath = (type: "inlineMath" | "mathBlock") => {
    if (!editor.isEditable) return;
    editor
      .chain()
      .focus()
      .insertContent({ type, attrs: { source: "x^2" } })
      .run();
  };

  return (
    <DocumentEditingProvider disabled={disabled || sourceOpen}>
      <article
        ref={articleRef}
        data-document-editor
        className="document-prose bg-surface w-full px-6 py-8"
        aria-busy={busy}
        onKeyDownCapture={keyDown}
      >
        <DocumentSectionStatus
          announcement={sectionAnnouncement}
          navigationKey={sectionNavigationKey}
        />
        <DocumentHeader
          document={{ ...document, title: draft.title }}
          titleRef={sectionTitleRef}
          className="bg-surface sticky top-0 z-20 py-2"
          titleControl={
            <textarea
              ref={titleRef}
              value={draft.title}
              rows={1}
              readOnly={disabled}
              maxLength={200}
              aria-label="Document title"
              aria-invalid={Boolean(session.titleError)}
              aria-describedby={
                session.titleError ? "document-title-error" : undefined
              }
              className="text-text focus-visible:ring-brand/50 block w-full resize-none overflow-hidden rounded bg-transparent p-0 text-[30px] leading-tight font-semibold outline-none focus-visible:ring-2"
              onChange={(event) =>
                session.setTitle(
                  event.target.value.replace(/[\r\n\u2028\u2029]/g, " "),
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (disabled) return;
                  if (sourceOpen) {
                    const source = sourceInputRef.current;
                    if (source && !source.readOnly) {
                      source.setSelectionRange(0, 0);
                      source.focus();
                    }
                  } else editor.commands.focus("start");
                }
              }}
            />
          }
          actions={
            <>
              {hasChanges ? (
                <>
                  <span className="text-text-3 text-[12px]" role="status">
                    {images.pending
                      ? "Uploading images…"
                      : busy
                        ? "Saving…"
                        : "Unsaved changes"}
                  </span>
                  <Button
                    type="button"
                    className="min-h-11"
                    variant="outline"
                    aria-label="Discard changes"
                    disabled={busy}
                    onClick={() => setDiscardOpen(true)}
                  >
                    Discard
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11"
                    aria-label="Save document"
                    disabled={
                      disabled ||
                      images.pending > 0 ||
                      Boolean(session.titleError) ||
                      !session.dirty
                    }
                    onClick={() => void session.save()}
                  >
                    <Save data-icon="inline-start" />
                    {busy ? "Saving…" : "Save"}
                  </Button>
                </>
              ) : null}
              <DocumentActionsMenu
                projectId={projectId}
                document={document}
                baseCommitSha={draft.baseline.baseCommitSha}
                dirty={hasChanges}
              />
            </>
          }
        />
        <DocumentWorkspaceToolbar>
          <EditorToolbar
            projectId={projectId}
            editor={editor}
            disabled={disabled}
            sourceOpen={sourceOpen}
            crossReferenceOpen={crossReferenceOpen}
            onCrossReferenceOpenChange={setCrossReferenceOpen}
            onMermaid={insertMermaid}
            onMath={insertMath}
            onUploadImage={(file) => void images.upload([file])}
            onTransientOpenChange={setTransientOpen}
            onViewSource={toggleSource}
          />
        </DocumentWorkspaceToolbar>
        {session.titleError ? (
          <p id="document-title-error" role="alert" className="text-danger">
            {session.titleError}
          </p>
        ) : null}
        {!canEdit ? (
          <p role="alert" className="text-danger">
            Editing access is no longer available. Your local changes are
            preserved; you can copy or discard them.
          </p>
        ) : null}
        {session.saveError ? (
          <p role="alert" className="text-danger">
            {session.saveError}
          </p>
        ) : null}
        {session.sourceError ? (
          <p role="alert" className="text-danger">
            {session.sourceError}
          </p>
        ) : null}
        {session.refreshError ? (
          <p role="status" className="text-text-3">
            {session.refreshError}
          </p>
        ) : null}
        {referenceState.warning ? (
          <p
            role="status"
            className="border-info-border bg-info-bg text-info rounded border px-3 py-2 text-[12px]"
          >
            {referenceState.warning}
          </p>
        ) : null}
        <DocumentReferenceProvider
          projectId={projectId}
          targets={referenceState.targets ?? []}
          status={referenceStatus}
        >
          <DocumentImageProvider
            projectId={projectId}
            documentPath={draft.baseline.path}
          >
            <div className="relative" hidden={sourceOpen} inert={sourceOpen}>
              <EditorContent editor={editor} />
            </div>
          </DocumentImageProvider>
        </DocumentReferenceProvider>
        <DocumentSourceView
          value={draft.sourceText}
          onChange={session.setSourceText}
          readOnly={disabled || images.pending > 0}
          open={sourceOpen}
          inputRef={sourceInputRef}
          regionRef={sourceRef}
          resetKey={session.sourceResetKey}
        />
        <DocumentDraftDialogs
          discardOpen={discardOpen}
          onDiscardOpenChange={setDiscardOpen}
          onDiscard={() => {
            session.discard();
            setDiscardOpen(false);
          }}
          conflictOpen={session.conflictOpen}
          onConflictOpenChange={session.setConflictOpen}
          conflictError={session.conflictError}
          busy={busy}
          activity={activity}
          canEdit={canEdit}
          onOverwrite={() => void session.save(true)}
          onReload={() => void session.reloadLatest()}
        />
      </article>
    </DocumentEditingProvider>
  );
}

"use client";

import type { Editor, EditorEvents } from "@tiptap/core";
import type { SelectionBookmark } from "@tiptap/pm/state";
import type { DocumentAssistantAction } from "@weaver/core/documents/assistantReply";
import { useEditorState } from "@tiptap/react";
import { FileCode2, FileText, Sparkles } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { DOCUMENT_IMAGE_ACCEPT } from "~/lib/documents/image-upload";
import { restoreDocumentSelection } from "~/lib/editor/document-selection";
import { externalUrlSchema } from "~/lib/editor/external-url";
import {
  documentAssistantContext,
  insertGeneratedMarkdown,
  replaceGeneratedMarkdown,
  sourceAssistantContext,
  spliceGeneratedSource,
  type SourceEdit,
} from "~/lib/editor/generated-markdown";
import { applySourceEdit } from "~/lib/editor/source-edit";
import { CrossReferencePicker } from "./CrossReferencePicker";
import type { DocumentCommand } from "./document-toolbar-groups";
import {
  DocumentAssistantDialog,
  type DocumentAssistantTarget,
} from "./DocumentAssistantDialog";
import { DocumentToolbarButton } from "./DocumentToolbarButton";
import { DocumentFormattingControls } from "./DocumentToolbarControls";

type EditorToolbarProps = {
  projectId: string;
  editor: Editor;
  disabled: boolean;
  sourceOpen?: boolean;
  crossReferenceOpen?: boolean;
  onCrossReferenceOpenChange?: (open: boolean) => void;
  allowImages?: boolean;
  onMermaid?: () => void;
  onMath?: (type: "inlineMath" | "mathBlock") => void;
  onUploadImage?: (file: File) => void;
  onTransientOpenChange?: (open: boolean) => void;
  onViewSource: () => void;
  assistantDocument?: { id: string; baseCommitSha: string };
  /** The raw Markdown field, which the assistant edits while the source view is open. */
  sourceInputRef?: RefObject<HTMLTextAreaElement | null>;
};

type AssistantSession = DocumentAssistantTarget & {
  revision: string;
  /** The source text and selection when the source view was open, else null for the formatted editor. */
  source: { value: string; start: number; end: number } | null;
};

export function EditorToolbar({
  projectId,
  editor,
  disabled,
  sourceOpen = false,
  crossReferenceOpen = false,
  onCrossReferenceOpenChange,
  allowImages = true,
  onMermaid,
  onMath,
  onUploadImage,
  onTransientOpenChange,
  onViewSource,
  assistantDocument,
  sourceInputRef,
}: EditorToolbarProps) {
  const id = useId();
  const [panel, setPanel] = useState<"link" | "image" | null>(null);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [assistant, setAssistant] = useState<AssistantSession | null>(null);
  const bookmark = useRef<SelectionBookmark | null>(null);
  const sourceEdit = useRef<SourceEdit | null>(null);
  const viewButtonRef = useRef<HTMLButtonElement>(null);
  const editorState = useEditorState({
    editor,
    selector: ({ editor: current, transactionNumber }) => ({
      transactionNumber,
      editable: current.isEditable,
    }),
  });
  const locked = disabled || sourceOpen || !editorState.editable;
  // The source view keeps the assistant: it edits the raw Markdown instead.
  const assistantLocked = disabled || !editorState.editable;
  const assistantOpen =
    !assistantLocked &&
    assistant !== null &&
    assistant.revision === assistantDocument?.baseCommitSha &&
    (assistant.source !== null) === sourceOpen;
  if (assistant !== null && !assistantOpen) setAssistant(null);
  const liveDisabled = useRef(locked);
  useLayoutEffect(() => {
    liveDisabled.current = locked;
  }, [locked]);
  const restore = useCallback(
    () =>
      restoreDocumentSelection(editor, bookmark.current, liveDisabled.current),
    [editor],
  );
  const capture = useCallback(() => {
    if (liveDisabled.current || editor.isDestroyed || !editor.isEditable)
      return false;
    bookmark.current = editor.state.selection.getBookmark();
    return true;
  }, [editor]);
  useEffect(() => {
    const map = ({
      transaction,
      appendedTransactions,
    }: EditorEvents["transaction"]) => {
      bookmark.current = bookmark.current?.map(transaction.mapping) ?? null;
      for (const appended of appendedTransactions ?? [])
        bookmark.current = bookmark.current?.map(appended.mapping) ?? null;
    };
    editor.on("transaction", map);
    return () => {
      editor.off("transaction", map);
    };
  }, [editor]);
  useEffect(() => {
    onTransientOpenChange?.(
      panel !== null || crossReferenceOpen || menuOpen || assistantOpen,
    );
  }, [
    panel,
    crossReferenceOpen,
    menuOpen,
    assistantOpen,
    onTransientOpenChange,
  ]);
  useEffect(() => {
    if (crossReferenceOpen) capture();
  }, [crossReferenceOpen, capture]);
  useEffect(
    () => () => onTransientOpenChange?.(false),
    [onTransientOpenChange],
  );

  const run = (command: DocumentCommand) => {
    if (!restore()) return;
    command(editor);
    bookmark.current = null;
    setPanel(null);
  };
  const runImmediate = (command: DocumentCommand) => {
    if (capture()) run(command);
  };
  const closeAutoFocus = (event: Event) => {
    event.preventDefault();
    if (restore()) editor.commands.focus(undefined, { scrollIntoView: false });
  };
  const showForm = (type: "image" | "link") => {
    if (!capture()) return;
    setUrl(
      type === "link" ? String(editor.getAttributes("link").href ?? "") : "",
    );
    setAlt("");
    setError(null);
    setPanel(type);
  };
  const showReference = onCrossReferenceOpenChange
    ? () => {
        if (capture()) onCrossReferenceOpenChange(true);
      }
    : undefined;
  const insertMermaid = onMermaid
    ? () => {
        if (!capture() || !restore()) return;
        editor.commands.focus(undefined, { scrollIntoView: false });
        onMermaid();
        bookmark.current = null;
      }
    : undefined;
  const insertMath = onMath
    ? (type: "inlineMath" | "mathBlock") => {
        if (!capture() || !restore()) return;
        editor.commands.focus(undefined, { scrollIntoView: false });
        onMath(type);
        bookmark.current = null;
      }
    : undefined;
  const openAssistant = (revision: string) => {
    if (assistantLocked || editor.isDestroyed || !editor.isEditable) return;
    if (sourceOpen) {
      const input = sourceInputRef?.current;
      if (!input || input.readOnly) return;
      const { value, selectionStart: start, selectionEnd: end } = input;
      setAssistant({
        revision,
        source: { value, start, end },
        context: sourceAssistantContext(value, start, end),
        hasSelection: start < end,
      });
      return;
    }
    if (!capture()) return;
    const { from, to } = editor.state.selection;
    setAssistant({
      revision,
      source: null,
      context: documentAssistantContext(editor.state.doc, from, to),
      hasSelection: from < to,
    });
  };
  const applyAssistant = (
    markdown: string,
    action: DocumentAssistantAction,
  ): string | null => {
    if (!assistantOpen || !assistant)
      return "Editing is not available right now.";
    if (assistant.source) {
      const input = sourceInputRef?.current;
      if (!input || input.readOnly || input.value !== assistant.source.value)
        return "The Markdown source changed while the assistant was open. Close this dialog and ask again.";
      const edit = spliceGeneratedSource(
        editor.schema,
        assistant.source,
        markdown,
        action,
      );
      if (!edit)
        return "This content cannot be added here without breaking the Markdown.";
      // The field takes the edit once the dialog has returned focus to it.
      sourceEdit.current = edit;
      setAssistant(null);
      return null;
    }
    if (liveDisabled.current || !bookmark.current)
      return "Editing is not available right now.";
    const applied =
      action === "replace"
        ? replaceGeneratedMarkdown(editor, bookmark.current, markdown)
        : insertGeneratedMarkdown(editor, bookmark.current, markdown);
    if (!applied)
      return action === "replace"
        ? "This content cannot replace the selection."
        : "This content cannot be inserted at the current cursor position.";
    bookmark.current = null;
    setAssistant(null);
    return null;
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Document formatting"
        className="flex min-w-0 flex-1 items-center gap-0.5"
      >
        <DocumentFormattingControls
          editor={editor}
          locked={locked}
          run={runImmediate}
          onLink={() => showForm("link")}
          onImage={allowImages ? () => showForm("image") : undefined}
          onReference={showReference}
          onMermaid={insertMermaid}
          onMath={insertMath}
          canOpenMenu={() => !liveDisabled.current && editor.isEditable}
          onCommandMenuClosed={closeAutoFocus}
          onMenuOpenChange={setMenuOpen}
        />
        {assistantDocument ? (
          <DocumentToolbarButton
            label="Ask the assistant"
            title="Ask the assistant about the selection or insert content"
            aria-haspopup="dialog"
            disabled={assistantLocked}
            onClick={() => openAssistant(assistantDocument.baseCommitSha)}
          >
            <Sparkles />
          </DocumentToolbarButton>
        ) : null}
        <span aria-hidden="true" className="bg-line mx-1 h-5 w-px shrink-0" />
        <div
          role="group"
          aria-label="Document view"
          className="flex shrink-0 items-center pr-1"
        >
          <DocumentToolbarButton
            ref={viewButtonRef}
            label={
              sourceOpen ? "View formatted document" : "View Markdown source"
            }
            title={`${sourceOpen ? "View formatted document" : "View Markdown source"} (Ctrl/Cmd+Alt+S)`}
            active={sourceOpen}
            aria-keyshortcuts="Control+Alt+s Meta+Alt+s"
            onClick={onViewSource}
          >
            {sourceOpen ? <FileText /> : <FileCode2 />}
          </DocumentToolbarButton>
        </div>
      </div>
      {assistantDocument ? (
        <DocumentAssistantDialog
          open={assistantOpen}
          target={assistant}
          schema={editor.schema}
          projectId={projectId}
          documentId={assistantDocument.id}
          onClose={() => setAssistant(null)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const edit = sourceEdit.current;
            sourceEdit.current = null;
            const input = sourceInputRef?.current;
            if (sourceOpen && input?.isConnected) {
              if (edit && !input.readOnly) applySourceEdit(input, edit);
              else input.focus({ preventScroll: true });
              return;
            }
            if (restore())
              editor.commands.focus(undefined, {
                scrollIntoView: bookmark.current === null,
              });
            else viewButtonRef.current?.focus({ preventScroll: true });
            bookmark.current = null;
          }}
          onApply={applyAssistant}
        />
      ) : null}
      <Dialog
        open={panel === "link" || panel === "image"}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={closeAutoFocus}
          onEscapeKeyDown={(event) => {
            if (event.isComposing) event.preventDefault();
            else event.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {panel === "image" ? "Insert image" : "Edit link"}
            </DialogTitle>
            <DialogDescription>
              {panel === "image"
                ? "Upload an image or enter an image URL."
                : "Link selected text to a web address."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (locked) return;
              const parsed = externalUrlSchema.safeParse(url);
              if (!parsed.success) {
                setError(
                  parsed.error.issues[0]?.message ?? "Enter a valid URL",
                );
                return;
              }
              run((current) => {
                if (panel === "image")
                  current
                    .chain()
                    .focus()
                    .setImage({ src: parsed.data, alt: alt.trim() || "Image" })
                    .run();
                else
                  current
                    .chain()
                    .focus()
                    .extendMarkRange("link")
                    .setLink({ href: parsed.data })
                    .run();
              });
            }}
          >
            {panel === "image" && onUploadImage ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-file`}>Upload image</Label>
                <Input
                  id={`${id}-file`}
                  type="file"
                  accept={DOCUMENT_IMAGE_ACCEPT}
                  disabled={locked}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file || !restore()) return;
                    editor.commands.focus(undefined, { scrollIntoView: false });
                    onUploadImage(file);
                    setPanel(null);
                  }}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-url`}>
                {panel === "image" ? "Image URL" : "URL"}
              </Label>
              <Input
                id={`${id}-url`}
                type="url"
                placeholder="https://example.com"
                value={url}
                disabled={locked}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setError(null);
                }}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${id}-error` : undefined}
              />
            </div>
            {panel === "image" ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-alt`}>Alternative text</Label>
                <Input
                  id={`${id}-alt`}
                  value={alt}
                  disabled={locked}
                  onChange={(event) => setAlt(event.target.value)}
                />
              </div>
            ) : null}
            {error ? (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-danger text-sm"
              >
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              {panel === "link" && editor.isActive("link") ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked}
                  onClick={() =>
                    run((current) => {
                      current
                        .chain()
                        .focus()
                        .extendMarkRange("link")
                        .unsetLink()
                        .run();
                    })
                  }
                >
                  Remove link
                </Button>
              ) : null}
              <Button type="submit" className="min-h-11" disabled={locked}>
                {panel === "image" ? "Insert image" : "Apply link"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {onCrossReferenceOpenChange ? (
        <CrossReferencePicker
          projectId={projectId}
          editor={editor}
          open={crossReferenceOpen}
          onOpenChange={(open) => {
            if (open && !capture()) return;
            onCrossReferenceOpenChange(open);
          }}
          disabled={locked}
          hideTrigger
          onBeforeSelect={restore}
        />
      ) : null}
    </>
  );
}

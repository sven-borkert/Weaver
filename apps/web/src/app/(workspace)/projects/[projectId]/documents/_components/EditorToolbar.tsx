"use client";

import type { Editor, EditorEvents } from "@tiptap/core";
import type { SelectionBookmark } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { FileCode2, FileText } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
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
import { CrossReferencePicker } from "./CrossReferencePicker";
import type { DocumentCommand } from "./document-toolbar-groups";
import { DocumentToolbarButton } from "./DocumentToolbarButton";
import { DocumentFormattingControls } from "./DocumentToolbarControls";

type EditorToolbarProps = {
  projectId: string;
  editor: Editor;
  disabled: boolean;
  sourceOpen?: boolean;
  crossReferenceOpen: boolean;
  onCrossReferenceOpenChange: (open: boolean) => void;
  onMermaid?: () => void;
  onMath?: (type: "inlineMath" | "mathBlock") => void;
  onUploadImage?: (file: File) => void;
  onTransientOpenChange?: (open: boolean) => void;
  onViewSource: () => void;
};

export function EditorToolbar({
  projectId,
  editor,
  disabled,
  sourceOpen = false,
  crossReferenceOpen,
  onCrossReferenceOpenChange,
  onMermaid,
  onMath,
  onUploadImage,
  onTransientOpenChange,
  onViewSource,
}: EditorToolbarProps) {
  const id = useId();
  const [panel, setPanel] = useState<"link" | "image" | null>(null);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const bookmark = useRef<SelectionBookmark | null>(null);
  const editorState = useEditorState({
    editor,
    selector: ({ editor: current, transactionNumber }) => ({
      transactionNumber,
      editable: current.isEditable,
    }),
  });
  const locked = disabled || sourceOpen || !editorState.editable;
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
    const map = ({ transaction }: EditorEvents["transaction"]) => {
      bookmark.current = bookmark.current?.map(transaction.mapping) ?? null;
    };
    editor.on("transaction", map);
    return () => {
      editor.off("transaction", map);
    };
  }, [editor]);
  useEffect(() => {
    onTransientOpenChange?.(panel !== null || crossReferenceOpen || menuOpen);
  }, [panel, crossReferenceOpen, menuOpen, onTransientOpenChange]);
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
  const showReference = () => {
    if (capture()) onCrossReferenceOpenChange(true);
  };
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
          onImage={() => showForm("image")}
          onReference={showReference}
          onMermaid={insertMermaid}
          onMath={insertMath}
          canOpenMenu={() => !liveDisabled.current && editor.isEditable}
          onCommandMenuClosed={closeAutoFocus}
          onMenuOpenChange={setMenuOpen}
        />
        <span aria-hidden="true" className="bg-line mx-1 h-5 w-px shrink-0" />
        <div
          role="group"
          aria-label="Document view"
          className="flex shrink-0 items-center pr-1"
        >
          <DocumentToolbarButton
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
    </>
  );
}

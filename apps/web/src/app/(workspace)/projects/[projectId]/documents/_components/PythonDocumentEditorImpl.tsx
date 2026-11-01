"use client";

import { EditorView } from "@codemirror/view";
import { Save } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Button } from "~/components/ui/button";
import {
  createPythonEditorState,
  replacePythonEditorText,
  scrollPythonEditorToLine,
  setPythonEditorEditable,
} from "~/lib/editor/python-editor";
import { useTextDocumentSession } from "~/lib/documents/use-text-document-session";
import type { PythonDocument } from "~/lib/documents/use-document-session";
import { useUnsavedChangesGuard } from "~/lib/use-unsaved-changes-guard";
import { DocumentActionsMenu } from "./DocumentActionsMenu";
import { DocumentDraftDialogs } from "./DocumentDraftDialogs";
import { DocumentHeader } from "./DocumentHeader";
import { DocumentRenderBoundary } from "./DocumentRenderBoundary";

export type PythonDocumentEditorProps = {
  projectId: string;
  document: PythonDocument;
  canEdit: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onTextChange?: (text: string) => void;
  jumpTo?: { line: number; jump: number };
};

export function PythonDocumentEditorImpl({
  projectId,
  document,
  canEdit,
  onDirtyChange,
  onTextChange,
  jumpTo,
}: PythonDocumentEditorProps) {
  const session = useTextDocumentSession({ document, projectId, canEdit });
  const { draft, activity } = session;
  const busy = activity !== null;
  const editable = canEdit && !busy;
  const viewRef = useRef<EditorView | null>(null);
  const sessionRef = useRef(session);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  useLayoutEffect(() => {
    sessionRef.current = session;
  });
  useUnsavedChangesGuard(session.dirty);
  useEffect(() => {
    onDirtyChange(session.dirty);
  }, [onDirtyChange, session.dirty]);
  useEffect(() => {
    onTextChange?.(draft.text);
  }, [draft.text, onTextChange]);

  useLayoutEffect(() => {
    const input = titleRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft.title]);

  return (
    <article
      className="bg-surface w-full px-6 py-8"
      aria-busy={busy}
      onKeyDownCapture={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "s" &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          if (editable && !session.conflictOpen && !discardOpen)
            void session.save();
        }
      }}
    >
      <DocumentHeader
        document={{ ...document, title: draft.title }}
        className="bg-surface sticky top-0 z-20 py-2"
        titleControl={
          <textarea
            ref={titleRef}
            value={draft.title}
            rows={1}
            readOnly={!editable}
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
                if (editable) viewRef.current?.focus();
              }
            }}
          />
        }
        actions={
          <>
            {session.dirty ? (
              <>
                <span className="text-text-3 text-[12px]" role="status">
                  {busy ? "Saving…" : "Unsaved changes"}
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
                  disabled={!editable || Boolean(session.titleError)}
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
              dirty={session.dirty}
            />
          </>
        }
      />
      {session.titleError ? (
        <p id="document-title-error" role="alert" className="text-danger">
          {session.titleError}
        </p>
      ) : null}
      {!canEdit && session.dirty ? (
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
      {session.refreshError ? (
        <p role="status" className="text-text-3">
          {session.refreshError}
        </p>
      ) : null}
      <DocumentRenderBoundary
        key={document.id}
        fallback={
          <>
            <p role="alert" className="text-danger">
              The code editor could not load. The file is shown below; reload
              the page to try again.
            </p>
            <pre className="whitespace-pre-wrap">{draft.text}</pre>
          </>
        }
      >
        <PythonCodeEditor
          resetKey={session.textResetKey}
          getText={() => sessionRef.current.getText()}
          editable={editable}
          jumpTo={jumpTo}
          viewRef={viewRef}
          onChange={(text) => sessionRef.current.setText(text)}
        />
      </DocumentRenderBoundary>
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
  );
}

function PythonCodeEditor({
  resetKey,
  getText,
  editable,
  jumpTo,
  viewRef,
  onChange,
}: {
  resetKey: number;
  getText: () => string;
  editable: boolean;
  jumpTo?: { line: number; jump: number };
  viewRef: RefObject<EditorView | null>;
  onChange: (text: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initial = useRef({ editable, onChange });
  const getTextRef = useRef(getText);

  useLayoutEffect(() => {
    getTextRef.current = getText;
  });

  // Created once; a failure throws to the surrounding render boundary.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { current } = initial;
    const view = new EditorView({
      parent: host,
      state: createPythonEditorState({
        doc: getTextRef.current(),
        editable: current.editable,
        onChange: (next) => current.onChange(next),
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [viewRef]);
  useEffect(() => {
    if (viewRef.current) setPythonEditorEditable(viewRef.current, editable);
  }, [editable, viewRef]);
  // Only external replacements sync into the view, during commit so no keystroke lands in between.
  useLayoutEffect(() => {
    if (viewRef.current)
      replacePythonEditorText(viewRef.current, getTextRef.current());
  }, [resetKey, viewRef]);
  useEffect(() => {
    if (jumpTo && viewRef.current)
      scrollPythonEditorToLine(viewRef.current, jumpTo.line);
  }, [jumpTo, viewRef]);

  return <div ref={hostRef} className="python-editor" data-python-editor />;
}

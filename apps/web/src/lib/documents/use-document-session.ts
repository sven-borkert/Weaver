"use client";

import type { Editor, JSONContent } from "@tiptap/react";
import type { Node } from "@tiptap/pm/model";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { rewriteOwnAssetsPrefix } from "@weaver/core/documents/images";
import { documentEditingContent } from "~/lib/editor/document-editing-content";
import { api, type RouterOutputs } from "~/trpc/react";
import { invalidateDocumentReferenceCaches } from "./document-cache-invalidation";
import { reconcileDocumentContent } from "./reconcile-document-content";
import { parseDocumentMarkdown } from "./document-markdown";
import {
  createDocumentDraft,
  documentDraftReducer,
  isDocumentDraftDirty,
  resetDocumentHistory,
  type DocumentDraftSnapshot,
  type DocumentDraftState,
} from "./draft-state";

export type DocumentGet = RouterOutputs["document"]["get"];
export type MarkdownDocument = DocumentGet & {
  content: Extract<DocumentGet["content"], { kind: "markdown" }>;
};
export type PythonDocument = DocumentGet & {
  content: Extract<DocumentGet["content"], { kind: "python" }>;
};

export function isMarkdownDocument(
  document: DocumentGet,
): document is MarkdownDocument {
  return document.content.kind === "markdown";
}

export function isPythonDocument(
  document: DocumentGet,
): document is PythonDocument {
  return document.content.kind === "python";
}

/** A document's kind never changes, so a refetch of a Markdown document stays Markdown. */
function asMarkdownDocument(document: DocumentGet): MarkdownDocument {
  if (!isMarkdownDocument(document))
    throw new Error("document is no longer a Markdown document");
  return document;
}

function snapshotFrom(
  editor: Editor,
  document: MarkdownDocument,
): DocumentDraftSnapshot {
  return {
    title: document.title,
    content: editor.schema.nodeFromJSON(
      documentEditingContent(document.content.contentJson),
    ),
    path: document.path,
    slug: document.slug,
    baseCommitSha: document.baseCommitSha,
  };
}

function replaceContent(editor: Editor, content: Node, resetHistory = false) {
  if (resetHistory) {
    editor.view.updateState(resetDocumentHistory(editor.state, content));
    editor.commands.setMeta("preventUpdate", true);
  } else if (!editor.state.doc.eq(content)) {
    editor.view.dispatch(reconcileDocumentContent(editor.state, content));
  }
}

/** The server's stated reason for rejecting the content, when it gave one. */
function badRequestReason(error: unknown): string | undefined {
  const trpcError = error as {
    message?: string;
    data?: { zodError?: { fieldErrors?: Record<string, string[]> } | null };
  };
  const fieldError = trpcError.data?.zodError?.fieldErrors?.content?.[0];
  const message = fieldError ?? trpcError.message;
  return typeof message === "string" &&
    message.trim() &&
    !message.startsWith("[")
    ? message.trim()
    : undefined;
}

export function useDocumentSession({
  editor,
  document,
  projectId,
  canEdit,
  hasPendingUploads,
  cancelUploads,
}: {
  editor: Editor;
  document: MarkdownDocument;
  projectId: string;
  canEdit: boolean;
  hasPendingUploads: () => boolean;
  cancelUploads: () => void;
}) {
  const utils = api.useUtils();
  const mutation = api.document.update.useMutation();
  const [draft, setDraft] = useState(() =>
    createDocumentDraft(snapshotFrom(editor, document)),
  );
  const draftRef = useRef(draft);
  const retiredShas = useRef(new Set<string>());
  const busyRef = useRef(false);
  const permissionRef = useRef(canEdit);
  const [activity, setActivity] = useState<
    "save" | "reload" | "overwrite" | null
  >(null);
  const [saveError, setSaveError] = useState<string>();
  const [sourceError, setSourceError] = useState<string>();
  const [sourceResetKey, setSourceResetKey] = useState(0);
  const [refreshError, setRefreshError] = useState<string>();
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictError, setConflictError] = useState<string>();
  const dirty = isDocumentDraftDirty(draft);
  const titleError =
    draft.title.trim().length === 0 ? "Title is required" : null;

  const dispatch = useCallback(
    (action: Parameters<typeof documentDraftReducer>[1]) => {
      const current = draftRef.current;
      const next = documentDraftReducer(current, action);
      if (current.baseline.baseCommitSha !== next.baseline.baseCommitSha) {
        retiredShas.current.add(current.baseline.baseCommitSha);
      }
      draftRef.current = next;
      setDraft(next);
      return next;
    },
    [],
  );

  useLayoutEffect(() => {
    permissionRef.current = canEdit;
    editor.setEditable(canEdit && activity === null, false);
  }, [activity, canEdit, editor]);

  useEffect(() => {
    const update = () => {
      if (draftRef.current.content.eq(editor.state.doc)) return;
      dispatch({ type: "content", content: editor.state.doc });
      setSourceResetKey((key) => key + 1);
      setSourceError(undefined);
    };
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [dispatch, editor]);

  const receiveDocument = useEffectEvent((latest: MarkdownDocument) => {
    const current = draftRef.current;
    if (
      busyRef.current ||
      hasPendingUploads() ||
      editor.isFocused ||
      isDocumentDraftDirty(current) ||
      latest.baseCommitSha === current.baseline.baseCommitSha ||
      retiredShas.current.has(latest.baseCommitSha)
    )
      return;
    const next = dispatch({
      type: "refresh",
      snapshot: snapshotFrom(editor, latest),
      requestedRevision: current.revision,
      expectedBaseCommitSha: current.baseline.baseCommitSha,
    });
    replaceContent(editor, next.content);
  });
  useEffect(() => {
    receiveDocument(document);
  }, [document]);

  const refreshAfterSave = async (acknowledged: DocumentDraftState) => {
    const input = { projectId, documentId: document.id };
    const results = await Promise.allSettled([
      utils.document.get.invalidate(input, { refetchType: "none" }),
      utils.document.list.invalidate({ projectId }),
      utils.folder.tree.invalidate({ projectId }),
      utils.document.history.invalidate(input),
      utils.document.backlinks.invalidate({ projectId }),
      invalidateDocumentReferenceCaches(utils, projectId),
    ]);
    if (editor.isDestroyed) return;
    try {
      const latest = asMarkdownDocument(await utils.document.get.fetch(input));
      if (
        editor.isDestroyed ||
        busyRef.current ||
        hasPendingUploads() ||
        retiredShas.current.has(latest.baseCommitSha)
      )
        return;
      const next = dispatch({
        type: "refresh",
        snapshot: snapshotFrom(editor, latest),
        requestedRevision: acknowledged.revision,
        expectedBaseCommitSha: acknowledged.baseline.baseCommitSha,
      });
      if (
        next !== acknowledged &&
        next.baseline.baseCommitSha === latest.baseCommitSha &&
        !isDocumentDraftDirty(next)
      ) {
        replaceContent(editor, next.content);
      }
      setRefreshError(
        results.some((result) => result.status === "rejected")
          ? "Document saved, but some related views could not refresh."
          : undefined,
      );
    } catch {
      if (!editor.isDestroyed)
        setRefreshError(
          "Document saved. The latest view could not refresh; your saved changes are safe.",
        );
    }
  };

  const finishActivity = () => {
    busyRef.current = false;
    if (!editor.isDestroyed) {
      editor.setEditable(permissionRef.current, false);
      setActivity(null);
    }
  };

  const validateSource = () => {
    const error = draftRef.current.sourceError;
    setSourceError(error ?? undefined);
    return error === null;
  };

  const setSourceText = (sourceText: string) => {
    if (
      !permissionRef.current ||
      busyRef.current ||
      hasPendingUploads() ||
      editor.isDestroyed
    )
      return;
    if (sourceText === draftRef.current.sourceText) return;
    setSourceError(undefined);
    try {
      const content = parseDocumentMarkdown(editor.schema, sourceText);
      dispatch({ type: "source", sourceText, content, sourceError: null });
      if (!editor.state.doc.eq(content))
        editor.view.dispatch(
          reconcileDocumentContent(editor.state, content).setMeta(
            "addToHistory",
            true,
          ),
        );
    } catch (error) {
      dispatch({
        type: "source",
        sourceText,
        sourceError:
          error instanceof Error
            ? error.message
            : "Markdown contains content that cannot be saved.",
      });
    }
  };

  const save = async (overwrite = false) => {
    const submitted = draftRef.current;
    if (
      !canEdit ||
      busyRef.current ||
      hasPendingUploads() ||
      !submitted.title.trim() ||
      !isDocumentDraftDirty(submitted)
    )
      return;
    if (!validateSource()) return;
    busyRef.current = true;
    editor.setEditable(false, false);
    setActivity(overwrite ? "overwrite" : "save");
    setSaveError(undefined);
    setConflictError(undefined);
    let result: RouterOutputs["document"]["update"];
    try {
      let baseCommitSha = submitted.baseline.baseCommitSha;
      if (overwrite) {
        const input = { projectId, documentId: document.id };
        await utils.document.get.invalidate(input, { refetchType: "none" });
        const latest = await utils.document.get.fetch(input);
        baseCommitSha = latest.baseCommitSha;
        retiredShas.current.add(baseCommitSha);
      }
      result = await mutation.mutateAsync({
        projectId,
        documentId: document.id,
        baseCommitSha,
        title: submitted.title,
        content: { kind: "markdown", contentJson: submitted.content.toJSON() },
      });
    } catch (error) {
      if (!editor.isDestroyed) {
        const code = (error as { data?: { code?: string } }).data?.code;
        if (code === "CONFLICT") {
          setConflictOpen(true);
          if (overwrite)
            setConflictError(
              "The document changed again while saving. Try overwriting again.",
            );
        } else {
          const reason =
            code === "BAD_REQUEST" ? badRequestReason(error) : undefined;
          setSaveError(
            reason
              ? `Could not save the document: ${reason}. Your changes are still here.`
              : "Could not save the document. Your changes are still here; try again.",
          );
          if (overwrite)
            setConflictError(
              reason
                ? `Could not save the document: ${reason}.`
                : "Could not save the document. Try again.",
            );
          toast.error("Could not save the document");
        }
      }
      finishActivity();
      return;
    }
    if (editor.isDestroyed) return;
    const content = editor.schema.nodeFromJSON(
      rewriteOwnAssetsPrefix(
        submitted.content.toJSON() as JSONContent,
        submitted.baseline.slug,
        result.slug,
      ),
    );
    const acknowledged = dispatch({
      type: "saved",
      submittedRevision: submitted.revision,
      snapshot: {
        title: result.title,
        path: result.path,
        slug: result.slug,
        baseCommitSha: result.headCommitSha,
        content,
      },
    });
    replaceContent(editor, acknowledged.content);
    setConflictOpen(false);
    setRefreshError(undefined);
    finishActivity();
    toast.success("Document saved");
    void refreshAfterSave(acknowledged);
  };

  const discard = () => {
    if (busyRef.current) return;
    cancelUploads();
    const next = dispatch({ type: "discard" });
    replaceContent(editor, next.content, true);
    setSourceResetKey((key) => key + 1);
    setSourceError(undefined);
    setSaveError(undefined);
    setConflictError(undefined);
    setConflictOpen(false);
  };

  const reloadLatest = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    editor.setEditable(false, false);
    setActivity("reload");
    setConflictError(undefined);
    cancelUploads();
    try {
      const input = { projectId, documentId: document.id };
      await utils.document.get.invalidate(input, { refetchType: "none" });
      const latest = asMarkdownDocument(await utils.document.get.fetch(input));
      if (editor.isDestroyed) return;
      const next = dispatch({
        type: "reload",
        snapshot: snapshotFrom(editor, latest),
      });
      replaceContent(editor, next.content, true);
      setSourceResetKey((key) => key + 1);
      setSourceError(undefined);
      setConflictOpen(false);
      setSaveError(undefined);
      setRefreshError(undefined);
      toast.success("Latest version loaded");
    } catch {
      if (!editor.isDestroyed)
        setConflictError(
          "Could not load the latest document. Your changes are still here.",
        );
    } finally {
      finishActivity();
    }
  };

  return {
    draft,
    dirty,
    titleError,
    activity,
    saveError,
    sourceError,
    sourceResetKey,
    refreshError,
    conflictOpen,
    conflictError,
    setConflictOpen,
    setTitle: (title: string) => dispatch({ type: "title", title }),
    setSourceText,
    validateSource,
    save,
    discard,
    reloadLatest,
  };
}

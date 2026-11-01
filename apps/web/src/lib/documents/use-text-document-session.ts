"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { api, type RouterOutputs } from "~/trpc/react";
import { invalidateDocumentReferenceCaches } from "./document-cache-invalidation";
import { isPythonDocument, type PythonDocument } from "./use-document-session";

export type TextDraftBaseline = {
  title: string;
  text: string;
  path: string;
  slug: string;
  baseCommitSha: string;
};
export type TextDraftState = {
  title: string;
  text: string;
  baseline: TextDraftBaseline;
  /** Increments on every local edit so a late refresh cannot clobber newer typing. */
  revision: number;
  /** Increments when the text is replaced from outside the editor. */
  textResetKey: number;
};
export type TextDraftAction =
  | { type: "title"; title: string }
  | { type: "text"; text: string }
  | { type: "discard" }
  | { type: "reload"; baseline: TextDraftBaseline }
  | { type: "saved"; submittedRevision: number; baseline: TextDraftBaseline }
  | {
      type: "refresh";
      baseline: TextDraftBaseline;
      expectedBaseCommitSha: string;
    };

export function isTextDraftDirty(state: TextDraftState): boolean {
  return (
    state.title !== state.baseline.title || state.text !== state.baseline.text
  );
}

export function textDraftReducer(
  state: TextDraftState,
  action: TextDraftAction,
): TextDraftState {
  switch (action.type) {
    case "title":
      return { ...state, title: action.title, revision: state.revision + 1 };
    case "text":
      return { ...state, text: action.text, revision: state.revision + 1 };
    case "discard":
      return {
        ...state,
        title: state.baseline.title,
        text: state.baseline.text,
        revision: state.revision + 1,
        textResetKey: state.textResetKey + 1,
      };
    case "reload":
      return {
        title: action.baseline.title,
        text: action.baseline.text,
        baseline: action.baseline,
        revision: state.revision + 1,
        textResetKey: state.textResetKey + 1,
      };
    case "saved":
      // Edits made while saving stay dirty against the new baseline.
      return action.submittedRevision === state.revision
        ? {
            title: action.baseline.title,
            text: action.baseline.text,
            baseline: action.baseline,
            revision: state.revision,
            textResetKey:
              action.baseline.text === state.text
                ? state.textResetKey
                : state.textResetKey + 1,
          }
        : { ...state, baseline: action.baseline };
    case "refresh":
      if (
        isTextDraftDirty(state) ||
        state.baseline.baseCommitSha !== action.expectedBaseCommitSha
      )
        return state;
      return {
        title: action.baseline.title,
        text: action.baseline.text,
        baseline: action.baseline,
        revision: state.revision + 1,
        textResetKey: state.textResetKey + 1,
      };
  }
}

function baselineOf(document: PythonDocument): TextDraftBaseline {
  return {
    title: document.title,
    text: document.content.text,
    path: document.path,
    slug: document.slug,
    baseCommitSha: document.baseCommitSha,
  };
}

function badRequestReason(error: unknown): string | undefined {
  const trpcError = error as {
    message?: string;
    data?: { zodError?: { fieldErrors?: Record<string, string[]> } | null };
  };
  const message =
    trpcError.data?.zodError?.fieldErrors?.content?.[0] ?? trpcError.message;
  return typeof message === "string" &&
    message.trim() &&
    !message.startsWith("[")
    ? message.trim()
    : undefined;
}

export function useTextDocumentSession({
  document,
  projectId,
  canEdit,
}: {
  document: PythonDocument;
  projectId: string;
  canEdit: boolean;
}) {
  const utils = api.useUtils();
  const mutation = api.document.update.useMutation();
  const [draft, setDraft] = useState<TextDraftState>(() => {
    const baseline = baselineOf(document);
    return {
      title: baseline.title,
      text: baseline.text,
      baseline,
      revision: 0,
      textResetKey: 0,
    };
  });
  const draftRef = useRef(draft);
  const retiredShas = useRef(new Set<string>());
  const busyRef = useRef(false);
  const [activity, setActivity] = useState<
    "save" | "reload" | "overwrite" | null
  >(null);
  const [saveError, setSaveError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictError, setConflictError] = useState<string>();
  const dirty = isTextDraftDirty(draft);
  const titleError =
    draft.title.trim().length === 0 ? "Title is required" : null;

  const dispatch = useCallback((action: TextDraftAction) => {
    const current = draftRef.current;
    const next = textDraftReducer(current, action);
    if (current.baseline.baseCommitSha !== next.baseline.baseCommitSha)
      retiredShas.current.add(current.baseline.baseCommitSha);
    draftRef.current = next;
    setDraft(next);
    return next;
  }, []);

  const applyLatest = (latest: PythonDocument) => {
    const current = draftRef.current;
    if (
      busyRef.current ||
      isTextDraftDirty(current) ||
      latest.baseCommitSha === current.baseline.baseCommitSha ||
      retiredShas.current.has(latest.baseCommitSha)
    )
      return;
    dispatch({
      type: "refresh",
      baseline: baselineOf(latest),
      expectedBaseCommitSha: current.baseline.baseCommitSha,
    });
  };
  const receiveDocument = useEffectEvent(applyLatest);
  useEffect(() => {
    receiveDocument(document);
  }, [document]);

  const finish = () => {
    busyRef.current = false;
    setActivity(null);
  };

  const refreshAfterSave = async () => {
    const input = { projectId, documentId: document.id };
    const results = await Promise.allSettled([
      utils.document.get.invalidate(input, { refetchType: "none" }),
      utils.document.list.invalidate({ projectId }),
      utils.folder.tree.invalidate({ projectId }),
      utils.document.history.invalidate(input),
      invalidateDocumentReferenceCaches(utils, projectId),
    ]);
    try {
      const latest = await utils.document.get.fetch(input);
      if (isPythonDocument(latest)) applyLatest(latest);
      setRefreshError(
        results.some((r) => r.status === "rejected")
          ? "Document saved, but some related views could not refresh."
          : undefined,
      );
    } catch {
      setRefreshError(
        "Document saved. The latest view could not refresh; your saved changes are safe.",
      );
    }
  };

  const save = async (overwrite = false) => {
    const submitted = draftRef.current;
    if (
      !canEdit ||
      busyRef.current ||
      !submitted.title.trim() ||
      !isTextDraftDirty(submitted)
    )
      return;
    busyRef.current = true;
    setActivity(overwrite ? "overwrite" : "save");
    setSaveError(undefined);
    setConflictError(undefined);
    let result: RouterOutputs["document"]["update"];
    try {
      let baseCommitSha = submitted.baseline.baseCommitSha;
      if (overwrite) {
        const input = { projectId, documentId: document.id };
        await utils.document.get.invalidate(input, { refetchType: "none" });
        baseCommitSha = (await utils.document.get.fetch(input)).baseCommitSha;
        retiredShas.current.add(baseCommitSha);
      }
      result = await mutation.mutateAsync({
        projectId,
        documentId: document.id,
        baseCommitSha,
        title: submitted.title,
        content: { kind: "python", text: submitted.text },
      });
    } catch (error) {
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
            ? `Could not save the file: ${reason}. Your changes are still here.`
            : "Could not save the file. Your changes are still here; try again.",
        );
        if (overwrite)
          setConflictError(
            reason
              ? `Could not save the file: ${reason}.`
              : "Could not save the file. Try again.",
          );
        toast.error("Could not save the file");
      }
      finish();
      return;
    }
    dispatch({
      type: "saved",
      submittedRevision: submitted.revision,
      baseline: {
        title: result.title,
        text: submitted.text
          .replace(/\r\n?/g, "\n")
          .replace(/([^\n])$/, "$1\n"),
        path: result.path,
        slug: result.slug,
        baseCommitSha: result.headCommitSha,
      },
    });
    setConflictOpen(false);
    setRefreshError(undefined);
    finish();
    toast.success("File saved");
    void refreshAfterSave();
  };

  const discard = () => {
    if (!busyRef.current) dispatch({ type: "discard" });
    setSaveError(undefined);
    setConflictError(undefined);
    setConflictOpen(false);
  };

  const reloadLatest = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActivity("reload");
    setConflictError(undefined);
    try {
      const input = { projectId, documentId: document.id };
      await utils.document.get.invalidate(input, { refetchType: "none" });
      const latest = await utils.document.get.fetch(input);
      if (!isPythonDocument(latest)) throw new Error("kind changed");
      dispatch({ type: "reload", baseline: baselineOf(latest) });
      setConflictOpen(false);
      setSaveError(undefined);
      setRefreshError(undefined);
      toast.success("Latest version loaded");
    } catch {
      setConflictError(
        "Could not load the latest file. Your changes are still here.",
      );
    } finally {
      finish();
    }
  };

  return {
    draft,
    textResetKey: draft.textResetKey,
    getText: () => draftRef.current.text,
    dirty,
    titleError,
    activity,
    saveError,
    refreshError,
    conflictOpen,
    conflictError,
    setConflictOpen,
    setTitle: (title: string) => {
      if (canEdit && !busyRef.current) dispatch({ type: "title", title });
    },
    setText: (text: string) => {
      if (canEdit && !busyRef.current && text !== draftRef.current.text)
        dispatch({ type: "text", text });
    },
    save,
    discard,
    reloadLatest,
  };
}

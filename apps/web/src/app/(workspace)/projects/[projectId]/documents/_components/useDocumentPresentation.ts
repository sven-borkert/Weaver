"use client";

import type { Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { collectDocumentReferences } from "~/lib/documents/references";
import { referenceResolutionState } from "~/lib/documents/reference-resolution-state";
import type { DocumentSectionNavigation } from "~/lib/documents/section-navigation";
import { useDocumentSectionNavigation } from "~/lib/documents/use-document-section-navigation";
import { DOCUMENT_SECTION_HIGHLIGHT_META } from "~/lib/editor/document-section-anchors";
import type { MarkdownDocument } from "~/lib/documents/use-document-session";
import { api } from "~/trpc/react";
import type { DocumentReferenceResolutionStatus } from "./DocumentReferenceMapping";

const noEditorSnapshot = () => undefined;

export function useDocumentPresentation({
  projectId,
  document,
  editor,
  sectionNavigation,
  sectionNavigationReady = true,
}: {
  projectId: string;
  document: MarkdownDocument;
  editor?: Editor | null;
  sectionNavigation?: DocumentSectionNavigation;
  sectionNavigationReady?: boolean;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!editor) return () => undefined;
      editor.on("transaction", notify);
      editor.on("destroy", notify);
      return () => {
        editor.off("transaction", notify);
        editor.off("destroy", notify);
      };
    },
    [editor],
  );
  const getSnapshot = useCallback(
    () => (editor && !editor.isDestroyed ? editor.state.doc : undefined),
    [editor],
  );
  const liveDocument = useSyncExternalStore(
    subscribe,
    getSnapshot,
    noEditorSnapshot,
  );
  const references = useMemo(
    () =>
      collectDocumentReferences(
        (liveDocument?.toJSON() as JSONContent | undefined) ??
          document.content.contentJson,
      ),
    [document.content.contentJson, liveDocument],
  );
  const referenceQuery = api.document.resolveRefs.useQuery(
    { projectId, ids: references.map((reference) => reference.targetId) },
    { enabled: references.length > 0 },
  );
  const referenceState = useMemo(
    () => referenceResolutionState(referenceQuery.data, referenceQuery.error),
    [referenceQuery.data, referenceQuery.error],
  );
  const referenceStatus: DocumentReferenceResolutionStatus =
    referenceQuery.isLoading
      ? "pending"
      : referenceQuery.error
        ? "error"
        : "settled";
  const highlightSection = useCallback(
    (section: string | null) => {
      if (editor && !editor.isDestroyed)
        editor.commands.setMeta(DOCUMENT_SECTION_HIGHLIGHT_META, section);
    },
    [editor],
  );
  const navigation = useDocumentSectionNavigation({
    documentId: document.id,
    currentSourceSha: document.baseCommitSha,
    sectionNavigation,
    articleRef,
    titleRef,
    editable: editor !== undefined,
    ready: editor !== null && sectionNavigationReady,
    highlightSection: editor ? highlightSection : undefined,
  });
  return {
    articleRef,
    titleRef,
    referenceState,
    referenceStatus,
    ...navigation,
  };
}

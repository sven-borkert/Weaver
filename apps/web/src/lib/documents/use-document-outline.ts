"use client";

import { getSchema, type JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { documentExtensions } from "@weaver/core/editor/extensions";
import {
  documentOutline,
  type DocumentOutlineEntry,
} from "~/lib/editor/document-heading-anchors";
import { documentOutlineFromState } from "~/lib/editor/document-section-anchors";

const noOutline = () => undefined;

/** The live editor's outline, or the saved content's without an editor. */
export function useDocumentOutline(
  editor: Editor | null | undefined,
  contentJson: JSONContent,
): DocumentOutlineEntry[] {
  const saved = useMemo(
    () =>
      documentOutline(
        getSchema(documentExtensions()).nodeFromJSON(contentJson),
      ),
    [contentJson],
  );
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
    () =>
      editor && !editor.isDestroyed
        ? documentOutlineFromState(editor.state)
        : undefined,
    [editor],
  );
  const live = useSyncExternalStore(subscribe, getSnapshot, noOutline);
  return live ?? saved;
}

"use client";

import type { Editor } from "@tiptap/react";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { altFromFileName, uploadDocumentImage } from "./image-upload";
import { PendingDocumentUploads } from "./pending-uploads";

export function useDocumentImages({
  editor,
  projectId,
  documentId,
  canEdit,
}: {
  editor: Editor;
  projectId: string;
  documentId: string;
  canEdit: boolean;
}) {
  const [uploads] = useState(() => new PendingDocumentUploads());
  const pending = useSyncExternalStore(
    uploads.subscribe,
    uploads.getSnapshot,
    uploads.getSnapshot,
  );
  const cancel = useCallback(() => {
    uploads.cancel();
  }, [uploads]);

  useEffect(() => {
    const map = ({ transaction }: { transaction: Transaction }) =>
      uploads.map(transaction.mapping);
    editor.on("transaction", map);
    return () => {
      editor.off("transaction", map);
      uploads.cancel();
    };
  }, [editor, uploads]);

  useEffect(() => {
    if (!canEdit) cancel();
  }, [canEdit, cancel]);

  const upload = useCallback(
    async (files: File[], position?: number) => {
      if (!canEdit || !editor.isEditable || editor.isDestroyed) return;
      const selection =
        position === undefined
          ? editor.state.selection
          : TextSelection.near(editor.state.doc.resolve(position));
      const batch = files.map((file) => ({
        file,
        ...uploads.add(selection.getBookmark()),
      }));
      for (const entry of batch) {
        if (entry.signal.aborted) continue;
        const toastId = toast.loading(
          `Uploading ${entry.file.name || "image"}…`,
        );
        try {
          const stored = await uploadDocumentImage({
            projectId,
            documentId,
            file: entry.file,
            signal: entry.signal,
          });
          const bookmark = uploads.complete(entry.id);
          if (
            !bookmark ||
            editor.isDestroyed ||
            !editor.isEditable ||
            entry.signal.aborted
          ) {
            toast.dismiss(toastId);
            continue;
          }
          const target = bookmark.resolve(editor.state.doc);
          editor.commands.insertContentAt(
            { from: target.from, to: target.to },
            {
              type: "image",
              attrs: { src: stored.src, alt: altFromFileName(entry.file.name) },
            },
            { updateSelection: false },
          );
          toast.success("Image added", { id: toastId });
        } catch (error) {
          if (entry.signal.aborted) toast.dismiss(toastId);
          else
            toast.error(
              error instanceof Error ? error.message : "Could not upload image",
              { id: toastId },
            );
        } finally {
          uploads.complete(entry.id);
        }
      }
    },
    [canEdit, documentId, editor, projectId, uploads],
  );

  return { pending, upload, cancel, hasPending: () => uploads.size > 0 };
}

"use client";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { api } from "~/trpc/react";
import { reembedMessage } from "./llmSchemas";

const EFFECT_TEXT = {
  none: "Nothing changes for the knowledge index.",
  extraction_only:
    "New and edited documents use this model; Rebuild re-extracts all documents.",
  compatible: "Compatible — existing vectors are kept.",
} as const;

export function KnowledgeRouteConfirmDialog({
  purpose,
  modelId,
  modelLabel,
  onConfirm,
  onCancel,
}: {
  purpose: "knowledge_extraction" | "knowledge_embedding";
  modelId: string;
  modelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Compatibility can change between openings; never act on a cached answer.
  const preview = api.llm.previewKnowledgeRouteChange.useQuery(
    { purpose, modelId },
    { staleTime: 0 },
  );
  const text =
    preview.data && !preview.isFetching
      ? preview.data.effect === "reindex"
        ? reembedMessage(preview.data.projects)
        : EFFECT_TEXT[preview.data.effect]
      : preview.error && !preview.isFetching
        ? "Could not preview the effect on the knowledge index."
        : "Checking the effect on the knowledge index…";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch to {modelLabel}?</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={preview.isFetching} onClick={onConfirm}>
            Switch model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

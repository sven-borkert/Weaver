"use client";

import { Button } from "~/components/ui/button";
import { api } from "~/trpc/react";
import { reembedMessage } from "./llmSchemas";

type Change = {
  providerModelId: string;
  embeddingDimensions: number | null;
  embeddingDimensionMode: "native" | "matryoshka";
  upstreamProvider: string | null;
};

export function KnowledgeModelChangeConfirm({
  modelId,
  change,
  pending,
  onBack,
  onConfirm,
}: {
  modelId: string;
  change: Change;
  pending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  // Routing can change between openings; never act on a cached answer.
  const preview = api.llm.previewKnowledgeModelChange.useQuery(
    { modelId, ...change },
    { staleTime: 0 },
  );
  const reembed = preview.data?.effect === "reembed";
  const text =
    preview.data && !preview.isFetching
      ? reembed
        ? reembedMessage(preview.data.projects)
        : "Nothing changes for the knowledge index."
      : preview.error && !preview.isFetching
        ? "Could not preview the effect on the knowledge index."
        : "Checking the effect on the knowledge index…";
  return (
    <div className="border-line flex flex-col gap-3 rounded-lg border p-3">
      <p role="status" className="text-text m-0 text-[13px]">
        {text}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onBack}
        >
          Back
        </Button>
        <Button
          type="button"
          disabled={pending || preview.isFetching}
          onClick={onConfirm}
        >
          {reembed ? "Save and re-embed" : "Save model"}
        </Button>
      </div>
    </div>
  );
}

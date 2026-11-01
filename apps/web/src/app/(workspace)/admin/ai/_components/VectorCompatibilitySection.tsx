"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { api, type RouterOutputs } from "~/trpc/react";

type Model =
  RouterOutputs["llm"]["overview"]["connections"][number]["models"][number];
type Candidate = {
  id: string;
  label: string;
  embeddingDimensions: number | null;
  embeddingDimensionMode: string;
};

export function VectorCompatibilitySection({
  model,
  candidates,
}: {
  model: Model;
  candidates: Candidate[];
}) {
  const utils = api.useUtils();
  const eligible = candidates.filter(
    (candidate) =>
      candidate.id !== model.id &&
      candidate.embeddingDimensions === model.embeddingDimensions &&
      candidate.embeddingDimensionMode === model.embeddingDimensionMode,
  );
  const [referenceId, setReferenceId] = useState<string>();
  const [result, setResult] = useState<string>();
  const verify = api.llm.verifyEmbeddingCompatibility.useMutation({
    onSuccess: (outcome) => {
      setResult(
        outcome.outcome === "compatible"
          ? `Compatible (min similarity ${outcome.minSimilarity!.toFixed(3)})`
          : outcome.outcome === "incompatible"
            ? `Not compatible (min similarity ${outcome.minSimilarity!.toFixed(3)})`
            : `Check failed: ${outcome.summary}`,
      );
      void utils.llm.overview.invalidate();
    },
    onError: (error) => setResult(error.message || "Could not verify models"),
  });
  const clear = api.llm.clearEmbeddingCompatibility.useMutation({
    onSuccess: ({ reindexProjects }) => {
      toast.success(
        reindexProjects > 0
          ? `Compatibility removed. Re-embedding started in ${reindexProjects} project${reindexProjects === 1 ? "" : "s"}.`
          : "Compatibility removed",
      );
      void utils.llm.overview.invalidate();
    },
    onError: (error) =>
      toast.error(error.message || "Could not remove compatibility"),
  });
  const [checkingClear, setCheckingClear] = useState(false);
  const [confirmClear, setConfirmClear] = useState<{ projects: number }>();
  const reference = candidates.find(
    (candidate) => candidate.id === model.vectorSpaceReferenceModelId,
  );
  const pending = verify.isPending || clear.isPending || checkingClear;

  async function requestClear() {
    setCheckingClear(true);
    try {
      const preview = await utils.llm.previewClearEmbeddingCompatibility.fetch(
        { modelId: model.id },
        { staleTime: 0 },
      );
      if (preview.effect === "reindex")
        setConfirmClear({ projects: preview.projects });
      else clear.mutate({ modelId: model.id });
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Could not check the effect on the knowledge index",
      );
    } finally {
      setCheckingClear(false);
    }
  }

  return (
    <section
      className="border-line flex flex-col gap-2 border-t pt-3"
      aria-labelledby="vector-compatibility-heading"
    >
      <h3
        id="vector-compatibility-heading"
        className="m-0 text-[13px] font-medium"
      >
        Vector compatibility
      </h3>
      {model.vectorSpaceKey && model.vectorSpaceVerifiedAt ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="text-text-2">
            {`Compatible with ${reference?.label ?? "a deleted model"} (verified ${new Date(
              model.vectorSpaceVerifiedAt,
            )
              .toISOString()
              .slice(
                0,
                10,
              )}, min ${model.vectorSpaceMinSimilarity?.toFixed(3)})`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void requestClear()}
          >
            Remove compatibility
          </Button>
        </div>
      ) : (
        <p className="text-text-3 m-0 text-[12px]">
          Verify against another embedding model to reuse its knowledge vectors.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <Label htmlFor="vector-compatibility-reference">
            Reference model
          </Label>
          <Select
            value={referenceId}
            onValueChange={setReferenceId}
            disabled={pending || eligible.length === 0}
          >
            <SelectTrigger
              id="vector-compatibility-reference"
              className="w-full"
            >
              <SelectValue
                placeholder={
                  eligible.length ? "Choose a model" : "No comparable models"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {eligible.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !referenceId}
          onClick={() => {
            setResult(undefined);
            if (referenceId)
              verify.mutate({
                modelId: model.id,
                referenceModelId: referenceId,
              });
          }}
        >
          {verify.isPending ? "Verifying…" : "Verify"}
        </Button>
      </div>
      {result ? (
        <p role="status" className="text-text-2 m-0 text-[12px]">
          {result}
        </p>
      ) : null}
      {confirmClear ? (
        <Dialog
          open
          onOpenChange={(open) =>
            open ? undefined : setConfirmClear(undefined)
          }
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove compatibility?</DialogTitle>
              <DialogDescription>
                {`Removing compatibility rebuilds the knowledge index of ${confirmClear.projects} project${confirmClear.projects === 1 ? "" : "s"}.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmClear(undefined)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmClear(undefined);
                  clear.mutate({ modelId: model.id });
                }}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

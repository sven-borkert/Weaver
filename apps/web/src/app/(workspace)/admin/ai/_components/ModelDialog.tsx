"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState, type RefObject } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import { KnowledgeModelChangeConfirm } from "./KnowledgeModelChangeConfirm";
import {
  capabilities,
  CAPABILITY_LABELS,
  changesEmbeddingIdentity,
  knowledgeDimensionHint,
  modelFormSchema,
  type ModelFormValues,
  optionalInt,
  type ProviderType,
  savedMessage,
} from "./llmSchemas";
import { VectorCompatibilitySection } from "./VectorCompatibilitySection";

type LlmModelSummary =
  RouterOutputs["llm"]["overview"]["connections"][number]["models"][number];
type EmbeddingCandidate = {
  id: string;
  label: string;
  embeddingDimensions: number | null;
  embeddingDimensionMode: string;
};
type ModelSave = Omit<RouterInputs["llm"]["updateModel"], "modelId">;

export function ModelDialog({
  open,
  onOpenChange,
  connectionId,
  providerType,
  model,
  embeddingModels,
  routedForKnowledgeEmbedding = false,
  returnFocusRef,
  fallbackFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  providerType: ProviderType;
  model?: LlmModelSummary;
  embeddingModels?: EmbeddingCandidate[];
  routedForKnowledgeEmbedding?: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const defaultValues: ModelFormValues = {
    providerModelId: model?.providerModelId ?? "",
    displayName: model?.displayName ?? "",
    contextWindow: model?.contextWindow?.toString() ?? "",
    maxOutputTokens: model?.maxOutputTokens?.toString() ?? "",
    embeddingDimensions: model?.embeddingDimensions?.toString() ?? "",
    embeddingDimensionMode: model?.embeddingDimensionMode ?? "native",
    upstreamProvider: model?.upstreamProvider ?? "",
    capabilities: model?.capabilities ?? ["chat"],
    inputCostMicrosPerMillion:
      model?.inputCostMicrosPerMillion?.toString() ?? "",
    outputCostMicrosPerMillion:
      model?.outputCostMicrosPerMillion?.toString() ?? "",
    currency: model?.currency ?? "",
  };
  const {
    register,
    handleSubmit,
    control,
    setError,
    setValue,
    getValues,
    reset,
    formState: { errors },
  } = useForm<ModelFormValues>({
    resolver: zodResolver(modelFormSchema),
    defaultValues,
  });

  const [confirming, setConfirming] = useState<ModelSave | null>(null);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const detectDimensions = api.llm.detectEmbeddingDimensions.useMutation();
  const detectNativeSize = () => {
    const modelId = getValues("providerModelId").trim();
    if (!modelId) return;
    detectDimensions.mutate(
      {
        connectionId,
        providerModelId: modelId,
        upstreamProvider:
          providerType === "openrouter"
            ? getValues("upstreamProvider") || null
            : null,
      },
      {
        onSuccess: ({ dimensions }) => {
          // A late answer must not overwrite a size chosen after re-enabling Matryoshka.
          if (getValues("embeddingDimensionMode") !== "native") return;
          setValue("embeddingDimensions", String(dimensions), {
            shouldDirty: true,
            shouldValidate: true,
          });
        },
        onError: () => {
          if (getValues("embeddingDimensionMode") !== "native") return;
          setDetectNote("Could not detect the native size; enter it manually.");
        },
      },
    );
  };
  const onSuccess = (
    result: LlmModelSummary & { reindexProjects?: number },
  ) => {
    toast.success(savedMessage("Model", result.reindexProjects));
    void utils.llm.overview.invalidate();
    onOpenChange(false);
  };
  const onError = (err: Parameters<typeof applyTrpcErrorToForm>[0]) => {
    setConfirming(null);
    if (err.data?.field) {
      applyTrpcErrorToForm(err, (name, error) =>
        setError(name as Parameters<typeof setError>[0], error),
      );
    } else {
      toast.error(err.message || "Could not save model");
    }
  };
  const createModel = api.llm.createModel.useMutation({ onSuccess, onError });
  const updateModel = api.llm.updateModel.useMutation({ onSuccess, onError });
  const pending = createModel.isPending || updateModel.isPending;
  const selectedCapabilities = useWatch({ control, name: "capabilities" });
  const providerModelId = useWatch({ control, name: "providerModelId" });
  const upstreamProvider = useWatch({ control, name: "upstreamProvider" });
  const embeddingDimensionsValue = useWatch({
    control,
    name: "embeddingDimensions",
  });
  const providersQuery = api.llm.listOpenRouterUpstreamProviders.useQuery(
    { connectionId, providerModelId: providerModelId.trim() },
    {
      enabled:
        open && providerType === "openrouter" && providerModelId.trim() !== "",
    },
  );
  const upstreamProviders = providersQuery.data ?? [];
  const selectedProviderMissing =
    upstreamProvider !== "" &&
    !upstreamProviders.some((provider) => provider.slug === upstreamProvider);

  const onSubmit = handleSubmit((values) => {
    const modelValues = {
      providerModelId: values.providerModelId,
      displayName: values.displayName,
      contextWindow: optionalInt(values.contextWindow),
      maxOutputTokens: optionalInt(values.maxOutputTokens),
      embeddingDimensions: values.capabilities.includes("embedding")
        ? optionalInt(values.embeddingDimensions)
        : null,
      embeddingDimensionMode: values.capabilities.includes("embedding")
        ? values.embeddingDimensionMode
        : "native",
      upstreamProvider:
        providerType === "openrouter" ? values.upstreamProvider || null : null,
      capabilities: values.capabilities,
      inputCostMicrosPerMillion: optionalInt(values.inputCostMicrosPerMillion),
      outputCostMicrosPerMillion: optionalInt(
        values.outputCostMicrosPerMillion,
      ),
      currency: values.currency || null,
    };
    if (model) {
      if (
        routedForKnowledgeEmbedding &&
        changesEmbeddingIdentity(model, modelValues)
      ) {
        setConfirming(modelValues);
        return;
      }
      updateModel.mutate({ modelId: model.id, ...modelValues });
    } else {
      createModel.mutate({ connectionId, ...modelValues });
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        if (!nextOpen) reset(defaultValues);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={!pending}
        aria-busy={pending || undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(returnFocusRef.current, fallbackFocusRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>{model ? "Edit model" : "Add model"}</DialogTitle>
          <DialogDescription>
            Declare a provider model and the capabilities Weaver may route to
            it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <fieldset
            disabled={confirming !== null}
            className="contents"
            data-testid="model-form-fields"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model-provider-id">Provider model id</Label>
                <Input
                  id="llm-model-provider-id"
                  autoFocus
                  aria-invalid={errors.providerModelId ? true : undefined}
                  {...register("providerModelId", {
                    onChange: () =>
                      setValue("upstreamProvider", "", { shouldDirty: true }),
                  })}
                />
                {errors.providerModelId ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.providerModelId.message}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model-display-name">Display name</Label>
                <Input
                  id="llm-model-display-name"
                  aria-invalid={errors.displayName ? true : undefined}
                  {...register("displayName")}
                />
                {errors.displayName ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.displayName.message}
                  </p>
                ) : null}
              </div>
            </div>

            <fieldset className="flex flex-col gap-2 border-0 p-0">
              <legend className="text-text-2 text-[12px] font-medium">
                Capabilities
              </legend>
              <Controller
                control={control}
                name="capabilities"
                render={({ field }) => (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {capabilities.map((capability) => (
                      <label
                        key={capability}
                        className="text-text flex items-center gap-2 text-[13px]"
                      >
                        <input
                          type="checkbox"
                          checked={field.value.includes(capability)}
                          onChange={(event) =>
                            field.onChange(
                              event.target.checked
                                ? [...field.value, capability]
                                : field.value.filter(
                                    (value) => value !== capability,
                                  ),
                            )
                          }
                        />
                        {CAPABILITY_LABELS[capability]}
                      </label>
                    ))}
                  </div>
                )}
              />
              {errors.capabilities ? (
                <p className="text-danger m-0 text-[12px]">
                  {errors.capabilities.message}
                </p>
              ) : null}
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model-context-window">Context window</Label>
                <Input
                  id="llm-model-context-window"
                  type="number"
                  min={0}
                  max={2_147_483_647}
                  step={1}
                  placeholder="Optional"
                  aria-invalid={errors.contextWindow ? true : undefined}
                  {...register("contextWindow")}
                />
                {errors.contextWindow ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.contextWindow.message}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model-max-output-tokens">
                  Max output tokens
                </Label>
                <Input
                  id="llm-model-max-output-tokens"
                  type="number"
                  min={0}
                  max={2_147_483_647}
                  step={1}
                  placeholder="Optional"
                  aria-invalid={errors.maxOutputTokens ? true : undefined}
                  {...register("maxOutputTokens")}
                />
                {errors.maxOutputTokens ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.maxOutputTokens.message}
                  </p>
                ) : null}
              </div>
            </div>

            {providerType === "openrouter" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model-upstream-provider">
                  Upstream provider
                </Label>
                <Controller
                  control={control}
                  name="upstreamProvider"
                  render={({ field }) => (
                    <Select
                      value={field.value || "__automatic__"}
                      disabled={
                        pending ||
                        providerModelId.trim() === "" ||
                        confirming !== null
                      }
                      onValueChange={(value) =>
                        field.onChange(value === "__automatic__" ? "" : value)
                      }
                    >
                      <SelectTrigger
                        id="llm-model-upstream-provider"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__automatic__">Automatic</SelectItem>
                        {selectedProviderMissing ? (
                          <SelectItem value={upstreamProvider}>
                            {upstreamProvider} (saved)
                          </SelectItem>
                        ) : null}
                        {upstreamProviders.map((provider) => (
                          <SelectItem key={provider.slug} value={provider.slug}>
                            {provider.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-text-3 m-0 text-[12px]">
                  Automatic lets OpenRouter choose. The available providers
                  depend on the model.
                </p>
                {providersQuery.isLoading ? (
                  <p className="text-text-3 m-0 text-[12px]">
                    Loading providers…
                  </p>
                ) : null}
                {providersQuery.error ? (
                  <div className="flex items-center gap-2">
                    <p className="text-danger m-0 text-[12px]">
                      Could not load upstream providers.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void providersQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedCapabilities.includes("embedding") ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="llm-model-embedding-dimensions">
                    Embedding dimensions
                  </Label>
                  <Input
                    id="llm-model-embedding-dimensions"
                    type="number"
                    min={1}
                    max={16_000}
                    step={1}
                    aria-invalid={errors.embeddingDimensions ? true : undefined}
                    {...register("embeddingDimensions")}
                  />
                  <p className="text-text-3 m-0 text-[12px]">
                    {knowledgeDimensionHint(embeddingDimensionsValue)}
                  </p>
                  {detectDimensions.isPending || detectNote ? (
                    <p className="text-text-3 m-0 text-[12px]" role="status">
                      {detectDimensions.isPending
                        ? "Detecting native size…"
                        : detectNote}
                    </p>
                  ) : null}
                  {errors.embeddingDimensions ? (
                    <p className="text-danger m-0 text-[12px]">
                      {errors.embeddingDimensions.message}
                    </p>
                  ) : null}
                </div>
                <Controller
                  control={control}
                  name="embeddingDimensionMode"
                  render={({ field }) => (
                    <label className="text-text flex items-start gap-2 text-[13px]">
                      <input
                        id="llm-model-matryoshka"
                        type="checkbox"
                        checked={field.value === "matryoshka"}
                        onChange={(event) => {
                          const matryoshka = event.target.checked;
                          field.onChange(matryoshka ? "matryoshka" : "native");
                          setDetectNote(null);
                          if (!matryoshka) detectNativeSize();
                        }}
                      />
                      <span>
                        Matryoshka / resizable
                        <span className="text-text-3 block text-[12px]">
                          Enable only when the model was trained for dimension
                          reduction.
                        </span>
                      </span>
                    </label>
                  )}
                />
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model-input-cost">
                  Input cost (µ per million)
                </Label>
                <Input
                  id="llm-model-input-cost"
                  type="number"
                  min={0}
                  max={2_147_483_647}
                  step={1}
                  placeholder="Optional"
                  aria-invalid={
                    errors.inputCostMicrosPerMillion ? true : undefined
                  }
                  {...register("inputCostMicrosPerMillion")}
                />
                {errors.inputCostMicrosPerMillion ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.inputCostMicrosPerMillion.message}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model-output-cost">
                  Output cost (µ per million)
                </Label>
                <Input
                  id="llm-model-output-cost"
                  type="number"
                  min={0}
                  max={2_147_483_647}
                  step={1}
                  placeholder="Optional"
                  aria-invalid={
                    errors.outputCostMicrosPerMillion ? true : undefined
                  }
                  {...register("outputCostMicrosPerMillion")}
                />
                {errors.outputCostMicrosPerMillion ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.outputCostMicrosPerMillion.message}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="llm-model-currency">Currency</Label>
              <Input
                id="llm-model-currency"
                placeholder="USD (optional)"
                aria-invalid={errors.currency ? true : undefined}
                {...register("currency")}
              />
              {errors.currency ? (
                <p className="text-danger m-0 text-[12px]">
                  {errors.currency.message}
                </p>
              ) : null}
            </div>

            {model &&
            model.capabilities.includes("embedding") &&
            embeddingModels ? (
              <VectorCompatibilitySection
                model={model}
                candidates={embeddingModels}
              />
            ) : null}
          </fieldset>

          {confirming && model ? (
            <KnowledgeModelChangeConfirm
              modelId={model.id}
              change={{
                providerModelId:
                  confirming.providerModelId ?? model.providerModelId,
                embeddingDimensions: confirming.embeddingDimensions ?? null,
                embeddingDimensionMode:
                  confirming.embeddingDimensionMode ?? "native",
                upstreamProvider: confirming.upstreamProvider ?? null,
              }}
              pending={pending}
              onBack={() => setConfirming(null)}
              onConfirm={() =>
                updateModel.mutate({ modelId: model.id, ...confirming })
              }
            />
          ) : (
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={pending || detectDimensions.isPending}
              >
                {pending ? "Saving…" : "Save model"}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

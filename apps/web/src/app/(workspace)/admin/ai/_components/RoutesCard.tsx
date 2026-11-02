"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { api, type RouterOutputs } from "~/trpc/react";
import { KnowledgeRouteConfirmDialog } from "./KnowledgeRouteConfirmDialog";
import {
  HEALTH_LABELS,
  PURPOSE_LABELS,
  REASONING_MODE_LABELS,
  reasoningModes,
  savedMessage,
  type ReasoningMode,
} from "./llmSchemas";

type Overview = RouterOutputs["llm"]["overview"];
type KnowledgePurpose = "knowledge_extraction" | "knowledge_embedding";
type PendingKnowledgeRoute = {
  purpose: KnowledgePurpose;
  modelId: string;
  label: string;
  reasoningMode: ReasoningMode;
};

// Fixed status width keeps every row's columns aligned with the header row.
const ROUTE_COLUMNS =
  "lg:grid lg:grid-cols-[minmax(10rem,1fr)_minmax(14rem,2fr)_minmax(10rem,1fr)_9rem] lg:items-center";

function isKnowledgePurpose(purpose: string): purpose is KnowledgePurpose {
  return (
    purpose === "knowledge_extraction" || purpose === "knowledge_embedding"
  );
}

export function RoutesCard({
  connections,
  routes,
}: Pick<Overview, "connections" | "routes">) {
  const utils = api.useUtils();
  const [pendingKnowledgeRoute, setPendingKnowledgeRoute] = useState<
    PendingKnowledgeRoute | undefined
  >();
  const setRoute = api.llm.setRoute.useMutation({
    onSuccess: (route) => {
      toast.success(savedMessage("Route", route.reindexProjects));
      void utils.llm.overview.invalidate();
    },
    onError: (error) => toast.error(error.message || "Could not save route"),
  });
  const modelOptions = connections.flatMap((connection) =>
    connection.models.map((model) => ({
      id: model.id,
      label: `${connection.name} › ${model.displayName}`,
    })),
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="m-0 text-base leading-snug font-medium">Routes</h2>
          </CardTitle>
          <CardDescription>
            Choose the declared model used for each AI purpose. Incompatible
            models remain visible so Weaver can explain why they cannot be
            assigned.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div
            aria-hidden="true"
            className={`text-text-2 hidden gap-2 border border-transparent px-3 text-xs ${ROUTE_COLUMNS}`}
          >
            <span>Purpose</span>
            <span>Model</span>
            <span>Thinking effort</span>
            <span>Status</span>
          </div>
          {routes.map((route) => (
            <div
              key={route.purpose}
              data-testid={`route-${PURPOSE_LABELS[route.purpose]}`}
              className={`border-line-faint flex flex-col gap-2 rounded-lg border px-3 py-2 ${ROUTE_COLUMNS}`}
            >
              <div className="text-text text-[13px] font-medium">
                {PURPOSE_LABELS[route.purpose]}
                {route.purpose === "document_summary" && (
                  <p className="text-text-2 mt-1 text-xs font-normal">
                    Optional. Summarizes changed document excerpts. Saves use a
                    standard comment when unavailable.
                  </p>
                )}
                {route.purpose === "wiki" && (
                  <p className="text-text-2 mt-1 text-xs font-normal">
                    Optional. Needs chat and tool use. Unassigning it stops the
                    wiki agent in every project.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label
                  className="text-text-2 text-xs lg:sr-only"
                  htmlFor={`route-model-${route.purpose}`}
                >
                  Model
                </label>
                <Select
                  value={route.model?.modelId ?? "unassigned"}
                  disabled={setRoute.isPending}
                  onValueChange={(value) => {
                    const reasoningMode: ReasoningMode =
                      value === "unassigned" ||
                      route.purpose === "knowledge_embedding"
                        ? "provider_default"
                        : route.reasoningMode;
                    if (
                      isKnowledgePurpose(route.purpose) &&
                      value !== "unassigned" &&
                      value !== route.model?.modelId
                    ) {
                      setPendingKnowledgeRoute({
                        purpose: route.purpose,
                        modelId: value,
                        label:
                          modelOptions.find((model) => model.id === value)
                            ?.label ?? value,
                        reasoningMode,
                      });
                      return;
                    }
                    setRoute.mutate({
                      purpose: route.purpose,
                      modelId: value === "unassigned" ? null : value,
                      reasoningMode,
                    });
                  }}
                >
                  <SelectTrigger
                    id={`route-model-${route.purpose}`}
                    className="w-full"
                    aria-label={`${PURPOSE_LABELS[route.purpose]} route`}
                  >
                    <SelectValue>
                      {route.model?.displayName ?? "Unassigned"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {modelOptions.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {route.purpose === "knowledge_embedding" ? (
                <span className="text-text-3 text-xs">No thinking effort</span>
              ) : (
                <div className="flex flex-col gap-1">
                  <label
                    className="text-text-2 text-xs lg:sr-only"
                    htmlFor={`route-reasoning-${route.purpose}`}
                  >
                    Thinking effort
                  </label>
                  <Select
                    value={route.reasoningMode}
                    disabled={setRoute.isPending || !route.model}
                    onValueChange={(value) =>
                      setRoute.mutate({
                        purpose: route.purpose,
                        modelId: route.model?.modelId ?? null,
                        reasoningMode: value as (typeof reasoningModes)[number],
                      })
                    }
                  >
                    <SelectTrigger
                      id={`route-reasoning-${route.purpose}`}
                      className="w-full"
                      aria-label={`${PURPOSE_LABELS[route.purpose]} thinking effort`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {reasoningModes.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {REASONING_MODE_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Badge
                variant={
                  route.health === "ready"
                    ? "default"
                    : (route.purpose === "document_summary" ||
                          route.purpose === "wiki") &&
                        route.health === "unassigned"
                      ? "outline"
                      : "destructive"
                }
              >
                {HEALTH_LABELS[route.health]}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
      {pendingKnowledgeRoute ? (
        <KnowledgeRouteConfirmDialog
          purpose={pendingKnowledgeRoute.purpose}
          modelId={pendingKnowledgeRoute.modelId}
          modelLabel={pendingKnowledgeRoute.label}
          onConfirm={() => {
            setRoute.mutate({
              purpose: pendingKnowledgeRoute.purpose,
              modelId: pendingKnowledgeRoute.modelId,
              reasoningMode: pendingKnowledgeRoute.reasoningMode,
            });
            setPendingKnowledgeRoute(undefined);
          }}
          onCancel={() => setPendingKnowledgeRoute(undefined)}
        />
      ) : null}
    </>
  );
}

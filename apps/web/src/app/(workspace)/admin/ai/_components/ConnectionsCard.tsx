"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useMounted } from "~/lib/use-mounted";
import { api, type RouterOutputs } from "~/trpc/react";
import { ConnectionDialog } from "./ConnectionDialog";
import { DeleteLlmDialog } from "./DeleteLlmDialog";
import { ImportModelsDialog } from "./ImportModelsDialog";
import { CAPABILITY_LABELS, PROVIDER_LABELS } from "./llmSchemas";
import { ModelDialog } from "./ModelDialog";

type Overview = RouterOutputs["llm"]["overview"];
type Connection = Overview["connections"][number];
type Model = Connection["models"][number];
type DiscoveredModel = NonNullable<
  RouterOutputs["llm"]["testConnection"]["models"]
>[number];

type DeleteTarget =
  | { kind: "connection"; connection: Connection }
  | { kind: "model"; connection: Connection; model: Model };

type DialogState<Value> = Value & { instance: number; open: boolean };

function relativeTime(value: Date): string {
  const elapsedSeconds = Math.round((value.getTime() - Date.now()) / 1000);
  const intervals = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.345, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ] as const;
  let amount = elapsedSeconds;
  for (const [limit, unit] of intervals) {
    if (Math.abs(amount) < limit) {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
        amount,
        unit,
      );
    }
    amount = Math.round(amount / limit);
  }
  return "";
}

function LastTest({ connection }: { connection: Connection }) {
  const mounted = useMounted();
  if (!connection.lastTestAt || !connection.lastTestOutcome) {
    return <span>Not tested</span>;
  }
  return (
    <span>
      {connection.lastTestOutcome === "success" ? "Success" : "Failed"}
      {connection.lastTestSummary ? ` · ${connection.lastTestSummary}` : ""}
      {mounted ? ` · ${relativeTime(connection.lastTestAt)}` : ""}
    </span>
  );
}

function Price({
  value,
  currency,
}: {
  value: number | null;
  currency: string | null;
}) {
  return value === null ? (
    <span>—</span>
  ) : (
    <span>{`${value} µ ${currency ?? ""}`.trim()}</span>
  );
}

export function ConnectionsCard({
  encryptionConfigured,
  connections,
  routedEmbeddingModelId = null,
}: Pick<Overview, "encryptionConfigured" | "connections"> & {
  routedEmbeddingModelId?: string | null;
}) {
  const utils = api.useUtils();
  const dialogSequenceRef = useRef(0);
  const connectionsFocusRef = useRef<HTMLDivElement | null>(null);
  const connectionDialogTriggerRef = useRef<HTMLElement | null>(null);
  const modelDialogTriggerRef = useRef<HTMLElement | null>(null);
  const deleteDialogTriggerRef = useRef<HTMLElement | null>(null);
  const importDialogTriggerRef = useRef<HTMLElement | null>(null);
  const [importDialog, setImportDialog] = useState<
    | DialogState<{
        connection: { id: string; name: string };
        models: DiscoveredModel[];
      }>
    | undefined
  >();
  const [connectionDialog, setConnectionDialog] = useState<
    DialogState<{ connection?: Connection }> | undefined
  >();
  const [modelDialog, setModelDialog] = useState<
    | DialogState<{
        connectionId: string;
        providerType: Connection["providerType"];
        model?: Model;
      }>
    | undefined
  >();
  const [deleteDialog, setDeleteDialog] = useState<
    DialogState<{ target: DeleteTarget }> | undefined
  >();

  const nextDialogInstance = () => {
    dialogSequenceRef.current += 1;
    return dialogSequenceRef.current;
  };

  const testConnection = api.llm.testConnection.useMutation({
    onSuccess: (result) => {
      if (result.outcome === "success") toast.success(result.summary);
      else toast.error(result.summary);
      void utils.llm.overview.invalidate();
    },
    onError: (error) =>
      toast.error(error.message || "Could not test the connection"),
  });
  // A successful test with discovered models opens the import dialog.
  const runConnectionTest = (
    connection: { id: string; name: string },
    trigger: HTMLElement | null,
  ) => {
    importDialogTriggerRef.current = trigger;
    testConnection.mutate(
      { connectionId: connection.id },
      {
        onSuccess: (result) => {
          if (result.outcome !== "success" || !result.models?.length) return;
          setImportDialog({
            instance: nextDialogInstance(),
            open: true,
            connection,
            models: result.models,
          });
        },
      },
    );
  };
  const testModel = api.llm.testModel.useMutation({
    onSuccess: (result) => {
      if (result.outcome === "success") toast.success(result.summary);
      else toast.error(result.summary);
      void utils.llm.overview.invalidate();
    },
    onError: (error) =>
      toast.error(error.message || "Could not test the model"),
  });
  const deleteConnection = api.llm.deleteConnection.useMutation();
  const deleteModel = api.llm.deleteModel.useMutation();
  const embeddingModels = connections.flatMap((connection) =>
    connection.models
      .filter((model) => model.capabilities.includes("embedding"))
      .map((model) => ({
        id: model.id,
        label: `${connection.name} › ${model.displayName}`,
        embeddingDimensions: model.embeddingDimensions,
        embeddingDimensionMode: model.embeddingDimensionMode,
      })),
  );

  return (
    <>
      <Card
        ref={connectionsFocusRef}
        role="region"
        aria-label="LLM connections"
        tabIndex={-1}
      >
        <CardHeader>
          <CardTitle>
            <h2 className="m-0 text-base leading-snug font-medium">
              Connections
            </h2>
          </CardTitle>
          <CardDescription>
            Provider credentials, declared models, capabilities and prices.
          </CardDescription>
          <CardAction>
            <Button
              size="sm"
              disabled={!encryptionConfigured}
              onClick={(event) => {
                connectionDialogTriggerRef.current = event.currentTarget;
                setConnectionDialog({
                  instance: nextDialogInstance(),
                  open: true,
                });
              }}
            >
              Add connection
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {connections.length === 0 ? (
            <p className="text-text-3 m-0 text-[13px]">
              No LLM connections have been added.
            </p>
          ) : (
            connections.map((connection) => (
              <Card
                key={connection.id}
                size="sm"
                data-testid={`connection-${connection.name}`}
              >
                <CardHeader>
                  <CardTitle>{connection.name}</CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {PROVIDER_LABELS[connection.providerType]}
                    </Badge>
                    {!connection.enabled ? (
                      <Badge variant="destructive">Disabled</Badge>
                    ) : null}
                    <span className="break-all">{connection.endpoint}</span>
                  </CardDescription>
                  <CardAction className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="Test connection"
                      disabled={testConnection.isPending}
                      onClick={(event) =>
                        runConnectionTest(
                          { id: connection.id, name: connection.name },
                          event.currentTarget,
                        )
                      }
                    >
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="Edit connection"
                      onClick={(event) => {
                        connectionDialogTriggerRef.current =
                          event.currentTarget;
                        setConnectionDialog({
                          instance: nextDialogInstance(),
                          open: true,
                          connection,
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      aria-label="Delete connection"
                      onClick={(event) => {
                        deleteDialogTriggerRef.current = event.currentTarget;
                        setDeleteDialog({
                          instance: nextDialogInstance(),
                          open: true,
                          target: { kind: "connection", connection },
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-text-3 m-0 text-[12px]">
                    Last test: <LastTest connection={connection} />
                  </p>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-text m-0 text-[13px] font-semibold">
                      Models
                    </h3>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="Add model"
                      onClick={(event) => {
                        modelDialogTriggerRef.current = event.currentTarget;
                        setModelDialog({
                          instance: nextDialogInstance(),
                          open: true,
                          connectionId: connection.id,
                          providerType: connection.providerType,
                        });
                      }}
                    >
                      Add model
                    </Button>
                  </div>
                  {connection.models.length === 0 ? (
                    <p className="text-text-3 m-0 text-[12px]">
                      No models declared for this connection.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Model</TableHead>
                          <TableHead>Capabilities</TableHead>
                          <TableHead>Context</TableHead>
                          <TableHead>Max output</TableHead>
                          <TableHead>Dimensions</TableHead>
                          <TableHead>Input cost</TableHead>
                          <TableHead>Output cost</TableHead>
                          <TableHead className="w-36">
                            <span className="sr-only">Actions</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {connection.models.map((model) => (
                          <TableRow key={model.id}>
                            <TableCell>
                              <div className="text-text text-[13px] font-medium">
                                {model.displayName}
                              </div>
                              <code className="text-text-3 text-[12px]">
                                {model.providerModelId}
                              </code>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {model.capabilities.map((capability) => (
                                  <Badge key={capability} variant="secondary">
                                    {CAPABILITY_LABELS[capability]}
                                  </Badge>
                                ))}
                                {connection.providerType === "openrouter" ? (
                                  <Badge variant="outline">
                                    Upstream:{" "}
                                    {model.upstreamProvider ?? "Automatic"}
                                  </Badge>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="text-text-3 text-[12px]">
                              {model.contextWindow ?? "—"}
                            </TableCell>
                            <TableCell className="text-text-3 text-[12px]">
                              {model.maxOutputTokens ?? "—"}
                            </TableCell>
                            <TableCell className="text-text-3 text-[12px]">
                              {model.embeddingDimensions ?? "—"}
                              {model.capabilities.includes("embedding") &&
                              model.embeddingDimensionMode === "matryoshka" ? (
                                <span className="text-text-3 block">
                                  Matryoshka
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-text-3 text-[12px]">
                              <Price
                                value={model.inputCostMicrosPerMillion}
                                currency={model.currency}
                              />
                            </TableCell>
                            <TableCell className="text-text-3 text-[12px]">
                              <Price
                                value={model.outputCostMicrosPerMillion}
                                currency={model.currency}
                              />
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  aria-label="Test model"
                                  disabled={testModel.isPending}
                                  onClick={() =>
                                    testModel.mutate({ modelId: model.id })
                                  }
                                >
                                  Test
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  aria-label="Edit model"
                                  onClick={(event) => {
                                    modelDialogTriggerRef.current =
                                      event.currentTarget;
                                    setModelDialog({
                                      instance: nextDialogInstance(),
                                      open: true,
                                      connectionId: connection.id,
                                      providerType: connection.providerType,
                                      model,
                                    });
                                  }}
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  aria-label="Delete model"
                                  onClick={(event) => {
                                    deleteDialogTriggerRef.current =
                                      event.currentTarget;
                                    setDeleteDialog({
                                      instance: nextDialogInstance(),
                                      open: true,
                                      target: {
                                        kind: "model",
                                        connection,
                                        model,
                                      },
                                    });
                                  }}
                                >
                                  Delete
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </CardContent>
      </Card>

      {connectionDialog ? (
        <ConnectionDialog
          key={connectionDialog.instance}
          open={connectionDialog.open}
          connection={connectionDialog.connection}
          returnFocusRef={connectionDialogTriggerRef}
          fallbackFocusRef={connectionsFocusRef}
          onOpenChange={(open) =>
            setConnectionDialog((current) =>
              current ? { ...current, open } : current,
            )
          }
          onCreated={(created) =>
            runConnectionTest(
              { id: created.id, name: created.name },
              connectionDialogTriggerRef.current,
            )
          }
        />
      ) : null}
      {importDialog ? (
        <ImportModelsDialog
          key={importDialog.instance}
          open={importDialog.open}
          connection={importDialog.connection}
          discovered={importDialog.models}
          declaredProviderModelIds={
            connections
              .find(
                (connection) => connection.id === importDialog.connection.id,
              )
              ?.models.map((model) => model.providerModelId) ?? []
          }
          returnFocusRef={importDialogTriggerRef}
          fallbackFocusRef={connectionsFocusRef}
          onOpenChange={(open) =>
            setImportDialog((current) =>
              current ? { ...current, open } : current,
            )
          }
        />
      ) : null}
      {modelDialog ? (
        <ModelDialog
          key={modelDialog.instance}
          open={modelDialog.open}
          connectionId={modelDialog.connectionId}
          providerType={modelDialog.providerType}
          model={modelDialog.model}
          embeddingModels={embeddingModels}
          routedForKnowledgeEmbedding={
            modelDialog.model?.id === routedEmbeddingModelId
          }
          returnFocusRef={modelDialogTriggerRef}
          fallbackFocusRef={connectionsFocusRef}
          onOpenChange={(open) =>
            setModelDialog((current) =>
              current ? { ...current, open } : current,
            )
          }
        />
      ) : null}
      {deleteDialog ? (
        <DeleteLlmDialog
          key={deleteDialog.instance}
          open={deleteDialog.open}
          returnFocusRef={deleteDialogTriggerRef}
          fallbackFocusRef={connectionsFocusRef}
          onOpenChange={(open) =>
            setDeleteDialog((current) =>
              current ? { ...current, open } : current,
            )
          }
          title={
            deleteDialog.target.kind === "connection"
              ? "Delete connection"
              : "Delete model"
          }
          description={
            deleteDialog.target.kind === "connection"
              ? `Delete “${deleteDialog.target.connection.name}” and all its models? This cannot be undone.`
              : `Delete “${deleteDialog.target.model.displayName}” from “${deleteDialog.target.connection.name}”? This cannot be undone.`
          }
          onConfirm={async () => {
            if (deleteDialog.target.kind === "connection") {
              await deleteConnection.mutateAsync({
                connectionId: deleteDialog.target.connection.id,
              });
              toast.success("Connection deleted");
            } else {
              await deleteModel.mutateAsync({
                modelId: deleteDialog.target.model.id,
              });
              toast.success("Model deleted");
            }
            await utils.llm.overview.invalidate();
          }}
        />
      ) : null}
    </>
  );
}

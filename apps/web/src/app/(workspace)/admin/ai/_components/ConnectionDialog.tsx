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
import { focusDialogTarget } from "~/lib/dialog-focus";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  connectionFormSchema,
  type ConnectionFormInput,
  type ConnectionFormValues,
  endpointAfterProviderChange,
  fixedEndpointFor,
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_LABELS,
  providerHasEditableEndpoint,
  providerRequiresCredential,
  providerTypes,
  savedMessage,
} from "./llmSchemas";

type LlmConnectionSummary =
  RouterOutputs["llm"]["overview"]["connections"][number];

function endpointOrigin(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

export function ConnectionDialog({
  open,
  onOpenChange,
  connection,
  onCreated,
  returnFocusRef,
  fallbackFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection?: LlmConnectionSummary;
  /** Called after a successful create (never on edit), e.g. to discover models. */
  onCreated?: (connection: LlmConnectionSummary) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const [keylessEndpoint, setKeylessEndpoint] = useState<string | null>(null);
  const defaultValues: ConnectionFormValues = {
    name: connection?.name ?? "",
    providerType: connection?.providerType ?? "openai",
    endpoint:
      connection && providerHasEditableEndpoint(connection.providerType)
        ? connection.endpoint
        : "",
    credential: "",
    requestTimeoutMs: connection?.requestTimeoutMs ?? 30_000,
    enabled: connection?.enabled ?? true,
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
  } = useForm<ConnectionFormInput, undefined, ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues,
  });

  const onClose = () => {
    void utils.llm.overview.invalidate();
    onOpenChange(false);
  };
  const onError = (err: Parameters<typeof applyTrpcErrorToForm>[0]) => {
    if (err.data?.field) {
      applyTrpcErrorToForm(err, (name, error) =>
        setError(name as Parameters<typeof setError>[0], error),
      );
    } else {
      toast.error(err.message || "Could not save connection");
    }
  };
  const createConnection = api.llm.createConnection.useMutation({
    onSuccess: (created) => {
      toast.success("Connection saved");
      onClose();
      onCreated?.(created);
    },
    onError,
  });
  const updateConnection = api.llm.updateConnection.useMutation({
    onSuccess: (result) => {
      toast.success(savedMessage("Connection", result.reindexProjects));
      onClose();
    },
    onError,
  });
  const pending = createConnection.isPending || updateConnection.isPending;
  const providerType = useWatch({ control, name: "providerType" });
  const endpoint = useWatch({ control, name: "endpoint" });
  const canUseNoCredential = Boolean(
    connection &&
    !providerRequiresCredential(connection.providerType) &&
    endpointOrigin(endpoint) !== null &&
    endpointOrigin(endpoint) !== endpointOrigin(connection.endpoint),
  );
  const useNoCredential = canUseNoCredential && keylessEndpoint === endpoint;

  const onSubmit = handleSubmit((values) => {
    if (
      !connection &&
      providerRequiresCredential(values.providerType) &&
      values.credential.trim() === ""
    ) {
      setError("credential", { message: "API key is required" });
      return;
    }
    if (connection) {
      updateConnection.mutate({
        connectionId: connection.id,
        name: values.name,
        endpoint: providerHasEditableEndpoint(connection.providerType)
          ? values.endpoint
          : null,
        credential: useNoCredential
          ? ""
          : values.credential.trim() === ""
            ? null
            : values.credential,
        requestTimeoutMs: values.requestTimeoutMs,
        enabled: values.enabled,
      });
      return;
    }
    createConnection.mutate({
      name: values.name,
      providerType: values.providerType,
      endpoint: providerHasEditableEndpoint(values.providerType)
        ? values.endpoint
        : null,
      credential: values.credential,
      requestTimeoutMs: values.requestTimeoutMs,
      enabled: values.enabled,
    });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        if (!nextOpen) {
          reset(defaultValues);
          setKeylessEndpoint(null);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!pending}
        aria-busy={pending || undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(returnFocusRef.current, fallbackFocusRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {connection ? "Edit connection" : "Add connection"}
          </DialogTitle>
          <DialogDescription>
            Configure the provider endpoint and its write-only credential.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="llm-connection-name">Name</Label>
            <Input
              id="llm-connection-name"
              autoFocus
              aria-invalid={errors.name ? true : undefined}
              {...register("name")}
            />
            {errors.name ? (
              <p className="text-danger m-0 text-[12px]">
                {errors.name.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="llm-connection-provider">Provider</Label>
            <Controller
              control={control}
              name="providerType"
              render={({ field }) => (
                <Select
                  value={field.value}
                  disabled={Boolean(connection)}
                  onValueChange={(value) => {
                    const next = value as ConnectionFormValues["providerType"];
                    const currentName = getValues("name").trim();
                    if (
                      currentName === "" ||
                      currentName === PROVIDER_LABELS[field.value]
                    ) {
                      setValue("name", PROVIDER_LABELS[next], {
                        shouldDirty: true,
                      });
                    }
                    field.onChange(next);
                    setValue(
                      "endpoint",
                      endpointAfterProviderChange(getValues("endpoint"), next),
                      { shouldDirty: true },
                    );
                  }}
                >
                  <SelectTrigger
                    id="llm-connection-provider"
                    className="w-full"
                    aria-invalid={errors.providerType ? true : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerTypes.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {PROVIDER_LABELS[provider]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {providerHasEditableEndpoint(providerType) ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="llm-connection-endpoint">Endpoint</Label>
              <Input
                id="llm-connection-endpoint"
                type="url"
                placeholder={
                  providerType === "lmstudio" || providerType === "ollama"
                    ? PROVIDER_DEFAULT_ENDPOINTS[providerType]
                    : "https://api.example.com/v1"
                }
                aria-invalid={errors.endpoint ? true : undefined}
                {...register("endpoint")}
              />
              {errors.endpoint ? (
                <p className="text-danger m-0 text-[12px]">
                  {errors.endpoint.message}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="llm-connection-fixed-endpoint">Endpoint</Label>
              <output
                id="llm-connection-fixed-endpoint"
                className="border-line bg-subtle text-text-2 m-0 block rounded-lg border px-2.5 py-1.5 text-[13px]"
              >
                {fixedEndpointFor(providerType)}
              </output>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="llm-connection-credential">API key</Label>
            <Input
              id="llm-connection-credential"
              type="password"
              autoComplete="off"
              disabled={useNoCredential}
              required={!connection && providerRequiresCredential(providerType)}
              placeholder={
                connection
                  ? "Leave blank to keep the current key"
                  : providerRequiresCredential(providerType)
                    ? undefined
                    : "Optional for local servers"
              }
              aria-invalid={errors.credential ? true : undefined}
              {...register("credential")}
            />
            {errors.credential ? (
              <p className="text-danger m-0 text-[12px]">
                {errors.credential.message}
              </p>
            ) : null}
            {canUseNoCredential ? (
              <label className="text-text flex items-center gap-2 text-[13px]">
                <input
                  id="llm-connection-no-credential"
                  type="checkbox"
                  checked={useNoCredential}
                  onChange={(event) =>
                    setKeylessEndpoint(event.target.checked ? endpoint : null)
                  }
                />
                Use the new endpoint without an API key
              </label>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="llm-connection-timeout">Timeout (ms)</Label>
            <Input
              id="llm-connection-timeout"
              type="number"
              min={1}
              max={120_000}
              aria-invalid={errors.requestTimeoutMs ? true : undefined}
              {...register("requestTimeoutMs")}
            />
            {errors.requestTimeoutMs ? (
              <p className="text-danger m-0 text-[12px]">
                {errors.requestTimeoutMs.message}
              </p>
            ) : null}
          </div>

          <Controller
            control={control}
            name="enabled"
            render={({ field }) => (
              <label className="text-text flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={field.value}
                  onChange={field.onChange}
                />
                Enabled
              </label>
            )}
          />

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save connection"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

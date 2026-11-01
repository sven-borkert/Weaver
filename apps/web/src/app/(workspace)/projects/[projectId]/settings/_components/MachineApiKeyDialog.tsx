"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { TRPCClientError } from "@trpc/client";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import {
  PROJECT_API_DEFAULT_EXPIRY_DAYS,
  PROJECT_API_DEFAULT_RATE_LIMIT,
  PROJECT_API_MAX_EXPIRY_DAYS,
  PROJECT_API_MAX_RATE_LIMIT,
} from "@weaver/core/projectApi/constants";
import {
  machineGrantInput,
  machineKeyName,
} from "@weaver/core/projectApi/schemas";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  MAX_MACHINE_GRANTS,
  MachineGrantFields,
  grantIdentity,
  type GrantTargetDisplay,
} from "./MachineGrantFields";
import { MachineKeySecretDialog } from "./MachineKeySecretDialog";

type KeySummary = RouterOutputs["projectApiKey"]["list"][number];

/** Client-side mirror of the server's projectApiKey create/update input. */
const keyFormSchema = z.object({
  name: machineKeyName,
  grants: z
    .array(machineGrantInput)
    .min(1, "Add at least one permission")
    .max(MAX_MACHINE_GRANTS),
  expiry: z.enum(["keep", "days", "never"]),
  expiresInDays: z
    .number({ error: "Enter a number of days" })
    .int()
    .min(1)
    .max(PROJECT_API_MAX_EXPIRY_DAYS),
  rateLimitPerMinute: z
    .number({ error: "Enter a request limit" })
    .int()
    .min(1)
    .max(PROJECT_API_MAX_RATE_LIMIT),
});
type KeyFormValues = z.infer<typeof keyFormSchema>;

const EXPIRY_LABELS: Record<KeyFormValues["expiry"], string> = {
  keep: "Keep current expiry",
  days: "After a number of days",
  never: "Never expires",
};

const SERVER_FIELDS: Record<string, keyof KeyFormValues> = {
  name: "name",
  grants: "grants",
  expiresInDays: "expiresInDays",
  rateLimitPerMinute: "rateLimitPerMinute",
};

function initialValues(existing?: KeySummary): KeyFormValues {
  return {
    name: existing?.name ?? "",
    grants:
      existing?.grants.map((grant) =>
        grant.root
          ? { kind: grant.kind, root: true as const, actions: grant.actions }
          : {
              kind: grant.kind,
              targetId: grant.targetId!,
              actions: grant.actions,
            },
      ) ?? [],
    expiry: existing ? "keep" : "days",
    expiresInDays: PROJECT_API_DEFAULT_EXPIRY_DAYS,
    rateLimitPerMinute:
      existing?.rateLimitPerMinute ?? PROJECT_API_DEFAULT_RATE_LIMIT,
  };
}

export function MachineApiKeyDialog({
  projectId,
  baseUrl,
  existing,
}: {
  projectId: string;
  baseUrl: string | null;
  existing?: KeySummary;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<{
    value: string;
    grants: KeySummary["grants"];
  } | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const defaults = useMemo(() => initialValues(existing), [existing]);
  const known = useMemo(
    () =>
      new Map<string, GrantTargetDisplay>(
        (existing?.grants ?? []).map((grant) => [
          grantIdentity(
            grant.root
              ? { kind: grant.kind, root: true }
              : { kind: grant.kind, targetId: grant.targetId ?? undefined },
          ),
          {
            label: grant.label,
            location: grant.location,
            available: grant.available,
          },
        ]),
      ),
    [existing],
  );
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<KeyFormValues>({
    resolver: zodResolver(keyFormSchema),
    defaultValues: defaults,
  });
  // The one-time secret must not linger in the mutation cache.
  const create = api.projectApiKey.create.useMutation({ gcTime: 0 });
  const update = api.projectApiKey.update.useMutation();
  const resetCreate = create.reset;
  useEffect(() => () => resetCreate(), [resetCreate]);
  const pending = create.isPending || update.isPending || isSubmitting;
  const expiry = useWatch({ control, name: "expiry" });
  const invalidGrants = new Set(
    Array.isArray(errors.grants)
      ? errors.grants.flatMap((error, index) => (error ? [index] : []))
      : [],
  );

  function close() {
    reset(defaults);
    setOpen(false);
  }

  async function refreshList(): Promise<boolean> {
    try {
      await utils.projectApiKey.list.invalidate({ projectId }, undefined, {
        throwOnError: true,
      });
      setRefreshFailed(false);
      return true;
    } catch {
      setRefreshFailed(true);
      return false;
    }
  }

  async function onSubmit(values: KeyFormValues) {
    const policy = {
      projectId,
      name: values.name,
      grants: values.grants,
      rateLimitPerMinute: values.rateLimitPerMinute,
      ...(values.expiry === "keep"
        ? {}
        : {
            expiresInDays:
              values.expiry === "never" ? null : values.expiresInDays,
          }),
    };
    try {
      if (existing) {
        await update.mutateAsync({ ...policy, keyId: existing.id });
        toast.success("Project API key updated");
        close();
        if (!(await refreshList()))
          toast.error("Saved, but the key list could not refresh");
        return;
      }
      const result = await create.mutateAsync(policy);
      setSecret({ value: result.secret, grants: result.key.grants });
      create.reset();
      close();
      toast.success("Project API key created");
      await refreshList();
    } catch (error) {
      const field =
        error instanceof TRPCClientError
          ? (error.data as { field?: string } | undefined)?.field
          : undefined;
      if (error instanceof TRPCClientError && field && SERVER_FIELDS[field])
        applyTrpcErrorToForm(error, (name, err) =>
          setError(SERVER_FIELDS[name]!, err),
        );
      else
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "Could not save the project API key",
        );
    }
  }

  const title = existing ? `Edit ${existing.name}` : "Create project API key";
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          if (!next) return close();
          reset(defaults);
          setOpen(true);
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm" variant={existing ? "outline" : "default"}>
            {existing ? "Edit" : "Create key"}
          </Button>
        </DialogTrigger>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
          aria-busy={pending}
          showCloseButton={!pending}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Project API keys belong to this project, not to you. They keep
              working if their creator leaves and only reach the targets below.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="flex min-w-0 flex-col gap-4"
            noValidate
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="machine-key-name">Name</Label>
              <Input
                id="machine-key-name"
                placeholder="Daily user audit"
                disabled={pending}
                aria-invalid={errors.name ? true : undefined}
                {...register("name")}
              />
              {errors.name ? (
                <p className="text-danger m-0 text-[12px]">
                  {errors.name.message}
                </p>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="machine-key-expiry">Expiry</Label>
                <Controller
                  control={control}
                  name="expiry"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      disabled={pending}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger id="machine-key-expiry" className="w-full">
                        <SelectValue>{EXPIRY_LABELS[field.value]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(existing
                          ? (["keep", "days", "never"] as const)
                          : (["days", "never"] as const)
                        ).map((option) => (
                          <SelectItem key={option} value={option}>
                            {EXPIRY_LABELS[option]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {expiry === "days" ? (
                  <Input
                    aria-label="Days until expiry"
                    type="number"
                    min={1}
                    max={PROJECT_API_MAX_EXPIRY_DAYS}
                    disabled={pending}
                    aria-invalid={errors.expiresInDays ? true : undefined}
                    {...register("expiresInDays", { valueAsNumber: true })}
                  />
                ) : null}
                {expiry === "days" && errors.expiresInDays ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.expiresInDays.message}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="machine-key-rate">Requests per minute</Label>
                <Input
                  id="machine-key-rate"
                  type="number"
                  min={1}
                  max={PROJECT_API_MAX_RATE_LIMIT}
                  disabled={pending}
                  aria-invalid={errors.rateLimitPerMinute ? true : undefined}
                  {...register("rateLimitPerMinute", { valueAsNumber: true })}
                />
                {errors.rateLimitPerMinute ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.rateLimitPerMinute.message}
                  </p>
                ) : null}
              </div>
            </div>
            <Controller
              control={control}
              name="grants"
              render={({ field }) => (
                <MachineGrantFields
                  projectId={projectId}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={pending}
                  known={known}
                  invalidGrants={invalidGrants}
                />
              )}
            />
            {errors.grants && !Array.isArray(errors.grants) ? (
              <p className="text-danger m-0 text-[12px]">
                {errors.grants.message ?? "Review the selected permissions"}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={close}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : existing ? "Save changes" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {secret ? (
        <MachineKeySecretDialog
          secret={secret.value}
          projectId={projectId}
          baseUrl={baseUrl}
          grants={secret.grants}
          refreshFailed={refreshFailed}
          onRetry={() => void refreshList()}
          onClose={() => {
            setSecret(null);
            setRefreshFailed(false);
          }}
        />
      ) : null}
    </>
  );
}

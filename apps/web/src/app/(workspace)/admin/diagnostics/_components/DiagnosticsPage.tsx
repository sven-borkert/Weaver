"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, type FormEvent } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import {
  type DIAGNOSTIC_LEVELS,
  diagnosticsSettingsValueSchema,
} from "@weaver/core/diagnostics/settings";

import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { useMounted } from "~/lib/use-mounted";
import { api, type RouterOutputs } from "~/trpc/react";
import { ProcessingCard } from "./ProcessingCard";
import { RetentionCard } from "./RetentionCard";
import { ChangeSummariesCard } from "./ChangeSummariesCard";
import { EventsPanel } from "./EventsPanel";

const PRUNE_CONFIRMATION =
  "Remove rows past retention and the oldest recent rows above the maximum row cap now?";

const LEVEL_HELP: Record<(typeof DIAGNOSTIC_LEVELS)[number], string> = {
  off: "Nothing is logged, not even errors. Housekeeping still runs.",
  errors:
    "Failures and warnings only. Current processing status remains visible, but successful lifecycle events are not recorded.",
  standard:
    "The default: processing lifecycle events, provider calls, warnings, errors, and settings changes, without bodies.",
  verbose:
    "Standard plus provider request and response bodies and tRPC mutations. Bodies may contain project content and are visible only to authorized members. Bodies are pruned after the verbose retention.",
};

export const diagnosticsSettingsFormSchema = diagnosticsSettingsValueSchema;

type DiagnosticsSettingsFormValues = z.infer<
  typeof diagnosticsSettingsFormSchema
>;
type DiagnosticsData = RouterOutputs["diagnostics"]["getSettings"];
type DiagnosticsAction = "save" | "prune";

type DiagnosticsActionToken = {
  owner: DiagnosticsAction;
  generation: number;
};

export function requestDiagnosticsPrune(
  confirm: (message: string) => boolean,
  prune: () => void,
): boolean {
  if (!confirm(PRUNE_CONFIRMATION)) return false;
  prune();
  return true;
}

function DiagnosticsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading diagnostics settings"
      className="flex w-full flex-col gap-4"
    >
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

function DiagnosticsSettingsPanel({ data }: { data: DiagnosticsData }) {
  const mounted = useMounted();
  const utils = api.useUtils();
  const actionLock = useRef<DiagnosticsActionToken | null>(null);
  const actionGeneration = useRef(0);
  const acquireAction = (owner: DiagnosticsAction) => {
    if (actionLock.current) return null;
    const token = { owner, generation: ++actionGeneration.current };
    actionLock.current = token;
    return token;
  };
  const releaseAction = (token: DiagnosticsActionToken) => {
    if (actionLock.current === token) actionLock.current = null;
  };
  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { dirtyFields, errors },
  } = useForm<DiagnosticsSettingsFormValues>({
    resolver: zodResolver(diagnosticsSettingsFormSchema),
    defaultValues: data.settings,
  });
  void dirtyFields; // keepDirtyValues requires a dirtyFields subscription.
  useEffect(() => {
    reset(data.settings, { keepDirtyValues: true });
  }, [data.settings, reset]);
  const level = useWatch({ control, name: "level" });
  const save = api.diagnostics.setSettings.useMutation({
    onSuccess: (result) => {
      reset(result.settings);
      toast.success("Diagnostics settings saved");
      void utils.diagnostics.getSettings.invalidate();
    },
    onError: (error) => {
      if (error.data?.field) {
        applyTrpcErrorToForm(error, (name, formError) =>
          setError(name as Parameters<typeof setError>[0], formError),
        );
      } else {
        toast.error(error.message || "Could not save settings");
      }
    },
  });
  const prune = api.diagnostics.prune.useMutation({
    onSuccess: (result) => {
      toast.success(
        `Removed ${result.verboseRemoved + result.expiredRemoved + result.overflowRemoved} rows`,
      );
      void utils.diagnostics.getSettings.invalidate();
    },
    onError: (error) => toast.error(error.message || "Prune failed"),
  });
  const formatTimestamp = (value: Date | null) =>
    value && mounted ? new Date(value).toLocaleString() : "—";
  const pending = save.isPending || prune.isPending;
  const submitSettings = (event: FormEvent<HTMLFormElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    const token = acquireAction("save");
    if (!token) {
      event.preventDefault();
      return;
    }
    return handleSubmit(
      (values) =>
        save.mutate(values, { onSettled: () => releaseAction(token) }),
      () => releaseAction(token),
    )(event).catch((error: unknown) => {
      releaseAction(token);
      throw error;
    });
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">Diagnostics</h1>
        <p className="text-text-3 m-0 text-[13px]">
          Control the diagnostic log every runtime writes and browse its events
          below. The same events are available through the admin MCP tools.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="m-0 text-base leading-snug font-medium">Logging</h2>
          </CardTitle>
          <CardDescription>{LEVEL_HELP[level]}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={submitSettings}
            noValidate
            aria-busy={pending || undefined}
            className="flex flex-col gap-5"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="diag-level">Level</Label>
                <Controller
                  control={control}
                  name="level"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={pending}
                    >
                      <SelectTrigger
                        id="diag-level"
                        className="w-full"
                        aria-invalid={errors.level ? true : undefined}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="errors">Errors only</SelectItem>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="verbose">Verbose</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.level ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.level.message}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="diag-retention">Retention (days)</Label>
                <Input
                  id="diag-retention"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={90}
                  step={1}
                  disabled={pending}
                  aria-invalid={errors.retentionDays ? true : undefined}
                  {...register("retentionDays", { valueAsNumber: true })}
                />
                {errors.retentionDays ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.retentionDays.message}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="diag-verbose-retention">
                  Verbose retention (hours)
                </Label>
                <Input
                  id="diag-verbose-retention"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={168}
                  step={1}
                  disabled={pending}
                  aria-invalid={errors.verboseRetentionHours ? true : undefined}
                  {...register("verboseRetentionHours", {
                    valueAsNumber: true,
                  })}
                />
                {errors.verboseRetentionHours ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.verboseRetentionHours.message}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="diag-max-rows">Maximum rows</Label>
                <Input
                  id="diag-max-rows"
                  type="number"
                  inputMode="numeric"
                  min={10_000}
                  max={10_000_000}
                  step={1}
                  disabled={pending}
                  aria-invalid={errors.maxRows ? true : undefined}
                  {...register("maxRows", { valueAsNumber: true })}
                />
                {errors.maxRows ? (
                  <p className="text-danger m-0 text-[12px]">
                    {errors.maxRows.message}
                  </p>
                ) : null}
              </div>
            </div>

            <dl className="text-text-2 grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-3 xl:grid-cols-5">
              <div>
                <dt>Rows</dt>
                <dd className="text-text m-0 font-medium">{data.stats.rows}</dd>
              </div>
              <div>
                <dt>Verbose rows</dt>
                <dd className="text-text m-0 font-medium">
                  {data.stats.verboseRows}
                </dd>
              </div>
              <div>
                <dt>Oldest</dt>
                <dd className="text-text m-0 font-medium">
                  {formatTimestamp(data.stats.oldestAt)}
                </dd>
              </div>
              <div>
                <dt>Newest</dt>
                <dd className="text-text m-0 font-medium">
                  {formatTimestamp(data.stats.newestAt)}
                </dd>
              </div>
              <div>
                <dt>Dropped (web)</dt>
                <dd className="text-text m-0 font-medium">
                  {data.stats.writer.dropped}
                </dd>
              </div>
              {(data.stats.writers ?? [])
                .filter((writer) => writer.runtime !== "web")
                .map((writer) => (
                  <div key={writer.runtime}>
                    <dt>Dropped ({writer.runtime}, last reported)</dt>
                    <dd
                      className="text-text m-0 font-medium"
                      title={writer.reportedAt}
                    >
                      {writer.dropped}
                    </dd>
                  </div>
                ))}
            </dl>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  if (pending) return;
                  const token = acquireAction("prune");
                  if (!token) return;
                  try {
                    const dispatched = requestDiagnosticsPrune(
                      (message) => window.confirm(message),
                      () =>
                        prune.mutate(undefined, {
                          onSettled: () => releaseAction(token),
                        }),
                    );
                    if (!dispatched) releaseAction(token);
                  } catch (error) {
                    releaseAction(token);
                    throw error;
                  }
                }}
              >
                {prune.isPending ? "Pruning…" : "Prune now"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function DiagnosticsPage() {
  const query = api.diagnostics.getSettings.useQuery(undefined, {
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const data = dataUnlessAccessError(query.data, query.error);
  const presentation = resolveQueryPresentation({
    data,
    error: query.error,
    isLoading: query.isLoading,
  });

  if (presentation === "loading") return <DiagnosticsPageSkeleton />;
  if (presentation === "error" || !data) {
    return (
      <div
        role="alert"
        className="border-danger-border bg-danger-bg flex w-full flex-col items-start gap-3 rounded-xl border p-5"
      >
        <h1 className="text-text m-0 text-[20px] font-semibold">
          Diagnostics unavailable
        </h1>
        <p className="text-danger m-0 text-[13px]">
          Could not load diagnostics settings.
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <DiagnosticsSettingsPanel data={data} />
      <RetentionCard />
      <ProcessingCard />
      <ChangeSummariesCard />
      <EventsPanel />
    </div>
  );
}

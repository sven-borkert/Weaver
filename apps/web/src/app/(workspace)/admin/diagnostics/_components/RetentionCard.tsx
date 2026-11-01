"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { retentionSettingsValueSchema } from "@weaver/core/diagnostics/retentionSettings";

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
import { Skeleton } from "~/components/ui/skeleton";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";

export const retentionSettingsFormSchema = retentionSettingsValueSchema;

type RetentionSettingsFormValues = z.infer<typeof retentionSettingsFormSchema>;
type RetentionData = RouterOutputs["diagnostics"]["getRetentionSettings"];

function RetentionForm({ data }: { data: RetentionData }) {
  const utils = api.useUtils();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { dirtyFields, errors },
  } = useForm<RetentionSettingsFormValues>({
    resolver: zodResolver(retentionSettingsFormSchema),
    defaultValues: data.settings,
  });
  void dirtyFields; // keepDirtyValues requires a dirtyFields subscription.
  useEffect(() => {
    reset(data.settings, { keepDirtyValues: true });
  }, [data.settings, reset]);
  const save = api.diagnostics.setRetentionSettings.useMutation({
    onSuccess: (result) => {
      reset(result.settings);
      toast.success("Retention settings saved");
      void utils.diagnostics.getRetentionSettings.invalidate();
    },
    onError: (error) => {
      if (error.data?.field) {
        applyTrpcErrorToForm(error, (name, formError) =>
          setError(name as Parameters<typeof setError>[0], formError),
        );
      } else {
        toast.error(error.message || "Could not save retention settings");
      }
    },
  });
  const pending = save.isPending;

  return (
    <form
      onSubmit={handleSubmit((values) => save.mutate(values))}
      noValidate
      aria-busy={pending || undefined}
      className="flex flex-col gap-5"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="retention-ingestion">Import history (days)</Label>
          <Input
            id="retention-ingestion"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            step={1}
            disabled={pending}
            aria-invalid={errors.ingestionDays ? true : undefined}
            {...register("ingestionDays", { valueAsNumber: true })}
          />
          {errors.ingestionDays ? (
            <p className="text-danger m-0 text-[12px]">
              {errors.ingestionDays.message}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="retention-assistant">
            Idle assistant conversations (days, 0 = keep)
          </Label>
          <Input
            id="retention-assistant"
            type="number"
            inputMode="numeric"
            min={0}
            max={730}
            step={1}
            disabled={pending}
            aria-invalid={errors.assistantConversationDays ? true : undefined}
            {...register("assistantConversationDays", {
              valueAsNumber: true,
            })}
          />
          {errors.assistantConversationDays ? (
            <p className="text-danger m-0 text-[12px]">
              {errors.assistantConversationDays.message}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="retention-task-runs">Task run history (days)</Label>
          <Input
            id="retention-task-runs"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            step={1}
            disabled={pending}
            aria-invalid={errors.taskRunDays ? true : undefined}
            {...register("taskRunDays", { valueAsNumber: true })}
          />
          {errors.taskRunDays ? (
            <p className="text-danger m-0 text-[12px]">
              {errors.taskRunDays.message}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="retention-ai-usage">AI usage history (days)</Label>
          <Input
            id="retention-ai-usage"
            type="number"
            inputMode="numeric"
            min={1}
            max={730}
            step={1}
            disabled={pending}
            aria-invalid={errors.aiUsageDays ? true : undefined}
            {...register("aiUsageDays", { valueAsNumber: true })}
          />
          {errors.aiUsageDays ? (
            <p className="text-danger m-0 text-[12px]">
              {errors.aiUsageDays.message}
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save retention"}
        </Button>
      </div>
    </form>
  );
}

export function RetentionCard() {
  const query = api.diagnostics.getRetentionSettings.useQuery();
  const data = dataUnlessAccessError(query.data, query.error);
  const presentation = resolveQueryPresentation({
    data,
    error: query.error,
    isLoading: query.isLoading,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Retention</CardTitle>
        <CardDescription>
          How long finished imports, idle assistant conversations, task runs and
          AI usage records are kept. Cleanup runs with the scheduled reconcile
          pass.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {presentation === "loading" ? (
          <Skeleton className="h-32 w-full rounded-xl" />
        ) : presentation === "error" || !data ? (
          <div
            role="alert"
            className="text-danger flex items-center gap-3 text-[13px]"
          >
            Retention settings unavailable.
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <RetentionForm data={data} />
        )}
      </CardContent>
    </Card>
  );
}

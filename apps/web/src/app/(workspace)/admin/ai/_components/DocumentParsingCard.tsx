"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

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
import { api } from "~/trpc/react";

const formSchema = z.object({
  doclingBaseUrl: z.string().trim().max(2048),
  doclingTimeoutMs: z.coerce.number().int().min(1_000).max(600_000),
});
type FormInput = z.input<typeof formSchema>;
type FormValues = z.infer<typeof formSchema>;

export function DocumentParsingCard() {
  const utils = api.useUtils();
  const settings = api.ingestionAdmin.getSettings.useQuery();
  const settingsData = dataUnlessAccessError(settings.data, settings.error);
  const presentation = resolveQueryPresentation({
    data: settingsData,
    error: settings.error,
    isLoading: settings.isLoading,
  });
  const {
    register,
    handleSubmit,
    getValues,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<FormInput, undefined, FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { doclingBaseUrl: "", doclingTimeoutMs: 120_000 },
  });
  useEffect(() => {
    if (settingsData) {
      reset({
        doclingBaseUrl: settingsData.doclingBaseUrl ?? "",
        doclingTimeoutMs: settingsData.doclingTimeoutMs,
      });
    }
  }, [settingsData, reset]);
  const save = api.ingestionAdmin.setSettings.useMutation({
    onSuccess: () => {
      toast.success("Document parsing settings saved");
      void utils.ingestionAdmin.getSettings.invalidate();
    },
    onError: (error) => {
      applyTrpcErrorToForm(error, (name, err) =>
        setError(name as Parameters<typeof setError>[0], err),
      );
      toast.error(error.message || "Could not save settings");
    },
  });
  const probe = api.ingestionAdmin.probeDocling.useMutation({
    onSuccess: (result) =>
      result.ok ? toast.success(result.message) : toast.error(result.message),
    onError: (error) => toast.error(error.message || "Connection test failed"),
  });

  if (presentation === "loading")
    return <Skeleton className="h-40 w-full rounded-xl" />;

  if (presentation === "error" || !settingsData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="m-0 text-base leading-snug font-medium">
              Document parsing
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            role="alert"
            className="border-danger-border bg-danger-bg text-danger flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px]"
          >
            <span>Could not load document parsing settings.</span>
            <Button variant="outline" onClick={() => void settings.refetch()}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="m-0 text-base leading-snug font-medium">
            Document parsing
          </h2>
        </CardTitle>
        <CardDescription>
          Optional docling-serve endpoint used for PDF and image imports. When
          it is empty or unreachable, the built-in parser and the Import parsing
          route handle scans.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={handleSubmit((values) =>
            save.mutate({
              doclingBaseUrl:
                values.doclingBaseUrl === "" ? null : values.doclingBaseUrl,
              doclingTimeoutMs: values.doclingTimeoutMs,
            }),
          )}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="doclingBaseUrl">Docling base URL</Label>
            <Input
              id="doclingBaseUrl"
              placeholder="http://docling:5001"
              defaultValue={settingsData.doclingBaseUrl ?? ""}
              {...register("doclingBaseUrl")}
            />
            {errors.doclingBaseUrl ? (
              <p className="text-danger m-0 text-[12px]">
                {errors.doclingBaseUrl.message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="doclingTimeoutMs">Conversion timeout (ms)</Label>
            <Input
              id="doclingTimeoutMs"
              type="number"
              min={1000}
              max={600000}
              defaultValue={settingsData.doclingTimeoutMs}
              {...register("doclingTimeoutMs")}
            />
            {errors.doclingTimeoutMs ? (
              <p className="text-danger m-0 text-[12px]">
                {errors.doclingTimeoutMs.message}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={!isDirty || save.isPending}>
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={probe.isPending}
              onClick={() => {
                const baseUrl = getValues("doclingBaseUrl").trim();
                if (!baseUrl) {
                  toast.error("Enter a base URL first");
                  return;
                }
                probe.mutate({ baseUrl });
              }}
            >
              Test connection
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

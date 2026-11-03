"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { describeSchedule } from "@weaver/core/scheduledTasks/scheduleSchema";

import { Button } from "~/components/ui/button";
import { ClientDate } from "~/components/ui/client-date";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  describeLintSkip,
  maintenanceDefaults,
  maintenanceFormSchema,
  maintenancePayload,
  type MaintenanceFormValues,
} from "./maintenanceForm";

type Settings = RouterOutputs["wiki"]["settings"];

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function MaintenanceSection({
  settings,
  isOwner,
}: {
  settings: Settings;
  isOwner: boolean;
}) {
  const utils = api.useUtils();
  const invalidate = () =>
    void utils.wiki.settings.invalidate({ projectId: settings.projectId });
  const clear = api.wiki.clearLintPause.useMutation({
    onSuccess: () => {
      toast.success("Scheduled maintenance resumed");
      invalidate();
    },
    onError: () => {
      toast.error("Could not resume scheduled maintenance.");
      invalidate();
    },
  });
  return (
    <div className="flex flex-col gap-2" aria-label="Wiki maintenance">
      <span className="text-text text-[13px] font-medium">Maintenance</span>
      {settings.lintSchedule ? (
        <p className="text-text-2 m-0 text-[13px]">
          {describeSchedule(settings.lintSchedule, settings.lintTimezone)}
          {settings.lintNextRunAt ? (
            <>
              . Next run <ClientDate value={settings.lintNextRunAt} />.
            </>
          ) : null}
        </p>
      ) : (
        <p className="text-text-2 m-0 text-[13px]">
          Scheduled maintenance is off.
        </p>
      )}
      {settings.lintPausedAt ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="text-danger m-0 text-[13px]">
            Scheduled maintenance is paused after{" "}
            {settings.lintConsecutiveFailures} failed runs in a row. Check the
            Runs tab.
          </p>
          {isOwner ? (
            <Button
              variant="outline"
              size="sm"
              disabled={clear.isPending}
              onClick={() =>
                clear.mutate({
                  projectId: settings.projectId,
                  expectedRevision: settings.revision,
                })
              }
            >
              Resume
            </Button>
          ) : null}
        </div>
      ) : null}
      {settings.lintSkipped ? (
        <p className="text-text-3 m-0 text-[12px]">
          The slot of <ClientDate value={settings.lintSkipped.at} /> was
          skipped: {describeLintSkip(settings.lintSkipped.reason)}.
        </p>
      ) : null}
      {isOwner ? (
        <ScheduleForm key={settings.revision} settings={settings} />
      ) : null}
    </div>
  );
}

function ScheduleForm({ settings }: { settings: Settings }) {
  const utils = api.useUtils();
  const form = useForm<MaintenanceFormValues>({
    resolver: zodResolver(maintenanceFormSchema),
    defaultValues: maintenanceDefaults(settings),
  });
  const kind = useWatch({ control: form.control, name: "kind" });
  const errors = form.formState.errors;
  const save = api.wiki.update.useMutation({
    onSuccess: () => {
      toast.success("Maintenance schedule saved");
      void utils.wiki.settings.invalidate({ projectId: settings.projectId });
    },
    onError: (error) => {
      toast.error(
        error.data?.code === "CONFLICT"
          ? "The wiki settings changed. Reload and try again."
          : "Could not save the maintenance schedule.",
      );
      void utils.wiki.settings.invalidate({ projectId: settings.projectId });
    },
  });
  return (
    <form
      aria-label="Maintenance schedule"
      className="flex flex-col gap-2"
      onSubmit={form.handleSubmit((values) =>
        save.mutate({
          projectId: settings.projectId,
          expectedRevision: settings.revision,
          ...maintenancePayload(values),
        }),
      )}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wiki-lint-kind">Repeat</Label>
          <Controller
            control={form.control}
            name="kind"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={save.isPending}
              >
                <SelectTrigger
                  id="wiki-lint-kind"
                  aria-label="Maintenance repeat"
                  className="w-32"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>
        {kind !== "off" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wiki-lint-time">
              {kind === "hourly" ? "Minute (as HH:MM)" : "Time"}
            </Label>
            <Input
              id="wiki-lint-time"
              type="time"
              className="w-32"
              disabled={save.isPending}
              aria-invalid={errors.time ? true : undefined}
              {...form.register("time")}
            />
          </div>
        ) : null}
        {kind === "weekly" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wiki-lint-weekday">Weekday</Label>
            <Controller
              control={form.control}
              name="weekday"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={save.isPending}
                >
                  <SelectTrigger
                    id="wiki-lint-weekday"
                    aria-label="Maintenance weekday"
                    className="w-36"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((name, index) => (
                      <SelectItem key={name} value={String(index)}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        ) : null}
        {kind === "monthly" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wiki-lint-day">Day of month (1–28)</Label>
            <Input
              id="wiki-lint-day"
              type="number"
              min={1}
              max={28}
              className="w-24"
              disabled={save.isPending}
              aria-invalid={errors.day ? true : undefined}
              {...form.register("day")}
            />
          </div>
        ) : null}
        {kind !== "off" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wiki-lint-timezone">Timezone</Label>
            <Input
              id="wiki-lint-timezone"
              className="w-44"
              disabled={save.isPending}
              aria-invalid={errors.timezone ? true : undefined}
              {...form.register("timezone")}
            />
          </div>
        ) : null}
        <Button
          type="submit"
          variant="outline"
          disabled={save.isPending || !form.formState.isDirty}
        >
          Save
        </Button>
      </div>
      {errors.time || errors.day || errors.timezone ? (
        <p className="text-danger m-0 text-[12px]">
          {(errors.time ?? errors.day ?? errors.timezone)?.message}
        </p>
      ) : (
        <p className="text-text-3 m-0 text-[12px]">
          The agent checks links, recent changes and stale pages, makes small
          fixes and writes a report page. Missed slots are skipped.
        </p>
      )}
    </form>
  );
}

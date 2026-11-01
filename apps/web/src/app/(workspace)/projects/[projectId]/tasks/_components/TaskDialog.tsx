"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import type { ExternalInput } from "@weaver/core/externalMcp/types";
import type { ScopeRequest } from "@weaver/core/assistant/scopeSchema";
import {
  describeSchedule,
  TASK_INSTRUCTION_MAX_LENGTH,
  taskScheduleSchema,
  WEEKDAY_NAMES,
} from "@weaver/core/scheduledTasks/scheduleSchema";

import { ScopeSelector } from "~/components/assistant/ScopeSelector";
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
import { Textarea } from "~/components/ui/textarea";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";
import { ExternalInputsEditor } from "./ExternalInputsEditor";
import { FolderPicker } from "../../documents/_components/FolderPicker";
import {
  browserTimezone,
  DEFAULT_SCHEDULE_VALUES,
  fromSchedule,
  taskFormSchema,
  taskExternalInputsSchema,
  toSchedule,
  type ScheduleFormValues,
  type TaskFormValues,
} from "./scheduleForm";

type TaskDetail = RouterOutputs["scheduledTask"]["get"];

// The server pins schedule and scope errors, which have no field of their own.
const ERROR_FIELDS: Record<
  string,
  keyof TaskFormValues | "root" | "root.externalInputs" | "root.outputDocument"
> = {
  name: "name",
  instruction: "instruction",
  outputFolderPath: "outputFolderPath",
  outputTitle: "outputTitle",
  outputDocumentId: "root.outputDocument",
  timezone: "timezone",
  externalInputs: "root.externalInputs",
  schedule: "time",
  scope: "root",
};

function defaultsFor(task: TaskDetail | null): TaskFormValues {
  const schedule: ScheduleFormValues = task
    ? fromSchedule(task.schedule)
    : DEFAULT_SCHEDULE_VALUES;
  return {
    name: task?.name ?? "",
    instruction: task?.instruction ?? "",
    outputFolderPath: task?.outputFolderPath ?? [],
    outputTitle: task?.outputTitle ?? "",
    ...schedule,
    timezone: task?.timezone ?? browserTimezone(),
  };
}

const TABS = [
  ["general", "General"],
  ["instructions", "Instructions"],
  ["focus", "Focus"],
  ["tools", "Tools"],
  ["output", "Output"],
] as const;
type TabId = (typeof TABS)[number][0];

// Where a rejected field lives, so a failed save opens the tab that needs attention.
const FIELD_TAB: Record<string, TabId> = {
  name: "general",
  kind: "general",
  time: "general",
  weekday: "general",
  day: "general",
  timezone: "general",
  schedule: "general",
  instruction: "instructions",
  scope: "focus",
  externalInputs: "tools",
  outputFolderPath: "output",
  outputTitle: "output",
  outputDocumentId: "output",
};

type TaskDialogProps = {
  projectId: string;
  task: TaskDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
};

export function TaskDialog(props: TaskDialogProps) {
  return props.open ? (
    <TaskDialogForm key={props.task?.id ?? props.projectId} {...props} />
  ) : null;
}

function TaskDialogForm({
  projectId,
  task,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: TaskDialogProps) {
  const [externalInputs, setExternalInputs] = useState<ExternalInput[]>(
    task?.externalInputs ?? [],
  );
  const utils = api.useUtils();
  const folders = api.folder.tree.useQuery({ projectId }, { enabled: open });
  const projects = api.project.list.useQuery(undefined, { enabled: open });
  const [scope, setScope] = useState<ScopeRequest>(
    task?.scopeRequest ?? { kind: "project", projectId },
  );
  const [tab, setTab] = useState<TabId>("general");
  const me = api.account.me.useQuery(undefined, { enabled: open });
  const connections = api.externalMcp.list.useQuery(
    { limit: 100 },
    { enabled: open, retry: false },
  );
  const [target, setTarget] = useState<"new" | "existing">(
    task?.outputDocumentId ? "existing" : "new",
  );
  const [targetDocumentId, setTargetDocumentId] = useState(
    task?.outputDocumentId ?? "",
  );
  const [outputMode, setOutputMode] = useState<"replace" | "update">(
    task?.outputMode ?? "replace",
  );
  const [documentSearch, setDocumentSearch] = useState("");
  const documents = api.document.list.useQuery(
    {
      projectId,
      pageSize: 100,
      sort: "title",
      dir: "asc",
      ...(documentSearch.trim() ? { search: documentSearch.trim() } : {}),
    },
    { enabled: open && target === "existing" },
  );
  const currentTarget = api.document.get.useQuery(
    { projectId, documentId: targetDocumentId },
    { enabled: open && Boolean(targetDocumentId), retry: false },
  );
  const {
    register,
    handleSubmit,
    control,
    setError,
    reset,
    formState: { errors },
  } = useForm<TaskFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: defaultsFor(task),
  });
  const instruction = useWatch({ control, name: "instruction" });
  const kind = useWatch({ control, name: "kind" });
  const time = useWatch({ control, name: "time" });
  const weekday = useWatch({ control, name: "weekday" });
  const day = useWatch({ control, name: "day" });
  const timezone = useWatch({ control, name: "timezone" });

  const onSettled = (message: string) => ({
    onSuccess: () => {
      toast.success(message);
      void utils.scheduledTask.listForProject.invalidate({ projectId });
      void utils.scheduledTask.listMine.invalidate();
      if (task) void utils.scheduledTask.get.invalidate({ taskId: task.id });
      onOpenChange(false);
      reset(defaultsFor(null));
    },
    onError: (err: { data?: { field?: string } | null; message: string }) => {
      let pinned = false;
      applyTrpcErrorToForm(err as never, (field, error) => {
        const pinTo = ERROR_FIELDS[field];
        if (!pinTo) return;
        pinned = true;
        setError(pinTo, error);
        const owner = FIELD_TAB[field];
        if (owner) setTab(owner);
      });
      if (!pinned) toast.error(err.message || "Could not save the task");
    },
  });
  const create = api.scheduledTask.create.useMutation(
    onSettled("Task created"),
  );
  const update = api.scheduledTask.update.useMutation(onSettled("Task saved"));
  const pending = create.isPending || update.isPending;

  const onSubmit = handleSubmit(
    (form) => {
      const validatedInputs =
        taskExternalInputsSchema.safeParse(externalInputs);
      if (!validatedInputs.success) {
        setTab("tools");
        setError("root.externalInputs", {
          message:
            validatedInputs.error.issues[0]?.message ??
            "Review external inputs.",
        });
        return;
      }
      if (target === "existing" && !targetDocumentId) {
        setTab("output");
        setError("root.outputDocument", { message: "Choose a document" });
        return;
      }
      const payload = {
        name: form.name,
        instruction: form.instruction,
        scope,
        outputProjectId: projectId,
        externalInputs: validatedInputs.data,
        outputFolderPath: form.outputFolderPath,
        outputDocumentId: target === "existing" ? targetDocumentId : null,
        outputTitle: form.outputTitle.trim() || null,
        outputMode,
        schedule: toSchedule({
          kind: form.kind,
          time: form.time,
          weekday: form.weekday,
          day: form.day,
        }),
        timezone: form.timezone,
      };
      if (task) update.mutate({ taskId: task.id, ...payload });
      else create.mutate(payload);
    },
    (invalid) => {
      const first = Object.keys(invalid).find((field) => FIELD_TAB[field]);
      if (first) setTab(FIELD_TAB[first]!);
    },
  );

  const parsedSchedule = taskScheduleSchema.safeParse(
    toSchedule({ kind, time, weekday, day }),
  );
  const preview = parsedSchedule.success
    ? describeSchedule(parsedSchedule.data, timezone)
    : "";

  const runsAs = me.data
    ? `${me.data.name ?? me.data.email} (${me.data.email})`
    : "you";
  const panel = "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-1";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (!next) reset(defaultsFor(task));
      }}
    >
      <DialogContent
        aria-busy={pending || undefined}
        showCloseButton={!pending}
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex h-[min(46rem,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-5xl flex-col sm:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Runs as {runsAs} with the model routed to Scheduled tasks. That
            account&apos;s project access and MCP connections apply.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            if (!event.currentTarget.reportValidity()) {
              event.preventDefault();
              return;
            }
            void onSubmit(event);
          }}
          className="flex min-h-0 flex-1 flex-col gap-3"
          noValidate
        >
          <fieldset
            disabled={pending}
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div
                role="tablist"
                aria-label="Task settings"
                className="border-line flex shrink-0 gap-1 border-b"
              >
                {TABS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`task-tab-${id}`}
                    aria-selected={tab === id}
                    aria-controls={`task-panel-${id}`}
                    onClick={() => setTab(id)}
                    className={cn(
                      "-mb-px border-b-2 px-3 py-1.5 text-[13px]",
                      tab === id
                        ? "border-brand text-text font-medium"
                        : "text-text-2 hover:text-text border-transparent",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div
                role="tabpanel"
                id="task-panel-general"
                aria-labelledby="task-tab-general"
                hidden={tab !== "general"}
                className={cn(panel, tab !== "general" && "hidden")}
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="task-name">Name</Label>
                  <Input
                    id="task-name"
                    autoFocus
                    disabled={pending}
                    placeholder="Weekly digest"
                    aria-invalid={errors.name ? true : undefined}
                    {...register("name")}
                  />
                  {errors.name ? (
                    <p className="text-danger text-[12px]">
                      {errors.name.message}
                    </p>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="task-kind">Repeat</Label>
                    <Controller
                      control={control}
                      name="kind"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={pending}
                        >
                          <SelectTrigger id="task-kind" aria-label="Repeat">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="hourly">Hourly</SelectItem>
                            <SelectItem value="daily">Daily</SelectItem>
                            <SelectItem value="weekly">Weekly</SelectItem>
                            <SelectItem value="monthly">Monthly</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="task-time">
                      {kind === "hourly" ? "Minute (as HH:MM)" : "Time"}
                    </Label>
                    <Input
                      id="task-time"
                      type="time"
                      disabled={pending}
                      aria-invalid={errors.time ? true : undefined}
                      {...register("time")}
                    />
                    {errors.time ? (
                      <p className="text-danger text-[12px]">
                        {errors.time.message}
                      </p>
                    ) : null}
                  </div>
                  {kind === "weekly" ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="task-weekday">Weekday</Label>
                      <Controller
                        control={control}
                        name="weekday"
                        render={({ field }) => (
                          <Select
                            value={field.value}
                            onValueChange={field.onChange}
                            disabled={pending}
                          >
                            <SelectTrigger
                              id="task-weekday"
                              aria-label="Weekday"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {WEEKDAY_NAMES.map((name, index) => (
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
                      <Label htmlFor="task-day">Day of month (1–28)</Label>
                      <Input
                        id="task-day"
                        type="number"
                        min={1}
                        max={28}
                        disabled={pending}
                        aria-invalid={errors.day ? true : undefined}
                        {...register("day")}
                      />
                      {errors.day ? (
                        <p className="text-danger text-[12px]">
                          {errors.day.message}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="task-timezone">Timezone</Label>
                    <Input
                      id="task-timezone"
                      disabled={pending}
                      placeholder="Europe/Berlin"
                      aria-invalid={errors.timezone ? true : undefined}
                      {...register("timezone")}
                    />
                    {errors.timezone ? (
                      <p className="text-danger text-[12px]">
                        {errors.timezone.message}
                      </p>
                    ) : null}
                  </div>
                </div>
                {preview ? (
                  <p className="text-text-3 text-[12px]">{preview}</p>
                ) : null}
              </div>

              <div
                role="tabpanel"
                id="task-panel-instructions"
                aria-labelledby="task-tab-instructions"
                hidden={tab !== "instructions"}
                className={cn(panel, tab !== "instructions" && "hidden")}
              >
                <Label htmlFor="task-instruction">Instruction</Label>
                <Textarea
                  id="task-instruction"
                  disabled={pending}
                  placeholder="Summarize what changed in this project since the last run and list open questions."
                  aria-invalid={errors.instruction ? true : undefined}
                  className="min-h-48 flex-1 resize-none font-mono text-[13px]"
                  {...register("instruction")}
                />
                <p className="text-text-3 text-[12px]">
                  {instruction.length} / {TASK_INSTRUCTION_MAX_LENGTH}
                  {errors.instruction ? ` — ${errors.instruction.message}` : ""}
                </p>
              </div>

              <div
                role="tabpanel"
                id="task-panel-focus"
                aria-labelledby="task-tab-focus"
                hidden={tab !== "focus"}
                className={cn(panel, tab !== "focus" && "hidden")}
              >
                <div className="flex flex-col gap-1.5">
                  <Label>What the task reads</Label>
                  <ScopeSelector
                    draft={scope}
                    onChange={setScope}
                    page={{ projectId }}
                    accessibleProjects={(projects.data ?? []).map((p) => ({
                      id: p.id,
                      name: p.name,
                    }))}
                  />
                  <p className="text-text-3 text-[12px]">
                    Choose one or more projects, or restrict the task to a
                    folder of this project. Each run is given the changes since
                    the last run and the content of what you choose here, as far
                    as the model&apos;s context allows.
                  </p>
                </div>
              </div>

              <div
                role="tabpanel"
                id="task-panel-tools"
                aria-labelledby="task-tab-tools"
                hidden={tab !== "tools"}
                className={cn(panel, tab !== "tools" && "hidden")}
              >
                <p className="text-text-2 m-0 text-[13px]">
                  The task runs as {runsAs}. It can call read tools of that
                  account&apos;s enabled MCP connections before each run and
                  hand the results to the model.
                </p>
                <p className="text-text-3 m-0 text-[12px]">
                  {connections.data
                    ? connections.data.items.filter((c) => c.enabled).length
                      ? `Enabled connections: ${connections.data.items
                          .filter((c) => c.enabled)
                          .map((c) => c.name)
                          .join(", ")}.`
                      : "This account has no enabled MCP connection. Add one under Account › MCP connections."
                    : ""}
                </p>
                <ExternalInputsEditor
                  scope={scope}
                  outputProjectId={projectId}
                  value={externalInputs}
                  onChange={setExternalInputs}
                  disabled={pending}
                />
                {errors.root?.externalInputs ? (
                  <p role="alert" className="text-danger text-[12px]">
                    {errors.root.externalInputs.message}
                  </p>
                ) : null}
                <p className="text-text-3 text-[12px]">
                  If a task with external inputs is queued or running, wait for
                  it to finish before editing its definition.
                </p>
              </div>

              <div
                role="tabpanel"
                id="task-panel-output"
                aria-labelledby="task-tab-output"
                hidden={tab !== "output"}
                className={cn(panel, tab !== "output" && "hidden")}
              >
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-text mb-1 text-[13px] font-medium">
                    Target document
                  </legend>
                  <label className="text-text flex items-center gap-2 text-[13px]">
                    <input
                      type="radio"
                      name="task-target"
                      checked={target === "new"}
                      onChange={() => setTarget("new")}
                    />
                    Create a document
                  </label>
                  <label className="text-text flex items-center gap-2 text-[13px]">
                    <input
                      type="radio"
                      name="task-target"
                      checked={target === "existing"}
                      onChange={() => setTarget("existing")}
                    />
                    Use an existing document
                  </label>
                </fieldset>
                {target === "existing" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="task-target-search">Document</Label>
                    <Input
                      id="task-target-search"
                      placeholder="Search by title"
                      value={documentSearch}
                      onChange={(event) =>
                        setDocumentSearch(event.target.value)
                      }
                    />
                    <div
                      role="listbox"
                      aria-label="Target document"
                      className="border-line bg-surface scrollarea flex max-h-44 min-h-24 flex-col overflow-y-auto rounded-lg border p-1"
                    >
                      {[
                        ...(targetDocumentId &&
                        currentTarget.data &&
                        !(documents.data?.items ?? []).some(
                          (d) => d.id === targetDocumentId,
                        )
                          ? [
                              {
                                id: targetDocumentId,
                                title: currentTarget.data.title,
                                path: "",
                              },
                            ]
                          : []),
                        ...(documents.data?.items ?? []),
                      ].map((document) => (
                        <button
                          key={document.id}
                          type="button"
                          role="option"
                          aria-selected={document.id === targetDocumentId}
                          onClick={() => setTargetDocumentId(document.id)}
                          className={cn(
                            "hover:bg-hover rounded px-2 py-1 text-left text-[13px]",
                            document.id === targetDocumentId &&
                              "bg-subtle font-medium",
                          )}
                        >
                          {document.title}
                          {document.path ? (
                            <span className="text-text-3">
                              {" "}
                              — {document.path}
                            </span>
                          ) : null}
                        </button>
                      ))}
                      {documents.data && !documents.data.items.length ? (
                        <p className="text-text-3 px-2 py-1 text-[12px]">
                          No document matches.
                        </p>
                      ) : null}
                    </div>
                    {errors.root?.outputDocument ? (
                      <p role="alert" className="text-danger text-[12px]">
                        {errors.root.outputDocument.message}
                      </p>
                    ) : null}
                    <p className="text-text-3 text-[12px]">
                      The task writes into this document. Its earlier content
                      stays in the version history.
                    </p>
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="task-output-title">
                      Title of a created document
                    </Label>
                    <Input
                      id="task-output-title"
                      placeholder="Same as the task name"
                      aria-invalid={errors.outputTitle ? true : undefined}
                      {...register("outputTitle")}
                    />
                    {errors.outputTitle ? (
                      <p className="text-danger text-[12px]">
                        {errors.outputTitle.message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Folder for a created document</Label>
                    <Controller
                      control={control}
                      name="outputFolderPath"
                      render={({ field }) => (
                        <FolderPicker
                          folders={folders.data?.folders ?? []}
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={pending}
                        />
                      )}
                    />
                    {errors.outputFolderPath ? (
                      <p className="text-danger text-[12px]">
                        {errors.outputFolderPath.message}
                      </p>
                    ) : null}
                  </div>
                </div>
                <p className="text-text-3 -mt-2 text-[12px]">
                  {target === "existing"
                    ? "Used only if the chosen document is deleted later: the task then creates a new one."
                    : "The task creates the document on its first run and keeps writing to it."}
                </p>
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-text mb-1 text-[13px] font-medium">
                    On each run
                  </legend>
                  <label className="text-text flex items-start gap-2 text-[13px]">
                    <input
                      type="radio"
                      name="task-output-mode"
                      className="mt-1"
                      checked={outputMode === "replace"}
                      onChange={() => setOutputMode("replace")}
                    />
                    <span>
                      Replace the content
                      <span className="text-text-3 block text-[12px]">
                        The model writes a fresh report that replaces what is
                        there.
                      </span>
                    </span>
                  </label>
                  <label className="text-text flex items-start gap-2 text-[13px]">
                    <input
                      type="radio"
                      name="task-output-mode"
                      className="mt-1"
                      checked={outputMode === "update"}
                      onChange={() => setOutputMode("update")}
                    />
                    <span>
                      Update the document
                      <span className="text-text-3 block text-[12px]">
                        The model is given the current document and revises it
                        according to the instruction.
                      </span>
                    </span>
                  </label>
                </fieldset>
              </div>
            </div>
            {errors.root?.message ? (
              <p className="text-danger text-[12px]">{errors.root.message}</p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : task ? "Save" : "Create"}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

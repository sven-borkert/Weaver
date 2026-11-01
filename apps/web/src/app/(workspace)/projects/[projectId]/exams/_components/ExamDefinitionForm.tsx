"use client";
import { useEffect, useState, useRef } from "react";
import {
  useForm,
  useFieldArray,
  useWatch,
  type FieldPath,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { examDefinitionInputSchema } from "@weaver/core/exams/schema";
import type { ExamDetail } from "@weaver/core/services/exams";
import { api } from "~/trpc/react";
import { useUnsavedChangesGuard } from "~/lib/use-unsaved-changes-guard";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ExamTextarea } from "./ExamTextarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  definitionFormDefaults,
  newQuestion,
  toUpdateInput,
  type ExamFormValues,
} from "./examForm";
import { QuestionFields } from "./QuestionFields";
import { ExamPreview } from "./ExamPreview";
export function ExamDefinitionForm({
  exam,
  reload,
}: {
  exam: ExamDetail;
  reload: () => Promise<ExamDetail | undefined>;
}) {
  const [baseline, setBaseline] = useState(exam);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const regionRef = useRef<HTMLElement | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const form = useForm<ExamFormValues>({
    defaultValues: definitionFormDefaults(exam),
    resolver: zodResolver(examDefinitionInputSchema),
  });
  const { isDirty } = form.formState;
  const fields = useFieldArray({
    control: form.control,
    name: "questions",
    keyName: "fieldKey",
  });
  const utils = api.useUtils();
  const router = useRouter();
  useUnsavedChangesGuard(isDirty);
  if (!isDirty && exam.revision > baseline.revision) setBaseline(exam);
  useEffect(() => {
    form.reset(definitionFormDefaults(baseline));
  }, [baseline, form]);

  const update = api.exam.update.useMutation({
    onSuccess: async (e) => {
      setBaseline(e);
      form.reset(definitionFormDefaults(e));
      setConflict(false);
      toast.success("Exam saved");
      await Promise.all([
        utils.exam.get.invalidate({ examId: e.id }),
        utils.exam.list.invalidate(),
        utils.exam.listAvailable.invalidate(),
      ]);
    },
    onError: (e) => {
      applyTrpcErrorToForm(e, (name, error) =>
        form.setError(name as FieldPath<ExamFormValues>, error),
      );
      if (e.data?.code === "CONFLICT") setConflict(true);
      toast.error(
        e.data?.code === "CONFLICT"
          ? "Someone else changed this exam"
          : e.message,
      );
    },
  });
  const remove = api.exam.delete.useMutation({
    onSuccess: () => {
      form.reset();
      void utils.exam.list.invalidate();
      router.push(`/projects/${exam.projectId}/exams`);
    },
    onError: (e) => toast.error(e.message),
  });
  const attempts = Object.values(exam.attemptCounts).reduce((a, b) => a + b, 0);
  const values = useWatch({ control: form.control }) as ExamFormValues;
  const busy = update.isPending || remove.isPending;
  function setStatus(status: "published" | "archived") {
    void form.handleSubmit((v) =>
      update.mutate({
        ...toUpdateInput(exam.id, baseline.revision, v),
        status,
      }),
    )();
  }
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label="Exam editor"
      className="space-y-4"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{exam.title}</h1>
        <ExamPreview values={values} />
        {exam.status !== "published" ? (
          <Button
            disabled={busy || !fields.fields.length}
            onClick={() => setStatus("published")}
          >
            {exam.status === "archived" ? "Re-open" : "Publish"}
          </Button>
        ) : null}
        {exam.status !== "archived" ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setStatus("archived")}
          >
            Archive
          </Button>
        ) : null}
        <Button
          ref={deleteRef}
          variant="destructive"
          disabled={busy || attempts > 0}
          title={attempts ? "Archive instead" : undefined}
          onClick={() => setDeleting(true)}
        >
          Delete
        </Button>
      </header>
      {attempts ? (
        <p role="status">
          {attempts} attempts exist — changes affect only future attempts
        </p>
      ) : null}
      {conflict ? (
        <p role="alert">
          Someone else changed this exam.{" "}
          <Button
            onClick={() => {
              void reload().then((latest) => {
                if (latest) {
                  setBaseline(latest);
                  form.reset(definitionFormDefaults(latest));
                  setConflict(false);
                }
              });
            }}
          >
            Reload
          </Button>
        </p>
      ) : null}
      <form
        onSubmit={form.handleSubmit((v) =>
          update.mutate(toUpdateInput(exam.id, baseline.revision, v)),
        )}
      >
        <fieldset disabled={busy} className="space-y-4">
          <h2 className="font-semibold">General</h2>
          <label htmlFor="exam-title">Title</label>
          <Input
            id="exam-title"
            maxLength={200}
            aria-invalid={!!form.formState.errors.title}
            {...form.register("title")}
          />
          {form.formState.errors.title ? (
            <p role="alert" className="text-danger">
              {form.formState.errors.title.message}
            </p>
          ) : null}
          <label htmlFor="exam-instructions">Instructions</label>
          <ExamTextarea
            value={values.instructions ?? ""}
            id="exam-instructions"
            maxLength={20000}
            aria-invalid={!!form.formState.errors.instructions}
            {...form.register("instructions")}
          />
          {form.formState.errors.instructions ? (
            <p role="alert" className="text-danger">
              {form.formState.errors.instructions.message}
            </p>
          ) : null}
          <label htmlFor="exam-time">Time limit (minutes)</label>
          <Input
            id="exam-time"
            type="number"
            min={1}
            max={1440}
            aria-invalid={!!form.formState.errors.timeLimitMinutes}
            {...form.register("timeLimitMinutes", { valueAsNumber: true })}
          />
          {form.formState.errors.timeLimitMinutes ? (
            <p role="alert" className="text-danger">
              {form.formState.errors.timeLimitMinutes.message}
            </p>
          ) : null}
          <label htmlFor="exam-pass">Passing percent (optional)</label>
          <Input
            id="exam-pass"
            type="number"
            min={0}
            max={100}
            aria-invalid={!!form.formState.errors.passingPercent}
            {...form.register("passingPercent", {
              setValueAs: (v: string) => (v === "" ? null : Number(v)),
            })}
          />
          {form.formState.errors.passingPercent ? (
            <p role="alert" className="text-danger">
              {form.formState.errors.passingPercent.message}
            </p>
          ) : null}
          <h2 className="font-semibold">Questions</h2>
          {fields.fields.map((q, i) => (
            <QuestionFields
              key={q.fieldKey}
              form={form}
              index={i}
              count={fields.fields.length}
              onMove={(to) => fields.move(i, to)}
              onRemove={() => fields.remove(i)}
            />
          ))}
          {form.formState.errors.questions?.message ? (
            <p role="alert" className="text-danger">
              {form.formState.errors.questions.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={fields.fields.length >= 100}
              onClick={() => fields.append(newQuestion("multiple_choice"))}
            >
              Add multiple-choice question
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={fields.fields.length >= 100}
              onClick={() => fields.append(newQuestion("free_text"))}
            >
              Add free-text question
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </fieldset>
      </form>
      <Dialog
        open={deleting}
        onOpenChange={(v) => {
          if (!remove.isPending) setDeleting(v);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(deleteRef.current, regionRef.current);
          }}
          aria-busy={remove.isPending}
          showCloseButton={!remove.isPending}
        >
          <DialogHeader>
            <DialogTitle>Delete exam?</DialogTitle>
            <DialogDescription>
              Delete {exam.title}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setDeleting(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ examId: exam.id })}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

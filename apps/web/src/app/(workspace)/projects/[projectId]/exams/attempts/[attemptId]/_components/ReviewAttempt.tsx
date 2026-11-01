"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { ReviewAttemptView } from "@weaver/core/services/examAttempts";
import { api } from "~/trpc/react";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { useUnsavedChangesGuard } from "~/lib/use-unsaved-changes-guard";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { AssistantMarkdown } from "~/components/assistant/AssistantMarkdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { ExamQueryState } from "../../../_components/ExamQueryState";
import { ExamQuestionPrompt } from "../../../_components/ExamQuestionPrompt";
import {
  ATTEMPT_STATUS_LABELS,
  GRADED_VIA_LABELS,
  scoreLabel,
} from "../../../_components/examPresentation";
import {
  reviewFormDefaults,
  reviewFormSchema,
  toGradeInput,
  releaseBlockers,
  type ReviewFormValues,
} from "./reviewForm";
function ReviewForm({
  view,
  reload,
}: {
  view: ReviewAttemptView;
  reload: () => Promise<ReviewAttemptView | undefined>;
}) {
  const [baseline, setBaseline] = useState(view);
  const [editing, setEditing] = useState(view.status !== "released");
  const [confirm, setConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const utils = api.useUtils();
  const form = useForm<ReviewFormValues>({
    defaultValues: reviewFormDefaults(view),
    resolver: zodResolver(reviewFormSchema(baseline)),
  });
  const { isDirty } = form.formState;
  useUnsavedChangesGuard(isDirty);
  if (!isDirty && view.revision > baseline.revision) setBaseline(view);
  useEffect(() => {
    form.reset(reviewFormDefaults(baseline));
  }, [baseline, form]);

  const grade = api.exam.grade.useMutation({
    onSuccess: async (next) => {
      form.reset(reviewFormDefaults(next));
      setBaseline(next);
      setConfirm(false);
      setConflict(false);
      toast.success(
        next.status === "released" ? "Grade released" : "Grade saved",
      );
      await Promise.all([
        utils.exam.getAttemptForReview.invalidate({ attemptId: view.id }),
        utils.exam.listAttempts.invalidate(),
        utils.exam.list.invalidate(),
      ]);
      if (next.status === "released") setEditing(false);
    },
    onError: (e) => {
      applyTrpcErrorToForm(e, (name, error) =>
        form.setError(name as `grades.${number}.score`, error),
      );
      if (e.data?.code === "CONFLICT") setConflict(true);
      toast.error(
        e.data?.code === "CONFLICT" ? "The attempt changed" : e.message,
      );
    },
  });
  const values = useWatch({ control: form.control }) as ReviewFormValues;
  const blockers = releaseBlockers(baseline, values);
  const readOnly = grade.isPending || !editing || view.status === "in_progress";
  function release() {
    void form.handleSubmit((v) =>
      grade.mutate(toGradeInput(baseline, v, true)),
    )();
  }
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">
        {view.examTitle} · Attempt {view.attemptNumber}
      </h1>
      <p>
        {view.trainee.name ?? view.trainee.email} ·{" "}
        {ATTEMPT_STATUS_LABELS[view.status]}
      </p>
      {view.submittedAt ? (
        <p>
          Submitted {new Date(view.submittedAt).toLocaleString()} ·{" "}
          {view.submissionKind}
        </p>
      ) : null}
      {view.gradedAt ? (
        <p>
          Proposed by {view.gradedByName ?? "trainer"}{" "}
          {GRADED_VIA_LABELS[view.gradedVia ?? "session"]} at{" "}
          {new Date(view.gradedAt).toLocaleString()}
        </p>
      ) : null}
      {view.releasedAt ? (
        <p>
          Released by {view.releasedByName ?? "trainer"} at{" "}
          {new Date(view.releasedAt).toLocaleString()} · {scoreLabel(view)}
        </p>
      ) : null}
      {conflict ? (
        <p role="alert">
          The attempt changed.{" "}
          <Button
            onClick={() => {
              void reload().then((latest) => {
                if (latest) {
                  setBaseline(latest);
                  form.reset(reviewFormDefaults(latest));
                  setConflict(false);
                }
              });
            }}
          >
            Reload
          </Button>
        </p>
      ) : null}
      {!editing ? (
        <Button onClick={() => setEditing(true)}>Update and re-release</Button>
      ) : null}
      <form
        onSubmit={form.handleSubmit((v) =>
          grade.mutate(toGradeInput(baseline, v, false)),
        )}
      >
        <div className="space-y-5">
          {baseline.snapshot.questions.map((q, i) => {
            const a = baseline.answers.find((a) => a.questionId === q.id);
            return (
              <article
                key={q.id}
                className="border-line space-y-2 rounded-lg border p-4"
              >
                <ExamQuestionPrompt text={q.prompt} />
                {q.choices?.map((c) => (
                  <p key={c.id}>
                    {a?.selectedChoiceIds.includes(c.id) ? "☑" : "☐"} {c.text}
                    {c.correct ? " · Correct" : ""}
                  </p>
                ))}
                {q.expectedAnswer ? (
                  <>
                    <h3>Expected answer</h3>
                    <AssistantMarkdown text={q.expectedAnswer} />
                  </>
                ) : null}
                <h3>Trainee answer</h3>
                <p className="whitespace-pre-wrap">
                  {a?.text ??
                    (a?.selectedChoiceIds.length
                      ? "See selections above"
                      : "No answer")}
                </p>
                <p>Automatic score: {a?.autoScore ?? "—"}</p>
                <label htmlFor={`score-${q.id}`}>Score (max {q.weight})</label>
                <Input
                  disabled={readOnly}
                  id={`score-${q.id}`}
                  type="number"
                  min={0}
                  max={q.weight}
                  step="0.01"
                  aria-invalid={!!form.formState.errors.grades?.[i]?.score}
                  {...form.register(`grades.${i}.score`)}
                />
                {form.formState.errors.grades?.[i]?.score ? (
                  <p role="alert" className="text-danger">
                    {form.formState.errors.grades[i]?.score?.message}
                  </p>
                ) : null}
                <label htmlFor={`rationale-${q.id}`}>Rationale</label>
                <Textarea
                  disabled={readOnly}
                  id={`rationale-${q.id}`}
                  maxLength={2000}
                  aria-invalid={!!form.formState.errors.grades?.[i]?.rationale}
                  {...form.register(`grades.${i}.rationale`)}
                />
                {form.formState.errors.grades?.[i]?.rationale ? (
                  <p role="alert" className="text-danger">
                    {form.formState.errors.grades[i]?.rationale?.message}
                  </p>
                ) : null}
              </article>
            );
          })}
          <label htmlFor="overall-feedback">Overall feedback</label>
          <Textarea
            disabled={readOnly}
            id="overall-feedback"
            maxLength={10000}
            aria-invalid={!!form.formState.errors.overallFeedback}
            {...form.register("overallFeedback")}
          />
          {form.formState.errors.overallFeedback ? (
            <p role="alert" className="text-danger">
              {form.formState.errors.overallFeedback.message}
            </p>
          ) : null}
          {editing ? (
            <div className="flex gap-2">
              <Button type="submit" disabled={readOnly}>
                Save
              </Button>
              <Button
                type="button"
                disabled={readOnly || blockers.length > 0}
                onClick={() => setConfirm(true)}
              >
                Release to trainee
              </Button>
              {blockers.length ? (
                <span>
                  {blockers.length} free-text answers need a score and rationale
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </form>
      <Dialog
        open={confirm}
        onOpenChange={(v) => {
          if (!grade.isPending) setConfirm(v);
        }}
      >
        <DialogContent
          aria-busy={grade.isPending}
          showCloseButton={!grade.isPending}
        >
          <DialogHeader>
            <DialogTitle>Release to trainee?</DialogTitle>
            <DialogDescription>
              The trainee will see the grade, the correct answers and the
              rationales.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={grade.isPending}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
            <Button disabled={grade.isPending} onClick={release}>
              Release
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
export function ReviewAttempt({
  attemptId,
  projectId,
}: {
  projectId: string;
  attemptId: string;
}) {
  const q = api.exam.getAttemptForReview.useQuery({ attemptId });
  const view = dataUnlessAccessError(q.data, q.error);
  if (!view)
    return (
      <ExamQueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.refetch()}
      />
    );
  return (
    <>
      <Button asChild variant="outline">
        <Link href={`/projects/${projectId}/exams/results`}>
          Back to results
        </Link>
      </Button>
      {q.error ? (
        <ExamQueryState error={q.error} retry={() => void q.refetch()} />
      ) : null}
      <ReviewForm
        key={attemptId}
        view={view}
        reload={async () => (await q.refetch()).data}
      />
    </>
  );
}

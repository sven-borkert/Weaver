"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { TraineeAttemptView } from "@weaver/core/services/examAttempts";
import { api } from "~/trpc/react";
import { AssistantMarkdown } from "~/components/assistant/AssistantMarkdown";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { useUnsavedChangesGuard } from "~/lib/use-unsaved-changes-guard";
import { useAutosaveAnswers, type AnswerSlot } from "./useAutosaveAnswers";
import { AttemptTimer } from "./AttemptTimer";
import { ExamQuestionPrompt } from "../../../_components/ExamQuestionPrompt";
export function TakeExam({
  attempt,
  onSubmitted,
  receivedAt,
}: {
  attempt: TraineeAttemptView;
  receivedAt?: number;
  onSubmitted: () => void;
}) {
  const [savedTiming, setTiming] = useState(() => ({
    ...attempt.timing,
    receivedAt: receivedAt ?? Date.now(),
  }));
  const timing =
    receivedAt !== undefined && receivedAt > savedTiming.receivedAt
      ? { ...attempt.timing, receivedAt }
      : savedTiming;
  const [expired, setExpired] = useState(false);
  const [serverClosed, setServerClosed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useRef(false);
  const submit = api.exam.submit.useMutation();
  const utils = api.useUtils();
  const initial = Object.fromEntries(
    attempt.questions.map((q) => [
      q.id,
      {
        value: {
          selectedChoiceIds: q.answer?.selectedChoiceIds ?? [],
          text: q.answer?.text ?? null,
        },
        status: "idle",
        sequence: q.answer?.sequence ?? 0,
        savedAt: q.answer?.savedAt ?? null,
        attempts: 0,
      } satisfies AnswerSlot,
    ]),
  );
  const saves = useAutosaveAnswers({
    attemptId: attempt.id,
    initial,
    onTiming: (t) => setTiming({ ...t, receivedAt: Date.now() }),
    onExpired: () => {
      setExpired(true);
      setServerClosed(true);
      setFailure(
        "The attempt is closed. Some local answers may not have been saved. Reload to see the submitted result.",
      );
    },
  });
  useUnsavedChangesGuard(saves.pendingCount > 0);
  async function finish(timeout = false) {
    if (timeout) setExpired(true);
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      await saves.flush();
      await submit.mutateAsync({ attemptId: attempt.id });
      await utils.exam.listAvailable.invalidate();
      toast.success(
        timeout
          ? "Time is up — your answers were submitted"
          : "Answers submitted",
      );
      setConfirm(false);
      onSubmitted();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Could not submit. Retry.");
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }
  const unanswered = attempt.questions.filter((q) => {
    const s = saves.slots[q.id];
    return !s?.value.text?.trim() && !s?.value.selectedChoiceIds.length;
  }).length;
  return (
    <section aria-label="Take exam" className="space-y-5">
      <header className="flex justify-between">
        <h1 className="text-xl font-semibold">
          {attempt.examTitle} · Attempt {attempt.attemptNumber}
        </h1>
        <AttemptTimer {...timing} onExpired={() => void finish(true)} />
      </header>
      <p role="status">
        {Object.values(saves.slots).some((s) => s.status === "error")
          ? "Save failed — retrying"
          : saves.pendingCount
            ? "Saving…"
            : `All changes saved${saves.lastSavedAt ? ` · ${saves.lastSavedAt.toLocaleTimeString()}` : ""}`}
      </p>
      {failure ? (
        <p role="alert" className="text-danger">
          {failure}{" "}
          {serverClosed ? (
            <Button onClick={onSubmitted}>Reload submitted result</Button>
          ) : null}
          <Button
            disabled={submitting || serverClosed}
            onClick={() => void finish(expired)}
          >
            Retry submission
          </Button>
        </p>
      ) : null}
      <AssistantMarkdown text={attempt.instructions} />
      <div className="space-y-5">
        {attempt.questions.map((q, index) => (
          <section
            key={q.id}
            className="bg-surface border-line space-y-2 rounded-lg border p-4"
          >
            <h2 className="font-semibold">
              Question {index + 1} · {q.weight} points
            </h2>
            <ExamQuestionPrompt text={q.prompt} />
            <fieldset disabled={expired || submitting} className="space-y-2">
              {q.kind === "multiple_choice" ? (
                q.choices?.map((c) => (
                  <label key={c.id} className="flex items-center gap-2">
                    <input
                      type={q.allowMultiple ? "checkbox" : "radio"}
                      name={q.id}
                      checked={
                        saves.slots[q.id]?.value.selectedChoiceIds.includes(
                          c.id,
                        ) ?? false
                      }
                      onChange={(e) =>
                        saves.setChoices(
                          q.id,
                          q.allowMultiple
                            ? e.target.checked
                              ? [
                                  ...(saves.slots[q.id]?.value
                                    .selectedChoiceIds ?? []),
                                  c.id,
                                ]
                              : (
                                  saves.slots[q.id]?.value.selectedChoiceIds ??
                                  []
                                ).filter((id) => id !== c.id)
                            : [c.id],
                        )
                      }
                    />
                    {c.text}
                  </label>
                ))
              ) : (
                <>
                  <label htmlFor={q.id}>Your answer</label>
                  <Textarea
                    id={q.id}
                    maxLength={20000}
                    value={saves.slots[q.id]?.value.text ?? ""}
                    onChange={(e) => saves.setText(q.id, e.target.value)}
                    onBlur={() => void saves.flush().catch(() => undefined)}
                  />
                  <p className="text-text-3 text-xs">
                    {saves.slots[q.id]?.value.text?.length ?? 0} / 20,000
                  </p>
                </>
              )}
            </fieldset>
          </section>
        ))}
      </div>
      <Button disabled={expired || submitting} onClick={() => setConfirm(true)}>
        Submit
      </Button>
      <Dialog
        open={confirm}
        onOpenChange={(v) => {
          if (!submitting) setConfirm(v);
        }}
      >
        <DialogContent aria-busy={submitting} showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>Submit exam?</DialogTitle>
            <DialogDescription>
              {unanswered} unanswered questions. Your answers will be saved
              before submission.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
            <Button disabled={submitting} onClick={() => void finish()}>
              Submit exam
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

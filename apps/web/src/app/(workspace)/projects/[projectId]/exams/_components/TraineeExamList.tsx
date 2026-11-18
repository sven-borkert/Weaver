"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  dataUnlessAccessError,
  isQueryAccessError,
} from "~/lib/query-presentation";
import { ExamQueryState } from "./ExamQueryState";
import { Button } from "~/components/ui/button";
import { DeleteAttemptButton } from "./DeleteAttemptButton";
import { StartExamDialog } from "./StartExamDialog";
import {
  ATTEMPT_STATUS_LABELS,
  formatRemaining,
  traineeExamState,
} from "./examPresentation";

type OwnAttempt = RouterOutputs["exam"]["listOwnAttempts"][number];

function ContinueAttempt({
  projectId,
  attempt,
  title,
  now,
}: {
  projectId: string;
  attempt: Pick<OwnAttempt, "id" | "attemptNumber" | "deadlineAt">;
  title: string;
  now: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="outline">
        <Link href={`/projects/${projectId}/exams/attempts/${attempt.id}`}>
          Continue ·{" "}
          {formatRemaining(new Date(attempt.deadlineAt).getTime() - now)}
        </Link>
      </Button>
      <DeleteAttemptButton
        attemptId={attempt.id}
        examTitle={title}
        attemptNumber={attempt.attemptNumber}
      />
    </div>
  );
}

export function TraineeExamList({ projectId }: { projectId: string }) {
  const [now, setNow] = useState(Date.now);
  const q = api.exam.listAvailable.useQuery({ projectId });
  const own = api.exam.listOwnAttempts.useQuery({ projectId });
  const exams = dataUnlessAccessError(q.data, q.error);
  const openOutsideCatalog = (
    dataUnlessAccessError(own.data, own.error) ?? []
  ).filter(
    (attempt) =>
      attempt.status === "in_progress" &&
      !exams?.some((exam) => exam.openAttemptId === attempt.id),
  );
  const countingDown = Boolean(
    openOutsideCatalog.some(
      (attempt) => new Date(attempt.deadlineAt).getTime() > now,
    ) ||
    exams?.some(
      (exam) =>
        exam.openAttemptId &&
        exam.attempts.some(
          (attempt) =>
            attempt.id === exam.openAttemptId &&
            new Date(attempt.deadlineAt).getTime() > now,
        ),
    ),
  );
  useEffect(() => {
    if (!countingDown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [countingDown]);
  if (!exams && (isQueryAccessError(q.error) || !openOutsideCatalog.length))
    return (
      <ExamQueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.refetch()}
      />
    );
  return (
    <div className="space-y-4">
      {q.error ? (
        <ExamQueryState error={q.error} retry={() => void q.refetch()} />
      ) : null}
      {own.error ? (
        <ExamQueryState error={own.error} retry={() => void own.refetch()} />
      ) : null}
      {!exams?.length && !openOutsideCatalog.length ? (
        <p>No exams available.</p>
      ) : null}
      {openOutsideCatalog.map((attempt) => (
        <article
          key={attempt.id}
          className="bg-surface border-line space-y-3 rounded-lg border p-4"
        >
          <h2 className="font-semibold">{attempt.examTitle}</h2>
          <ContinueAttempt
            projectId={projectId}
            attempt={attempt}
            title={attempt.examTitle}
            now={now}
          />
        </article>
      ))}
      {exams?.map((e) => {
        const openAttempt = e.attempts.find((a) => a.id === e.openAttemptId);
        return (
          <article
            key={e.id}
            className="bg-surface border-line space-y-3 rounded-lg border p-4"
          >
            <h2 className="font-semibold">{e.title}</h2>
            <p>
              {e.timeLimitMinutes} minutes · {e.questionCount} questions ·{" "}
              {e.maxScore} points
              {e.passingPercent !== null
                ? ` · Pass: ${e.passingPercent} %`
                : ""}
            </p>
            <p>
              {traineeExamState(e) === "closed"
                ? "Closed"
                : e.attempts[0]
                  ? ATTEMPT_STATUS_LABELS[e.attempts[0].status]
                  : "Not started"}
            </p>
            {openAttempt ? (
              <ContinueAttempt
                projectId={projectId}
                attempt={openAttempt}
                title={e.title}
                now={now}
              />
            ) : null}
            {e.canStart ? (
              <StartExamDialog
                projectId={projectId}
                exam={e}
                label={e.attempts.length ? "Start new attempt" : "Start"}
              />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

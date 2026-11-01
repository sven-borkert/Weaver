"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { ExamQueryState } from "./ExamQueryState";
import { Button } from "~/components/ui/button";
import { DeleteAttemptButton } from "./DeleteAttemptButton";
import { StartExamDialog } from "./StartExamDialog";
import {
  ATTEMPT_STATUS_LABELS,
  formatRemaining,
  traineeExamState,
} from "./examPresentation";
export function TraineeExamList({ projectId }: { projectId: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const q = api.exam.listAvailable.useQuery({ projectId });
  const exams = dataUnlessAccessError(q.data, q.error);
  if (!exams)
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
      {!exams.length ? <p>No exams available.</p> : null}
      {exams.map((e) => (
        <article
          key={e.id}
          className="bg-surface border-line space-y-3 rounded-lg border p-4"
        >
          <h2 className="font-semibold">{e.title}</h2>
          <p>
            {e.timeLimitMinutes} minutes · {e.questionCount} questions ·{" "}
            {e.maxScore} points
            {e.passingPercent !== null ? ` · Pass: ${e.passingPercent} %` : ""}
          </p>
          <p>
            {traineeExamState(e) === "closed"
              ? "Closed"
              : e.attempts[0]
                ? ATTEMPT_STATUS_LABELS[e.attempts[0].status]
                : "Not started"}
          </p>
          {e.openAttemptId ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline">
                <Link
                  href={`/projects/${projectId}/exams/attempts/${e.openAttemptId}`}
                >
                  Continue ·{" "}
                  {formatRemaining(
                    new Date(
                      e.attempts.find((a) => a.id === e.openAttemptId)
                        ?.deadlineAt ?? 0,
                    ).getTime() - now,
                  )}
                </Link>
              </Button>
              <DeleteAttemptButton
                attemptId={e.openAttemptId}
                examTitle={e.title}
                attemptNumber={
                  e.attempts.find((a) => a.id === e.openAttemptId)!
                    .attemptNumber
                }
              />
            </div>
          ) : null}
          {e.canStart ? (
            <StartExamDialog
              projectId={projectId}
              exam={e}
              label={e.attempts.length ? "Start new attempt" : "Start"}
            />
          ) : null}
        </article>
      ))}
    </div>
  );
}

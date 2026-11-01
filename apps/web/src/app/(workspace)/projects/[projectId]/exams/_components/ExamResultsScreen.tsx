"use client";
import { useState } from "react";
import NotFound from "~/app/not-found";
import { api } from "~/trpc/react";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { Button } from "~/components/ui/button";
import { ExamQueryState } from "./ExamQueryState";
import { ExamNavigation } from "./ExamNavigation";
import { AttemptResultsTable } from "./AttemptResultsTable";

function TraineeResults({ projectId }: { projectId: string }) {
  const q = api.exam.listAvailable.useQuery(
    { projectId },
    { refetchOnMount: "always" },
  );
  const exams = dataUnlessAccessError(q.data, q.error);
  if (!exams)
    return (
      <ExamQueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.refetch()}
      />
    );
  const attempts = exams
    .flatMap((e) =>
      e.attempts
        .filter((a) => a.status !== "in_progress")
        .map((a) => ({ ...a, examTitle: e.title })),
    )
    .sort(
      (a, b) =>
        new Date(b.submittedAt ?? b.startedAt).getTime() -
          new Date(a.submittedAt ?? a.startedAt).getTime() ||
        a.id.localeCompare(b.id),
    );
  return (
    <>
      {q.error ? (
        <ExamQueryState error={q.error} retry={() => void q.refetch()} />
      ) : null}
      <AttemptResultsTable
        projectId={projectId}
        attempts={attempts}
        trainer={false}
      />
    </>
  );
}
type ResultStatus = "in_progress" | "waiting" | "in_review" | "released";
function TrainerResultsPage({
  projectId,
  status,
}: {
  projectId: string;
  status: ResultStatus;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const q = api.exam.listAttempts.useQuery(
    { projectId, status, limit: 25, cursor: cursors.at(-1) },
    {
      refetchOnMount: "always",
      refetchInterval: 30000,
      refetchIntervalInBackground: false,
    },
  );
  const data = dataUnlessAccessError(q.data, q.error);
  if (!data)
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
      <AttemptResultsTable
        projectId={projectId}
        attempts={data.items.map((a) => ({
          ...a,
          traineeName: a.trainee.name ?? a.trainee.email,
        }))}
        trainer
      />
      <div className="flex items-center justify-end gap-3">
        <Button
          variant="outline"
          disabled={!cursors.length || q.isFetching}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          Previous
        </Button>
        <span className="text-text-3 text-sm">Page {cursors.length + 1}</span>
        <Button
          variant="outline"
          disabled={!data.nextCursor || q.isFetching}
          onClick={() => {
            if (data.nextCursor) setCursors((c) => [...c, data.nextCursor!]);
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
function TrainerResults({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<ResultStatus>("waiting");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="result-status">Show</label>
        <select
          id="result-status"
          className="border-line bg-surface rounded-lg border px-3 py-2 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as ResultStatus)}
        >
          <option value="in_progress">In progress</option>
          <option value="waiting">Submitted · waiting for grading</option>
          <option value="in_review">Graded · awaiting your review</option>
          <option value="released">Released results</option>
        </select>
      </div>
      <TrainerResultsPage key={status} projectId={projectId} status={status} />
    </div>
  );
}
export function ExamResultsScreen({ projectId }: { projectId: string }) {
  const q = api.project.get.useQuery({ projectId });
  const p = dataUnlessAccessError(q.data, q.error);
  if (!p)
    return (
      <ExamQueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.refetch()}
      />
    );
  if (!p.myTrainingRole) return <NotFound />;
  return (
    <section
      aria-label="Exam results"
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Exam results</h1>
        <ExamNavigation projectId={projectId} active="results" />
      </header>
      <p className="text-text-3">
        {p.myTrainingRole === "trainer"
          ? "Manage ongoing attempts, review submissions and proposed grades, and open released results."
          : "Your submitted attempts and released grades. Open an attempt to see its answers and feedback."}
      </p>
      {q.error ? (
        <ExamQueryState error={q.error} retry={() => void q.refetch()} />
      ) : null}
      {p.myTrainingRole === "trainer" ? (
        <TrainerResults projectId={projectId} />
      ) : (
        <TraineeResults projectId={projectId} />
      )}
    </section>
  );
}

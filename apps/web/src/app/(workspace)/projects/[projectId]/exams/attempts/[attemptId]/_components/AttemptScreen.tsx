"use client";
import { useState } from "react";
import NotFound from "~/app/not-found";
import { api } from "~/trpc/react";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { ExamQueryState } from "../../../_components/ExamQueryState";
import { TakeExam } from "./TakeExam";
import { AttemptResult } from "./AttemptResult";
import { ReviewAttempt } from "./ReviewAttempt";
function OwnAttempt({
  projectId,
  attemptId,
}: {
  projectId: string;
  attemptId: string;
}) {
  const q = api.exam.getAttempt.useQuery(
    { attemptId },
    { refetchOnMount: "always" },
  );
  const [initialized, setInitialized] = useState(false);
  if (!initialized && q.isFetchedAfterMount && q.isSuccess)
    setInitialized(true);
  const a = dataUnlessAccessError(q.data, q.error);
  if (!initialized || !a)
    return (
      <ExamQueryState
        loading={!q.isFetchedAfterMount || q.isFetching}
        error={q.error}
        retry={() => void q.refetch()}
      />
    );
  return (
    <>
      {q.error ? (
        <ExamQueryState error={q.error} retry={() => void q.refetch()} />
      ) : null}
      {a.status === "in_progress" ? (
        <TakeExam
          key={a.id}
          attempt={a}
          receivedAt={q.dataUpdatedAt}
          onSubmitted={() => void q.refetch()}
        />
      ) : (
        <AttemptResult projectId={projectId} attempt={a} />
      )}
    </>
  );
}
export function AttemptScreen({
  projectId,
  attemptId,
}: {
  projectId: string;
  attemptId: string;
}) {
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
  return p.myTrainingRole === "trainer" ? (
    <ReviewAttempt projectId={projectId} attemptId={attemptId} />
  ) : p.myTrainingRole === "trainee" ? (
    <OwnAttempt key={attemptId} projectId={projectId} attemptId={attemptId} />
  ) : (
    <NotFound />
  );
}

"use client";
import NotFound from "~/app/not-found";
import { api } from "~/trpc/react";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { ExamQueryState } from "./ExamQueryState";
import { TrainerExamList } from "./TrainerExamList";
import { TraineeExamList } from "./TraineeExamList";
import { ExamNavigation } from "./ExamNavigation";
export function ExamsScreen({ projectId }: { projectId: string }) {
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
    <section aria-label="Exams" tabIndex={-1} className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Exams</h1>
        <ExamNavigation projectId={projectId} active="exams" />
      </header>
      {p.myTrainingRole === "trainer" ? (
        <TrainerExamList projectId={projectId} />
      ) : (
        <TraineeExamList projectId={projectId} />
      )}
    </section>
  );
}

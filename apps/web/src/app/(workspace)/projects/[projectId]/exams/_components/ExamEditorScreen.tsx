"use client";
import NotFound from "~/app/not-found";
import { api } from "~/trpc/react";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { ExamQueryState } from "./ExamQueryState";
import { ExamDefinitionForm } from "./ExamDefinitionForm";
export function ExamEditorScreen({
  projectId,
  examId,
}: {
  projectId: string;
  examId: string;
}) {
  const q = api.exam.get.useQuery({ examId });
  const exam = dataUnlessAccessError(q.data, q.error);
  if (!exam)
    return (
      <ExamQueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.refetch()}
      />
    );
  if (exam.projectId !== projectId) return <NotFound />;
  return (
    <>
      {q.error ? (
        <ExamQueryState error={q.error} retry={() => void q.refetch()} />
      ) : null}
      <ExamDefinitionForm
        key={examId}
        exam={exam}
        reload={async () => (await q.refetch()).data}
      />
    </>
  );
}

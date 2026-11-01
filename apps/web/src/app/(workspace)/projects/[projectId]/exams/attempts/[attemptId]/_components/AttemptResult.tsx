"use client";
import Link from "next/link";
import type { TraineeAttemptView } from "@weaver/core/services/examAttempts";
import { AssistantMarkdown } from "~/components/assistant/AssistantMarkdown";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { StartExamDialog } from "../../../_components/StartExamDialog";
import { scoreLabel } from "../../../_components/examPresentation";
import { ExamQuestionPrompt } from "../../../_components/ExamQuestionPrompt";
import { Button } from "~/components/ui/button";
export function AttemptResult({
  projectId,
  attempt: a,
}: {
  projectId: string;
  attempt: TraineeAttemptView;
}) {
  const q = api.exam.listAvailable.useQuery({ projectId });
  const exam = dataUnlessAccessError(q.data, q.error)?.find(
    (e) => e.id === a.examId,
  );
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">
        {a.examTitle} · Attempt {a.attemptNumber}
      </h1>
      <h2>{a.status === "released" ? scoreLabel(a) : "Waiting for grading"}</h2>
      {a.overallFeedback ? (
        <AssistantMarkdown text={a.overallFeedback} />
      ) : null}
      {a.questions.map((q, i) => (
        <article
          key={q.id}
          className="border-line space-y-2 rounded-lg border p-4"
        >
          <h3>Question {i + 1}</h3>
          <ExamQuestionPrompt text={q.prompt} />
          {q.choices?.map((c) => (
            <p key={c.id}>
              {q.answer?.selectedChoiceIds.includes(c.id) ? "☑" : "☐"} {c.text}
              {q.correctChoiceIds?.includes(c.id) ? " · Correct" : ""}
            </p>
          ))}
          {q.answer?.text ? (
            <p className="whitespace-pre-wrap">{q.answer.text}</p>
          ) : null}
          {q.expectedAnswer ? (
            <>
              <h4>Expected answer</h4>
              <AssistantMarkdown text={q.expectedAnswer} />
            </>
          ) : null}
          {a.status === "released" ? (
            <>
              <p>
                {q.score ?? 0} / {q.weight}
              </p>
              {q.rationale ? <AssistantMarkdown text={q.rationale} /> : null}
            </>
          ) : null}
        </article>
      ))}
      <Button asChild variant="outline">
        <Link href={`/projects/${projectId}/exams/results`}>
          Back to results
        </Link>
      </Button>
      {exam?.canStart ? (
        <StartExamDialog
          projectId={projectId}
          exam={exam}
          label="Start new attempt"
        />
      ) : null}
    </section>
  );
}

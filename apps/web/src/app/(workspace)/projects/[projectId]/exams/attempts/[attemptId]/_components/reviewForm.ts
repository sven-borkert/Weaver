import { z } from "zod";
import type { ReviewAttemptView } from "@weaver/core/services/examAttempts";
import type { RouterInputs } from "~/trpc/react";
export type ReviewFormValues = {
  grades: Array<{ questionId: string; score: string; rationale: string }>;
  overallFeedback: string;
};
export function reviewFormDefaults(v: ReviewAttemptView): ReviewFormValues {
  return {
    grades: v.snapshot.questions.map((q) => {
      const a = v.answers.find((a) => a.questionId === q.id);
      return {
        questionId: q.id,
        score: String(a?.score ?? a?.autoScore ?? ""),
        rationale: a?.rationale ?? "",
      };
    }),
    overallFeedback: v.overallFeedback ?? "",
  };
}
export function reviewFormSchema(v: ReviewAttemptView) {
  return z
    .object({
      grades: z.array(
        z.object({
          questionId: z.string(),
          score: z.string(),
          rationale: z.string().max(2000),
        }),
      ),
      overallFeedback: z.string().max(10000),
    })
    .superRefine((values, ctx) => {
      values.grades.forEach((g, i) => {
        const q = v.snapshot.questions.find((q) => q.id === g.questionId);
        if (
          g.score !== "" &&
          (!q ||
            !/^\d+(?:\.\d{1,2})?$/.test(g.score) ||
            Number(g.score) > q.weight)
        )
          ctx.addIssue({
            code: "custom",
            path: ["grades", i, "score"],
            message: `Enter a score from 0 to ${q?.weight ?? 0}, with up to two decimals`,
          });
      });
    });
}
export function toGradeInput(
  v: ReviewAttemptView,
  values: ReviewFormValues,
  release: boolean,
): RouterInputs["exam"]["grade"] {
  return {
    attemptId: v.id,
    expectedRevision: v.revision,
    grades: values.grades
      .filter((g) => g.score !== "")
      .map((g) => ({
        questionId: g.questionId,
        score: Number(g.score),
        rationale: g.rationale,
      })),
    overallFeedback: values.overallFeedback,
    release,
  };
}
export function releaseBlockers(
  v: ReviewAttemptView,
  values: ReviewFormValues,
) {
  return v.snapshot.questions
    .filter(
      (q) =>
        q.kind === "free_text" &&
        !values.grades.some(
          (g) => g.questionId === q.id && g.score.trim() && g.rationale.trim(),
        ),
    )
    .map((q) => q.id);
}

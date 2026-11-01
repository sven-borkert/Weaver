import { it, expect } from "vitest";
import {
  reviewFormDefaults,
  reviewFormSchema,
  releaseBlockers,
  toGradeInput,
} from "./reviewForm";
import type { ReviewAttemptView } from "@weaver/core/services/examAttempts";
const view = {
  id: "a",
  revision: 3,
  snapshot: { questions: [{ id: "q", kind: "free_text", weight: 6 }] },
  answers: [{ questionId: "q", score: null, autoScore: 4, rationale: "Good" }],
  overallFeedback: null,
} as unknown as ReviewAttemptView;
it("prefers proposed grades, then automatic scores", () =>
  expect(reviewFormDefaults(view).grades[0]).toEqual({
    questionId: "q",
    score: "4",
    rationale: "Good",
  }));
it("validates bounds and decimal precision", () => {
  const values = reviewFormDefaults(view);
  expect(reviewFormSchema(view).safeParse(values).success).toBe(true);
  for (const score of ["7", "2.345"]) {
    expect(
      reviewFormSchema(view).safeParse({
        ...values,
        grades: [{ ...values.grades[0], score }],
      }).success,
    ).toBe(false);
  }
});
it("omits blank scores and blocks release without rationales", () => {
  const values = {
    grades: [{ questionId: "q", score: "", rationale: "" }],
    overallFeedback: "",
  };
  expect(releaseBlockers(view, values)).toEqual(["q"]);
  expect(toGradeInput(view, values, false)).toMatchObject({
    attemptId: "a",
    expectedRevision: 3,
    grades: [],
    release: false,
  });
});

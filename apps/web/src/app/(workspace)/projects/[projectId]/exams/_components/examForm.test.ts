import { it, expect } from "vitest";
import { moveQuestion, newQuestion, toUpdateInput } from "./examForm";
it("starts multiple choice with one correct option", () => {
  const q = newQuestion("multiple_choice");
  expect(q.choices).toHaveLength(2);
  expect(q.choices?.map((c) => c.correct)).toEqual([true, false]);
});
it("moves questions without mutating the original", () => {
  const a = [1, 2, 3];
  expect(moveQuestion(a, 2, 0)).toEqual([3, 1, 2]);
  expect(a).toEqual([1, 2, 3]);
  expect(moveQuestion(a, 9, 0)).toBe(a);
});
it("preserves the revision used to build the form", () => {
  expect(
    toUpdateInput("id", 3, {
      title: "Exam",
      questions: [],
      timeLimitMinutes: 5,
    }),
  ).toMatchObject({ examId: "id", expectedRevision: 3, title: "Exam" });
});

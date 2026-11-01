import type { z } from "zod";
import type { examDefinitionInputSchema } from "@weaver/core/exams/schema";
import type { ExamDetail } from "@weaver/core/services/exams";
import type { RouterInputs } from "~/trpc/react";
export type ExamFormValues = z.input<typeof examDefinitionInputSchema>;
export function definitionFormDefaults(e: ExamDetail): ExamFormValues {
  return {
    title: e.title,
    instructions: e.instructions,
    timeLimitMinutes: e.timeLimitMinutes,
    passingPercent: e.passingPercent,
    questions: e.questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      weight: q.weight,
      allowMultiple: q.allowMultiple,
      expectedAnswer: q.expectedAnswer,
      ...(q.kind === "multiple_choice" ? { choices: q.choices ?? [] } : {}),
    })),
  };
}
export function newChoice() {
  return { text: "", correct: false };
}
export function newQuestion(
  kind: "multiple_choice" | "free_text",
): ExamFormValues["questions"][number] {
  return {
    kind,
    prompt: "",
    weight: 1,
    expectedAnswer: "",
    ...(kind === "multiple_choice"
      ? {
          allowMultiple: false,
          choices: [{ text: "", correct: true }, newChoice()],
        }
      : {}),
  };
}
export function moveQuestion<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length)
    return list;
  const next = [...list];
  const removed = next.splice(from, 1);
  next.splice(to, 0, ...removed);
  return next;
}
export function toUpdateInput(
  examId: string,
  expectedRevision: number,
  values: ExamFormValues,
): RouterInputs["exam"]["update"] {
  return { examId, expectedRevision, ...values };
}

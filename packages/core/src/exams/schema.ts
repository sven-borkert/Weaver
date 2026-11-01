import { z } from "zod";

export const EXAM_LIMITS = {
  title: 200,
  instructions: 20_000,
  prompt: 10_000,
  expectedAnswer: 10_000,
  choiceText: 2_000,
  choicesMin: 2,
  choicesMax: 10,
  questionsMax: 100,
  weightMin: 1,
  weightMax: 1_000,
  timeLimitMin: 1,
  timeLimitMax: 1_440,
  answerText: 20_000,
  rationale: 2_000,
  overallFeedback: 10_000,
  examsPerProject: 500,
  graceMs: 10_000,
  autosaveDebounceMs: 750,
} as const;
export const trainingRoleSchema = z.enum(["trainer", "trainee"]);
export type TrainingRoleName = z.infer<typeof trainingRoleSchema>;
export const examStatusSchema = z.enum(["draft", "published", "archived"]);
export const examQuestionKindSchema = z.enum(["multiple_choice", "free_text"]);
export type ExamQuestionKind = z.infer<typeof examQuestionKindSchema>;
export const examAttemptStatusSchema = z.enum([
  "in_progress",
  "submitted",
  "in_review",
  "released",
]);
export const attemptListStatusSchema = z.enum([
  "waiting",
  "in_review",
  "released",
  "in_progress",
]);
const uuid = z.uuid();
const weight = z.number().int().min(1).max(1000);
const timeLimit = z.number().int().min(1).max(1440);
const passingPercent = z.number().int().min(0).max(100).nullable();
export const examChoiceInputSchema = z.object({
  id: uuid.optional(),
  text: z.string().trim().min(1).max(2000),
  correct: z.boolean(),
});
export const examQuestionInputSchema = z
  .object({
    id: uuid.optional(),
    kind: examQuestionKindSchema,
    prompt: z.string().trim().min(1).max(10000),
    weight,
    choices: z.array(examChoiceInputSchema).min(2).max(10).optional(),
    allowMultiple: z.boolean().optional(),
    expectedAnswer: z.string().max(10000).nullable().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.kind === "free_text" && q.choices !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Free-text questions must omit choices",
      });
    if (q.kind === "multiple_choice") {
      const count = q.choices?.filter((c) => c.correct).length ?? 0;
      if (!q.choices || count === 0 || (!q.allowMultiple && count !== 1))
        ctx.addIssue({
          code: "custom",
          path: ["choices"],
          message: "Choose the correct answer(s)",
        });
    }
    const ids = q.choices?.flatMap((c) => (c.id ? [c.id] : [])) ?? [];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Choice IDs must be unique",
      });
  });
export const examDefinitionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    instructions: z.string().max(20000).default(""),
    timeLimitMinutes: timeLimit,
    passingPercent: passingPercent.optional(),
    questions: z.array(examQuestionInputSchema).max(100),
  })
  .superRefine((value, ctx) => {
    const ids = value.questions.flatMap((q) => (q.id ? [q.id] : []));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Question IDs must be unique",
      });
  });
export type ExamDefinitionInput = z.input<typeof examDefinitionInputSchema>;
export const examAnswerInputSchema = z.object({
  questionId: uuid,
  sequence: z.number().int().min(1).max(2147483647),
  selectedChoiceIds: z.array(uuid).max(10).optional(),
  text: z.string().max(20000).nullable().optional(),
});
export type ExamAnswerInput = z.infer<typeof examAnswerInputSchema>;
export function hasTwoDecimals(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(value * 100 - Math.round(value * 100)) <=
      Number.EPSILON * Math.max(1, Math.abs(value * 100)) * 4
  );
}
export const examGradeEntrySchema = z.object({
  questionId: uuid,
  score: z
    .number()
    .min(0)
    .max(1000)
    .refine(hasTwoDecimals, "Use at most two decimal places"),
  rationale: z.string().trim().max(2000).nullable().optional(),
});
export type ExamGradeEntry = z.infer<typeof examGradeEntrySchema>;
export const gradeAttemptInputSchema = z.object({
  grades: z.array(examGradeEntrySchema).max(100),
  overallFeedback: z.string().max(10000).nullable().optional(),
  release: z.boolean().default(false),
});
export type GradeAttemptInput = z.infer<typeof gradeAttemptInputSchema>;
export const examSnapshotSchema = z.object({
  examId: uuid,
  revision: z.number().int().positive(),
  title: z.string().max(200),
  instructions: z.string().max(20000),
  timeLimitMinutes: timeLimit,
  passingPercent,
  questions: z
    .array(
      z.object({
        id: uuid,
        position: z.number().int().nonnegative(),
        kind: examQuestionKindSchema,
        prompt: z.string().max(10000),
        weight,
        choices: z.array(examChoiceInputSchema.required()).max(10).nullable(),
        allowMultiple: z.boolean(),
        expectedAnswer: z.string().max(10000).nullable(),
      }),
    )
    .max(100),
});
export type ExamSnapshot = z.infer<typeof examSnapshotSchema>;
export type ExamSnapshotQuestion = ExamSnapshot["questions"][number];
type SavedAnswer = {
  selectedChoiceIds: string[];
  text: string | null;
  sequence: number;
  savedAt: Date;
  score: number | null;
  rationale: string | null;
};
export type TraineeQuestionView = {
  id: string;
  position: number;
  kind: ExamQuestionKind;
  prompt: string;
  weight: number;
  choices: Array<{ id: string; text: string }> | null;
  allowMultiple: boolean;
  correctChoiceIds: string[] | null;
  expectedAnswer: string | null;
  answer: {
    selectedChoiceIds: string[];
    text: string | null;
    sequence: number;
    savedAt: Date;
  } | null;
  score: number | null;
  rationale: string | null;
};
export function traineeQuestionViews(input: {
  snapshot: ExamSnapshot;
  answers: ReadonlyMap<string, SavedAnswer>;
  released: boolean;
}): TraineeQuestionView[] {
  return input.snapshot.questions.map((q) => {
    const a = input.answers.get(q.id);
    return {
      id: q.id,
      position: q.position,
      kind: q.kind,
      prompt: q.prompt,
      weight: q.weight,
      choices: q.choices?.map(({ id, text }) => ({ id, text })) ?? null,
      allowMultiple: q.allowMultiple,
      correctChoiceIds:
        input.released && q.choices
          ? q.choices.filter((c) => c.correct).map((c) => c.id)
          : null,
      expectedAnswer: input.released ? q.expectedAnswer : null,
      answer: a
        ? {
            selectedChoiceIds: [...a.selectedChoiceIds],
            text: a.text,
            sequence: a.sequence,
            savedAt: a.savedAt,
          }
        : null,
      score: input.released ? (a?.score ?? null) : null,
      rationale: input.released ? (a?.rationale ?? null) : null,
    };
  });
}
export function autoScoreFor(
  question: ExamSnapshotQuestion,
  selectedChoiceIds: readonly string[],
): number | null {
  if (question.kind === "free_text") return null;
  const correct = new Set(
    question.choices?.filter((c) => c.correct).map((c) => c.id) ?? [],
  );
  if (correct.size === 0) return 0;
  const selected = new Set(selectedChoiceIds);
  let net = 0;
  for (const id of selected) net += correct.has(id) ? 1 : -1;
  if (net <= 0) return 0;
  return Math.round((question.weight * 100 * net) / correct.size) / 100;
}
export function shuffleChoices(
  snapshot: ExamSnapshot,
  random: () => number = Math.random,
): ExamSnapshot {
  return {
    ...snapshot,
    questions: snapshot.questions.map((q) => {
      if (!q.choices) return q;
      const choices = [...q.choices];
      for (let i = choices.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [choices[i], choices[j]] = [choices[j]!, choices[i]!];
      }
      return { ...q, choices };
    }),
  };
}
export function autoRationaleFor(
  question: ExamSnapshotQuestion,
  selectedChoiceIds: readonly string[],
): string | null {
  if (question.kind === "free_text") return null;
  if (autoScoreFor(question, selectedChoiceIds) === question.weight)
    return "Selected the correct choices.";
  const labels = (correct: boolean) =>
    question.choices
      ?.filter((c) => (correct ? c.correct : selectedChoiceIds.includes(c.id)))
      .map((c) => Array.from(c.text).slice(0, 100).join(""))
      .join(", ") ?? "";
  const prefix = selectedChoiceIds.length ? "Selected " : "No choice selected";
  const selected = selectedChoiceIds.length ? labels(false) : "";
  const correct = labels(true);
  const available =
    EXAM_LIMITS.rationale - prefix.length - "; correct: ".length - 1;
  const selectedBudget = Math.min(
    selected.length,
    Math.max(Math.floor(available / 2), available - correct.length),
  );
  const clip = (text: string, budget: number) =>
    text.length <= budget
      ? text
      : `${text.slice(0, budget - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
  return `${prefix}${clip(selected, selectedBudget)}; correct: ${clip(correct, available - selectedBudget)}.`;
}
export function summarizeScores(input: {
  questions: readonly ExamSnapshotQuestion[];
  scores: ReadonlyMap<string, number>;
  passingPercent: number | null;
}): {
  totalScore: number;
  maxScore: number;
  percent: number;
  passed: boolean | null;
} | null {
  let cents = 0;
  let maxScore = 0;
  for (const q of input.questions) {
    const score = input.scores.get(q.id);
    if (score === undefined) return null;
    cents += Math.round(score * 100);
    maxScore += q.weight;
  }
  const totalScore = cents / 100;
  const percent = maxScore === 0 ? 0 : Math.round((cents * 10) / maxScore) / 10;
  return {
    totalScore,
    maxScore,
    percent,
    passed:
      input.passingPercent === null ? null : percent >= input.passingPercent,
  };
}
export function remainingMs(deadlineAt: Date, now: Date): number {
  return Math.max(0, deadlineAt.getTime() - now.getTime());
}

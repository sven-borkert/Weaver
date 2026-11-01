import { describe, expect, it } from "vitest";
import {
  autoRationaleFor,
  autoScoreFor,
  examDefinitionInputSchema,
  examGradeEntrySchema,
  examQuestionInputSchema,
  hasTwoDecimals,
  remainingMs,
  shuffleChoices,
  summarizeScores,
  traineeQuestionViews,
  type ExamSnapshot,
  type ExamSnapshotQuestion,
} from "./schema";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q: ExamSnapshotQuestion = {
  id: id(1),
  position: 0,
  kind: "multiple_choice",
  prompt: "Pick",
  weight: 3,
  allowMultiple: false,
  expectedAnswer: "Answer",
  choices: [
    { id: id(2), text: "Right", correct: true },
    { id: id(3), text: "Wrong", correct: false },
  ],
};
const free: ExamSnapshotQuestion = {
  ...q,
  id: id(4),
  kind: "free_text",
  weight: 7,
  choices: null,
};
const snapshot: ExamSnapshot = {
  examId: id(5),
  revision: 1,
  title: "Exam",
  instructions: "",
  timeLimitMinutes: 5,
  passingPercent: 65,
  questions: [q, free],
};
describe("exam validation", () => {
  it("enforces choice correctness, kinds and weights", () => {
    expect(
      examQuestionInputSchema.safeParse({
        ...q,
        choices: q.choices!.map((c) => ({ ...c, correct: false })),
      }).error?.issues[0]?.path,
    ).toEqual(["choices"]);
    const both = q.choices!.map((c) => ({ ...c, correct: true }));
    expect(
      examQuestionInputSchema.safeParse({ ...q, choices: both }).success,
    ).toBe(false);
    expect(
      examQuestionInputSchema.safeParse({
        ...q,
        choices: both,
        allowMultiple: true,
      }).success,
    ).toBe(true);
    expect(
      examQuestionInputSchema.safeParse({ ...free, choices: both }).success,
    ).toBe(false);
    for (const weight of [0, 1001])
      expect(examQuestionInputSchema.safeParse({ ...q, weight }).success).toBe(
        false,
      );
  });
  it("rejects duplicate identifiers", () => {
    expect(
      examQuestionInputSchema.safeParse({
        ...q,
        choices: [q.choices![0], q.choices![0]],
      }).success,
    ).toBe(false);
    expect(
      examDefinitionInputSchema.safeParse({ ...snapshot, questions: [q, q] })
        .success,
    ).toBe(false);
  });
  it("validates decimal grades without floating point artifacts", () => {
    for (const score of [2.345, NaN, Infinity])
      expect(
        examGradeEntrySchema.safeParse({ questionId: q.id, score }).success,
      ).toBe(false);
    expect(
      examGradeEntrySchema.safeParse({ questionId: q.id, score: 2.5 }).success,
    ).toBe(true);
    expect(
      examGradeEntrySchema.safeParse({
        questionId: q.id,
        score: 2,
        rationale: "x".repeat(2001),
      }).success,
    ).toBe(false);
    expect(hasTwoDecimals(0.29)).toBe(true);
  });
});
describe("exam helpers", () => {
  it("reveals answer keys and grades only after release", () => {
    const answers = new Map([
      [
        q.id,
        {
          selectedChoiceIds: [id(2)],
          text: null,
          sequence: 1,
          savedAt: new Date(),
          score: 3,
          rationale: "Good",
        },
      ],
    ]);
    const hidden = traineeQuestionViews({ snapshot, answers, released: false });
    expect(hidden[0]).toMatchObject({
      correctChoiceIds: null,
      expectedAnswer: null,
      score: null,
      rationale: null,
    });
    expect(JSON.stringify(hidden)).not.toContain('"correct":');
    expect(
      traineeQuestionViews({ snapshot, answers, released: true })[0],
    ).toMatchObject({
      correctChoiceIds: [id(2)],
      expectedAnswer: "Answer",
      score: 3,
      rationale: "Good",
    });
  });
  it("scores exact sets and explains mistakes", () => {
    expect(autoScoreFor(q, [id(2)])).toBe(3);
    expect(autoScoreFor(q, [id(2), id(3)])).toBe(0);
    expect(autoScoreFor(q, [])).toBe(0);
    expect(autoScoreFor(free, [])).toBeNull();
    expect(autoRationaleFor(q, [id(3)])).toBe(
      "Selected Wrong; correct: Right.",
    );
  });
  it("gives partial credit with each wrong choice cancelling a right one", () => {
    const multi: ExamSnapshotQuestion = {
      ...q,
      weight: 2,
      allowMultiple: true,
      choices: Array.from({ length: 6 }, (_, index) => ({
        id: id(index + 10),
        text: `C${index}`,
        correct: index < 4,
      })),
    };
    expect(autoScoreFor(multi, [id(10)])).toBe(0.5);
    expect(autoScoreFor(multi, [id(10), id(11), id(12)])).toBe(1.5);
    expect(autoScoreFor(multi, [id(10), id(11), id(12), id(14)])).toBe(1);
    expect(autoScoreFor(multi, [id(10), id(14)])).toBe(0);
    expect(autoScoreFor(multi, [id(14), id(15)])).toBe(0);
    expect(
      autoScoreFor(
        multi,
        multi.choices!.map((c) => c.id),
      ),
    ).toBe(1);
    expect(autoScoreFor(multi, [id(10), id(11), id(12), id(13)])).toBe(2);
    const thirds = { ...multi, weight: 1, choices: multi.choices!.slice(1) };
    expect(autoScoreFor(thirds, [id(11), id(12)])).toBe(0.67);
  });
  it("shuffles choices without changing questions or choice identity", () => {
    const multi: ExamSnapshotQuestion = {
      ...q,
      allowMultiple: true,
      choices: Array.from({ length: 4 }, (_, index) => ({
        id: id(index + 10),
        text: `C${index}`,
        correct: index < 2,
      })),
    };
    const input = { ...snapshot, questions: [multi, free] };
    const shuffled = shuffleChoices(input, () => 0);
    expect(
      shuffled.questions.map((x) => x.choices?.map((c) => c.text) ?? null),
    ).toEqual([["C1", "C2", "C3", "C0"], null]);
    expect(shuffled.questions[0]!.choices).toEqual(
      expect.arrayContaining(multi.choices!),
    );
    expect(input.questions[0]!.choices!.map((c) => c.text)).toEqual([
      "C0",
      "C1",
      "C2",
      "C3",
    ]);
  });
  it("includes up to 100 Unicode characters per choice in mistake explanations", () => {
    const question = {
      ...q,
      choices: [
        { id: id(2), text: "C".repeat(101), correct: true },
        { id: id(3), text: "😀".repeat(101), correct: false },
      ],
    };
    expect(autoRationaleFor(question, [id(3)])).toBe(
      `Selected ${"😀".repeat(100)}; correct: ${"C".repeat(100)}.`,
    );
  });
  it("keeps explanations with many long choices valid for subsequent grading", () => {
    const question = {
      ...q,
      allowMultiple: true,
      choices: Array.from({ length: 10 }, (_, index) => ({
        id: id(index + 10),
        text: "😀".repeat(100),
        correct: index < 9,
      })),
    };
    const rationale = autoRationaleFor(
      question,
      question.choices.map((c) => c.id),
    );
    expect(
      examGradeEntrySchema.safeParse({ questionId: q.id, score: 0, rationale })
        .success,
    ).toBe(true);
    expect(rationale).toContain("Selected ");
    expect(rationale).toContain("; correct: ");
    expect(rationale).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
  it("sums in cents, handles missing scores and clamps time", () => {
    expect(
      summarizeScores({
        questions: [q, free],
        scores: new Map([
          [q.id, 3],
          [free.id, 3.5],
        ]),
        passingPercent: 65,
      }),
    ).toEqual({ totalScore: 6.5, maxScore: 10, percent: 65, passed: true });
    expect(
      summarizeScores({
        questions: [q, free],
        scores: new Map([
          [q.id, 0.1],
          [free.id, 0.2],
        ]),
        passingPercent: null,
      })?.totalScore,
    ).toBe(0.3);
    expect(
      summarizeScores({
        questions: [q, free],
        scores: new Map(),
        passingPercent: null,
      }),
    ).toBeNull();
    expect(remainingMs(new Date(0), new Date(1))).toBe(0);
  });
});

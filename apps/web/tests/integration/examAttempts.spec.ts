import { beforeEach, describe, expect, it } from "vitest";
import {
  createExam,
  updateExam,
  deleteExam,
} from "@weaver/core/services/exams";
import {
  deleteAttempt,
  startAttempt,
  saveAnswer,
  submitAttempt,
  getOwnAttempt,
  gradeAttempt,
  getAttemptForReview,
  listAttempts,
  finalizeExpiredAttempts,
} from "@weaver/core/services/examAttempts";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  callerWithSecurity,
} from "./_harness";
const T0 = new Date("2026-10-20T10:00:00Z");
describe("exam attempts service", () => {
  beforeEach(resetDb);
  async function fixture() {
    const db = getPrisma();
    const trainer = await makeUser("User", "trainer");
    const trainee = await makeUser("User", "trainee");
    const project = await makeProject("Exams");
    await addMembership(project.id, trainer.id, "Owner");
    await addMembership(project.id, trainee.id, "Viewer");
    await db.projectTrainingRole.createMany({
      data: [
        { projectId: project.id, userId: trainer.id, role: "trainer" },
        { projectId: project.id, userId: trainee.id, role: "trainee" },
      ],
    });
    const exam = await createExam(db, securityContextFor(trainer), {
      projectId: project.id,
      status: "published",
      definition: {
        title: "Safety",
        timeLimitMinutes: 30,
        passingPercent: 80,
        questions: [
          {
            kind: "multiple_choice",
            prompt: "Pick",
            weight: 4,
            choices: [
              { text: "Yes", correct: true },
              { text: "No", correct: false },
            ],
          },
          { kind: "free_text", prompt: "Explain", weight: 6 },
        ],
      },
    });
    return {
      db,
      trainer: securityContextFor(trainer),
      trainerUser: trainer,
      traineeUser: trainee,
      trainee: securityContextFor(trainee),
      exam,
    };
  }
  it.each(["in_progress", "submitted", "in_review", "released"] as const)(
    "allows trainees to delete their own %s attempt and its answers",
    async (status) => {
      const { db, trainee, traineeUser, exam } = await fixture();
      const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
      await saveAnswer(
        db,
        trainee,
        {
          attemptId: a.id,
          answer: {
            questionId: exam.questions[1]!.id,
            sequence: 1,
            text: "Answer",
          },
        },
        T0,
      );
      await db.examAttempt.update({ where: { id: a.id }, data: { status } });
      await callerWithSecurity(traineeUser, trainee).exam.deleteAttempt({
        attemptId: a.id,
      });
      expect(
        await db.examAttempt.findUnique({ where: { id: a.id } }),
      ).toBeNull();
      expect(await db.examAnswer.count({ where: { attemptId: a.id } })).toBe(0);
    },
  );
  it("allows a trainer to delete an attempt and keeps later attempt numbers valid", async () => {
    const { db, trainer, trainerUser, trainee, exam } = await fixture();
    const first = await startAttempt(db, trainee, { examId: exam.id }, T0);
    await submitAttempt(db, trainee, { attemptId: first.id }, T0);
    const second = await startAttempt(db, trainee, { examId: exam.id }, T0);
    await submitAttempt(db, trainee, { attemptId: second.id }, T0);
    await callerWithSecurity(trainerUser, trainer).exam.deleteAttempt({
      attemptId: first.id,
    });
    const third = await startAttempt(db, trainee, { examId: exam.id }, T0);
    expect(third.attemptNumber).toBe(3);
    await deleteAttempt(db, trainer, third.id);
    expect(await db.examAttempt.count()).toBe(1);
  });
  it("refuses other trainees, nonmembers, training Off, and non-session callers", async () => {
    const { db, trainer, trainee, traineeUser, exam } = await fixture();
    const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
    const stranger = await makeUser("Admin", "stranger");
    await expect(
      deleteAttempt(db, securityContextFor(stranger), a.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await addMembership(exam.projectId, stranger.id, "Owner");
    await db.projectTrainingRole.create({
      data: { projectId: exam.projectId, userId: stranger.id, role: "trainee" },
    });
    await expect(
      deleteAttempt(db, securityContextFor(stranger), a.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const authenticationMethod of ["apiKey", "oauth", "task"] as const)
      await expect(
        deleteAttempt(db, { ...trainer, authenticationMethod }, a.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      deleteAttempt(
        db,
        { ...trainer, capabilities: new Set(["content:read"]) },
        a.id,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.projectTrainingRole.delete({
      where: {
        projectId_userId: { projectId: exam.projectId, userId: traineeUser.id },
      },
    });
    await expect(deleteAttempt(db, trainee, a.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await db.examAttempt.count()).toBe(1);
    await db.project.update({
      where: { id: exam.projectId },
      data: { deletedAt: T0 },
    });
    await expect(deleteAttempt(db, trainer, a.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("serializes concurrent starts, orders saves and keeps proposed grades private", async () => {
    const { db, trainer, trainee, exam } = await fixture();
    const [a, b] = await Promise.all([
      startAttempt(db, trainee, { examId: exam.id }, T0),
      startAttempt(db, trainee, { examId: exam.id }, T0),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.timing.remainingMs).toBe(1_800_000);
    const questionId = exam.questions[1]!.id;
    expect(
      (
        await saveAnswer(
          db,
          trainee,
          { attemptId: a.id, answer: { questionId, sequence: 2, text: "New" } },
          T0,
        )
      ).outcome,
    ).toBe("saved");
    expect(
      (
        await saveAnswer(
          db,
          trainee,
          { attemptId: a.id, answer: { questionId, sequence: 1, text: "Old" } },
          T0,
        )
      ).outcome,
    ).toBe("stale");
    await saveAnswer(
      db,
      trainee,
      {
        attemptId: a.id,
        answer: {
          questionId: exam.questions[0]!.id,
          sequence: 1,
          selectedChoiceIds: [exam.questions[0]!.choices![0]!.id],
        },
      },
      T0,
    );
    await submitAttempt(db, trainee, { attemptId: a.id }, T0);
    const review = await getAttemptForReview(db, trainer, a.id, T0);
    expect(
      review.snapshot.questions[0]!.choices!.find(
        (c) => c.id === exam.questions[0]!.choices![0]!.id,
      )!.correct,
    ).toBe(true);
    expect(review.answers[0]!.autoScore).toBe(4);
    const proposal = await gradeAttempt(
      db,
      trainer,
      {
        attemptId: a.id,
        expectedRevision: review.revision,
        release: false,
        grades: [
          { questionId, score: 4.5, rationale: "Covers the main points" },
        ],
      },
      T0,
    );
    expect(proposal).toMatchObject({
      status: "in_review",
      totalScore: 8.5,
      percent: 85,
      passed: true,
    });
    const privateView = await getOwnAttempt(db, trainee, a.id, T0);
    expect(privateView.totalScore).toBeNull();
    expect(
      privateView.questions.every(
        (q) =>
          q.score === null &&
          q.rationale === null &&
          q.expectedAnswer === null &&
          q.correctChoiceIds === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(privateView)).not.toContain('"correct":');
    expect(JSON.stringify(privateView)).not.toContain('"autoScore":');
    const released = await gradeAttempt(
      db,
      trainer,
      {
        attemptId: a.id,
        expectedRevision: proposal.revision,
        release: true,
        grades: [],
      },
      T0,
    );
    expect(released.status).toBe("released");
    expect((await getOwnAttempt(db, trainee, a.id, T0)).totalScore).toBe(8.5);
  });
  it("keeps one shuffled choice order per attempt and stores partial credit", async () => {
    const { db, trainer, trainee, exam } = await fixture();
    const multi = await updateExam(db, trainer, {
      examId: exam.id,
      expectedRevision: exam.revision,
      definition: {
        title: "Safety",
        timeLimitMinutes: 30,
        passingPercent: 80,
        questions: [
          {
            kind: "multiple_choice",
            prompt: "Pick all",
            weight: 2,
            allowMultiple: true,
            choices: ["A", "B", "C", "D", "E", "F"].map((text, i) => ({
              text,
              correct: i < 4,
            })),
          },
        ],
      },
    });
    const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
    const order = a.questions[0]!.choices!.map((c) => c.id);
    const authored = multi.questions[0]!.choices!;
    expect([...order].sort()).toEqual(authored.map((c) => c.id).sort());
    expect(
      (await getOwnAttempt(db, trainee, a.id, T0)).questions[0]!.choices!.map(
        (c) => c.id,
      ),
    ).toEqual(order);
    await saveAnswer(
      db,
      trainee,
      {
        attemptId: a.id,
        answer: {
          questionId: multi.questions[0]!.id,
          sequence: 1,
          selectedChoiceIds: [
            authored[0]!.id,
            authored[1]!.id,
            authored[4]!.id,
          ],
        },
      },
      T0,
    );
    await submitAttempt(db, trainee, { attemptId: a.id }, T0);
    const review = await getAttemptForReview(db, trainer, a.id, T0);
    expect(review.snapshot.questions[0]!.choices!.map((c) => c.id)).toEqual(
      order,
    );
    expect(review.answers[0]!.autoScore).toBe(0.5);
  });
  it("serializes save with submission so scoring always matches the final stored selection", async () => {
    const { db, trainer, trainee, exam } = await fixture();
    const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
    const q = exam.questions[0]!;
    const [saved] = await Promise.all([
      saveAnswer(
        db,
        trainee,
        {
          attemptId: a.id,
          answer: {
            questionId: q.id,
            sequence: 1,
            selectedChoiceIds: [q.choices![0]!.id],
          },
        },
        T0,
      ),
      submitAttempt(db, trainee, { attemptId: a.id }, T0),
    ]);
    const review = await getAttemptForReview(db, trainer, a.id, T0);
    const answer = review.answers.find((x) => x.questionId === q.id)!;
    expect(answer.autoScore).toBe(saved.outcome === "saved" ? 4 : 0);
    expect(
      (
        await saveAnswer(
          db,
          trainee,
          {
            attemptId: a.id,
            answer: { questionId: q.id, sequence: 2, selectedChoiceIds: [] },
          },
          T0,
        )
      ).outcome,
    ).toBe("closed");
  });
  it("exposes effective expiry before the sweeper and grades without a self-conflict", async () => {
    const { db, trainer, trainee, exam } = await fixture();
    const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
    const later = new Date(T0.getTime() + 31 * 60_000);
    const listed = await listAttempts(
      db,
      trainer,
      { projectIds: [exam.projectId], status: "waiting" },
      later,
    );
    expect(listed.items[0]).toMatchObject({
      id: a.id,
      status: "submitted",
      submissionKind: "timeout",
    });
    const review = await gradeAttempt(
      db,
      trainer,
      {
        attemptId: a.id,
        expectedRevision: listed.items[0]!.revision,
        release: false,
        grades: [],
      },
      later,
    );
    expect(review.status).toBe("in_review");
    expect(await finalizeExpiredAttempts(db, later)).toEqual({ expired: 0 });
  });
  it("keeps manually overridden choice scores when releasing and gates rationales", async () => {
    const { db, trainer, trainee, exam } = await fixture();
    const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
    await submitAttempt(db, trainee, { attemptId: a.id }, T0);
    let review = await getAttemptForReview(db, trainer, a.id, T0);
    await expect(
      gradeAttempt(
        db,
        trainer,
        {
          attemptId: a.id,
          expectedRevision: review.revision,
          release: false,
          grades: [{ questionId: exam.questions[1]!.id, score: 3 }],
        },
        T0,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "grades.0.rationale" },
    });
    review = await gradeAttempt(
      db,
      trainer,
      {
        attemptId: a.id,
        expectedRevision: review.revision,
        release: false,
        grades: [
          {
            questionId: exam.questions[0]!.id,
            score: 2,
            rationale: "Partial credit",
          },
          {
            questionId: exam.questions[1]!.id,
            score: 6,
            rationale: "Complete",
          },
        ],
      },
      T0,
    );
    const released = await gradeAttempt(
      db,
      trainer,
      {
        attemptId: a.id,
        expectedRevision: review.revision,
        release: true,
        grades: [],
      },
      T0,
    );
    expect(released.totalScore).toBe(8);
    expect(released.answers[0]).toMatchObject({
      score: 2,
      rationale: "Partial credit",
    });
  });
  it("enforces session-only trainee calls and release through the router", async () => {
    const { db, trainer, trainee, exam, traineeUser, trainerUser } =
      await fixture();
    const traineeKey = callerWithSecurity(traineeUser, {
      ...trainee,
      authenticationMethod: "apiKey",
    });
    await expect(
      traineeKey.exam.listAvailable({ projectId: exam.projectId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      traineeKey.exam.start({ examId: exam.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
    await expect(
      traineeKey.exam.getAttempt({ attemptId: a.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      traineeKey.exam.saveAnswer({
        attemptId: a.id,
        questionId: exam.questions[1]!.id,
        sequence: 1,
        text: "Answer",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      traineeKey.exam.submit({ attemptId: a.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await submitAttempt(db, trainee, { attemptId: a.id }, T0);
    const trainerKey = callerWithSecurity(trainerUser, {
      ...trainer,
      authenticationMethod: "apiKey",
    });
    const review = await trainerKey.exam.getAttemptForReview({
      attemptId: a.id,
    });
    const proposal = await trainerKey.exam.grade({
      attemptId: a.id,
      expectedRevision: review.revision,
      grades: [
        { questionId: exam.questions[1]!.id, score: 6, rationale: "Complete" },
      ],
    });
    expect(proposal).toMatchObject({
      status: "in_review",
      gradedVia: "apiKey",
    });
    await expect(
      trainerKey.exam.grade({
        attemptId: a.id,
        expectedRevision: proposal.revision,
        release: true,
        grades: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("keeps immutable snapshots, allows new attempts and prevents deleting an exam with attempts", async () => {
    const { db, trainer, trainee, exam } = await fixture();
    const a = await startAttempt(db, trainee, { examId: exam.id }, T0);
    await updateExam(db, trainer, {
      examId: exam.id,
      expectedRevision: exam.revision,
      definition: {
        questions: exam.questions.map(({ choices, ...q }, i) => ({
          ...q,
          weight: i === 0 ? 9 : q.weight,
          ...(choices ? { choices } : {}),
        })),
      },
    });
    expect(
      (await getOwnAttempt(db, trainee, a.id, T0)).questions[0]!.weight,
    ).toBe(4);
    await expect(deleteExam(db, trainer, exam.id)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const questionId = exam.questions[1]!.id;
    expect(
      (
        await saveAnswer(
          db,
          trainee,
          {
            attemptId: a.id,
            answer: { questionId, sequence: 1, text: "Late but within grace" },
          },
          new Date(T0.getTime() + 30 * 60_000 + 9_000),
        )
      ).outcome,
    ).toBe("saved");
    expect(
      (
        await saveAnswer(
          db,
          trainee,
          {
            attemptId: a.id,
            answer: { questionId, sequence: 2, text: "Too late" },
          },
          new Date(T0.getTime() + 30 * 60_000 + 11_000),
        )
      ).outcome,
    ).toBe("expired");
    expect(
      await finalizeExpiredAttempts(db, new Date(T0.getTime() + 40 * 60_000)),
    ).toEqual({ expired: 1 });
    expect(
      await finalizeExpiredAttempts(db, new Date(T0.getTime() + 40 * 60_000)),
    ).toEqual({ expired: 0 });
    const next = await startAttempt(
      db,
      trainee,
      { examId: exam.id },
      new Date(T0.getTime() + 40 * 60_000),
    );
    expect(next).toMatchObject({ attemptNumber: 2, maxScore: 15 });
    expect(next.questions[0]!.weight).toBe(9);
    const firstPage = await listAttempts(
      db,
      trainer,
      { projectIds: [exam.projectId], limit: 1 },
      new Date(T0.getTime() + 40 * 60_000),
    );
    const secondPage = await listAttempts(
      db,
      trainer,
      { projectIds: [exam.projectId], limit: 1, cursor: firstPage.nextCursor! },
      new Date(T0.getTime() + 40 * 60_000),
    );
    expect(firstPage.items[0]!.id).toBe(next.id);
    expect(secondPage.items[0]!.id).toBe(a.id);
  });
});

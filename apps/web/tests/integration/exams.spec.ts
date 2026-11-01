import { beforeEach, describe, expect, it } from "vitest";
import {
  createExam,
  updateExam,
  getExam,
  listExams,
} from "@weaver/core/services/exams";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  callerFor,
} from "./_harness";

describe("exam definitions service", () => {
  beforeEach(resetDb);
  it("pages trainer summaries with aggregate counts including expired attempts", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "paged-trainer");
    const other = await makeUser("User", "paged-other");
    const project = await makeProject("Paged exams");
    await addMembership(project.id, user.id, "Owner");
    await db.projectTrainingRole.create({
      data: { projectId: project.id, userId: user.id, role: "trainer" },
    });
    const actor = securityContextFor(user);
    const now = new Date();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const exam = await createExam(db, actor, {
        projectId: project.id,
        definition: {
          title: `Exam ${index}`,
          timeLimitMinutes: 30,
          questions: [{ kind: "free_text", prompt: "Explain", weight: 4 }],
        },
      });
      ids.push(exam.id);
      await db.examAttempt.createMany({
        data: Array.from({ length: 120 }, (_, n) => ({
          examId: exam.id,
          projectId: project.id,
          traineeId: n === 119 ? other.id : user.id,
          startedAt: now,
          attemptNumber: n + 1,
          examRevision: 1,
          definitionSnapshot: {},
          maxScore: 4,
          status: n < 118 ? ("released" as const) : ("in_progress" as const),
          deadlineAt: new Date(now.getTime() + (n < 119 ? -20_000 : 60_000)),
        })),
      });
    }
    const first = await listExams(
      db,
      actor,
      { projectId: project.id, limit: 2 },
      now,
    );
    expect(first.items).toHaveLength(2);
    for (const item of first.items)
      expect(item).toMatchObject({
        questionCount: 1,
        maxScore: 4,
        attemptCounts: {
          inProgress: 1,
          waiting: 1,
          inReview: 0,
          released: 118,
        },
      });
    const second = await listExams(
      db,
      actor,
      { projectId: project.id, limit: 2, cursor: first.nextCursor! },
      now,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.items, ...second.items].map((row) => row.id).sort(),
    ).toEqual(ids.sort());
  });
  it("retains question identities when positions are swapped and rejects stale edits", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "trainer");
    const project = await makeProject("Exams");
    await addMembership(project.id, user.id, "Owner");
    await db.projectTrainingRole.create({
      data: { projectId: project.id, userId: user.id, role: "trainer" },
    });
    const actor = securityContextFor(user);
    const exam = await createExam(db, actor, {
      projectId: project.id,
      definition: {
        title: "Safety",
        timeLimitMinutes: 30,
        questions: [
          { kind: "free_text", prompt: "First", weight: 4 },
          { kind: "free_text", prompt: "Second", weight: 6 },
        ],
      },
    });
    expect(exam).toMatchObject({ revision: 1, maxScore: 10, questionCount: 2 });
    const updated = await updateExam(db, actor, {
      examId: exam.id,
      expectedRevision: 1,
      definition: {
        questions: [exam.questions[1]!, exam.questions[0]!].map(
          ({ choices: _choices, ...q }) => q,
        ),
      },
    });
    expect(updated.questions.map((q) => q.id)).toEqual([
      exam.questions[1]!.id,
      exam.questions[0]!.id,
    ]);
    expect(updated.questions.map((q) => q.position)).toEqual([0, 1]);
    await expect(
      updateExam(db, actor, {
        examId: exam.id,
        expectedRevision: 1,
        status: "published",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const off = await makeUser("User", "off");
    await addMembership(project.id, off.id, "Editor");
    await expect(
      listExams(db, securityContextFor(off), { projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsider = await makeUser("Admin", "outsider");
    await expect(
      getExam(db, securityContextFor(outsider), exam.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listExams(
        db,
        { ...actor, authenticationMethod: "task" },
        { projectId: project.id },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getExam(db, actor, exam.id)).revision).toBe(2);
  });
  it("validates publication and choice fields through the router and blocks trainees", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "trainer");
    const trainee = await makeUser("User", "trainee");
    const project = await makeProject("Router exams");
    await addMembership(project.id, user.id, "Owner");
    await addMembership(project.id, trainee.id, "Viewer");
    await db.projectTrainingRole.createMany({
      data: [
        { projectId: project.id, userId: user.id, role: "trainer" },
        { projectId: project.id, userId: trainee.id, role: "trainee" },
      ],
    });
    const caller = callerFor(user);
    await expect(
      caller.exam.create({
        projectId: project.id,
        title: "Empty",
        timeLimitMinutes: 5,
        questions: [],
        status: "published",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const exam = await caller.exam.create({
      projectId: project.id,
      title: "Draft",
      instructions: "Read carefully before starting",
      timeLimitMinutes: 5,
      questions: [],
    });
    expect((await caller.exam.get({ examId: exam.id })).id).toBe(exam.id);
    const archived = await caller.exam.update({
      examId: exam.id,
      expectedRevision: exam.revision,
      status: "archived",
    });
    expect(archived.instructions).toBe("Read carefully before starting");
    expect(
      (await caller.exam.list({ projectId: project.id })).items,
    ).toHaveLength(1);
    await expect(
      callerFor(trainee).exam.get({ examId: exam.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller.exam.delete({ examId: exam.id });
    expect(
      (await caller.exam.list({ projectId: project.id })).items,
    ).toHaveLength(0);
  });
  it("enforces the project cap transactionally and rejects empty published definitions", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "trainer");
    const project = await makeProject("Limit");
    await addMembership(project.id, user.id, "Owner");
    await db.projectTrainingRole.create({
      data: { projectId: project.id, userId: user.id, role: "trainer" },
    });
    const actor = securityContextFor(user);
    const definition = { title: "Exam", timeLimitMinutes: 5, questions: [] };
    await expect(
      createExam(db, actor, {
        projectId: project.id,
        definition,
        status: "published",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "questions" },
    });
    await db.exam.createMany({
      data: Array.from({ length: 499 }, (_, i) => ({
        projectId: project.id,
        title: `Exam ${i}`,
        timeLimitMinutes: 5,
      })),
    });
    await createExam(db, actor, { projectId: project.id, definition });
    await expect(
      createExam(db, actor, { projectId: project.id, definition }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

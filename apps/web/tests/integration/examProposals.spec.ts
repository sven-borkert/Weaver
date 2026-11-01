import { beforeEach, describe, expect, it } from "vitest";
import { createConversation } from "@weaver/core/services/assistantConversations";
import {
  acceptProposal,
  createProposal,
  rejectProposal,
} from "@weaver/core/services/assistantProposals";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import { createExam, getExam, updateExam } from "@weaver/core/services/exams";
import type { ExamProposalOperationInput } from "@weaver/core/services/examProposals";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const definition = {
  title: "Proposed exam",
  timeLimitMinutes: 20,
  questions: [
    {
      kind: "multiple_choice" as const,
      prompt: "Pick",
      weight: 2,
      choices: [
        { text: "Right", correct: true },
        { text: "Wrong", correct: false },
      ],
    },
    {
      kind: "free_text" as const,
      prompt: "Explain",
      weight: 3,
      expectedAnswer: "A reason",
    },
  ],
};

async function setup(suffix: string, trainer = true) {
  const db = getPrisma();
  const user = await makeUser("User", suffix);
  const project = await makeProject(`Exam proposals ${suffix}`);
  // Training powers are orthogonal to content rank: a Viewer trainer may propose and accept.
  await addMembership(project.id, user.id, "Viewer");
  if (trainer)
    await db.projectTrainingRole.create({
      data: { projectId: project.id, userId: user.id, role: "trainer" },
    });
  const actor = {
    ...securityContextFor(user),
    name: `User ${suffix}`,
    email: user.email,
  };
  const conversation = await createConversation(db, actor, {});
  const { run } = await submitUserMessage(db, actor, {
    conversationId: conversation.id,
    text: "build an exam",
    scope: { kind: "project", projectId: project.id },
  });
  const propose = (operation: ExamProposalOperationInput, summary = "Exam") =>
    createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary,
      operation,
    });
  return { db, user, project, actor, conversation, run, propose };
}

type Preview = { kind: string; lines: Array<{ type: string; text: string }> };

describe("exam proposals", () => {
  beforeEach(resetDb);

  it("creates nothing until a trainer accepts, then records the exam revision", async () => {
    const f = await setup("create");
    const proposal = await f.propose({
      kind: "exam.create",
      projectId: f.project.id,
      definition,
    });
    expect(proposal).toMatchObject({
      kind: "exam.create",
      status: "pending",
      resourceId: null,
    });
    const lines = (proposal.preview as Preview).lines;
    expect(lines.every((line) => line.type === "add")).toBe(true);
    expect(lines.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        "Status: draft",
        "Questions: 2 (1 multiple choice, 1 free text), max score 5",
        "  [x] Right",
        "  [ ] Wrong",
        "  Expected answer:",
      ]),
    );
    expect(await f.db.exam.count()).toBe(0);

    const accepted = await acceptProposal(f.db, f.actor, proposal.id);
    expect(accepted).toMatchObject({
      status: "accepted",
      resolution: { revision: 1 },
    });
    const exam = await getExam(f.db, f.actor, accepted.resourceId!);
    expect(exam).toMatchObject({
      title: "Proposed exam",
      status: "draft",
      questionCount: 2,
      maxScore: 5,
    });
    await expect(acceptProposal(f.db, f.actor, proposal.id)).rejects.toThrow(
      "proposal is accepted",
    );
    expect(await f.db.exam.count()).toBe(1);
  });

  it("refuses question ids on create and non-trainers before storing a proposal", async () => {
    const f = await setup("ids");
    await expect(
      f.propose({
        kind: "exam.create",
        projectId: f.project.id,
        definition: {
          ...definition,
          questions: [{ ...definition.questions[1]!, id: crypto.randomUUID() }],
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "questions.0.id" },
    });
    const outsider = await setup("not-trainer", false);
    await expect(
      outsider.propose({
        kind: "exam.create",
        projectId: outsider.project.id,
        definition,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.db.assistantProposal.count()).toBe(0);
  });

  it("previews an update as a diff and conflicts when the exam moved on", async () => {
    const f = await setup("update");
    const exam = await createExam(f.db, f.actor, {
      projectId: f.project.id,
      definition,
    });
    await expect(
      f.propose({
        kind: "exam.update",
        projectId: f.project.id,
        examId: exam.id,
        expectedRevision: exam.revision + 1,
        definition: { title: "Stale" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.propose({
        kind: "exam.update",
        projectId: f.project.id,
        examId: exam.id,
        expectedRevision: exam.revision,
        definition: {
          questions: [{ ...definition.questions[0]!, id: crypto.randomUUID() }],
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "questions.0.id" },
    });

    const proposal = await f.propose({
      kind: "exam.update",
      projectId: f.project.id,
      examId: exam.id,
      expectedRevision: exam.revision,
      definition: { title: "Renamed exam" },
    });
    expect(proposal.resourceId).toBe(exam.id);
    const changed = (proposal.preview as Preview).lines.filter(
      (line) => line.type !== "same",
    );
    expect(changed).toEqual([
      { type: "del", text: "Title: Proposed exam" },
      { type: "add", text: "Title: Renamed exam" },
    ]);

    await updateExam(f.db, f.actor, {
      examId: exam.id,
      expectedRevision: exam.revision,
      definition: { timeLimitMinutes: 45 },
    });
    expect(await acceptProposal(f.db, f.actor, proposal.id)).toMatchObject({
      status: "conflicted",
      resolution: { reason: "exam changed since this was proposed" },
    });
    expect(await getExam(f.db, f.actor, exam.id)).toMatchObject({
      title: "Proposed exam",
      timeLimitMinutes: 45,
    });
  });

  it("keeps question ids an update names and applies only after acceptance", async () => {
    const f = await setup("keep");
    const exam = await createExam(f.db, f.actor, {
      projectId: f.project.id,
      definition,
    });
    const kept = exam.questions[0]!;
    const proposal = await f.propose({
      kind: "exam.update",
      projectId: f.project.id,
      examId: exam.id,
      expectedRevision: exam.revision,
      definition: {
        instructions: "Answer every question.",
        questions: [{ ...definition.questions[0]!, id: kept.id }],
      },
    });
    expect((await getExam(f.db, f.actor, exam.id)).questionCount).toBe(2);
    expect(await acceptProposal(f.db, f.actor, proposal.id)).toMatchObject({
      status: "accepted",
      resolution: { revision: exam.revision + 1 },
    });
    const after = await getExam(f.db, f.actor, exam.id);
    expect(after.instructions).toBe("Answer every question.");
    expect(after.questions.map((q) => q.id)).toEqual([kept.id]);
  });

  it("rejects without writing and refuses acceptance after losing the trainer role", async () => {
    const f = await setup("reject");
    const first = await f.propose({
      kind: "exam.create",
      projectId: f.project.id,
      definition,
    });
    expect(await rejectProposal(f.db, f.actor, first.id)).toMatchObject({
      status: "rejected",
    });
    const second = await f.propose({
      kind: "exam.create",
      projectId: f.project.id,
      definition,
    });
    await f.db.projectTrainingRole.deleteMany({
      where: { projectId: f.project.id, userId: f.user.id },
    });
    await expect(
      acceptProposal(f.db, f.actor, second.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.db.exam.count()).toBe(0);
    expect(
      (
        await f.db.assistantProposal.findUniqueOrThrow({
          where: { id: second.id },
        })
      ).status,
    ).toBe("pending");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveMcpScopeSnapshot } from "@weaver/core/assistant/scope";
import {
  createApiKeySecurityContext,
  createOAuthSecurityContext,
} from "@weaver/core/security/context";
import { createExam, getExam, updateExam } from "@weaver/core/services/exams";
import {
  getOwnAttempt,
  startAttempt,
  saveAnswer,
  submitAttempt,
} from "@weaver/core/services/examAttempts";
import { pruneExamOperations } from "@weaver/core/services/examOperations";
import {
  EXAM_TOOLS,
  examToolsForActor,
} from "@weaver/assistant-tools/registry";
import { detailPage } from "../../../../packages/assistant-tools/src/tools/exams/shared";
import type { ToolContext } from "@weaver/assistant-tools/contract";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
async function invoke(name: string, input: unknown, ctx: ToolContext) {
  const tool = EXAM_TOOLS.find((t) => t.name === name)!;
  return (await tool.execute(tool.inputSchema.parse(input), ctx)).output as {
    exam: {
      id: string;
      status: string;
      questionIds: string[];
      instructions: string;
      revision: number;
    };
    attempt: { status: string; revision: number };
    notice: string;
    questions: Array<{ proposal: unknown }>;
    replayed: boolean;
  };
}
describe("exam tools", () => {
  beforeEach(resetDb);
  async function fixture() {
    const db = getPrisma();
    const trainer = await makeUser("User", "trainer");
    const trainee = await makeUser("User", "trainee");
    const off = await makeUser("User", "off");
    const stranger = await makeUser("User", "stranger");
    const project = await makeProject("Exam tools");
    for (const u of [trainer, trainee, off])
      await addMembership(project.id, u.id, "Viewer");
    await db.projectTrainingRole.createMany({
      data: [
        { projectId: project.id, userId: trainer.id, role: "trainer" },
        { projectId: project.id, userId: trainee.id, role: "trainee" },
      ],
    });
    async function context(user: typeof trainer): Promise<ToolContext> {
      const actor = securityContextFor(user);
      return {
        db,
        actor,
        scope: await resolveMcpScopeSnapshot(db, actor),
        profile: { name: null, email: user.email },
        run: null,
      };
    }
    const ctx = await context(trainer);
    const definition = {
      title: "Exam",
      instructions: "Keep instructions",
      timeLimitMinutes: 5,
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
          expectedAnswer: "Reason",
        },
      ],
    };
    const exam = await createExam(db, ctx.actor, {
      projectId: project.id,
      definition,
      status: "published",
    });
    return {
      db,
      trainer,
      trainee,
      off,
      stranger,
      project,
      ctx,
      context,
      exam,
      definition,
    };
  }
  it("checks training and project scope before returning answer keys", async () => {
    const f = await fixture();
    const got = await invoke("get_exam", { examId: f.exam.id }, f.ctx);
    expect(JSON.stringify(got)).toContain('"correct":true');
    for (const user of [f.trainee, f.off])
      await expect(
        invoke("get_exam", { examId: f.exam.id }, await f.context(user)),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      invoke("get_exam", { examId: f.exam.id }, await f.context(f.stranger)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      invoke(
        "get_exam",
        { examId: f.exam.id },
        { ...f.ctx, scope: { ...f.ctx.scope, projectIds: [] } },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("replays identical writes and rechecks authorization on replay", async () => {
    const f = await fixture();
    const input = {
      projectId: f.project.id,
      idempotencyKey: "create-exam-123",
      ...f.definition,
    };
    const a = await invoke("create_exam", input, f.ctx);
    const b = await invoke("create_exam", input, f.ctx);
    expect(b).toMatchObject({
      exam: { id: a.exam.id, status: "draft" },
      replayed: true,
    });
    expect(a.exam.questionIds).toHaveLength(2);
    const update = await invoke(
      "update_exam",
      {
        examId: a.exam.id,
        expectedRevision: 1,
        status: "published",
        idempotencyKey: "publish-exam-key",
      },
      f.ctx,
    );
    expect(update.exam.status).toBe("published");
    expect((await getExam(f.db, f.ctx.actor, a.exam.id)).instructions).toBe(
      "Keep instructions",
    );
    await expect(
      invoke("create_exam", { ...input, title: "Another" }, f.ctx),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await f.db.projectTrainingRole.delete({
      where: {
        projectId_userId: { projectId: f.project.id, userId: f.trainer.id },
      },
    });
    await expect(invoke("create_exam", input, f.ctx)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("pages every oversized field losslessly including Unicode and escaping", async () => {
    const f = await fixture();
    const data = {
      instructions: '"漢🙂'.repeat(12000),
      questions: [{ expectedAnswer: "字".repeat(10000) }],
    };
    let cursor: string | undefined;
    let joined = "";
    let count = 0;
    do {
      const page = detailPage(data, "1", cursor) as {
        jsonFragment: string;
        nextCursor: string | null;
      };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        16000,
      );
      joined += page.jsonFragment;
      cursor = page.nextCursor ?? undefined;
      count++;
    } while (cursor);
    expect(count).toBeGreaterThan(1);
    expect(JSON.parse(joined)).toEqual(data);
    const first = detailPage(data, "1") as { nextCursor: string };
    expect(() => detailPage(data, "2", first.nextCursor)).toThrow("changed");
    expect(
      await invoke("list_exams", { projectId: f.project.id }, f.ctx),
    ).toHaveProperty("items");
  });
  it("proposes grades privately and refuses read-only writes", async () => {
    const f = await fixture();
    const learner = securityContextFor(f.trainee);
    const attempt = await startAttempt(f.db, learner, { examId: f.exam.id });
    await saveAnswer(f.db, learner, {
      attemptId: attempt.id,
      answer: {
        questionId: f.exam.questions[1]!.id,
        sequence: 1,
        text: "Because",
      },
    });
    await submitAttempt(f.db, learner, { attemptId: attempt.id });
    await updateExam(f.db, f.ctx.actor, {
      examId: f.exam.id,
      expectedRevision: 1,
      definition: { instructions: "Changed live" },
    });
    const review = await invoke(
      "get_exam_attempt",
      { attemptId: attempt.id },
      f.ctx,
    );
    expect(review.exam.instructions).toBe("Keep instructions");
    expect(review.exam.revision).toBe(1);
    expect(review.notice).toContain("untrusted");
    expect(review.questions[1]!.proposal).toBeNull();
    const input = {
      attemptId: attempt.id,
      expectedRevision: review.attempt.revision,
      idempotencyKey: "grade-exam-123",
      grades: [
        {
          questionId: f.exam.questions[1]!.id,
          score: 3,
          rationale: "Good reason",
        },
      ],
    };
    expect(
      (await invoke("grade_exam_attempt", input, f.ctx)).attempt.status,
    ).toBe("in_review");
    expect(
      (await getOwnAttempt(f.db, learner, attempt.id)).totalScore,
    ).toBeNull();
    expect(
      z.toJSONSchema(EXAM_TOOLS[6]!.inputSchema, { io: "input" }).properties,
    ).not.toHaveProperty("release");
    const ro = createApiKeySecurityContext({
      userId: f.trainer.id,
      globalRole: "User",
      keyId: "key",
      permissions: { content: ["read"], mcp: ["use"] },
      projectIds: [],
    });
    expect(examToolsForActor(ro)).toHaveLength(4);
    await expect(
      invoke(
        "create_exam",
        {
          ...f.definition,
          projectId: f.project.id,
          idempotencyKey: "ro-write-key",
        },
        { ...f.ctx, actor: ro },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getExam(f.db, f.ctx.actor, f.exam.id)).revision).toBe(2);
  });
  it("prunes receipts at thirty days in bounded batches", async () => {
    const f = await fixture();
    const now = new Date();
    for (const age of [29, 31])
      await f.db.examOperation.create({
        data: {
          userId: f.trainer.id,
          idempotencyKey: `age-${age}`,
          toolName: "create_exam",
          requestHash: "hash",
          result: {},
          createdAt: new Date(now.getTime() - age * 86400000),
        },
      });
    expect(await pruneExamOperations(f.db, now)).toBe(1);
    expect(await f.db.examOperation.count()).toBe(1);
  });
  it("allows write-only OAuth creation, update, grading and replay while refusing reads", async () => {
    const f = await fixture();
    const actor = createOAuthSecurityContext({
      userId: f.trainer.id,
      globalRole: f.trainer.role,
      tokenId: "write-only-oauth",
      scopes: ["mcp:use", "content:write"],
    });
    const ctx = {
      ...f.ctx,
      actor,
      scope: await resolveMcpScopeSnapshot(f.db, actor),
    };
    const create = {
      projectId: f.project.id,
      idempotencyKey: "oauth-create-only",
      ...f.definition,
      status: "published",
    };
    const created = await invoke("create_exam", create, ctx);
    expect((await invoke("create_exam", create, ctx)).replayed).toBe(true);
    const update = {
      examId: created.exam.id,
      idempotencyKey: "oauth-update-only",
      expectedRevision: created.exam.revision,
      title: "Updated through write OAuth",
    };
    const updated = await invoke("update_exam", update, ctx);
    expect(updated.exam.revision).toBe(2);
    expect((await invoke("update_exam", update, ctx)).replayed).toBe(true);
    await expect(
      invoke("get_exam", { examId: created.exam.id }, ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const trainee = securityContextFor(f.trainee);
    const now = new Date();
    const attempt = await startAttempt(
      f.db,
      trainee,
      { examId: created.exam.id },
      now,
    );
    await submitAttempt(f.db, trainee, { attemptId: attempt.id }, now);
    const stored = await f.db.examAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    const grade = {
      attemptId: attempt.id,
      idempotencyKey: "oauth-grade-only",
      expectedRevision: stored.revision,
      grades: [
        {
          questionId: created.exam.questionIds[1]!,
          score: 3,
          rationale: "All required points",
        },
      ],
    };
    expect(
      (await invoke("grade_exam_attempt", grade, ctx)).attempt.status,
    ).toBe("in_review");
    expect((await invoke("grade_exam_attempt", grade, ctx)).replayed).toBe(
      true,
    );
    expect(
      await f.db.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).toMatchObject({ status: "in_review", gradedVia: "oauth" });
    await expect(
      invoke("get_exam_attempt", { attemptId: attempt.id }, ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

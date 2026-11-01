import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toAiToolSet, type ToolCollector } from "@weaver/ai/tools";
import { toolByName } from "@weaver/assistant-tools/registry";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { createProposal } from "@weaver/core/services/assistantProposals";
import {
  leaseRunAttempt,
  persistRunAttemptFailure,
  reconcileAssistantRuns,
  requestRunCancel,
} from "@weaver/core/services/assistantRuns";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { toOrganizationRole } from "@weaver/core/roles";
import { getDocument } from "@weaver/core/services/documents";
import { getTable } from "@weaver/core/services/tables";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

async function fixture() {
  const db = getPrisma();
  const user = await makeUser("User", "auto-approve");
  const project = await makeProject("Auto approval");
  await addMembership(project.id, user.id, "Editor");
  const actor = securityContextFor(user);
  const caller = callerFor(user);
  const conversation = await caller.assistant.createConversation({});
  const { run } = await caller.assistant.sendMessage({
    conversationId: conversation.id,
    text: "Create notes",
    scope: { kind: "project", projectId: project.id },
  });
  const leased = (await leaseRunAttempt(db, {
    runId: run.id,
    workerId: "auto-test",
  }))!;
  const input = {
    attemptId: leased.attempt.id,
    conversationId: conversation.id,
    runId: run.id,
    summary: "Create notes",
    operation: {
      kind: "document.create" as const,
      projectId: project.id,
      title: "Notes",
      folderPath: [],
      markdown: "Automatically approved notes",
    },
  };
  return { db, user, project, actor, caller, conversation, run, input, leased };
}

describe("conversation auto-approval", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  it("requires review for unpinned projects in a multi-project run", async () => {
    const { db, user, actor, caller, conversation, run, input, project } =
      await fixture();
    const second = await makeProject("Second auto-approval project");
    await addMembership(second.id, user.id, "Editor");
    await db.assistantRun.update({
      where: { id: run.id },
      data: {
        scopeSnapshot: await resolveScopeSnapshot(db, actor, {
          kind: "projects",
          projectIds: [project.id, second.id],
        }),
      },
    });
    await caller.assistant.setAutoApproveChanges({
      conversationId: conversation.id,
      enabled: true,
    });
    expect((await createProposal(db, actor, input)).status).toBe("pending");
    await db.assistantConversation.update({
      where: { id: conversation.id },
      data: { pinnedProjectId: project.id },
    });
    expect(
      (
        await createProposal(db, actor, {
          ...input,
          operation: { ...input.operation, projectId: second.id },
        })
      ).status,
    ).toBe("pending");
    expect(
      (
        await createProposal(db, actor, {
          ...input,
          operation: { ...input.operation, title: "Pinned notes" },
        })
      ).status,
    ).toBe("accepted");
  });

  it("defaults off, persists for its owner, and does not approve existing proposals", async () => {
    const { db, actor, caller, conversation, input } = await fixture();
    expect(conversation.autoApproveChanges).toBe(false);
    const pending = await createProposal(db, actor, input);
    expect(pending.status).toBe("pending");
    await caller.assistant.setAutoApproveChanges({
      conversationId: conversation.id,
      enabled: true,
    });
    expect(
      (
        await caller.assistant.getConversation({
          conversationId: conversation.id,
        })
      ).autoApproveChanges,
    ).toBe(true);
    expect(
      (await caller.assistant.getProposal({ proposalId: pending.id })).status,
    ).toBe("pending");
    const other = callerFor(await makeUser("Admin", "auto-approve-other"));
    await expect(
      other.assistant.setAutoApproveChanges({
        conversationId: conversation.id,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await caller.assistant.createConversation({})).autoApproveChanges,
    ).toBe(false);
  });

  it.each(["document.create", "table.create"] as const)(
    "applies %s on the server and stops auto-approving when disabled",
    async (kind) => {
      const { db, actor, caller, conversation, project, input } =
        await fixture();
      await caller.assistant.setAutoApproveChanges({
        conversationId: conversation.id,
        enabled: true,
      });
      const proposal = await createProposal(db, actor, {
        ...input,
        operation:
          kind === "document.create"
            ? input.operation
            : {
                kind,
                projectId: project.id,
                title: "Tasks",
                folderPath: [],
                columns: [
                  {
                    id: "11111111-1111-4111-8111-111111111111",
                    name: "Task",
                    type: "text",
                  },
                ],
                rows: [],
              },
      });
      expect(proposal.status).toBe("accepted");
      expect(proposal.resolution?.commitSha).toMatch(/^[0-9a-f]{40}$/);
      if (kind === "document.create") {
        expect(
          (
            await getDocument(
              db,
              { projectId: project.id, documentId: proposal.resourceId! },
              actor,
            )
          ).title,
        ).toBe("Notes");
      } else {
        expect(
          (
            await getTable(
              db,
              { projectId: project.id, tableId: proposal.resourceId! },
              actor,
            )
          ).title,
        ).toBe("Tasks");
      }
      await caller.assistant.setAutoApproveChanges({
        conversationId: conversation.id,
        enabled: false,
      });
      expect((await createProposal(db, actor, input)).status).toBe("pending");
    },
  );

  it("returns the committed revision to the assistant tool and keeps proposals scoped", async () => {
    const { db, actor, caller, conversation, project, run, input, user } =
      await fixture();
    await caller.assistant.setAutoApproveChanges({
      conversationId: conversation.id,
      enabled: true,
    });
    const ctx = {
      db,
      actor,
      profile: { name: null, email: user.email },
      scope: await resolveScopeSnapshot(db, actor, {
        kind: "project",
        projectId: project.id,
      }),
      run: {
        conversationId: conversation.id,
        runId: run.id,
        attemptId: input.attemptId,
      },
    };
    const tool = toolByName("propose_document_create")!;
    const { kind: _kind, ...operation } = input.operation;
    const result = await tool.execute(
      { ...operation, summary: input.summary },
      ctx,
    );
    expect(result.output).toMatchObject({
      status: "accepted",
      resourceId: expect.any(String),
      resolution: { commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) },
    });
    const hidden = await makeProject("Out of scope");
    await addMembership(hidden.id, user.id, "Editor");
    await expect(
      tool.execute(
        { ...operation, projectId: hidden.id, summary: "Outside scope" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "SCOPE_VIOLATION" },
    });
    expect(await db.document.count({ where: { projectId: hidden.id } })).toBe(
      0,
    );
  });
  it.each(["provider", "lease"] as const)(
    "does not replay applied changes after %s failure",
    async (failure) => {
      const { db, actor, caller, conversation, input, run, leased } =
        await fixture();
      await caller.assistant.setAutoApproveChanges({
        conversationId: conversation.id,
        enabled: true,
      });
      const accepted = await createProposal(db, actor, input);
      if (failure === "provider") {
        expect(
          await persistRunAttemptFailure(db, {
            runId: run.id,
            attemptId: leased.attempt.id,
            code: "RATE_LIMIT",
            message: "provider unavailable",
            retryable: true,
          }),
        ).toMatchObject({ retrying: false });
      } else {
        await db.assistantRunAttempt.update({
          where: { id: leased.attempt.id },
          data: { leaseExpiresAt: new Date(0) },
        });
        await reconcileAssistantRuns(db);
      }
      expect(
        await db.assistantRun.findUnique({ where: { id: run.id } }),
      ).toMatchObject({
        status: "failed",
        errorCode: "CONTENT_CHANGE_APPLIED",
      });
      expect(
        (
          await caller.assistant.listProposals({
            conversationId: conversation.id,
          })
        ).map((p) => [p.id, p.status]),
      ).toContainEqual([accepted.id, "accepted"]);
      expect(await db.document.count()).toBe(1);
    },
  );

  it.each([
    "disable",
    "cancel",
    "demote",
    "abandon",
    "reset",
    "revoke",
    "ban",
  ] as const)(
    "rechecks %s before a blocked automatic write",
    async (action) => {
      const {
        db,
        actor,
        caller,
        conversation,
        project,
        user,
        input,
        run,
        leased,
      } = await fixture();
      await caller.assistant.setAutoApproveChanges({
        conversationId: conversation.id,
        enabled: true,
      });
      let release!: () => void;
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lock = withProjectRepo(project.id, async () => {
        locked();
        await gate;
      });
      await acquired;
      const creation = createProposal(db, actor, input).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await vi.waitFor(async () =>
          expect(await db.assistantProposal.count()).toBe(1),
        );
        if (action === "disable")
          await caller.assistant.setAutoApproveChanges({
            conversationId: conversation.id,
            enabled: false,
          });
        if (action === "cancel") await requestRunCancel(db, actor, run.id);
        if (action === "reset")
          await db.user.update({
            where: { id: user.id },
            data: { mustChangePassword: true },
          });
        if (action === "ban")
          await db.user.update({
            where: { id: user.id },
            data: { banned: true },
          });
        if (action === "revoke")
          await db.session.delete({ where: { id: actor.credentialId } });
        if (action === "demote")
          await db.member.updateMany({
            where: {
              userId: user.id,
              organizationId: (
                await db.project.findUniqueOrThrow({
                  where: { id: project.id },
                  select: { organizationId: true },
                })
              ).organizationId,
            },
            data: { role: toOrganizationRole("Viewer") },
          });
        if (action === "abandon") {
          await db.assistantRunAttempt.update({
            where: { id: leased.attempt.id },
            data: { leaseExpiresAt: new Date(0) },
          });
          await reconcileAssistantRuns(db);
        }
      } finally {
        release();
        await lock;
      }
      await creation;
      expect(await db.document.count()).toBe(0);
      expect(
        await db.assistantProposal.count({
          where: { status: { in: ["accepted", "accepting"] } },
        }),
      ).toBe(0);
    },
  );

  it("rejects a stale attempt after a replacement worker leases the run", async () => {
    const { db, actor, caller, conversation, input, run, leased } =
      await fixture();
    await caller.assistant.setAutoApproveChanges({
      conversationId: conversation.id,
      enabled: true,
    });
    await db.assistantRunAttempt.update({
      where: { id: leased.attempt.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await reconcileAssistantRuns(db);
    await leaseRunAttempt(db, { runId: run.id, workerId: "replacement" });
    await expect(createProposal(db, actor, input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await db.assistantProposal.count()).toBe(0);
    expect(await db.document.count()).toBe(0);
  });

  it("preserves an interrupted acceptance for manual recovery without replaying the run", async () => {
    const {
      db,
      actor,
      caller,
      conversation,
      input,
      run,
      leased,
      user,
      project,
    } = await fixture();
    await caller.assistant.setAutoApproveChanges({
      conversationId: conversation.id,
      enabled: true,
    });
    const collector: ToolCollector = { citations: [], proposals: [] };
    const tools = toAiToolSet([toolByName("propose_document_create")!], {
      collector,
      onEvent: async () => undefined,
      context: async () => ({
        db,
        actor,
        profile: { name: null, email: user.email },
        scope: await resolveScopeSnapshot(db, actor, {
          kind: "project",
          projectId: project.id,
        }),
        run: {
          conversationId: conversation.id,
          runId: run.id,
          attemptId: leased.attempt.id,
        },
      }),
    });
    const { kind: _kind, ...operation } = input.operation;
    const call = async (): Promise<unknown> =>
      tools.propose_document_create!.execute!(
        { ...operation, summary: input.summary },
        {
          toolCallId: "create",
          messages: [],
          abortSignal: undefined,
          context: undefined,
        },
      );
    const ack = vi
      .spyOn(db.assistantProposal, "update")
      .mockRejectedValueOnce(new Error("ack failed"));
    try {
      expect(await call()).toMatchObject({
        status: "accepting",
        proposalId: expect.any(String),
      });
    } finally {
      ack.mockRestore();
    }
    const proposal = await db.assistantProposal.findFirstOrThrow();
    expect(proposal.status).toBe("accepting");
    expect(collector.proposals.map((p) => p.proposalId)).toContain(proposal.id);
    expect(await call()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await db.assistantProposal.count()).toBe(1);
    expect(await db.document.count()).toBe(1);
    await db.assistantRunAttempt.update({
      where: { id: leased.attempt.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await reconcileAssistantRuns(db);
    expect(
      await db.assistantRun.findUnique({ where: { id: run.id } }),
    ).toMatchObject({ status: "failed", errorCode: "CONTENT_CHANGE_APPLIED" });
    expect(
      (await caller.assistant.acceptProposal({ proposalId: proposal.id }))
        .status,
    ).toBe("accepted");
    expect(await db.document.count()).toBe(1);
  });
});

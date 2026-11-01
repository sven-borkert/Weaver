import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { createDocument, saveDocument } from "@weaver/core/services/documents";
import { createProposal } from "@weaver/core/services/assistantProposals";
import {
  completeRun,
  leaseRunAttempt,
} from "@weaver/core/services/assistantRuns";
import {
  createApiKeySecurityContext,
  createOAuthSecurityContext,
} from "@weaver/core/security/context";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
} from "./_harness";

// The SSE route authenticates through ~/server/auth directly (there is no tRPC
// context to inject), so the session is the one seam this spec stubs; the
// database, core services and the handler itself are the real ones.
const authState = vi.hoisted(() => ({
  user: null as {
    id: string;
    email: string;
    name: string;
    role: "Admin" | "User";
    sessionId: string;
    mustChangePassword: boolean;
  } | null,
}));
vi.mock("~/server/auth", () => ({
  auth: {},
  getSessionUser: () => Promise.resolve(authState.user),
}));
const { GET: streamRunEvents } =
  await import("~/app/api/assistant/runs/[runId]/events/route");

const MISSING_ID = "99999999-9999-4999-8999-999999999999";

function eventStreamRequest(runId: string, query = "") {
  return new NextRequest(
    `http://localhost:3000/api/assistant/runs/${runId}/events${query}`,
  );
}

function callStreamRoute(runId: string, query = "") {
  return streamRunEvents(eventStreamRequest(runId, query), {
    params: Promise.resolve({ runId }),
  });
}

/** SSE frames of a response whose run is already terminal (the stream never polls). */
async function frames(response: Response): Promise<string[]> {
  return (await response.text()).split("\n\n").filter(Boolean);
}

describe("assistant router", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "test");
    setJobQueueForTests(new FakeJobQueue());
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it("reports availability, drives a conversation end to end, and pages events", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "router");
    const project = await makeProject("Router");
    await addMembership(project.id, user.id, "Editor");
    const caller = callerFor(user);
    expect(await caller.assistant.availability()).toEqual({
      ready: false,
      reason: "no_route",
    });
    await seedTestLlmRouting();
    expect(await caller.assistant.availability()).toEqual({
      ready: true,
      reason: "ready",
    });

    const conversation = await caller.assistant.createConversation({
      pinnedProjectId: project.id,
    });
    const sent = await caller.assistant.sendMessage({
      conversationId: conversation.id,
      text: "Hello",
      scope: { kind: "project", projectId: project.id },
    });
    expect(sent.run.status).toBe("queued");
    await expect(
      caller.assistant.sendMessage({
        conversationId: conversation.id,
        text: "Again",
        scope: { kind: "all" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const leased = await leaseRunAttempt(db, {
      runId: sent.run.id,
      workerId: "spec",
    });
    await completeRun(db, {
      runId: sent.run.id,
      attemptId: leased!.attempt.id,
      text: "Hi!",
      citations: [],
      proposalIds: [],
    });
    expect(await caller.assistant.getRun({ runId: sent.run.id })).toMatchObject(
      {
        id: sent.run.id,
        status: "completed",
      },
    );
    const events = await caller.assistant.runEvents({
      runId: sent.run.id,
      after: -1,
    });
    expect(events.status).toBe("completed");
    expect(events.events.map((e) => e.type)).toEqual([
      "run.queued",
      "run.started",
      "run.completed",
    ]);
    expect(
      (
        await caller.assistant.runEvents({
          runId: sent.run.id,
          after: events.events[0]!.sequence,
        })
      ).events.map((e) => e.type),
    ).toEqual(["run.started", "run.completed"]);
    const detail = await caller.assistant.getConversation({
      conversationId: conversation.id,
    });
    expect(detail.messages.map((m) => m.text)).toEqual(["Hello", "Hi!"]);
    expect((await caller.assistant.listConversations({})).items[0]?.title).toBe(
      "Hello",
    );
    await caller.assistant.renameConversation({
      conversationId: conversation.id,
      title: "Greeting",
    });
    expect(
      await caller.assistant.pinConversation({
        conversationId: conversation.id,
        projectId: null,
      }),
    ).toMatchObject({ title: "Greeting", pinnedProjectId: null });
    await caller.assistant.deleteConversation({
      conversationId: conversation.id,
    });
    expect((await caller.assistant.listConversations({})).items).toEqual([]);
  });

  it("maps core errors and hides other users' resources", async () => {
    const owner = await makeUser("User", "owner2");
    const stranger = await makeUser("User", "stranger2");
    const conversation = await callerFor(owner).assistant.createConversation(
      {},
    );
    await expect(
      callerFor(stranger).assistant.getConversation({
        conversationId: conversation.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(owner).assistant.renameConversation({
        conversationId: conversation.id,
        title: "x".repeat(201),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("gives a stranger the same NOT_FOUND as a missing run or proposal", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "owner3");
    const stranger = await makeUser("User", "stranger3");
    const project = await makeProject("Hidden");
    await addMembership(project.id, owner.id, "Editor");
    await addMembership(project.id, stranger.id, "Editor");
    const ownerCaller = callerFor(owner);
    const conversation = await ownerCaller.assistant.createConversation({});
    const sent = await ownerCaller.assistant.sendMessage({
      conversationId: conversation.id,
      text: "propose something",
      scope: { kind: "project", projectId: project.id },
    });
    const proposal = await createProposal(db, securityContextFor(owner), {
      conversationId: conversation.id,
      runId: sent.run.id,
      summary: "add a document",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Draft",
        markdown: "# Draft",
      },
    });

    const intruder = callerFor(stranger);
    const notFound = { code: "NOT_FOUND" };
    // A stranger and a nonexistent id must be indistinguishable.
    for (const runId of [sent.run.id, MISSING_ID]) {
      await expect(intruder.assistant.getRun({ runId })).rejects.toMatchObject(
        notFound,
      );
      await expect(
        intruder.assistant.runEvents({ runId, after: -1 }),
      ).rejects.toMatchObject(notFound);
      await expect(
        intruder.assistant.cancelRun({ runId }),
      ).rejects.toMatchObject(notFound);
    }
    for (const proposalId of [proposal.id, MISSING_ID]) {
      await expect(
        intruder.assistant.acceptProposal({ proposalId }),
      ).rejects.toMatchObject(notFound);
      await expect(
        intruder.assistant.rejectProposal({ proposalId }),
      ).rejects.toMatchObject(notFound);
    }
    for (const conversationId of [conversation.id, MISSING_ID]) {
      await expect(
        intruder.assistant.listProposals({ conversationId }),
      ).rejects.toMatchObject(notFound);
    }

    expect(
      (
        await ownerCaller.assistant.listProposals({
          conversationId: conversation.id,
        })
      ).map((p) => p.id),
    ).toEqual([proposal.id]);
    expect(
      await ownerCaller.assistant.rejectProposal({ proposalId: proposal.id }),
    ).toMatchObject({ id: proposal.id, status: "rejected" });
    expect(
      await ownerCaller.assistant.cancelRun({ runId: sent.run.id }),
    ).toMatchObject({ id: sent.run.id, status: "cancelled" });
    // Cancelling frees the conversation for the next message.
    await ownerCaller.assistant.sendMessage({
      conversationId: conversation.id,
      text: "second try",
      scope: { kind: "project", projectId: project.id },
    });
  });

  it("refuses api-key and oauth credentials on every assistant procedure", async () => {
    const user = await makeUser("User", "bearer");
    const conversation = await callerFor(user).assistant.createConversation({});
    const contexts = [
      createApiKeySecurityContext({
        userId: user.id,
        globalRole: user.role,
        keyId: "key-1",
        permissions: { content: ["read", "write", "propose"], mcp: ["use"] },
        projectIds: [],
      }),
      createOAuthSecurityContext({
        userId: user.id,
        globalRole: user.role,
        tokenId: "token-1",
        scopes: "content:read content:write content:propose mcp:use",
      }),
    ];
    for (const security of contexts) {
      const caller = callerWithSecurity(user, security);
      const forbidden = { code: "FORBIDDEN" };
      await expect(caller.assistant.availability()).rejects.toMatchObject(
        forbidden,
      );
      await expect(
        caller.assistant.listConversations({}),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.createConversation({}),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.getConversation({ conversationId: conversation.id }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.renameConversation({
          conversationId: conversation.id,
          title: "taken over",
        }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.pinConversation({
          conversationId: conversation.id,
          projectId: null,
        }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.deleteConversation({
          conversationId: conversation.id,
        }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.sendMessage({
          conversationId: conversation.id,
          text: "drive the assistant",
          scope: { kind: "all" },
        }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.getRun({ runId: MISSING_ID }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.runEvents({ runId: MISSING_ID, after: -1 }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.cancelRun({ runId: MISSING_ID }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.listProposals({ conversationId: conversation.id }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.acceptProposal({ proposalId: MISSING_ID }),
      ).rejects.toMatchObject(forbidden);
      await expect(
        caller.assistant.rejectProposal({ proposalId: MISSING_ID }),
      ).rejects.toMatchObject(forbidden);
    }
    // The conversation is untouched by the rejected credentials.
    expect(
      (await callerFor(user).assistant.listConversations({})).items,
    ).toHaveLength(1);
  });

  it("reports jobs_disabled and refuses to queue a run when jobs are off", async () => {
    const user = await makeUser("User", "nojobs");
    const project = await makeProject("No jobs");
    await addMembership(project.id, user.id, "Editor");
    await seedTestLlmRouting();
    const caller = callerFor(user);
    const conversation = await caller.assistant.createConversation({});
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");
    expect(await caller.assistant.availability()).toEqual({
      ready: false,
      reason: "jobs_disabled",
    });
    await expect(
      caller.assistant.sendMessage({
        conversationId: conversation.id,
        text: "Hello",
        scope: { kind: "project", projectId: project.id },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects malformed input at the transport", async () => {
    const user = await makeUser("User", "input");
    const caller = callerFor(user);
    await expect(
      caller.assistant.getConversation({ conversationId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.assistant.runEvents({ runId: MISSING_ID, after: -2 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.assistant.renameConversation({
        conversationId: MISSING_ID,
        title: "x".repeat(401),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("assistant run-event SSE route", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "test");
    setJobQueueForTests(new FakeJobQueue());
    authState.user = null;
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
    authState.user = null;
  });

  /** A signed-in owner whose run has already completed, so the stream is finite. */
  async function completedRun(suffix: string) {
    const db = getPrisma();
    const user = await makeUser("User", suffix);
    const project = await makeProject(`SSE ${suffix}`);
    await addMembership(project.id, user.id, "Editor");
    const caller = callerFor(user);
    const conversation = await caller.assistant.createConversation({});
    const { run } = await caller.assistant.sendMessage({
      conversationId: conversation.id,
      text: "stream me",
      scope: { kind: "project", projectId: project.id },
    });
    const leased = await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "sse",
    });
    await completeRun(db, {
      runId: run.id,
      attemptId: leased!.attempt.id,
      text: "done",
      citations: [],
      proposalIds: [],
    });
    return { user, runId: run.id };
  }

  function signIn(
    user: { id: string; email: string; role: "Admin" | "User" },
    options: { mustChangePassword?: boolean } = {},
  ) {
    authState.user = {
      id: user.id,
      email: user.email,
      name: "Stream user",
      role: user.role,
      sessionId: "sse-session",
      mustChangePassword: options.mustChangePassword ?? false,
    };
  }

  it("streams the whole run as text/event-stream and ends with the terminal status", async () => {
    const { user, runId } = await completedRun("sse-ok");
    signIn(user);
    const response = await callStreamRoute(runId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await frames(response)).toEqual([
      "id: 0\nevent: run.queued\ndata: {}",
      'id: 1\nevent: run.started\ndata: {"attempt":1}',
      expect.stringMatching(
        /^id: 2\nevent: run\.completed\ndata: \{"messageId":"[0-9a-f-]+"\}$/,
      ),
      'event: end\ndata: {"status":"completed"}',
    ]);
  });

  it("treats a blank or unparseable after cursor as a replay from the start", async () => {
    const { user, runId } = await completedRun("sse-cursor");
    signIn(user);
    for (const query of [
      "",
      "?after=",
      "?after=%20",
      "?after=abc",
      "?after=-5",
    ]) {
      const types = (await frames(await callStreamRoute(runId, query))).map(
        (frame) => frame.split("\n")[1] ?? frame,
      );
      expect(types, `for query "${query}"`).toEqual([
        "event: run.queued",
        "event: run.started",
        "event: run.completed",
        'data: {"status":"completed"}',
      ]);
    }
  });

  it("uses Last-Event-ID as the cursor when ?after= is absent or blank, and lets ?after= win", async () => {
    const { user, runId } = await completedRun("sse-last-event-id");
    signIn(user);
    const typesFor = async (query: string, lastEventId?: string) => {
      const request = new NextRequest(
        `http://localhost:3000/api/assistant/runs/${runId}/events${query}`,
        lastEventId === undefined
          ? undefined
          : { headers: { "last-event-id": lastEventId } },
      );
      const response = await streamRunEvents(request, {
        params: Promise.resolve({ runId }),
      });
      return (await frames(response)).map((f) => f.split("\n")[1] ?? f);
    };
    // Header alone resumes after sequence 0.
    expect(await typesFor("", "0")).toEqual([
      "event: run.started",
      "event: run.completed",
      'data: {"status":"completed"}',
    ]);
    // Blank ?after= defers to the header.
    expect(await typesFor("?after=", "1")).toEqual([
      "event: run.completed",
      'data: {"status":"completed"}',
    ]);
    // Explicit ?after= wins over the header.
    expect(await typesFor("?after=-1", "1")).toEqual([
      "event: run.queued",
      "event: run.started",
      "event: run.completed",
      'data: {"status":"completed"}',
    ]);
    // Garbage header replays from the start.
    expect(await typesFor("", "abc")).toEqual([
      "event: run.queued",
      "event: run.started",
      "event: run.completed",
      'data: {"status":"completed"}',
    ]);
  });

  it("resumes after an explicit cursor without replaying earlier events", async () => {
    const { user, runId } = await completedRun("sse-resume");
    signIn(user);
    expect(await frames(await callStreamRoute(runId, "?after=1"))).toEqual([
      expect.stringContaining("id: 2\nevent: run.completed"),
      'event: end\ndata: {"status":"completed"}',
    ]);
    expect(await frames(await callStreamRoute(runId, "?after=2"))).toEqual([
      'event: end\ndata: {"status":"completed"}',
    ]);
  });

  it("returns 401 without a session and never touches the run", async () => {
    const { runId } = await completedRun("sse-anon");
    const response = await callStreamRoute(runId);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream",
    );
    expect(await response.text()).toBe("unauthorized");
  });

  it("blocks a user who must change their password, but streams normally once they don't", async () => {
    const { user, runId } = await completedRun("sse-forced-change");

    signIn(user, { mustChangePassword: true });
    const blocked = await callStreamRoute(runId);
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("content-type")).not.toContain(
      "text/event-stream",
    );
    expect(await blocked.text()).toBe("password change required");

    signIn(user, { mustChangePassword: false });
    const allowed = await callStreamRoute(runId);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
  });

  it("answers malformed, unknown, and foreign run ids with one identical 404", async () => {
    const { runId } = await completedRun("sse-owner");
    const stranger = await makeUser("User", "sse-stranger");
    signIn(stranger);
    const responses = await Promise.all(
      ["not-a-uuid", MISSING_ID, runId].map((id) => callStreamRoute(id)),
    );
    const shapes = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await response.text(),
        contentType: response.headers.get("content-type"),
      })),
    );
    expect(shapes[0]).toMatchObject({ status: 404, body: "not found" });
    // Byte-identical, so a caller cannot tell malformed from unknown from foreign.
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  describe("listCitations", () => {
    const TABLE_SHA = "0123456789abcdef0123456789abcdef01234567";
    const SEARCH_TABLE_ID = "55555555-5555-4555-8555-555555555555";

    /** Better Auth stores project membership on the organization member row. */
    async function revokeMembership(projectId: string, userId: string) {
      const db = getPrisma();
      const project = await db.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { organizationId: true },
      });
      await db.member.delete({
        where: {
          organizationId_userId: {
            organizationId: project.organizationId,
            userId,
          },
        },
      });
    }

    async function conversationWithCitations(suffix: string) {
      const db = getPrisma();
      const user = await makeUser("User", suffix);
      const visible = await makeProject(`Cited ${suffix}`);
      const hidden = await makeProject(`Hidden ${suffix}`);
      await addMembership(visible.id, user.id, "Editor");
      await addMembership(hidden.id, user.id, "Editor");
      const caller = callerFor(user);
      const conversation = await caller.assistant.createConversation({});
      const document = await createDocument(
        db,
        {
          projectId: visible.id,
          folderPath: [],
          title: "Runbook",
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody(
              "# Deploy\n\nText.\n\n## Rollback\n\nSteps.\n",
            ),
          },
        },
        {
          ...securityContextFor(user),
          name: `User ${suffix}`,
          email: user.email,
        },
      );
      const { run } = await caller.assistant.sendMessage({
        conversationId: conversation.id,
        text: "cite things",
        scope: { kind: "projects", projectIds: [visible.id, hidden.id] },
      });
      const leased = await leaseRunAttempt(db, {
        runId: run.id,
        workerId: "cite",
      });
      await completeRun(db, {
        runId: run.id,
        attemptId: leased!.attempt.id,
        text: "See the runbook.",
        citations: [
          {
            kind: "document",
            projectId: visible.id,
            resourceId: document.id,
            commitSha: document.headCommitSha,
            label: "Runbook › Deploy › Rollback",
            excerpt: "Steps.",
            locator: {
              kind: "document",
              projectId: visible.id,
              documentId: document.id,
              commitSha: document.headCommitSha,
              headingPath: ["Deploy", "Rollback"],
              excerpt: "Steps.",
            },
          },
          {
            kind: "table",
            projectId: hidden.id,
            resourceId: MISSING_ID,
            commitSha: TABLE_SHA,
            label: "Secret table",
            excerpt: "Secret excerpt",
            locator: {
              kind: "table",
              projectId: hidden.id,
              tableId: MISSING_ID,
              commitSha: TABLE_SHA,
              rowIds: ["secret-row"],
              columnIds: ["secret-column"],
            },
          },
          {
            kind: "search",
            projectId: visible.id,
            resourceId: document.id,
            commitSha: document.headCommitSha,
            label: "Runbook hit",
            excerpt: "Steps.",
            locator: {
              kind: "search",
              projectId: visible.id,
              resourceType: "document",
              resourceId: document.id,
              commitSha: document.headCommitSha,
              excerpt: "Steps.",
              score: 0.8,
            },
          },
          {
            kind: "search",
            projectId: visible.id,
            resourceId: SEARCH_TABLE_ID,
            commitSha: TABLE_SHA,
            label: "Roster hit",
            excerpt: null,
            locator: {
              kind: "search",
              projectId: visible.id,
              resourceType: "table",
              resourceId: SEARCH_TABLE_ID,
              commitSha: TABLE_SHA,
              excerpt: null,
              score: 0.4,
            },
          },
        ],
        proposalIds: [],
      });
      return { db, user, caller, conversation, visible, hidden, document };
    }

    it("returns cards with a navigation anchor and hides sources the user lost access to", async () => {
      const { db, user, caller, conversation, visible, hidden, document } =
        await conversationWithCitations("list");
      const before = await caller.assistant.listCitations({
        conversationId: conversation.id,
      });
      expect(before).toHaveLength(4);
      const documentCard = before.find((card) => card.kind === "document")!;
      const tableCard = before.find((card) => card.kind === "table")!;
      const documentHit = before.find(
        (card) => card.kind === "search" && card.resourceId === document.id,
      )!;
      const tableHit = before.find(
        (card) => card.kind === "search" && card.resourceId === SEARCH_TABLE_ID,
      )!;

      expect(documentCard).toMatchObject({
        kind: "document",
        access: "ok",
        resourceId: document.id,
        headingPath: ["Runbook", "Deploy", "Rollback"],
        navigationAnchor: "section-deploy--rollback",
      });
      expect(documentCard.messageId).toEqual(expect.any(String));
      expect(tableCard).toMatchObject({ kind: "table", access: "unavailable" });
      expect(tableCard).not.toHaveProperty("excerpt");
      expect(tableCard).not.toHaveProperty("rowIds");
      expect(tableHit.access).toBe("unavailable");

      // A document-search hit can carry an anchor in principle, a table hit cannot.
      expect(documentHit.navigationAnchor).toBeNull();
      expect(tableHit).not.toHaveProperty("navigationAnchor");
      expect(tableHit.navigationAnchor).toBeUndefined();

      await db.assistantCitation.updateMany({
        where: { kind: "document" },
        data: {
          locator: {
            kind: "document",
            projectId: visible.id,
            documentId: document.id,
            commitSha: document.headCommitSha,
            headingPath: ["Runbook", "Deploy", "Rollback"],
            excerpt: "Steps.",
          },
        },
      });
      await revokeMembership(hidden.id, user.id);
      const after = await caller.assistant.listCitations({
        conversationId: conversation.id,
      });
      const revoked = after.find((card) => card.id === tableCard.id)!;
      expect(revoked).toEqual({
        id: tableCard.id,
        messageId: tableCard.messageId,
        kind: "table",
        projectId: hidden.id,
        resourceId: MISSING_ID,
        commitSha: TABLE_SHA,
        access: "unavailable",
      });
      const serialized = JSON.stringify(revoked);
      for (const leak of [
        "Secret table",
        "Secret excerpt",
        "secret-row",
        "secret-column",
      ]) {
        expect(serialized).not.toContain(leak);
      }
      // The still-visible project keeps its cards.
      expect(after.find((card) => card.id === documentCard.id)).toMatchObject({
        access: "ok",
        navigationAnchor: "section-deploy--rollback",
      });
    });

    it("marks mismatched revisions and deleted sources unavailable", async () => {
      const { db, caller, conversation, visible, document } =
        await conversationWithCitations("stale");
      await db.assistantCitation.updateMany({
        where: { kind: "document" },
        data: {
          locator: {
            kind: "document",
            projectId: visible.id,
            documentId: document.id,
            commitSha: "deadbee",
            headingPath: ["Deploy", "Rollback"],
            excerpt: "Steps.",
          },
        },
      });
      const cards = await caller.assistant.listCitations({
        conversationId: conversation.id,
      });
      expect(cards.find((card) => card.kind === "document")).toMatchObject({
        access: "unavailable",
      });
      expect(cards.find((card) => card.kind === "document")).not.toHaveProperty(
        "navigationAnchor",
      );

      await db.document.delete({ where: { id: document.id } });
      const afterDelete = await caller.assistant.listCitations({
        conversationId: conversation.id,
      });
      expect(
        afterDelete.find((card) => card.kind === "document"),
      ).toMatchObject({ access: "unavailable" });
    });

    it("derives stored citation cards from Git instead of retaining supplied private text", async () => {
      const { db, caller, conversation } =
        await conversationWithCitations("legacy-provenance");
      await db.assistantCitation.updateMany({
        where: { kind: "document" },
        data: {
          label: "forged private marker",
          excerpt: "forged private marker",
        },
      });
      const sourceReads = vi.spyOn(db.document, "findFirst");
      const cards = await caller.assistant.listCitations({
        conversationId: conversation.id,
      });
      expect(sourceReads).toHaveBeenCalledTimes(1);
      sourceReads.mockRestore();
      const card = cards.find((item) => item.kind === "document");
      expect(card).toMatchObject({
        access: "ok",
        label: "Runbook › Deploy › Rollback",
      });
      expect(card?.excerpt).toContain("Steps.");
      expect(JSON.stringify(cards)).not.toContain("forged private marker");
    });

    /** One document citation, so anchor projection can be probed in isolation. */
    async function singleDocumentCitation(
      suffix: string,
      document: { title: string; markdown: string; headingPath: string[] },
    ) {
      const db = getPrisma();
      const user = await makeUser("User", suffix);
      const project = await makeProject(`Anchor ${suffix}`);
      await addMembership(project.id, user.id, "Editor");
      const actor = {
        ...securityContextFor(user),
        name: `User ${suffix}`,
        email: user.email,
      };
      const caller = callerFor(user);
      const conversation = await caller.assistant.createConversation({});
      const created = await createDocument(
        db,
        {
          projectId: project.id,
          folderPath: [],
          title: document.title,
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody(document.markdown),
          },
        },
        actor,
      );
      const { run } = await caller.assistant.sendMessage({
        conversationId: conversation.id,
        text: "cite it",
        scope: { kind: "project", projectId: project.id },
      });
      const leased = await leaseRunAttempt(db, {
        runId: run.id,
        workerId: "anchor",
      });
      await completeRun(db, {
        runId: run.id,
        attemptId: leased!.attempt.id,
        text: "cited",
        citations: [
          {
            kind: "document",
            projectId: project.id,
            resourceId: created.id,
            commitSha: created.headCommitSha,
            label: document.title,
            excerpt: null,
            locator: {
              kind: "document",
              projectId: project.id,
              documentId: created.id,
              commitSha: created.headCommitSha,
              headingPath: document.headingPath,
              excerpt: null,
            },
          },
        ],
        proposalIds: [],
      });
      const anchor = async () =>
        (
          await caller.assistant.listCitations({
            conversationId: conversation.id,
          })
        )[0]!.navigationAnchor;
      return { db, actor, project, created, anchor };
    }

    it("never resolves a title-only path to a same-named section heading", async () => {
      // The chunker gives this document's preamble the path ["Deploy"] (its
      // title) with no anchor; `## Deploy` is a different chunk entirely.
      // Matching them would land the reader on a section that was not cited.
      const { anchor } = await singleDocumentCitation("preamble", {
        title: "Deploy",
        markdown: "Preamble.\n\n## Deploy\n\nSteps.\n",
        headingPath: ["Deploy"],
      });
      expect(await anchor()).toBeNull();
    });

    it("matches against the title stored in the cited revision, so a rename still resolves", async () => {
      const { db, actor, project, created, anchor } =
        await singleDocumentCitation("renamed", {
          title: "Runbook",
          markdown: "## Rollback\n\nSteps.\n",
          headingPath: ["Runbook", "Rollback"],
        });
      expect(await anchor()).toBe("section-rollback");

      await saveDocument(
        db,
        {
          projectId: project.id,
          documentId: created.id,
          baseCommitSha: created.headCommitSha,
          title: "Handbook",
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("## Rollback\n\nSteps.\n"),
          },
          changeSummary: "rename",
        },
        actor,
      );
      // The citation's own revision still carries the title the chunker indexed.
      expect(await anchor()).toBe("section-rollback");
    });

    it("is NOT_FOUND for another user's conversation and for an unknown one", async () => {
      const { conversation } = await conversationWithCitations("owner");
      const stranger = await makeUser("User", "stranger");
      for (const conversationId of [conversation.id, MISSING_ID]) {
        await expect(
          callerFor(stranger).assistant.listCitations({ conversationId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    });
  });
});

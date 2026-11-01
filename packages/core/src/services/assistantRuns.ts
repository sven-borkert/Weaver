import { assertLiveAssistantPrincipal } from "../assistant/principal";
import {
  externalTransaction,
  type ExternalDiagnostics,
} from "./externalMcp/diagnostics";
import {
  externalToolSnapshotsSchema,
  type ExternalToolSnapshot,
} from "../externalMcp/schema";
import type { ExternalSource } from "../externalMcp/types";
import { hasExternalDispatch } from "./externalMcp/calls";
import { invalidateExternalApprovals } from "./externalMcp/approvals";
import { settleExternalRun } from "./externalMcp/retention";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  deserializeSecurityContext,
  serializeSecurityContext,
} from "../assistant/actor";
import type { ValidatedCitation } from "../assistant/citations";
import {
  assistantEventSchema,
  boundedJson,
  MAX_EVENT_PAYLOAD_CHARS,
  type AssistantEvent,
} from "../assistant/events";
import { replayStepsByRun, type ReplayEventRow } from "../assistant/replay";
import type { AssistantRouteSnapshot } from "../assistant/route";
import {
  resolveScopeSnapshot,
  scopeSnapshotSchema,
  type ScopeRequest,
  type ScopeSnapshot,
} from "../assistant/scope";
import { CoreError } from "../errors";
import { parseKnowledgeConfig } from "../knowledge/config";
import { requestKnowledgeJob } from "../jobs/queue";
import { mayAccessProject, type SecurityContext } from "../security/context";
import {
  ACTIVE_RUN_STATUSES,
  assertAssistantUse,
  requireOwnedConversation,
  toMessageView,
  type MessageView,
} from "./assistantConversations";
import { expireProposals } from "./assistantProposals";

export const MAX_USER_MESSAGE_CHARS = 32_000;
export const ASSISTANT_RUN_MAX_ATTEMPTS = 3;

export type RunView = {
  id: string;
  conversationId: string;
  status:
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  assistantMessageId: string | null;
};

const RUN_VIEW_SELECT = {
  id: true,
  conversationId: true,
  status: true,
  errorCode: true,
  errorMessage: true,
  attemptCount: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  assistantMessageId: true,
} satisfies Prisma.AssistantRunSelect;

/** Appends one event inside the caller's transaction; sequence comes from the run's monotonic counter. */
export async function appendRunEventTx(
  tx: Prisma.TransactionClient,
  input: { runId: string; attemptId: string | null; event: AssistantEvent },
): Promise<{ sequence: number; runStatus: RunView["status"] }> {
  const event = assistantEventSchema.parse(input.event);
  const run = await tx.assistantRun.update({
    where: { id: input.runId },
    data: { nextSequence: { increment: 1 } },
    select: { nextSequence: true, status: true },
  });
  const sequence = run.nextSequence - 1;
  const { type, ...payload } = event;
  await tx.assistantRunEvent.create({
    data: {
      runId: input.runId,
      attemptId: input.attemptId,
      sequence,
      type,
      payload: boundedJson(
        payload,
        MAX_EVENT_PAYLOAD_CHARS,
      ) as Prisma.InputJsonValue,
    },
  });
  return { sequence, runStatus: run.status };
}

export async function dispatchAssistantRun(
  db: PrismaClient,
  runId: string,
): Promise<string | null> {
  const jobId = await requestKnowledgeJob("assistant.run", { runId });
  if (jobId)
    await db.assistantRun.updateMany({
      where: { id: runId, jobId: null },
      data: { jobId },
    });
  return jobId;
}

export async function submitUserMessage(
  db: PrismaClient,
  actor: SecurityContext,
  input: {
    conversationId: string;
    text: string;
    scope: ScopeRequest;
  },
): Promise<{ userMessage: MessageView; run: RunView }> {
  assertAssistantUse(actor);
  const text = input.text.trim();
  if (text.length === 0)
    throw new CoreError("BAD_REQUEST", "message is empty", { field: "text" });
  if (text.length > MAX_USER_MESSAGE_CHARS)
    throw new CoreError("BAD_REQUEST", "message too long", { field: "text" });
  if (!parseKnowledgeConfig(process.env).jobsEnabled) {
    throw new CoreError("PRECONDITION_FAILED", "background jobs are disabled");
  }
  const conversation = await requireOwnedConversation(
    db,
    actor,
    input.conversationId,
  );
  if (
    conversation.runs.some((run) =>
      (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
    )
  )
    throw new CoreError("CONFLICT", "a run is already active");
  const scopeSnapshot = await resolveScopeSnapshot(db, actor, input.scope);

  const created = await db.$transaction(async (tx) => {
    // Lock the conversation row so a concurrent submit can't slip an active
    // run past the pre-check above before this one commits (spec §17 BUSY).
    await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "AssistantConversation" WHERE "id" = ${conversation.id}::uuid FOR UPDATE`;
    const stillActive = await tx.assistantRun.findFirst({
      where: {
        conversationId: conversation.id,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true },
    });
    if (stillActive) throw new CoreError("CONFLICT", "a run is already active");

    const last = await tx.assistantMessage.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const message = await tx.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        position: (last?.position ?? -1) + 1,
        role: "user",
        status: "pending",
        content: { text },
        scopeSnapshot,
      },
    });
    const run = await tx.assistantRun.create({
      data: {
        conversationId: conversation.id,
        userMessageId: message.id,
        scopeSnapshot,
        actorSnapshot: serializeSecurityContext(actor),
        maxAttempts: ASSISTANT_RUN_MAX_ATTEMPTS,
      },
      select: RUN_VIEW_SELECT,
    });
    await appendRunEventTx(tx, {
      runId: run.id,
      attemptId: null,
      event: { type: "run.queued" },
    });
    await tx.assistantConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: message.createdAt,
        ...(conversation.title === "New conversation" && last === null
          ? { title: text.slice(0, 80).replace(/\s+/g, " ") }
          : {}),
      },
    });
    return { message, run };
  });
  // Commit/publish gap is closed by reconcileAssistantRuns (assistant.reconcile).
  await dispatchAssistantRun(db, created.run.id);
  return {
    userMessage: toMessageView({
      ...created.message,
      triggeredRun: { id: created.run.id },
    }),
    run: created.run,
  };
}

export async function getRun(
  db: PrismaClient,
  actor: SecurityContext,
  runId: string,
): Promise<RunView> {
  assertAssistantUse(actor);
  const run = await db.assistantRun.findFirst({
    where: { id: runId, conversation: { ownerId: actor.userId } },
    select: RUN_VIEW_SELECT,
  });
  if (!run) throw new CoreError("NOT_FOUND");
  return run;
}

// ---- Worker half: leases, attempts, streaming, completion, reconciliation ----

export const ASSISTANT_LEASE_MS = 30_000;
export { ASSISTANT_RUN_TIMEOUT_MS } from "../assistant/limits";
export const QUEUED_REPUBLISH_AFTER_MS = 30_000;
const EVENT_PAGE_LIMIT = 500;
export const MAX_HISTORY_MESSAGES = 100;

export type LeasedRun = {
  run: {
    id: string;
    conversationId: string;
    scopeSnapshot: ScopeSnapshot;
    maxAttempts: number;
    attemptCount: number;
    externalToolSnapshots: ExternalToolSnapshot[];
  };
  attempt: { id: string; number: number };
  actor: SecurityContext;
  user: { id: string; name: string | null; email: string };
  history: MessageView[];
};

/** Error columns are VARCHAR(300); citation excerpts VARCHAR(500). */
function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The one predicate that identifies an attempt still holding its lease. */
function leasedAttemptWhere(input: {
  runId: string;
  attemptId: string;
}): Prisma.AssistantRunAttemptWhereInput {
  return { id: input.attemptId, runId: input.runId, status: "running" };
}

function isRunActive(status: RunView["status"]): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

// Lock the attempt before checking ownership so abandonment cannot race the check.
async function holdsLease(
  tx: Prisma.TransactionClient,
  input: { runId: string; attemptId: string },
): Promise<boolean> {
  await tx.$queryRaw`SELECT "id" FROM "AssistantRunAttempt" WHERE "id" = ${input.attemptId}::uuid FOR UPDATE`;
  const leased = await tx.assistantRunAttempt.count({
    where: leasedAttemptWhere(input),
  });
  return leased === 1;
}

async function rejectRunProposals(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> {
  await tx.assistantProposal.updateMany({
    where: { runId, status: "pending" },
    data: {
      status: "rejected",
      resolvedAt: new Date(),
      resolution: { reason: "Run attempt did not complete" },
    },
  });
}

async function lockRun(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "AssistantRun" WHERE "id" = ${runId}::uuid FOR UPDATE`;
}

async function hasAdmittedContentChange(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<boolean> {
  return (
    (await tx.assistantProposal.count({
      where: { runId, status: { in: ["accepting", "accepted"] } },
    })) > 0
  );
}

const CONTENT_CHANGE_FAILURE =
  "A proposed change was approved; automatic retry is disabled. Review its proposal for the result or recover an interrupted acceptance.";

// Terminal transitions always lock the attempt before the run.
async function closeLeasedAttempt(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    attemptId: string;
    status: "succeeded" | "failed" | "cancelled";
    failureCode?: string;
    failureSummary?: string;
  },
  diagnostics: ExternalDiagnostics,
): Promise<boolean> {
  const closed = await tx.assistantRunAttempt.updateMany({
    where: leasedAttemptWhere(input),
    data: {
      status: input.status,
      endedAt: new Date(),
      ...(input.failureCode === undefined
        ? {}
        : { failureCode: input.failureCode }),
      ...(input.failureSummary === undefined
        ? {}
        : { failureSummary: input.failureSummary }),
    },
  });
  if (closed.count === 1) {
    await lockRun(tx, input.runId);
    await settleExternalRun(
      tx,
      input.runId,
      input.status === "cancelled" ? "run_cancelled" : "run_finished",
      new Date(),
      diagnostics,
    );
  }
  return closed.count === 1;
}

export async function leaseRunAttempt(
  db: PrismaClient,
  input: { runId: string; workerId: string; leaseMs?: number },
): Promise<LeasedRun | null> {
  const leaseMs = input.leaseMs ?? ASSISTANT_LEASE_MS;
  return db.$transaction(async (tx) => {
    // Only one transaction can move the run out of `queued`, so only one
    // worker ever creates an attempt for it.
    const claimed = await tx.assistantRun.updateMany({
      where: { id: input.runId, status: "queued" },
      data: {
        status: "running",
        startedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;
    const run = await tx.assistantRun.findUniqueOrThrow({
      where: { id: input.runId },
      include: {
        conversation: {
          include: {
            owner: {
              select: { id: true, name: true, email: true, banned: true },
            },
          },
        },
      },
    });
    let authorized = true;
    try {
      await assertLiveAssistantPrincipal(
        tx,
        deserializeSecurityContext(run.actorSnapshot),
      );
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      authorized = false;
    }
    if (!authorized) {
      await tx.assistantRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          errorCode: "FORBIDDEN",
          errorMessage:
            "The assistant session is no longer authorized. Sign in again.",
          finishedAt: new Date(),
        },
      });
      await tx.assistantMessage.update({
        where: { id: run.userMessageId },
        data: { status: "failed" },
      });
      await appendRunEventTx(tx, {
        runId: run.id,
        attemptId: null,
        event: {
          type: "run.failed",
          code: "FORBIDDEN",
          message:
            "The assistant session is no longer authorized. Sign in again.",
          retrying: false,
        },
      });
      return null;
    }
    const attempt = await tx.assistantRunAttempt.create({
      data: {
        runId: run.id,
        number: run.attemptCount,
        workerId: input.workerId.slice(0, 200),
        leaseExpiresAt: new Date(Date.now() + leaseMs),
      },
      select: { id: true, number: true },
    });
    await appendRunEventTx(tx, {
      runId: run.id,
      attemptId: attempt.id,
      event: { type: "run.started", attempt: attempt.number },
    });
    const messages = await tx.assistantMessage.findMany({
      where: {
        conversationId: run.conversationId,
        status: { in: ["complete", "pending"] },
      },
      orderBy: { position: "desc" },
      take: MAX_HISTORY_MESSAGES,
      include: {
        triggeredRun: { select: { id: true } },
        producedBy: { select: { id: true } },
      },
    });
    const producedRunIds = messages.flatMap((message) =>
      message.role === "assistant" && message.producedBy
        ? [message.producedBy.id]
        : [],
    );
    // Text deltas are read as lengths only; the message row already holds the text.
    const replaySteps = replayStepsByRun(
      producedRunIds.length
        ? await tx.$queryRaw<ReplayEventRow[]>`
            SELECT "runId", "type",
                   CASE WHEN "type" = 'text.delta' THEN NULL ELSE "payload" END AS "payload",
                   CASE WHEN "type" = 'text.delta'
                        THEN char_length("payload"->>'text') END AS "textLength"
            FROM "AssistantRunEvent"
            WHERE "runId" = ANY(${producedRunIds}::uuid[])
              AND "type" IN ('run.started', 'text.delta', 'tool.call',
                             'tool.result', 'external.call.status')
            ORDER BY "runId", "sequence"`
        : [],
    );
    return {
      run: {
        id: run.id,
        conversationId: run.conversationId,
        scopeSnapshot: scopeSnapshotSchema.parse(run.scopeSnapshot),
        externalToolSnapshots: externalToolSnapshotsSchema
          .catch([])
          .parse(
            (
              messages.find((m) => m.id === run.userMessageId)?.content as
                { externalToolSnapshots?: unknown } | undefined
            )?.externalToolSnapshots,
          ),
        maxAttempts: run.maxAttempts,
        attemptCount: run.attemptCount,
      },
      attempt,
      actor: deserializeSecurityContext(run.actorSnapshot),
      user: {
        id: run.conversation.owner.id,
        name: run.conversation.owner.name,
        email: run.conversation.owner.email,
      },
      history: messages.reverse().map((message) => {
        const steps =
          message.role === "assistant" && message.producedBy
            ? replaySteps.get(message.producedBy.id)
            : undefined;
        return steps
          ? { ...toMessageView(message), replaySteps: steps }
          : toMessageView(message);
      }),
    };
  });
}

/** Extends the lease and reports the run status so the worker sees cancellation mid-stream. */
export async function heartbeatAttempt(
  db: PrismaClient,
  input: { attemptId: string; leaseMs?: number },
): Promise<RunView["status"] | null> {
  const leaseMs = input.leaseMs ?? ASSISTANT_LEASE_MS;
  const updated = await db.assistantRunAttempt.updateMany({
    where: { id: input.attemptId, status: "running" },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  if (updated.count !== 1) return null;
  const attempt = await db.assistantRunAttempt.findUniqueOrThrow({
    where: { id: input.attemptId },
    select: { run: { select: { status: true, actorSnapshot: true } } },
  });
  await assertLiveAssistantPrincipal(
    db,
    deserializeSecurityContext(attempt.run.actorSnapshot),
  );
  return attempt.run.status;
}

/**
 * Streaming append from a worker. Returns `null` — dropping the event — when
 * the run is already terminal or the named attempt no longer holds its lease,
 * so a worker the reconciler abandoned mid-stream cannot interleave deltas
 * with the live attempt or append past the terminal event. The `null` is also
 * the zombie's own signal to stop: `appendRunEventTx`'s `runStatus` reads
 * `running` again once a later attempt is live.
 */
export async function appendRunEvent(
  db: PrismaClient,
  input: { runId: string; attemptId: string | null; event: AssistantEvent },
): Promise<{ sequence: number; runStatus: RunView["status"] } | null> {
  return db.$transaction(async (tx) => {
    // Attempt first, then run — the order closeLeasedAttempt establishes, so a
    // zombie append and a concurrent completeRun cannot deadlock.
    if (
      input.attemptId !== null &&
      !(await holdsLease(tx, {
        runId: input.runId,
        attemptId: input.attemptId,
      }))
    )
      return null;
    // Lock the run before appendRunEventTx's unconditional nextSequence
    // increment, so a terminal transaction cannot slip in between.
    const [run] = await tx.$queryRaw<Array<{ status: RunView["status"] }>>`
      SELECT "status"::text AS "status" FROM "AssistantRun" WHERE "id" = ${input.runId}::uuid FOR UPDATE`;
    if (!run || !isRunActive(run.status)) return null;
    return appendRunEventTx(tx, input);
  });
}

/**
 * Records the route the run was dispatched on. The signature carries no
 * attemptId, so this is guarded on run status alone: a worker that finished or
 * was abandoned cannot overwrite a terminal run's snapshot.
 */
export async function setRunRouteSnapshot(
  db: PrismaClient,
  runId: string,
  snapshot: AssistantRouteSnapshot,
): Promise<void> {
  await db.assistantRun.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { routeSnapshot: snapshot },
  });
}

export async function completeRun(
  db: PrismaClient,
  input: {
    runId: string;
    attemptId: string;
    text: string;
    citations: ValidatedCitation[];
    proposalIds: string[];
    externalSources?: ExternalSource[];
    hasExternalContext?: boolean;
    contextProjectIds?: string[] | null;
    usageId?: string;
  },
): Promise<
  | { status: "completed"; messageId: string }
  | { status: "cancelled"; messageId: null }
> {
  return externalTransaction(db, async (tx, _diagnostics) => {
    if (!(await holdsLease(tx, input)))
      throw new CoreError("CONFLICT", "attempt no longer holds the lease");
    await lockRun(tx, input.runId);
    const run = await tx.assistantRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { conversationId: true, userMessageId: true, status: true },
    });
    if (run.status === "cancelling") {
      await rejectRunProposals(tx, input.runId);
      await closeLeasedAttempt(
        tx,
        { ...input, status: "cancelled" },
        _diagnostics,
      );
      await tx.assistantRun.update({
        where: { id: input.runId },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      await tx.assistantMessage.update({
        where: { id: run.userMessageId },
        data: { status: "cancelled" },
      });
      await appendRunEventTx(tx, {
        runId: input.runId,
        attemptId: input.attemptId,
        event: { type: "run.cancelled" },
      });
      return { status: "cancelled", messageId: null };
    }
    if (run.status !== "running")
      throw new CoreError("CONFLICT", `run is ${run.status}`);
    if (
      !(await closeLeasedAttempt(
        tx,
        {
          runId: input.runId,
          attemptId: input.attemptId,
          status: "succeeded",
        },
        _diagnostics,
      ))
    )
      throw new CoreError("CONFLICT", "attempt no longer holds the lease");
    const last = await tx.assistantMessage.findFirst({
      where: { conversationId: run.conversationId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const proposalIds = (
      await tx.assistantProposal.findMany({
        where: {
          runId: input.runId,
          status: { in: ["pending", "accepting", "accepted"] },
        },
        select: { id: true },
      })
    ).map((proposal) => proposal.id);
    const message = await tx.assistantMessage.create({
      data: {
        conversationId: run.conversationId,
        position: (last?.position ?? -1) + 1,
        role: "assistant",
        status: "complete",
        content: {
          text: input.text,
          externalSources: input.externalSources ?? [],
          hasExternalContext: input.hasExternalContext ?? false,
          contextProjectIds: input.contextProjectIds ?? null,
          citationIds: [],
          proposalIds,
        },
      },
    });
    const citationIds: string[] = [];
    for (const citation of input.citations) {
      const label = truncate(citation.label);
      const excerpt = citation.excerpt ? truncate(citation.excerpt, 500) : null;
      const row = await tx.assistantCitation.create({
        data: {
          runId: input.runId,
          messageId: message.id,
          kind: citation.kind,
          projectId: citation.projectId,
          resourceId: citation.resourceId,
          commitSha: citation.commitSha,
          locator: citation.locator,
          label,
          excerpt,
        },
        select: { id: true },
      });
      citationIds.push(row.id);
      await appendRunEventTx(tx, {
        runId: input.runId,
        attemptId: input.attemptId,
        event: {
          type: "citation",
          citation: {
            id: row.id,
            kind: citation.kind,
            projectId: citation.projectId,
            resourceId: citation.resourceId,
            commitSha: citation.commitSha,
            label,
            excerpt,
          },
        },
      });
    }
    await tx.assistantMessage.update({
      where: { id: message.id },
      data: {
        content: {
          text: input.text,
          externalSources: input.externalSources ?? [],
          hasExternalContext: input.hasExternalContext ?? false,
          contextProjectIds: input.contextProjectIds ?? null,
          citationIds,
          proposalIds,
        },
      },
    });
    await tx.assistantMessage.update({
      where: { id: run.userMessageId },
      data: { status: "complete" },
    });
    await tx.assistantRun.update({
      where: { id: input.runId },
      data: {
        status: "completed",
        assistantMessageId: message.id,
        finishedAt: new Date(),
      },
    });
    if (input.usageId)
      await tx.aiUsage.updateMany({
        where: { id: input.usageId, runId: input.runId },
        data: { outcome: "success" },
      });
    await tx.assistantConversation.update({
      where: { id: run.conversationId },
      data: { lastMessageAt: message.createdAt },
    });
    await appendRunEventTx(tx, {
      runId: input.runId,
      attemptId: input.attemptId,
      event: { type: "run.completed", messageId: message.id },
    });
    return { status: "completed", messageId: message.id };
  });
}

/**
 * Records the attempt failure and decides retryability (spec §17): permission,
 * scope, validation, and conflict failures never retry; the caller passes
 * `retryable` for provider rate limits and transient faults.
 */
type RunAttemptFailureInput = {
  runId: string;
  attemptId: string;
  code: string;
  message: string;
  retryable: boolean;
};

type RunAttemptFailureOutcome = {
  retrying: boolean;
  transitioned: boolean;
  cancelled?: boolean;
};

/** Commits the failure transition without performing the fallible retry dispatch. */
export async function persistRunAttemptFailure(
  db: PrismaClient,
  input: RunAttemptFailureInput,
): Promise<RunAttemptFailureOutcome> {
  const summary = truncate(input.message);
  const code = input.code.slice(0, 40);
  const outcome = await externalTransaction(db, async (tx, _diagnostics) => {
    if (
      !(await closeLeasedAttempt(
        tx,
        {
          runId: input.runId,
          attemptId: input.attemptId,
          status: "failed",
          failureCode: code,
          failureSummary: summary,
        },
        _diagnostics,
      ))
    ) {
      // The reconciler already abandoned this attempt and decided the outcome.
      return { retrying: false, transitioned: false };
    }
    await lockRun(tx, input.runId);
    const run = await tx.assistantRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: {
        status: true,
        attemptCount: true,
        maxAttempts: true,
        userMessageId: true,
      },
    });
    if (run.status === "cancelling") {
      await tx.assistantRunAttempt.update({
        where: { id: input.attemptId },
        data: { status: "cancelled", failureCode: null, failureSummary: null },
      });
    }
    await rejectRunProposals(tx, input.runId);
    const dispatched = await hasExternalDispatch(tx, input.attemptId);
    const contentChanged = await hasAdmittedContentChange(tx, input.runId);
    const failureCode = dispatched
      ? "EXTERNAL_CALL_DISPATCHED"
      : contentChanged
        ? "CONTENT_CHANGE_APPLIED"
        : code;
    const failureSummary = dispatched
      ? "An external call was dispatched; automatic retry is disabled. Check its recorded outcome."
      : contentChanged
        ? CONTENT_CHANGE_FAILURE
        : summary;
    if ((dispatched || contentChanged) && run.status !== "cancelling")
      await tx.assistantRunAttempt.update({
        where: { id: input.attemptId },
        data: { failureCode, failureSummary },
      });
    const retry =
      !dispatched &&
      !contentChanged &&
      input.retryable &&
      run.status === "running" &&
      run.attemptCount < run.maxAttempts;
    if (retry) {
      await tx.assistantRun.update({
        where: { id: input.runId },
        data: { status: "queued", jobId: null, queuedAt: new Date() },
      });
    } else {
      const terminal = run.status === "cancelling" ? "cancelled" : "failed";
      await tx.assistantRun.update({
        where: { id: input.runId },
        data: {
          status: terminal,
          errorCode: failureCode,
          errorMessage: failureSummary,
          finishedAt: new Date(),
        },
      });
      await tx.assistantMessage.update({
        where: { id: run.userMessageId },
        data: { status: terminal },
      });
    }
    await appendRunEventTx(tx, {
      runId: input.runId,
      attemptId: input.attemptId,
      event:
        run.status === "cancelling"
          ? { type: "run.cancelled" }
          : {
              type: "run.failed",
              code: failureCode,
              message: failureSummary,
              retrying: retry,
            },
    });
    return {
      retrying: retry,
      transitioned: true,
      cancelled: run.status === "cancelling",
    };
  });
  return outcome;
}

export async function failRunAttempt(
  db: PrismaClient,
  input: RunAttemptFailureInput,
): Promise<RunAttemptFailureOutcome> {
  const outcome = await persistRunAttemptFailure(db, input);
  if (outcome.retrying) await dispatchAssistantRun(db, input.runId);
  return outcome;
}

/** Terminal cancellation once the worker has observed `cancelling` and stopped. */
export async function cancelRunFromWorker(
  db: PrismaClient,
  input: { runId: string; attemptId: string },
): Promise<{ transitioned: boolean }> {
  return externalTransaction(db, async (tx, _diagnostics) => {
    if (
      !(await closeLeasedAttempt(
        tx,
        {
          runId: input.runId,
          attemptId: input.attemptId,
          status: "cancelled",
        },
        _diagnostics,
      ))
    )
      return { transitioned: false };
    await rejectRunProposals(tx, input.runId);
    const run = await tx.assistantRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { userMessageId: true },
    });
    await tx.assistantRun.update({
      where: { id: input.runId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    await tx.assistantMessage.update({
      where: { id: run.userMessageId },
      data: { status: "cancelled" },
    });
    await appendRunEventTx(tx, {
      runId: input.runId,
      attemptId: input.attemptId,
      event: { type: "run.cancelled" },
    });
    return { transitioned: true };
  });
}

export async function listRunEvents(
  db: PrismaClient,
  actor: SecurityContext,
  input: { runId: string; after: number; limit?: number },
): Promise<{
  events: Array<{
    sequence: number;
    type: string;
    payload: unknown;
    createdAt: Date;
  }>;
  status: RunView["status"];
  nextAfter: number;
}> {
  const run = await getRun(db, actor, input.runId);
  const scope = await db.assistantRun.findUniqueOrThrow({
    where: { id: run.id },
    select: { scopeSnapshot: true },
  });
  const projectIds = [
    ...new Set(scopeSnapshotSchema.parse(scope.scopeSnapshot).projectIds),
  ];
  if (projectIds.some((id) => !mayAccessProject(actor, id)))
    throw new CoreError("NOT_FOUND");
  const accessible = await db.project.count({
    where: {
      id: { in: projectIds },
      deletedAt: null,
      organization: { members: { some: { userId: actor.userId } } },
    },
  });
  if (accessible !== projectIds.length) throw new CoreError("NOT_FOUND");
  const limit = Math.min(
    Math.max(input.limit ?? EVENT_PAGE_LIMIT, 1),
    EVENT_PAGE_LIMIT,
  );
  const events = await db.assistantRunEvent.findMany({
    where: { runId: run.id, sequence: { gt: input.after } },
    orderBy: { sequence: "asc" },
    take: limit,
    select: { sequence: true, type: true, payload: true, createdAt: true },
  });
  return {
    events,
    status: run.status,
    nextAfter: events.at(-1)?.sequence ?? input.after,
  };
}

/** Durable cancel (spec §11.1): queued runs end immediately; running runs are
 * marked `cancelling` and the worker observes it through `heartbeatAttempt`. */
export async function requestRunCancel(
  db: PrismaClient,
  actor: SecurityContext,
  runId: string,
): Promise<RunView> {
  await getRun(db, actor, runId);
  await externalTransaction(db, async (tx, _diagnostics) => {
    await lockRun(tx, runId);
    const run = await tx.assistantRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, userMessageId: true },
    });
    if (!isRunActive(run.status)) return false;
    await invalidateExternalApprovals(
      tx,
      { runId, reason: "run_cancelled" },
      _diagnostics,
    );
    const queued = run.status === "queued";
    await tx.assistantRun.update({
      where: { id: runId },
      data: {
        status: queued ? "cancelled" : "cancelling",
        cancelRequestedAt: new Date(),
        ...(queued ? { finishedAt: new Date() } : {}),
      },
    });
    if (queued) {
      await rejectRunProposals(tx, runId);
      await tx.assistantMessage.update({
        where: { id: run.userMessageId },
        data: { status: "cancelled" },
      });
      await appendRunEventTx(tx, {
        runId,
        attemptId: null,
        event: { type: "run.cancelled" },
      });
    }
    return queued;
  });
  return getRun(db, actor, runId);
}

/**
 * Closes the commit/publish gap and recovers from dead workers (spec §11.1
 * steps 3–4). Driven by the `assistant.reconcile` cron job, which runs far more
 * often than `system.reconcile` because a stranded run blocks its conversation.
 * Concurrency-safe: expired attempts and requeued runs are both claimed with a
 * conditional updateMany, and a duplicate republish is a no-op at lease time.
 */
export async function reconcileAssistantRuns(
  db: PrismaClient,
  now = new Date(),
): Promise<{
  republished: number;
  abandoned: number;
  expiredProposals: number;
}> {
  let abandoned = 0;
  const expired = await db.assistantRunAttempt.findMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    select: { id: true, runId: true },
    take: 200,
  });
  for (const attempt of expired) {
    const closed = await externalTransaction(db, async (tx, _diagnostics) => {
      const claimed = await tx.assistantRunAttempt.updateMany({
        where: {
          id: attempt.id,
          status: "running",
          leaseExpiresAt: { lt: now },
        },
        data: {
          status: "abandoned",
          endedAt: now,
          failureCode: "WORKER_LOST",
          failureSummary: "worker lease expired",
        },
      });
      if (claimed.count !== 1) return false;
      // Re-read after claiming the attempt: the run may have moved on between
      // the scan above and this transaction.
      await lockRun(tx, attempt.runId);
      const run = await tx.assistantRun.findUniqueOrThrow({
        where: { id: attempt.runId },
        select: {
          status: true,
          attemptCount: true,
          maxAttempts: true,
          userMessageId: true,
        },
      });
      await rejectRunProposals(tx, attempt.runId);
      const dispatched = await hasExternalDispatch(tx, attempt.id);
      const contentChanged = await hasAdmittedContentChange(tx, attempt.runId);
      await settleExternalRun(
        tx,
        attempt.runId,
        "lease_expired",
        now,
        _diagnostics,
      );
      const failureCode = dispatched
        ? "EXTERNAL_CALL_DISPATCHED"
        : contentChanged
          ? "CONTENT_CHANGE_APPLIED"
          : "WORKER_LOST";
      const failureSummary = dispatched
        ? "An external call was dispatched; automatic retry is disabled. Check its recorded outcome."
        : contentChanged
          ? CONTENT_CHANGE_FAILURE
          : "worker lease expired";
      if (dispatched || contentChanged)
        await tx.assistantRunAttempt.update({
          where: { id: attempt.id },
          data: { failureCode, failureSummary },
        });
      const canRetry =
        !dispatched &&
        !contentChanged &&
        run.status === "running" &&
        run.attemptCount < run.maxAttempts;
      if (canRetry) {
        await tx.assistantRun.update({
          where: { id: attempt.runId },
          data: { status: "queued", jobId: null, queuedAt: now },
        });
      } else {
        const terminal = run.status === "cancelling" ? "cancelled" : "failed";
        await tx.assistantRun.update({
          where: { id: attempt.runId },
          data: {
            status: terminal,
            errorCode: failureCode,
            errorMessage: failureSummary,
            finishedAt: now,
          },
        });
        await tx.assistantMessage.update({
          where: { id: run.userMessageId },
          data: { status: terminal },
        });
      }
      await appendRunEventTx(tx, {
        runId: attempt.runId,
        attemptId: attempt.id,
        event:
          !canRetry && run.status === "cancelling"
            ? { type: "run.cancelled" }
            : {
                type: "run.failed",
                code: failureCode,
                message: failureSummary,
                retrying: canRetry,
              },
      });
      return true;
    });
    if (closed) abandoned += 1;
  }
  const stale = await db.assistantRun.findMany({
    where: {
      status: "queued",
      OR: [
        { jobId: null },
        {
          queuedAt: { lt: new Date(now.getTime() - QUEUED_REPUBLISH_AFTER_MS) },
        },
      ],
    },
    select: { id: true },
    take: 200,
  });
  let republished = 0;
  for (const run of stale) {
    const claimed = await db.assistantRun.updateMany({
      where: {
        id: run.id,
        status: "queued",
        OR: [
          { jobId: null },
          {
            queuedAt: {
              lt: new Date(now.getTime() - QUEUED_REPUBLISH_AFTER_MS),
            },
          },
        ],
      },
      data: { jobId: null, queuedAt: now },
    });
    if (claimed.count !== 1) continue;
    if (await dispatchAssistantRun(db, run.id)) republished += 1;
  }
  return {
    republished,
    abandoned,
    expiredProposals: await expireProposals(db, now),
  };
}

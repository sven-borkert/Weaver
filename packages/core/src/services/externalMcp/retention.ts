import { appendRunEventTx } from "../assistantRuns";
import { externalCallView } from "./activity";
import {
  externalTransaction,
  recordExternalCall,
  type ExternalDiagnostics,
} from "./diagnostics";
import type { Prisma, PrismaClient, ExternalMcpCall } from "@weaver/db/client";
import {
  CLEARED_APPROVAL_ARGUMENTS,
  invalidateExternalApprovals,
  type ExternalInvalidationReason,
} from "./approvals";
import { lockExternalCall } from "./calls";

const ACTIVE_ASSISTANT = ["queued", "running", "cancelling"] as const;
const ACTIVE_TASK = ["queued", "running"] as const;
const UNKNOWN_OUTCOME = {
  status: "unknown" as const,
  errorCode: "EXTERNAL_OUTCOME_UNKNOWN",
  errorSummary: "External call was dispatched; its remote outcome is unknown.",
};

// The caller holds the run lock; never acquire an attempt after dependent rows.
export async function settleExternalRun(
  tx: Prisma.TransactionClient,
  runId: string,
  reason: ExternalInvalidationReason,
  now = new Date(),
  diagnostics: ExternalDiagnostics = [],
): Promise<void> {
  const calls = await tx.externalMcpCall.findMany({
    where: { assistantRunId: runId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const call of calls)
    await tx.$queryRaw`SELECT id FROM "ExternalMcpCall" WHERE id = ${call.id}::uuid FOR UPDATE`;
  const transitioning = await tx.externalMcpCall.findMany({
    where: {
      assistantRunId: runId,
      status: { in: ["prepared", "dispatched"] },
    },
    select: { id: true },
  });
  await invalidateExternalApprovals(tx, { runId, reason }, diagnostics);
  await tx.externalMcpCall.updateMany({
    where: { assistantRunId: runId, status: "dispatched" },
    data: { ...UNKNOWN_OUTCOME, completedAt: now },
  });
  await tx.externalMcpCall.updateMany({
    where: { assistantRunId: runId, status: "prepared" },
    data: {
      status: "failed",
      errorCode: "EXTERNAL_CALL_INVALIDATED",
      completedAt: now,
    },
  });
  const settling = await tx.externalMcpToolApproval.findMany({
    where: {
      runId,
      state: { in: ["pending", "approved"] },
      call: { status: { not: "prepared" } },
    },
    include: { call: true },
  });
  await tx.externalMcpToolApproval.updateMany({
    where: {
      runId,
      state: { in: ["pending", "approved"] },
      call: { status: { not: "prepared" } },
    },
    data: { state: "settled", decidedAt: now, ...CLEARED_APPROVAL_ARGUMENTS },
  });
  for (const row of settling)
    recordExternalCall(diagnostics, row.call, "external.approval.changed", {
      id: row.id,
      state: "settled",
    });
  for (const seed of transitioning) {
    const call = await tx.externalMcpCall.findUniqueOrThrow({
      where: { id: seed.id },
    });
    recordExternalCall(diagnostics, call, "external.call.settled");
    await appendRunEventTx(tx, {
      runId,
      attemptId: call.attemptId,
      event: { type: "external.call.status", ...externalCallView(call) },
    });
  }
}

async function lockOwner(tx: Prisma.TransactionClient, call: ExternalMcpCall) {
  if (call.attemptId)
    await tx.$queryRaw`SELECT id FROM "AssistantRunAttempt" WHERE id = ${call.attemptId}::uuid FOR UPDATE`;
  if (call.assistantRunId)
    await tx.$queryRaw`SELECT id FROM "AssistantRun" WHERE id = ${call.assistantRunId}::uuid FOR UPDATE`;
  if (call.taskRunId)
    await tx.$queryRaw`SELECT id FROM "ScheduledTaskRun" WHERE id = ${call.taskRunId}::uuid FOR UPDATE`;
}
function staleOwner(now: Date): Prisma.ExternalMcpCallWhereInput {
  return {
    OR: [
      { assistantRun: { status: { not: "running" } } },
      { assistantRun: { cancelRequestedAt: { not: null } } },
      { attempt: { status: { not: "running" } } },
      { attempt: { leaseExpiresAt: { lte: now } } },
      { taskRun: { status: { not: "running" } } },
      { taskRun: { leaseExpiresAt: { lte: now } } },
      { taskRun: { leaseExpiresAt: null } },
      // An MCP-owned call has no run; only its deadline settles it.
      { assistantRunId: null, taskRunId: null, mcpRequestId: null },
    ],
  };
}
async function reconcileCall(
  db: PrismaClient,
  seed: ExternalMcpCall,
  now: Date,
) {
  return externalTransaction(db, async (tx, _diagnostics) => {
    await lockOwner(tx, seed);
    await lockExternalCall(tx, seed.connectionSnapshotId, seed.id);
    const call = await tx.externalMcpCall.findUnique({
      where: { id: seed.id },
      include: { approval: true },
    });
    if (!call) return { approvals: 0, calls: 0 };
    const stale = Boolean(
      await tx.externalMcpCall.findFirst({
        where: { id: call.id, ...staleOwner(now) },
        select: { id: true },
      }),
    );
    const overdue = call.deadline !== null && call.deadline <= now;
    const approval = call.approval;
    let approvals = 0;
    let calls = 0;
    const terminalApproval =
      approval && !["pending", "approved"].includes(approval.state);
    const expiredApproval = approval && approval.expiresAt <= now;
    if (
      (call.status === "prepared" || call.status === "dispatched") &&
      (stale ||
        overdue ||
        (call.status === "prepared" && (expiredApproval || terminalApproval)))
    ) {
      await tx.externalMcpCall.update({
        where: { id: call.id },
        data:
          call.status === "dispatched"
            ? { ...UNKNOWN_OUTCOME, completedAt: now }
            : {
                status: "failed",
                errorCode: "EXTERNAL_CALL_INVALIDATED",
                completedAt: now,
              },
      });
      const settled = await tx.externalMcpCall.findUniqueOrThrow({
        where: { id: call.id },
      });
      recordExternalCall(_diagnostics, settled, "external.call.settled");
      if (settled.assistantRunId)
        await appendRunEventTx(tx, {
          runId: settled.assistantRunId,
          attemptId: settled.attemptId,
          event: { type: "external.call.status", ...externalCallView(settled) },
        });
      calls = 1;
    }
    if (approval) {
      const settled =
        !["prepared", "dispatched"].includes(call.status) ||
        (call.status === "dispatched" && calls === 1);
      const state = terminalApproval
        ? approval.state
        : settled
          ? "settled"
          : call.status === "prepared" && expiredApproval
            ? "expired"
            : call.status === "prepared" && (stale || overdue)
              ? "invalidated"
              : approval.state;
      if (
        !["pending", "approved"].includes(state) &&
        (state !== approval.state ||
          approval.pendingArgumentsCiphertext !== null ||
          approval.pendingArgumentsKeyVersion !== null ||
          approval.pendingArgumentsIv !== null ||
          approval.pendingArgumentsTag !== null)
      ) {
        await tx.externalMcpToolApproval.update({
          where: { id: approval.id },
          data: {
            state,
            decidedAt: approval.decidedAt ?? now,
            ...CLEARED_APPROVAL_ARGUMENTS,
          },
        });
        if (state !== approval.state)
          recordExternalCall(
            _diagnostics,
            await tx.externalMcpCall.findUniqueOrThrow({
              where: { id: call.id },
            }),
            "external.approval.changed",
            { id: approval.id, state },
          );
        approvals = 1;
      }
    }
    return { approvals, calls };
  });
}

export async function reconcileExternalMcpState(
  db: PrismaClient,
  now: Date,
): Promise<{ approvals: number; calls: number; pruned: number }> {
  let approvals = 0,
    calls = 0,
    pruned = 0;
  const approvalRows = await db.externalMcpToolApproval.findMany({
    where: {
      OR: [
        {
          state: { in: ["pending", "approved"] },
          OR: [
            { expiresAt: { lte: now } },
            { call: staleOwner(now) },
            { call: { status: { notIn: ["prepared", "dispatched"] } } },
          ],
        },
        {
          state: { notIn: ["pending", "approved"] },
          OR: [
            { pendingArgumentsCiphertext: { not: null } },
            { pendingArgumentsKeyVersion: { not: null } },
            { pendingArgumentsIv: { not: null } },
            { pendingArgumentsTag: { not: null } },
          ],
        },
      ],
    },
    include: { call: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  for (const row of approvalRows) {
    const result = await reconcileCall(db, row.call, now);
    approvals += result.approvals;
    calls += result.calls;
  }
  const callRows = await db.externalMcpCall.findMany({
    where: {
      status: { in: ["prepared", "dispatched"] },
      OR: [staleOwner(now), { deadline: { lte: now } }],
    },
    orderBy: { id: "asc" },
    take: 500,
  });
  for (const row of callRows) {
    const result = await reconcileCall(db, row, now);
    approvals += result.approvals;
    calls += result.calls;
  }
  const inactive: Prisma.ExternalMcpCallWhereInput = {
    AND: [
      {
        OR: [
          { assistantRunId: null },
          { assistantRun: { status: { notIn: [...ACTIVE_ASSISTANT] } } },
        ],
      },
      {
        OR: [
          { taskRunId: null },
          { taskRun: { status: { notIn: [...ACTIVE_TASK] } } },
        ],
      },
    ],
  };
  const oldApprovals = await db.externalMcpToolApproval.findMany({
    where: {
      retainedUntil: { lt: now },
      state: { notIn: ["pending", "approved"] },
      call: inactive,
    },
    select: { id: true },
    orderBy: { retainedUntil: "asc" },
    take: 5000,
  });
  if (oldApprovals.length)
    pruned += (
      await db.externalMcpToolApproval.deleteMany({
        where: {
          id: { in: oldApprovals.map((row) => row.id) },
          call: inactive,
        },
      })
    ).count;
  if (pruned < 5000) {
    const oldCalls = await db.externalMcpCall.findMany({
      where: {
        ...inactive,
        retainedUntil: { lt: now },
        status: { notIn: ["prepared", "dispatched"] },
        approval: null,
      },
      select: { id: true },
      orderBy: { retainedUntil: "asc" },
      take: 5000 - pruned,
    });
    if (oldCalls.length)
      pruned += (
        await db.externalMcpCall.deleteMany({
          where: {
            ...inactive,
            id: { in: oldCalls.map((row) => row.id) },
            approval: null,
          },
        })
      ).count;
  }
  return { approvals, calls, pruned };
}

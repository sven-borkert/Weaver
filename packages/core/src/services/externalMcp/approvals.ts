import {
  externalTransaction,
  recordExternalCall,
  type ExternalDiagnostics,
} from "./diagnostics";
import type {
  Prisma,
  ExternalMcpToolApproval,
  ExternalMcpCall,
} from "@weaver/db/client";
import type {
  ExternalApprovalView,
  ExternalRuntimeDeps,
  JsonObject,
} from "../../externalMcp/types";
import { scopeSnapshotSchema } from "../../assistant/scopeSchema";
import type { SecurityContext } from "../../security/context";
import { CoreError } from "../../errors";
import { canonicalDigest } from "../../externalMcp/digest";
import { decryptExternalSecret } from "./credentials";
import {
  assertExternalApprovalOwner,
  authorizeExternalInvocationContext,
} from "./access";
import { lockExternalOwner, lockExternalCall, callOwner } from "./calls";
export const CLEARED_APPROVAL_ARGUMENTS = {
  pendingArgumentsCiphertext: null,
  pendingArgumentsKeyVersion: null,
  pendingArgumentsIv: null,
  pendingArgumentsTag: null,
};
export type ExternalInvalidationReason =
  | "configuration_changed"
  | "run_cancelled"
  | "run_finished"
  | "lease_expired"
  | "scope_changed";
// Caller holds the run or connection lock; dependent locks never acquire an attempt.
export async function invalidateExternalApprovals(
  tx: Prisma.TransactionClient,
  input: {
    runId?: string;
    connectionId?: string;
    reason: ExternalInvalidationReason;
  },
  diagnostics: ExternalDiagnostics = [],
): Promise<number> {
  if (!input.runId && !input.connectionId) throw new CoreError("BAD_REQUEST");
  const where = {
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  };
  const rows = await tx.externalMcpToolApproval.findMany({
    where,
    select: { id: true, callId: true },
    orderBy: { callId: "asc" },
  });
  for (const row of rows)
    await tx.$queryRaw`SELECT id FROM "ExternalMcpCall" WHERE id = ${row.callId}::uuid FOR UPDATE`;
  for (const row of rows.sort((a, b) => a.id.localeCompare(b.id)))
    await tx.$queryRaw`SELECT id FROM "ExternalMcpToolApproval" WHERE id = ${row.id}::uuid FOR UPDATE`;
  const eligible = await tx.externalMcpToolApproval.findMany({
    where: {
      ...where,
      state: { in: ["pending", "approved"] },
      call: { status: "prepared" },
    },
    select: { id: true },
  });
  const result = await tx.externalMcpToolApproval.updateMany({
    where: {
      ...where,
      state: { in: ["pending", "approved"] },
      call: { status: "prepared" },
    },
    data: {
      state: "invalidated",
      decidedAt: new Date(),
      ...CLEARED_APPROVAL_ARGUMENTS,
    },
  });
  if (result.count) {
    const changed = await tx.externalMcpToolApproval.findMany({
      where: {
        id: { in: eligible.map((row) => row.id) },
        state: "invalidated",
      },
      include: { call: true },
    });
    for (const row of changed)
      recordExternalCall(
        diagnostics,
        row.call,
        "external.approval.changed",
        row,
      );
  }
  return result.count;
}
type ApprovalRow = ExternalMcpToolApproval & { call: ExternalMcpCall };
function context(row: ApprovalRow) {
  if (!row.call.deadline) throw new CoreError("PRECONDITION_FAILED");
  return {
    owner: callOwner(row.call),
    scope: scopeSnapshotSchema.parse(row.scopeSnapshot),
    toolId: row.call.toolSnapshotId,
    expectedConfigRevision: row.configRevision,
    expectedToolDigest: row.reviewDigest,
    deadline: row.call.deadline,
  };
}
function view(row: ApprovalRow, args: JsonObject | null): ExternalApprovalView {
  return {
    id: row.id,
    callId: row.callId,
    connectionName: row.call.connectionSnapshotName,
    toolName: row.call.toolSnapshotName,
    effect: row.call.effect,
    arguments: args,
    expiresAt: row.expiresAt.toISOString(),
    status: row.state,
  };
}
function decryptArguments(
  deps: ExternalRuntimeDeps,
  row: ApprovalRow,
): JsonObject {
  const args = JSON.parse(
    decryptExternalSecret(
      deps.ring,
      {
        ciphertext: row.pendingArgumentsCiphertext,
        keyVersion: row.pendingArgumentsKeyVersion,
        iv: row.pendingArgumentsIv,
        tag: row.pendingArgumentsTag,
      },
      "approval",
      row.id,
    ),
  ) as JsonObject;
  if (
    canonicalDigest(args) !== row.argsDigest ||
    row.argsDigest !== row.call.argsDigest
  )
    throw new CoreError("PRECONDITION_FAILED");
  return args;
}
async function approvalOperation(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  id: string,
  decision?: "approve" | "deny",
): Promise<ExternalApprovalView> {
  const seed = await deps.db.externalMcpToolApproval.findUnique({
    where: { id },
    include: { call: true },
  });
  if (seed?.ownerId !== actor.userId) throw new CoreError("NOT_FOUND");
  const result = await externalTransaction(
    deps.db,
    async (tx, _diagnostics) => {
      await lockExternalOwner(tx, callOwner(seed.call));
      await lockExternalCall(tx, seed.call.connectionSnapshotId, seed.callId);
      let row = await tx.externalMcpToolApproval.findUnique({
        where: { id },
        include: { call: true },
      });
      if (row?.ownerId !== actor.userId) throw new CoreError("NOT_FOUND");
      await assertExternalApprovalOwner(
        { ...deps, db: tx },
        actor,
        row.runId,
        scopeSnapshotSchema.parse(row.scopeSnapshot),
      );
      let expired = false;
      if (
        (row.state === "pending" || row.state === "approved") &&
        row.expiresAt <= deps.now() &&
        row.call.status === "prepared"
      ) {
        expired = true;
        row = await tx.externalMcpToolApproval.update({
          where: { id },
          data: {
            state: "expired",
            decidedAt: deps.now(),
            ...CLEARED_APPROVAL_ARGUMENTS,
          },
          include: { call: true },
        });
      }
      if (row.state === "expired") {
        if (expired)
          recordExternalCall(
            _diagnostics,
            row.call,
            "external.approval.changed",
            row,
          );
        return view(row, null);
      }
      if (row.state !== "pending" && row.state !== "approved") {
        if (
          decision &&
          !(
            (decision === "deny" && row.state === "denied") ||
            (decision === "approve" && row.state === "settled")
          )
        )
          throw new CoreError("CONFLICT", "External approval already resolved");
        return view(row, null);
      }
      await authorizeExternalInvocationContext(
        { ...deps, db: tx },
        actor,
        context(row),
      );
      const args = decryptArguments(deps, row);
      if (decision) {
        const state = decision === "approve" ? "approved" : "denied";
        if (row.state === "approved") {
          if (state !== "approved")
            throw new CoreError(
              "CONFLICT",
              "External approval already resolved",
            );
        } else {
          row = await tx.externalMcpToolApproval.update({
            where: { id },
            data: {
              state,
              decidedAt: deps.now(),
              decidedById: actor.userId,
              ...(state === "denied" ? CLEARED_APPROVAL_ARGUMENTS : {}),
            },
            include: { call: true },
          });
          recordExternalCall(
            _diagnostics,
            row.call,
            "external.approval.changed",
            row,
          );
          if (state === "denied") {
            await tx.externalMcpCall.updateMany({
              where: { id: row.callId, status: "prepared" },
              data: { status: "denied", completedAt: deps.now() },
            });
            recordExternalCall(
              _diagnostics,
              { ...row.call, status: "denied" },
              "external.call.settled",
            );
          }
        }
      }
      return view(row, row.state === "denied" ? null : args);
    },
  );
  if (decision && result.status === "expired")
    throw new CoreError("PRECONDITION_FAILED", "External approval expired");
  return result;
}
export async function getExternalApproval(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  id: string,
): Promise<ExternalApprovalView> {
  return approvalOperation(deps, actor, id);
}
export async function decideExternalApproval(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  input: { id: string; decision: "approve" | "deny" },
): Promise<ExternalApprovalView> {
  return approvalOperation(deps, actor, input.id, input.decision);
}
export async function listRunExternalApprovals(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  runId: string,
): Promise<ExternalApprovalView[]> {
  const run = await deps.db.assistantRun.findUnique({
    where: { id: runId },
    select: { scopeSnapshot: true },
  });
  if (!run) throw new CoreError("NOT_FOUND");
  await assertExternalApprovalOwner(
    deps,
    actor,
    runId,
    scopeSnapshotSchema.parse(run.scopeSnapshot),
  );
  const rows = await deps.db.externalMcpToolApproval.findMany({
    where: { runId, ownerId: actor.userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const views: ExternalApprovalView[] = [];
  for (const row of rows)
    views.push(await getExternalApproval(deps, actor, row.id));
  return views;
}

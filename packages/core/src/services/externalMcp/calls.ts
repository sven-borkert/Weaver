import { ASSISTANT_RUN_TIMEOUT_MS } from "../../assistant/limits";
import { externalTransaction, recordExternalCall } from "./diagnostics";
import { externalCallView } from "./activity";
import { randomUUID } from "node:crypto";
import type { Prisma, ExternalMcpCall } from "@weaver/db/client";
import type {
  ExternalInvocation,
  ExternalCallView,
  ExternalRuntimeDeps,
  ExecutionOwner,
} from "../../externalMcp/types";
import {
  canonicalDigest,
  canonicalJson,
  externalInvocationDigest,
  externalDenialDigest,
} from "../../externalMcp/digest";
import { CoreError } from "../../errors";
import { requiresApproval } from "../../externalMcp/policy";
import type { UserSecurityContext } from "../../security/context";
import { authorizeExternalInvocation } from "./access";
import { encryptExternalSecret } from "./credentials";

export async function lockExternalOwner(
  tx: Prisma.TransactionClient,
  owner: ExecutionOwner,
) {
  if (owner.kind === "assistant") {
    await tx.$queryRaw`SELECT id FROM "AssistantRunAttempt" WHERE id = ${owner.attemptId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AssistantRun" WHERE id = ${owner.runId}::uuid FOR UPDATE`;
  } else if (owner.kind === "task") {
    await tx.$queryRaw`SELECT id FROM "ScheduledTaskRun" WHERE id = ${owner.runId}::uuid FOR UPDATE`;
  }
}
export async function lockExternalCall(
  tx: Prisma.TransactionClient,
  connectionId: string,
  callId?: string,
) {
  await tx.$queryRaw`SELECT id FROM "ExternalMcpConnection" WHERE id = ${connectionId}::uuid FOR UPDATE`;
  if (callId) {
    await tx.$queryRaw`SELECT id FROM "ExternalMcpCall" WHERE id = ${callId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ExternalMcpToolApproval" WHERE "callId" = ${callId}::uuid FOR UPDATE`;
  }
}
export function callOwner(call: ExternalMcpCall): ExecutionOwner {
  if (call.assistantRunId && call.attemptId && call.toolCallId)
    return {
      kind: "assistant",
      runId: call.assistantRunId,
      attemptId: call.attemptId,
      toolCallId: call.toolCallId,
    };
  if (call.taskRunId && call.inputSnapshotId)
    return {
      kind: "task",
      runId: call.taskRunId,
      inputId: call.inputSnapshotId,
    };
  if (
    call.mcpRequestId &&
    call.mcpCredentialId &&
    (call.mcpAuthMethod === "apiKey" || call.mcpAuthMethod === "oauth")
  )
    return {
      kind: "mcp",
      requestId: call.mcpRequestId,
      credentialId: call.mcpCredentialId,
      authenticationMethod: call.mcpAuthMethod,
    };
  throw new CoreError(
    "PRECONDITION_FAILED",
    "External call identity unavailable",
  );
}
export function assertCallIdentity(
  call: ExternalMcpCall,
  actor: UserSecurityContext,
  invocation: ExternalInvocation,
) {
  if (call.userId !== actor.userId) throw new CoreError("NOT_FOUND");
  if (!call.invocationDigest || !call.deadline)
    throw new CoreError("PRECONDITION_FAILED");
  if (call.invocationDigest !== externalInvocationDigest(invocation))
    throw new CoreError("CONFLICT", "External call identity changed");
}
export async function effectiveExternalDeadline(
  tx: Prisma.TransactionClient,
  invocation: ExternalInvocation,
) {
  const owner = invocation.owner;
  if (owner.kind === "mcp") return invocation.deadline;
  const run =
    owner.kind === "assistant"
      ? await tx.assistantRun.findUnique({
          where: { id: owner.runId },
          select: { startedAt: true },
        })
      : await tx.scheduledTaskRun.findUnique({
          where: { id: owner.runId },
          select: { startedAt: true },
        });
  if (!run?.startedAt) throw new CoreError("PRECONDITION_FAILED");
  return new Date(
    Math.min(
      invocation.deadline.getTime(),
      run.startedAt.getTime() +
        (owner.kind === "assistant" ? ASSISTANT_RUN_TIMEOUT_MS : 900000),
    ),
  );
}
async function conversationAutoApproves(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<boolean> {
  const run = await tx.assistantRun.findUnique({
    where: { id: runId },
    select: { conversation: { select: { autoApproveChanges: true } } },
  });
  return run?.conversation.autoApproveChanges === true;
}
export async function prepareExternalCall(
  deps: ExternalRuntimeDeps,
  actor: UserSecurityContext,
  invocation: ExternalInvocation,
): Promise<{
  callId: string;
  approvalId: string | null;
  activity: ExternalCallView;
  status: "prepared" | "denied";
}> {
  invocation = structuredClone(invocation);
  return externalTransaction(deps.db, async (tx, _diagnostics) => {
    await lockExternalOwner(tx, invocation.owner);
    const tool = await tx.externalMcpTool.findUnique({
      where: { id: invocation.toolId },
      select: { connectionId: true },
    });
    if (!tool) throw new CoreError("NOT_FOUND");
    await lockExternalCall(tx, tool.connectionId);
    const authorized = await authorizeExternalInvocation(
      { ...deps, db: tx },
      actor,
      invocation,
    );
    const owner = invocation.owner;
    const existing = await tx.externalMcpCall.findFirst({
      where:
        owner.kind === "assistant"
          ? { attemptId: owner.attemptId, toolCallId: owner.toolCallId }
          : owner.kind === "task"
            ? { taskRunId: owner.runId, inputSnapshotId: owner.inputId }
            : { mcpRequestId: owner.requestId },
      include: { approval: true },
    });
    if (existing) {
      assertCallIdentity(existing, actor, invocation);
      return {
        activity: externalCallView(existing),
        callId: existing.id,
        approvalId: existing.approval?.id ?? null,
        status: existing.status === "denied" ? "denied" : "prepared",
      };
    }
    const now = deps.now();
    const deadline = await effectiveExternalDeadline(tx, invocation);
    if (deadline <= now) throw new CoreError("PRECONDITION_FAILED");
    const denialDigest = externalDenialDigest(invocation);
    const denied =
      owner.kind === "mcp"
        ? null
        : await tx.externalMcpCall.findFirst({
            where: {
              denialDigest,
              status: "denied",
              ...(owner.kind === "assistant"
                ? { assistantRunId: owner.runId }
                : { taskRunId: owner.runId }),
            },
            select: { id: true },
          });
    const user = await tx.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { name: true },
    });
    const call = await tx.externalMcpCall.create({
      data: {
        userId: actor.userId,
        connectionId: authorized.connectionId,
        toolId: authorized.toolId,
        ...(owner.kind === "assistant"
          ? {
              assistantRunId: owner.runId,
              attemptId: owner.attemptId,
              toolCallId: owner.toolCallId,
            }
          : owner.kind === "task"
            ? {
                taskRunId: owner.runId,
                inputId: owner.inputId,
                inputSnapshotId: owner.inputId,
              }
            : {
                mcpRequestId: owner.requestId,
                mcpCredentialId: owner.credentialId,
                mcpAuthMethod: owner.authenticationMethod,
              }),
        userSnapshotId: actor.userId,
        userSnapshotName: user.name.slice(0, 200),
        connectionSnapshotId: authorized.connectionId,
        connectionSnapshotName: authorized.connectionName,
        toolSnapshotId: authorized.toolId,
        toolSnapshotName: authorized.definition.name,
        remoteDigest: canonicalDigest(authorized.definition),
        reviewDigest: authorized.reviewedDigest,
        configRevision: authorized.configRevision,
        effect: authorized.effect,
        argsDigest: canonicalDigest(invocation.arguments),
        invocationDigest: externalInvocationDigest(invocation),
        denialDigest,
        deadline,
        scopeSnapshot: invocation.scope,
        preparedAt: now,
        retainedUntil: new Date(now.getTime() + 30 * 86400000),
        status: denied ? "denied" : "prepared",
      },
    });
    let approvalId: string | null = null;
    if (
      !denied &&
      owner.kind === "assistant" &&
      requiresApproval(
        owner.kind,
        authorized.effect,
        await conversationAutoApproves(tx, owner.runId),
      )
    ) {
      approvalId = randomUUID();
      const secret = encryptExternalSecret(
        deps.ring,
        canonicalJson(invocation.arguments),
        "approval",
        approvalId,
      );
      await tx.externalMcpToolApproval.create({
        data: {
          id: approvalId,
          callId: call.id,
          ownerId: actor.userId,
          runId: owner.runId,
          attemptId: owner.attemptId,
          connectionId: authorized.connectionId,
          toolId: authorized.toolId,
          toolCallId: owner.toolCallId,
          scopeSnapshot: invocation.scope,
          configRevision: authorized.configRevision,
          reviewDigest: authorized.reviewedDigest,
          argsDigest: call.argsDigest,
          expiresAt: deadline,
          createdAt: now,
          retainedUntil: call.retainedUntil,
          pendingArgumentsCiphertext: secret.ciphertext,
          pendingArgumentsKeyVersion: secret.keyVersion,
          pendingArgumentsIv: secret.iv,
          pendingArgumentsTag: secret.tag,
        },
      });
    }
    recordExternalCall(_diagnostics, call, "external.call.prepared");
    if (approvalId)
      recordExternalCall(_diagnostics, call, "external.approval.changed", {
        id: approvalId,
        state: "pending",
      });
    return {
      activity: externalCallView(call),
      callId: call.id,
      approvalId,
      status: denied ? "denied" : "prepared",
    };
  });
}
export async function hasExternalDispatch(
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<boolean> {
  return (
    (await tx.externalMcpCall.count({
      where: { attemptId, dispatchedAt: { not: null } },
    })) > 0
  );
}

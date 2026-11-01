import { externalTransaction, recordExternalCall } from "./diagnostics";
import {
  externalError,
  externalTransportError,
} from "../../externalMcp/errors";
import { externalCallView } from "./activity";
import { ExternalMcpError } from "@weaver/external-mcp";
import type {
  ExternalCallView,
  ExternalRuntimeDeps,
  ExternalInvocation,
  ExternalResult,
} from "../../externalMcp/types";
import type { SecurityContext } from "../../security/context";
import { canonicalDigest } from "../../externalMcp/digest";
import { CoreError } from "../../errors";
import {
  authorizeExternalInvocation,
  authorizeExternalInvocationContext,
  assertExternalApprovalOwner,
} from "./access";
import {
  assertCallIdentity,
  lockExternalOwner,
  lockExternalCall,
} from "./calls";
import { CLEARED_APPROVAL_ARGUMENTS } from "./approvals";
import { decryptExternalConnectionCredential } from "./credentials";
import type { ExternalMcpSession } from "@weaver/external-mcp";

export async function executeExternalCall(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  input: {
    callId: string;
    invocation: ExternalInvocation;
    signal: AbortSignal;
    onDispatched?: (call: ExternalCallView) => Promise<void>;
  },
): Promise<ExternalResult> {
  const { callId, signal } = input;
  const invocation = structuredClone(input.invocation);
  const claim = await externalTransaction(deps.db, async (tx, _diagnostics) => {
    await lockExternalOwner(tx, invocation.owner);
    const seed = await tx.externalMcpCall.findUnique({ where: { id: callId } });
    if (!seed) throw new CoreError("NOT_FOUND");
    assertCallIdentity(seed, actor, invocation);
    await lockExternalCall(tx, seed.connectionSnapshotId, callId);
    const call = await tx.externalMcpCall.findUniqueOrThrow({
      where: { id: callId },
      include: { approval: true },
    });
    assertCallIdentity(call, actor, invocation);
    if (invocation.owner.kind === "assistant")
      await assertExternalApprovalOwner(
        { ...deps, db: tx },
        actor,
        invocation.owner.runId,
        invocation.scope,
      );
    if (call.status !== "prepared") {
      if (invocation.owner.kind === "task")
        await authorizeExternalInvocationContext(
          { ...deps, db: tx },
          actor,
          invocation,
        );
      if (call.status === "denied")
        throw new CoreError("PRECONDITION_FAILED", "External call denied");
      return { call, connection: null, authorized: null };
    }
    if (
      call.approval &&
      (call.approval.state === "pending" ||
        call.approval.state === "approved") &&
      call.approval.expiresAt <= deps.now()
    ) {
      await tx.externalMcpToolApproval.update({
        where: { id: call.approval.id },
        data: {
          state: "expired",
          decidedAt: deps.now(),
          ...CLEARED_APPROVAL_ARGUMENTS,
        },
      });
      recordExternalCall(_diagnostics, call, "external.approval.changed", {
        id: call.approval.id,
        state: "expired",
      });
      return { call, connection: null, authorized: null };
    }
    signal.throwIfAborted();
    const authorized = await authorizeExternalInvocation(
      { ...deps, db: tx },
      actor,
      {
        ...invocation,
        deadline: new Date(
          Math.min(call.deadline!.getTime(), invocation.deadline.getTime()),
        ),
      },
    );
    // Whether to ask was settled when the call was prepared; a call with an approval runs only once approved.
    if (
      call.approval &&
      (call.approval.state !== "approved" ||
        call.approval.expiresAt <= deps.now() ||
        call.approval.argsDigest !== call.argsDigest)
    )
      throw new CoreError(
        "PRECONDITION_FAILED",
        "External call needs approval",
      );
    const connection = await tx.externalMcpConnection.findUniqueOrThrow({
      where: { id: authorized.connectionId },
      select: { endpoint: true, timeoutMs: true, allowInsecureTls: true },
    });
    const updated = await tx.externalMcpCall.updateMany({
      where: { id: callId, status: "prepared" },
      data: {
        status: "dispatched",
        dispatchedAt: deps.now(),
        requestBytes: Buffer.byteLength(JSON.stringify(invocation.arguments)),
      },
    });
    if (!updated.count) throw new CoreError("CONFLICT");
    recordExternalCall(
      _diagnostics,
      {
        ...call,
        status: "dispatched",
        requestBytes: Buffer.byteLength(JSON.stringify(invocation.arguments)),
      },
      "external.call.dispatched",
    );
    return { call, connection, authorized };
  });
  if (claim.call.status === "prepared" && !claim.authorized)
    throw new CoreError("PRECONDITION_FAILED", "External approval expired");
  if (!claim.connection || !claim.authorized) {
    const activity = externalCallView({
      ...claim.call,
      status:
        claim.call.status === "dispatched" ? "unknown" : claim.call.status,
    });
    return {
      callId,
      status: activity.status as ExternalResult["status"],
      output: null,
      source: null,
      error: activity.error,
      summary: activity.summary,
    };
  }
  let session: ExternalMcpSession | undefined;
  const started = deps.now();
  let result: ExternalResult = {
    callId,
    status: "unknown",
    output: null,
    source: null,
    error: {
      code: "EXTERNAL_OUTCOME_UNKNOWN",
      message: "External call outcome is unknown",
    },
  };
  let responseBytes: number | undefined;
  let requestSignal = signal;
  try {
    await input.onDispatched?.(
      externalCallView({ ...claim.call, status: "dispatched" }),
    );
    const remaining =
      Math.min(claim.call.deadline!.getTime(), invocation.deadline.getTime()) -
      deps.now().getTime();
    if (remaining <= 0) throw new ExternalMcpError("CANCELLED");
    requestSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    requestSignal.throwIfAborted();
    session = await deps.transport.open({
      endpoint: claim.connection.endpoint,
      timeoutMs: claim.connection.timeoutMs,
      signal: requestSignal,
      insecureTls: claim.connection.allowInsecureTls,
      token: () =>
        decryptExternalConnectionCredential(
          deps.db,
          deps.ring,
          claim.authorized.connectionId,
          claim.connection.endpoint,
          claim.authorized.configRevision,
        ),
    });
    const catalog = await session.discover();
    const definition = catalog.tools.find(
      (t) => t.name === claim.authorized.definition.name,
    );
    if (!definition || canonicalDigest(definition) !== claim.call.remoteDigest)
      throw new ExternalMcpError("TOOL_CHANGED");
    requestSignal.throwIfAborted();
    const remote = await session.call({
      name: claim.authorized.definition.name,
      arguments: invocation.arguments,
    });
    requestSignal.throwIfAborted();
    responseBytes = remote.responseBytes;
    result = {
      callId,
      status: remote.isError ? "failed" : "completed",
      output: {
        content: remote.content,
        ...(remote.structuredContent
          ? { structuredContent: remote.structuredContent }
          : {}),
      },
      source: {
        callId,
        connectionId: claim.call.connectionSnapshotId,
        connectionName: claim.call.connectionSnapshotName,
        toolName: claim.call.toolSnapshotName,
        retrievedAt: deps.now().toISOString(),
        truncated: remote.truncated,
      },
      error: remote.isError ? externalError("EXTERNAL_TOOL_ERROR") : null,
    };
  } catch (error) {
    result.error =
      error instanceof ExternalMcpError
        ? externalTransportError(error.code)
        : externalError(
            requestSignal.aborted
              ? "EXTERNAL_TIMEOUT"
              : "EXTERNAL_OUTCOME_UNKNOWN",
          );
  } finally {
    try {
      await session?.close();
    } catch {
      /* The observed result remains authoritative. */
    }
  }
  try {
    const saved = await externalTransaction(
      deps.db,
      async (tx, _diagnostics) => {
        await tx.$queryRaw`SELECT id FROM "ExternalMcpCall" WHERE id = ${callId}::uuid FOR UPDATE`;
        const saved = await tx.externalMcpCall.updateMany({
          where: { id: callId, status: "dispatched" },
          data: {
            status: result.status,
            completedAt: deps.now(),
            durationMs: Math.max(0, deps.now().getTime() - started.getTime()),
            responseBytes,
            errorCode: result.error?.code,
            errorSummary: result.error?.message,
          },
        });
        if (saved.count)
          await tx.externalMcpToolApproval.updateMany({
            where: { callId, state: "approved" },
            data: { state: "settled", ...CLEARED_APPROVAL_ARGUMENTS },
          });
        if (saved.count) {
          const settled = await tx.externalMcpCall.findUniqueOrThrow({
            where: { id: callId },
          });
          recordExternalCall(_diagnostics, settled, "external.call.settled");
          const approval = await tx.externalMcpToolApproval.findUnique({
            where: { callId },
          });
          if (approval?.state === "settled")
            recordExternalCall(
              _diagnostics,
              settled,
              "external.approval.changed",
              approval,
            );
        }
        return saved.count;
      },
    );
    if (saved)
      return {
        ...result,
        summary: externalCallView({
          ...claim.call,
          status: result.status,
          responseBytes: responseBytes ?? null,
          errorCode: result.error?.code ?? null,
        }).summary,
      };
  } catch {
    /* Persisted dispatch remains durable evidence of uncertainty. */
  }
  return {
    callId,
    status: "unknown",
    output: null,
    source: null,
    error: {
      code: "EXTERNAL_OUTCOME_UNKNOWN",
      message: "External call outcome is unknown",
    },
  };
}

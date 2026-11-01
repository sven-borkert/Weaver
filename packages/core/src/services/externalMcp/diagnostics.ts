import type { ExternalMcpCall, Prisma, PrismaClient } from "@weaver/db/client";
import {
  emitDiagnostic,
  type DiagnosticEmitInput,
} from "../../diagnostics/writer";
import { externalError } from "../../externalMcp/errors";

export type ExternalDiagnostics = DiagnosticEmitInput[];
export async function externalTransaction<T>(
  db: PrismaClient,
  work: (
    tx: Prisma.TransactionClient,
    diagnostics: ExternalDiagnostics,
  ) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  const diagnostics: ExternalDiagnostics = [];
  const result = await db.$transaction((tx) => work(tx, diagnostics), options);
  for (const event of diagnostics) emitDiagnostic(event);
  return result;
}
export function recordExternalCall(
  diagnostics: ExternalDiagnostics,
  call: ExternalMcpCall,
  event:
    | "external.call.prepared"
    | "external.call.dispatched"
    | "external.call.settled"
    | "external.approval.changed",
  approval?: { id: string; state: string },
) {
  diagnostics.push({
    event,
    message: "External MCP state changed",
    userId: call.userSnapshotId,
    connectionId: call.connectionSnapshotId,
    runId: call.assistantRunId ?? call.taskRunId ?? undefined,
    durationMs: call.durationMs,
    outcome:
      call.status === "failed" || call.status === "unknown"
        ? "error"
        : call.status === "denied"
          ? "denied"
          : "ok",
    details: {
      attemptId: call.attemptId,
      callId: call.id,
      toolId: call.toolSnapshotId,
      status: call.status,
      configRevision: call.configRevision,
      requestBytes: call.requestBytes,
      responseBytes: call.responseBytes,
      errorCode: call.errorCode ? externalError(call.errorCode).code : null,
      ...(approval
        ? { approvalId: approval.id, decision: approval.state }
        : {}),
    },
  });
}

import type { ExternalMcpCall } from "@weaver/db/client";
import { scopeSnapshotSchema } from "../../assistant/scopeSchema";
import {
  externalError,
  EXTERNAL_UNKNOWN_WARNING,
} from "../../externalMcp/errors";
import type { ExternalCallView } from "../../externalMcp/types";
import { CoreError } from "../../errors";
import type { SecurityContext } from "../../security/context";
import { assertExternalApprovalOwner, type ExternalAccessDeps } from "./access";

export function externalCallView(call: ExternalMcpCall): ExternalCallView {
  const error = call.errorCode ? externalError(call.errorCode) : null;
  return {
    callId: call.id,
    toolCallId: call.toolCallId ?? call.id,
    connectionId: call.connectionSnapshotId,
    connectionName: call.connectionSnapshotName,
    toolName: call.toolSnapshotName,
    status: call.status,
    summary:
      call.status === "unknown"
        ? `${error?.message ?? externalError(null).message} ${EXTERNAL_UNKNOWN_WARNING}`
        : call.status === "completed"
          ? `Received ${call.responseBytes ?? 0} bytes of external data.`
          : (error?.message ?? null),
    error,
  };
}
export async function listRunExternalCalls(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  input: { runId: string; after?: string },
): Promise<{ calls: ExternalCallView[]; nextAfter: string | null }> {
  const run = await deps.db.assistantRun.findUnique({
    where: { id: input.runId },
    select: {
      scopeSnapshot: true,
      conversation: { select: { ownerId: true } },
    },
  });
  if (run?.conversation.ownerId !== actor.userId)
    throw new CoreError("NOT_FOUND");
  const scope = scopeSnapshotSchema.safeParse(run.scopeSnapshot);
  if (!scope.success) throw new CoreError("FORBIDDEN");
  await assertExternalApprovalOwner(deps, actor, input.runId, scope.data);
  const calls = await deps.db.externalMcpCall.findMany({
    where: {
      assistantRunId: input.runId,
      userId: actor.userId,
      ...(input.after ? { id: { gt: input.after } } : {}),
    },
    orderBy: { id: "asc" },
    take: 101,
  });
  const page = calls.slice(0, 100);
  return {
    calls: page.map(externalCallView),
    nextAfter: calls.length > 100 ? page.at(-1)!.id : null,
  };
}

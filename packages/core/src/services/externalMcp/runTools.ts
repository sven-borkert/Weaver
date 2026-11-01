import type { PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import { MAX_EXTERNAL_TOOLS } from "../../externalMcp/limits";
import {
  externalToolSnapshotsSchema,
  type ExternalToolSnapshot,
} from "../../externalMcp/schema";
import { hasCapability, type SecurityContext } from "../../security/context";
import { assertActiveAssistantAttempt, reviewedTool } from "./access";

export type ExternalLoadRefusal = {
  toolId: string;
  reason: "UNKNOWN_TOOL" | "CHANGED" | "LIMIT_REACHED";
};

export async function ownsEnabledExternalConnection(
  db: PrismaClient,
  userId: string,
): Promise<boolean> {
  return (
    (await db.externalMcpConnection.count({
      where: { ownerId: userId, enabled: true },
    })) > 0
  );
}

/** Lock order attempt → run, as everywhere else in external execution. */
export async function loadExternalToolsForRun(
  deps: { db: PrismaClient; now: () => Date },
  actor: SecurityContext,
  input: {
    runId: string;
    attemptId: string;
    snapshots: ExternalToolSnapshot[];
  },
): Promise<{ loaded: ExternalToolSnapshot[]; refused: ExternalLoadRefusal[] }> {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("NOT_FOUND");
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AssistantRunAttempt" WHERE "id" = ${input.attemptId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AssistantRun" WHERE "id" = ${input.runId}::uuid FOR UPDATE`;
    const attempt = await tx.assistantRunAttempt.findFirst({
      where: { id: input.attemptId, runId: input.runId },
      include: {
        run: {
          include: {
            conversation: { select: { ownerId: true } },
            userMessage: true,
          },
        },
      },
    });
    if (attempt?.run.conversation.ownerId !== actor.userId)
      throw new CoreError("NOT_FOUND");
    assertActiveAssistantAttempt(attempt, deps.now());
    const rows = await tx.externalMcpTool.findMany({
      where: {
        id: { in: input.snapshots.map((s) => s.toolId) },
        connection: { ownerId: actor.userId },
      },
      include: { connection: true },
    });
    const content = (attempt.run.userMessage.content ?? {}) as Record<
      string,
      unknown
    >;
    let current = externalToolSnapshotsSchema
      .catch([])
      .parse(content.externalToolSnapshots);
    const canWrite = hasCapability(actor, "content:write");
    const loaded: ExternalToolSnapshot[] = [];
    const refused: ExternalLoadRefusal[] = [];
    for (const snapshot of input.snapshots) {
      const row = rows.find(
        (r) =>
          r.id === snapshot.toolId && r.connectionId === snapshot.connectionId,
      );
      if (!row) {
        refused.push({ toolId: snapshot.toolId, reason: "UNKNOWN_TOOL" });
        continue;
      }
      if (
        !row.connection.enabled ||
        !reviewedTool(row) ||
        (row.effect === "write" && !canWrite) ||
        row.connection.revision !== snapshot.configRevision ||
        row.reviewDigest !== snapshot.toolDigest
      ) {
        refused.push({ toolId: snapshot.toolId, reason: "CHANGED" });
        continue;
      }
      const others = current.filter((s) => s.toolId !== snapshot.toolId);
      if (others.length >= MAX_EXTERNAL_TOOLS) {
        refused.push({ toolId: snapshot.toolId, reason: "LIMIT_REACHED" });
        continue;
      }
      current = [...others, snapshot];
      loaded.push(snapshot);
    }
    if (loaded.length)
      await tx.assistantMessage.update({
        where: { id: attempt.run.userMessageId },
        data: {
          content: { ...content, externalToolSnapshots: current },
        },
      });
    return { loaded, refused };
  });
}

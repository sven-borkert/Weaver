import type { PrismaClient } from "@weaver/db/client";
import type { UserSecurityContext } from "../security/context";
import { requireOwnedConversation } from "./assistantConversations";
import { resolveLlmRoute } from "./llmRoutes";

export type RunUsage = {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null once the run's events were pruned. */
  toolCalls: number | null;
  durationMs: number | null;
};

export type ConversationUsage = {
  /** Model of the latest run, else the one the next message would use. */
  model: string | null;
  totals: {
    replies: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
  runs: Record<string, RunUsage>;
};

function providerModel(snapshot: unknown): string | null {
  const id = (snapshot as { providerModelId?: unknown } | null)
    ?.providerModelId;
  return typeof id === "string" && id ? id : null;
}

/** Owner-only: what the conversation's runs used, for the session bar and reply footers. */
export async function getConversationUsage(
  db: PrismaClient,
  actor: UserSecurityContext,
  conversationId: string,
): Promise<ConversationUsage> {
  await requireOwnedConversation(db, actor, conversationId);
  const runs = await db.assistantRun.findMany({
    where: { conversationId },
    select: {
      id: true,
      status: true,
      routeSnapshot: true,
      startedAt: true,
      finishedAt: true,
    },
    orderBy: { queuedAt: "asc" },
  });
  const ids = runs.map((run) => run.id);
  const [tokens, calls] = ids.length
    ? await Promise.all([
        db.aiUsage.groupBy({
          by: ["runId"],
          where: { runId: { in: ids }, operation: "assistant.run" },
          _sum: { inputTokens: true, outputTokens: true },
        }),
        // An external call has no tool.call event; its first status is "prepared".
        db.$queryRaw<Array<{ runId: string; calls: number }>>`
          SELECT "runId", count(*)::int AS "calls"
          FROM "AssistantRunEvent"
          WHERE "runId" = ANY(${ids}::uuid[])
            AND ("type" = 'tool.call'
              OR ("type" = 'external.call.status'
                  AND "payload"->>'status' = 'prepared'))
          GROUP BY "runId"`,
      ])
    : [[], []];
  const eventful = new Set(
    ids.length
      ? (
          await db.assistantRunEvent.findMany({
            where: { runId: { in: ids } },
            distinct: ["runId"],
            select: { runId: true },
          })
        ).map((row) => row.runId)
      : [],
  );
  const tokensByRun = new Map(tokens.map((row) => [row.runId, row._sum]));
  const callsByRun = new Map(calls.map((row) => [row.runId, row.calls]));
  const usage: ConversationUsage = {
    model:
      providerModel(runs.at(-1)?.routeSnapshot) ??
      (await resolveLlmRoute(db, "assistant"))?.providerModelId ??
      null,
    totals: { replies: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    runs: {},
  };
  for (const run of runs) {
    const sum = tokensByRun.get(run.id);
    const toolCalls = eventful.has(run.id)
      ? (callsByRun.get(run.id) ?? 0)
      : null;
    usage.runs[run.id] = {
      model: providerModel(run.routeSnapshot),
      inputTokens: sum?.inputTokens ?? null,
      outputTokens: sum?.outputTokens ?? null,
      toolCalls,
      durationMs:
        run.startedAt && run.finishedAt
          ? run.finishedAt.getTime() - run.startedAt.getTime()
          : null,
    };
    if (run.status === "completed") usage.totals.replies += 1;
    usage.totals.toolCalls += toolCalls ?? 0;
    usage.totals.inputTokens += sum?.inputTokens ?? 0;
    usage.totals.outputTokens += sum?.outputTokens ?? 0;
  }
  return usage;
}

"use client";

import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { ToolRow } from "~/lib/assistant/liveMessage";
import { ToolActivity } from "./ToolActivity";

export function ExternalRunActivity({
  runId,
  active = false,
  enabled = true,
  live = [],
}: {
  runId: string;
  active?: boolean;
  enabled?: boolean;
  live?: ToolRow[];
}) {
  const [after, setAfter] = useState<string>();
  const [earlier, setEarlier] = useState<ToolRow[]>([]);
  const query = api.externalMcp.listCalls.useQuery(
    { runId, after },
    { enabled, refetchInterval: active ? 2000 : false, staleTime: 0 },
  );
  const { refetch } = query;
  useEffect(() => {
    if (enabled) void refetch();
  }, [active, enabled, refetch]);
  const rows =
    !enabled || query.error
      ? []
      : (query.data?.calls ?? []).map(
          (call) =>
            ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              callId: call.callId,
              connectionId: call.connectionId,
              connectionName: call.connectionName,
              externalStatus: call.status,
              input: null,
              ok: ["prepared", "dispatched"].includes(call.status)
                ? null
                : call.status === "completed",
              summary: call.summary,
            }) satisfies ToolRow,
        );
  const tools = new Map(live.map((row) => [row.callId ?? row.toolCallId, row]));
  for (const row of [...(query.error ? [] : earlier), ...rows]) {
    const current = tools.get(row.callId!);
    // Durable terminal state wins; newer live dispatch/approval beats a stale prepared read.
    if (
      !current ||
      ["completed", "failed", "unknown", "denied"].includes(
        row.externalStatus!,
      ) ||
      (row.externalStatus === "dispatched" &&
        ["prepared", "pending", "approved"].includes(
          current.externalStatus ?? "",
        ))
    )
      tools.set(row.callId!, row);
  }
  if (enabled && query.error)
    return (
      <p role="alert">
        Couldn’t load external call outcomes.{" "}
        <button onClick={() => void query.refetch()}>Retry</button>
      </p>
    );
  return (
    <>
      <ToolActivity tools={[...tools.values()]} />
      {query.data?.nextAfter ? (
        <button
          type="button"
          onClick={() => {
            setEarlier([...earlier, ...rows]);
            setAfter(query.data.nextAfter ?? undefined);
          }}
        >
          Load more call outcomes
        </button>
      ) : null}
    </>
  );
}

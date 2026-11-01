"use client";
import { useRef } from "react";
import type { ExternalApprovalView } from "@weaver/core/externalMcp/types";
import { Button } from "~/components/ui/button";
import { api } from "~/trpc/react";

export function ExternalToolApprovalCard({
  approval,
  onDecide,
  pending,
}: {
  approval: ExternalApprovalView;
  onDecide: (id: string, decision: "approve" | "deny") => void;
  pending: boolean;
}) {
  return (
    <section
      aria-label="External tool approval"
      className="border-line bg-subtle rounded border p-3 text-[12px]"
    >
      <p className="font-medium">
        {approval.connectionName} · {approval.toolName}
      </p>
      <p>
        {approval.effect === "write"
          ? "Writes to the external service"
          : "Reads from the external service"}{" "}
        · {approval.status}
      </p>
      <p>
        Expires <time dateTime={approval.expiresAt}>{approval.expiresAt}</time>
      </p>
      <p>Approve from the browser session that sent this message.</p>
      <details>
        <summary>Complete arguments</summary>
        <pre className="overflow-auto break-all whitespace-pre-wrap">
          {approval.arguments === null
            ? "Arguments are no longer available."
            : JSON.stringify(approval.arguments, null, 2)}
        </pre>
      </details>
      {approval.status === "pending" ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending || approval.arguments === null}
            onClick={() => onDecide(approval.id, "approve")}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onDecide(approval.id, "deny")}
          >
            Deny
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function ExternalApproval({
  id,
  runId,
  conversationId,
}: {
  id: string;
  runId: string;
  conversationId: string;
}) {
  const utils = api.useUtils();
  const locked = useRef(false);
  const detail = api.externalMcp.getApproval.useQuery(
    { id },
    { refetchInterval: 5_000 },
  );
  const refresh = () => {
    locked.current = false;
    void utils.externalMcp.getApproval.invalidate({ id });
    void utils.externalMcp.listApprovals.invalidate({ runId });
    void utils.assistant.getConversationStatus.invalidate({ conversationId });
    void utils.assistant.getConversation.invalidate({ conversationId });
  };
  const decide = api.externalMcp.decideApproval.useMutation({
    onSettled: refresh,
  });
  if (detail.error)
    return (
      <p role="alert">
        Approval unavailable. Open the browser session that sent this message;
        approvals are tied to that session.{" "}
        <button type="button" onClick={() => void detail.refetch()}>
          Retry
        </button>
      </p>
    );
  if (!detail.data) return <p role="status">Loading approval…</p>;
  return (
    <div>
      <ExternalToolApprovalCard
        approval={detail.data}
        pending={decide.isPending || detail.isFetching}
        onDecide={(approvalId, decision) => {
          if (
            locked.current ||
            detail.isFetching ||
            detail.data.status !== "pending"
          )
            return;
          locked.current = true;
          decide.mutate({ id: approvalId, decision });
        }}
      />
      {decide.error ? <p role="alert">{decide.error.message}</p> : null}
    </div>
  );
}

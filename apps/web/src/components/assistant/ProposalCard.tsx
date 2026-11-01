"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { projectRoleAtLeast } from "@weaver/core/roles";
import type { ProposalView } from "@weaver/core/services/assistantProposals";
import { Button } from "~/components/ui/button";
import { humanAssistantError } from "~/lib/assistant/conversationErrors";
import {
  acceptErrorAction,
  clientNow,
  isProposalExpired,
  parsePreview,
  proposalKindLabel,
} from "~/lib/assistant/proposalPreview";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { confirmNavigation } from "~/lib/use-unsaved-changes-guard";
import { withBasePath } from "~/lib/basePath";
import { useMounted } from "~/lib/use-mounted";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { DocumentDiffPreview } from "./previews/DocumentDiffPreview";
import { LifecyclePreview } from "./previews/LifecyclePreview";
import { TableCreatePreview } from "./previews/TableCreatePreview";
import { TableDiffPreview } from "./previews/TableDiffPreview";

const STATUS_LABELS: Record<ProposalView["status"], string> = {
  pending: "Pending",
  accepting: "Applying",
  accepted: "Accepted",
  rejected: "Rejected",
  conflicted: "Conflicted",
  expired: "Expired",
};

/** Terminal states have to read differently at a glance, not just in words. */
const STATUS_TONES: Record<ProposalView["status"], string> = {
  pending: "border-review-border bg-review-bg text-review",
  accepting: "border-info-border bg-info-bg text-info",
  accepted: "border-approved-border bg-approved-bg text-approved",
  rejected: "border-line bg-subtle text-text-muted",
  conflicted: "border-danger-border bg-danger-bg text-danger",
  expired: "border-line-faint bg-surface-2 text-text-3",
};

// A restore and an item lifecycle action are generic over both resource types,
// so the kind names the one it targets; without that a table would link to
// /documents/<tableId>.
const isExamProposal = (kind: ProposalView["kind"]) => kind.startsWith("exam.");

const isTableProposal = (kind: ProposalView["kind"]) =>
  kind.startsWith("table.") ||
  kind === "content.restore.table" ||
  kind.endsWith(".table");

function targetHref(proposal: {
  kind: ProposalView["kind"];
  projectId: string;
  resourceId: string | null;
}): string | null {
  if (!proposal.resourceId) return null;
  // A delete's target is gone the moment it is accepted, so the link would 404.
  if (proposal.kind.startsWith("content.lifecycle.item_delete")) return null;
  const project = encodeURIComponent(proposal.projectId);
  const area = isExamProposal(proposal.kind)
    ? "exams"
    : isTableProposal(proposal.kind)
      ? "tables"
      : "documents";
  return `/projects/${project}/${area}/${encodeURIComponent(proposal.resourceId)}`;
}

function Preview({ proposal }: { proposal: ProposalView }) {
  const preview = parsePreview(proposal.preview);
  switch (preview.kind) {
    case "document":
      return (
        <DocumentDiffPreview
          lines={preview.lines}
          truncated={preview.truncated}
        />
      );
    case "table-diff":
      return (
        <TableDiffPreview
          diff={preview.diff}
          columns={preview.columns}
          truncated={preview.truncated}
        />
      );
    case "table-create":
      return (
        <TableCreatePreview
          columns={preview.columns}
          rowCount={preview.rowCount}
          sampleRows={preview.sampleRows}
          truncated={preview.truncated}
        />
      );
    case "lifecycle":
      return (
        <LifecyclePreview
          action={preview.action}
          resourceType={preview.resourceType}
          from={preview.from}
          to={preview.to}
          title={preview.title}
          affected={preview.affected}
          truncated={preview.truncated}
        />
      );
    case "unknown":
      // Accept stays available — blocking would strand the proposal with no
      // way to resolve it — but the preview IS the confirmation here, so say
      // plainly that it is missing rather than staying neutral about it.
      return (
        <p className="border-line text-text-muted m-0 rounded-md border border-dashed px-2 py-1.5 text-[12px]">
          No preview is available — accepting will commit a change you cannot
          review here.
        </p>
      );
  }
}

export function ProposalCard({
  proposal: summary,
}: {
  proposal: ProposalView;
}) {
  const detail = api.assistant.getProposal.useQuery(
    { proposalId: summary.id },
    { enabled: summary.preview == null },
  );
  const proposal = {
    ...summary,
    preview: detail.data?.preview ?? summary.preview,
  };
  const utils = api.useUtils();
  const router = useRouter();
  const mounted = useMounted();
  const isExam = isExamProposal(proposal.kind);
  const isTable = isTableProposal(proposal.kind);
  const hasResource = Boolean(proposal.resourceId) && !isExam;
  const targetLabel = isExam ? "exam" : isTable ? "table" : "document";
  const conflictMessage = isExam
    ? "The exam changed since this was proposed, so nothing was saved."
    : "The content changed since this was proposed, so nothing was written.";

  const project = api.project.get.useQuery({ projectId: proposal.projectId });
  const references = api.document.resolveRefs.useQuery(
    {
      projectId: proposal.projectId,
      ids: proposal.resourceId ? [proposal.resourceId] : [],
    },
    { enabled: hasResource },
  );
  const reference = hasResource ? references.data?.[0] : undefined;
  const title = reference?.exists ? reference.title : undefined;

  // Undefined while `project.get` is in flight, so a Viewer never sees Accept
  // through a loading gap; the server rechecks Editor (exams: trainer) on accept.
  const access = dataUnlessAccessError(project.data, project.error);
  const canAccept = isExam
    ? access?.myTrainingRole === "trainer"
    : access?.myRole
      ? projectRoleAtLeast(access.myRole, "Editor")
      : false;

  const expired = isProposalExpired(proposal, clientNow(mounted));
  const displayStatus =
    expired && proposal.status === "pending" ? "expired" : proposal.status;
  const accepting = proposal.status === "accepting";
  const pending = (proposal.status === "pending" && !expired) || accepting;
  const href = targetHref(proposal);

  const refresh = () => {
    void utils.assistant.getProposal.invalidate({ proposalId: proposal.id });
    void utils.assistant.listProposals.invalidate({
      conversationId: proposal.conversationId,
    });
    void utils.assistant.getConversation.invalidate({
      conversationId: proposal.conversationId,
    });
  };

  // Accepting commits to the target, and a conflict means someone else already
  // did: a reader sitting on that document/table page would otherwise keep the
  // pre-commit content until it navigated away.
  const refreshTarget = (resourceId: string | null) => {
    if (isExam) {
      void utils.exam.invalidate();
      return;
    }
    if (!resourceId) return;
    if (isTable)
      void utils.table.get.invalidate({
        projectId: proposal.projectId,
        tableId: resourceId,
      });
    else
      void utils.document.get.invalidate({
        projectId: proposal.projectId,
        documentId: resourceId,
      });
  };

  const accept = api.assistant.acceptProposal.useMutation({
    onSuccess: (result) => {
      refresh();
      if (result.status === "accepted") {
        refreshTarget(result.resourceId);
        const target = targetHref(result);
        toast.success(
          "Proposal accepted",
          target
            ? {
                action: {
                  label: `Open ${targetLabel}`,
                  onClick: () => {
                    if (confirmNavigation(withBasePath(target)))
                      router.push(target);
                  },
                },
              }
            : undefined,
        );
      } else if (result.status === "conflicted") {
        refreshTarget(result.resourceId);
        toast.error(conflictMessage);
      } else {
        toast.error("This proposal expired before it could be applied.");
      }
    },
    onError: (error) => {
      const action = acceptErrorAction(error.data?.code, error.message);
      if (action.toast) toast.error(action.toast);
      if (action.refreshProposal) refresh();
      // Without this the stale `myRole` keeps `canAccept` true, leaving Accept
      // on the card to repeat the identical failure on the next click.
      if (action.refreshRole)
        void utils.project.get.invalidate({ projectId: proposal.projectId });
    },
  });

  const reject = api.assistant.rejectProposal.useMutation({
    onSuccess: refresh,
    onError: (error) => {
      if (error.data?.code === "CONFLICT") refresh();
      else
        toast.error(
          humanAssistantError(error.message, "Couldn’t reject the proposal"),
        );
    },
  });

  const busy =
    accept.isPending ||
    reject.isPending ||
    (summary.preview == null && detail.isPending);

  return (
    <article
      aria-busy={busy}
      aria-label={`${proposalKindLabel(proposal.kind)} proposal`}
      data-proposal-id={proposal.id}
      data-proposal-pending={pending ? "true" : undefined}
      className="border-line bg-surface-2 flex flex-col gap-2 rounded-md border p-2.5"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <span className="text-text font-medium">
          {proposalKindLabel(proposal.kind)}
        </span>
        {title ? (
          <span className="text-text-2 min-w-0 truncate">{title}</span>
        ) : null}
        {project.data ? (
          <span className="text-text-muted min-w-0 truncate">
            · {project.data.name}
          </span>
        ) : null}
        <span
          data-proposal-status={displayStatus}
          className={cn(
            "ml-auto rounded-full border px-1.5 py-0.5 text-[11px]",
            STATUS_TONES[displayStatus],
          )}
        >
          {STATUS_LABELS[displayStatus]}
        </span>
      </header>

      <p className="text-text m-0 text-[13px]">{proposal.summary}</p>

      <Preview proposal={proposal} />

      <footer className="text-text-2 flex flex-wrap items-center gap-2 text-[12px]">
        {pending ? (
          <>
            {canAccept ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => accept.mutate({ proposalId: proposal.id })}
              >
                {accepting ? "Retry acceptance" : "Accept"}
              </Button>
            ) : (
              <span className="text-text-muted">
                {isExam
                  ? "You need the trainer role to accept this."
                  : "You need Editor access to accept this."}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => reject.mutate({ proposalId: proposal.id })}
            >
              Reject
            </Button>
            {busy ? (
              // Accepting takes the project lock and commits, so it is not
              // instant — say which decision is in flight.
              <span role="status" className="text-text-muted">
                {accept.isPending ? "Applying…" : "Rejecting…"}
              </span>
            ) : null}
          </>
        ) : null}

        {proposal.status === "accepted" ? (
          <span className="text-approved">
            {isExam
              ? `Accepted · revision ${proposal.resolution?.revision ?? "unknown"}`
              : `Accepted · commit ${proposal.resolution?.commitSha?.slice(0, 7) ?? "unknown"}`}
          </span>
        ) : null}

        {proposal.status === "conflicted" ? (
          <span className="text-danger">{conflictMessage}</span>
        ) : null}

        {displayStatus === "expired" ? (
          <span className="text-text-muted">
            Expired
            {mounted ? ` on ${proposal.expiresAt.toLocaleDateString()}` : ""}
          </span>
        ) : null}

        {href && !pending ? (
          <Link className="text-brand-text underline" href={href}>
            {proposal.status === "conflicted"
              ? "Open current version"
              : `Open ${targetLabel}`}
          </Link>
        ) : null}
      </footer>
    </article>
  );
}

export function ProposalCards({
  conversationId,
  proposalIds,
}: {
  conversationId: string;
  messageId: string | null;
  proposalIds: string[];
}) {
  const query = api.assistant.listProposals.useQuery(
    { conversationId },
    { enabled: proposalIds.length > 0 },
  );
  const byId = new Map((query.data ?? []).map((p) => [p.id, p]));
  const shown = proposalIds.flatMap((id) => {
    const proposal = byId.get(id);
    return proposal ? [proposal] : [];
  });
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { projectRoleAtLeast } from "@weaver/core/roles";
import type {
  WikiRunDetail,
  WikiRunRow,
} from "@weaver/core/services/wikiRunViews";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ClientDate } from "~/components/ui/client-date";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  dataUnlessAccessError,
  isQueryAccessError,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { WikiTabs } from "./WikiTabs";
import {
  wikiCost,
  wikiDuration,
  wikiRunOutcome,
  wikiRunStatusLabel,
  wikiSkipReason,
  wikiVersionHref,
} from "./wikiRunPresentation";

const ACTIVE_POLL_MS = 5_000;
const ACTIVE = new Set(["preparing", "queued", "running"]);

function RunRow({ run, onOpen }: { run: WikiRunRow; onOpen: () => void }) {
  const outcome = wikiRunOutcome(run);
  return (
    <li className="border-line flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-3 last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="text-text min-w-40 text-left text-[13px] font-medium hover:underline"
      >
        {run.kind} · {run.trigger}
      </button>
      <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
        {wikiRunStatusLabel(run.status)}
      </Badge>
      <span className="text-text-2 text-[12px]">
        {run.startedBy ?? "Schedule"} · <ClientDate value={run.startedAt} />
        {run.endedAt ? ` · ${wikiDuration(run.startedAt, run.endedAt)}` : ""}
      </span>
      <span className="text-text-2 text-[12px]">
        {run.items} inputs · {run.pagesCreated} created · {run.pagesPatched}{" "}
        patched
      </span>
      <span className="text-text-2 text-[12px]">
        {run.usageTokens.toLocaleString("en-US")} tokens ·{" "}
        {wikiCost(run.costMicros, run.currency)}
        {run.indexingCostMicros === null
          ? ""
          : ` · indexing ${wikiCost(run.indexingCostMicros, run.currency)}`}
      </span>
      {outcome ? (
        <span className="text-text-2 w-full text-[12px]">{outcome}</span>
      ) : null}
    </li>
  );
}

function RunDetail({
  projectId,
  run,
  canEdit,
  onRevert,
  onCancel,
  busy,
}: {
  projectId: string;
  run: WikiRunDetail;
  canEdit: boolean;
  onRevert: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const outcome = wikiRunOutcome(run);
  return (
    <div className="space-y-4 text-[13px]">
      {outcome ? <p className="text-text-2">{outcome}</p> : null}
      {run.summary ? (
        <section>
          <h3 className="text-text font-semibold">
            Summary
            {run.summaryByAgent ? (
              <span className="text-text-2 ml-2 text-[12px] font-normal">
                written by the agent
              </span>
            ) : null}
          </h3>
          <p className="text-text-2 whitespace-pre-wrap">{run.summary}</p>
        </section>
      ) : null}
      {run.inputs.length > 0 ? (
        <section>
          <h3 className="text-text font-semibold">Inputs</h3>
          <ul className="space-y-1">
            {run.inputs.map((input) => (
              <li key={input.id} className="text-text-2">
                <span className="text-text">{input.title}</span> ·{" "}
                {input.status}
                {input.outcomeNote ? (
                  <span className="block text-[12px]">
                    {input.outcomeNote}
                    <span className="ml-1 italic">written by the agent</span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {run.commits.length > 0 ? (
        <section>
          <h3 className="text-text font-semibold">Commits</h3>
          <ul className="space-y-1">
            {run.commits.map((commit) => (
              <li
                key={commit.n}
                className="text-text-2 flex flex-wrap items-center gap-2"
              >
                {commit.documentId && commit.baseCommitSha ? (
                  <Link
                    className="hover:underline"
                    href={wikiVersionHref(
                      projectId,
                      commit.documentId,
                      commit.baseCommitSha,
                    )}
                  >
                    {commit.path ?? commit.documentId}
                  </Link>
                ) : (
                  <span>{commit.path ?? commit.toolName}</span>
                )}
                <code className="text-[11px]">
                  {commit.commitSha.slice(0, 7)}
                </code>
                {commit.verified && run.kind !== "revert" ? (
                  <Badge variant="secondary">Wiki agent</Badge>
                ) : null}
                {!commit.verified ? (
                  <Badge variant="outline">Not verified</Badge>
                ) : null}
                {commit.indexingPending ? (
                  <span className="text-[12px]">indexing pending</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {run.report && run.report.skipped.length > 0 ? (
        <section>
          <h3 className="text-text font-semibold">Not reverted</h3>
          <ul className="space-y-1">
            {run.report.skipped.map((skip) => (
              <li key={skip.documentId} className="text-text-2">
                {skip.path ?? skip.documentId}: {wikiSkipReason(skip.reason)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {canEdit ? (
        <DialogFooter>
          {ACTIVE.has(run.status) ? (
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              Cancel run
            </Button>
          ) : null}
          {run.revertible ? (
            <Button variant="destructive" disabled={busy} onClick={onRevert}>
              Revert run
            </Button>
          ) : null}
        </DialogFooter>
      ) : null}
    </div>
  );
}

export function WikiRunsScreen({ projectId }: { projectId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const utils = api.useUtils();
  const projectQuery = api.project.get.useQuery({ projectId });
  const project = dataUnlessAccessError(projectQuery.data, projectQuery.error);
  const runsQuery = api.wiki.runs.useQuery(
    { projectId },
    {
      refetchInterval: (query) =>
        query.state.data?.runs.some((run) => ACTIVE.has(run.status))
          ? ACTIVE_POLL_MS
          : false,
    },
  );
  const runs = dataUnlessAccessError(runsQuery.data, runsQuery.error);
  const usageQuery = api.wiki.usage.useQuery({ projectId });
  const usage = dataUnlessAccessError(usageQuery.data, usageQuery.error);
  const detailQuery = api.wiki.run.useQuery(
    { projectId, runId: openId ?? "" },
    { enabled: openId !== null },
  );
  const detail = dataUnlessAccessError(detailQuery.data, detailQuery.error);
  const refresh = () =>
    Promise.all([
      utils.wiki.runs.invalidate({ projectId }),
      utils.wiki.run.invalidate(),
      utils.wiki.input.list.invalidate({ projectId }),
    ]);
  const revert = api.wiki.revertRun.useMutation({
    onSuccess: async () => {
      toast.success("Revert started");
      setConfirming(false);
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const cancel = api.wiki.cancelRun.useMutation({
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const maintenance = api.wiki.runMaintenance.useMutation({
    onSuccess: async () => {
      toast.success("Maintenance started");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  if (isQueryAccessError(runsQuery.error))
    return (
      <p className="text-text-2 p-6 text-[13px]">
        You do not have access to this project.
      </p>
    );
  const canEdit = projectRoleAtLeast(project?.myRole ?? "Viewer", "Editor");

  return (
    <div className="flex h-full flex-col">
      <WikiTabs projectId={projectId} active="runs" />
      <div className="space-y-4 overflow-auto p-6">
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={maintenance.isPending}
              onClick={() => maintenance.mutate({ projectId })}
            >
              Run maintenance now
            </Button>
            <span className="text-text-3 text-[12px]">
              Checks links, recent changes and stale pages and writes a report.
              Once an hour at most.
            </span>
          </div>
        ) : null}
        {usage ? (
          <p className="text-text-2 text-[12px]">
            Last 30 days: {usage.tokens.toLocaleString("en-US")} tokens ·{" "}
            {wikiCost(usage.costMicros, usage.currency)}
            {usage.indexingCostMicros === null
              ? ""
              : ` · indexing ${wikiCost(usage.indexingCostMicros, usage.currency)}`}
          </p>
        ) : null}
        {runs?.runs.length === 0 ? (
          <p className="text-text-2 text-[13px]">No runs yet.</p>
        ) : (
          <ul>
            {runs?.runs.map((run) => (
              <RunRow key={run.id} run={run} onOpen={() => setOpenId(run.id)} />
            ))}
          </ul>
        )}
      </div>
      <Dialog
        open={openId !== null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Wiki run</DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.kind} · ${wikiRunStatusLabel(detail.status)}`
                : "Loading"}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <RunDetail
              projectId={projectId}
              run={detail}
              canEdit={canEdit}
              busy={revert.isPending || cancel.isPending}
              onRevert={() => setConfirming(true)}
              onCancel={() => cancel.mutate({ projectId, runId: detail.id })}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revert this run?</DialogTitle>
            <DialogDescription>
              Pages the run created are removed and pages it changed go back to
              how they were, under your name. A page someone edited since, or a
              later run changed, is left alone and listed afterwards. Source
              pages are not touched, and the inputs wait under Needs attention.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep the run
            </Button>
            <Button
              variant="destructive"
              disabled={revert.isPending || openId === null}
              onClick={() =>
                openId && revert.mutate({ projectId, runId: openId })
              }
            >
              Revert run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

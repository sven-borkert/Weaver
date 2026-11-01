"use client";

import { useState } from "react";
import { toast } from "sonner";

import { describeGenerationEmbedding } from "@weaver/core/knowledge/generationEmbedding";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  knowledgeStatusLifecycle,
  outdatedExtractionMessage,
  runFailedKnowledgeRetry,
} from "~/lib/knowledge/operations";
import { useMounted } from "~/lib/use-mounted";
import { api, type RouterOutputs } from "~/trpc/react";

type KnowledgeStatus = RouterOutputs["knowledge"]["status"];
type GenerationStatus = NonNullable<KnowledgeStatus["activeGeneration"]>;
type RetryReceipt = {
  retried: number;
  outcome: "complete" | "stalled";
};

export function KnowledgeIndexCard({ projectId }: { projectId: string }) {
  const mounted = useMounted();
  const utils = api.useUtils();
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [rebuildError, setRebuildError] = useState<string>();
  const [retryError, setRetryError] = useState<string>();
  const [acceptedGenerationId, setAcceptedGenerationId] = useState<string>();
  const [retryReceipt, setRetryReceipt] = useState<RetryReceipt>();

  const status = api.knowledge.status.useQuery(
    { projectId },
    {
      retry: false,
      refetchInterval: (query) =>
        knowledgeStatusLifecycle({
          data: query.state.data,
          error: query.state.error,
        }).refetchInterval,
    },
  );
  const rebuild = api.knowledge.rebuild.useMutation();
  const retryFailed = api.knowledge.retryFailed.useMutation();

  const { accessError, snapshot } = knowledgeStatusLifecycle({
    data: status.data,
    error: status.error,
  });

  async function refreshKnowledgeQueries() {
    try {
      await Promise.all([
        utils.knowledge.status.invalidate({ projectId }),
        utils.knowledge.readiness.invalidate({ projectId }),
      ]);
    } catch {
      // Query state presents refresh failures without changing mutation receipts.
    }
  }

  async function requestRebuild() {
    setRebuildError(undefined);

    let result: { generationId: string };
    try {
      result = await rebuild.mutateAsync({ projectId });
    } catch (error) {
      setRebuildError(safeOperationError(error, "Could not request a rebuild"));
      return;
    }

    setAcceptedGenerationId(result.generationId);
    setRebuildOpen(false);
    toast.success("Knowledge rebuild requested");
    await refreshKnowledgeQueries();
  }

  async function requestRetry() {
    setRetryError(undefined);

    let result: RetryReceipt;
    try {
      result = await runFailedKnowledgeRetry(async (cursor) => {
        const page = await retryFailed.mutateAsync({
          projectId,
          ...(cursor ? { cursor } : {}),
        });
        return { ...page, nextCursor: page.nextCursor ?? null };
      });
    } catch (error) {
      setRetryError(
        safeOperationError(error, "Could not retry failed knowledge work"),
      );
      return;
    }

    setRetryReceipt(result);
    setRetryOpen(false);
    toast.success(
      result.outcome === "complete"
        ? "Failed knowledge work queued for retry"
        : "Knowledge retry stopped before all work was queued",
    );
    await refreshKnowledgeQueries();
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Knowledge index</CardTitle>
          <CardDescription>
            Inspect search and graph health or request bounded maintenance.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status.error ? (
            <StatusRefreshError
              hasSnapshot={Boolean(snapshot)}
              accessError={accessError}
              retrying={status.isFetching}
              onRetry={() => void status.refetch()}
            />
          ) : null}

          {!snapshot && status.isLoading ? (
            <p className="text-text-3 m-0 text-[13px]" role="status">
              Loading knowledge status…
            </p>
          ) : null}

          {snapshot ? (
            <KnowledgeStatusSnapshot status={snapshot} mounted={mounted} />
          ) : null}

          {acceptedGenerationId ? (
            <div
              className="border-info-border bg-info-bg text-info rounded-lg border px-3 py-2 text-[12px]"
              role="status"
            >
              Rebuild accepted for generation{" "}
              <span className="font-mono break-all">
                {acceptedGenerationId}
              </span>
              . The current active generation remains available while it builds.
            </div>
          ) : null}

          {retryReceipt ? (
            <div
              className={
                retryReceipt.outcome === "stalled"
                  ? "border-danger-border bg-danger-bg text-danger flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12px]"
                  : "border-info-border bg-info-bg text-info rounded-lg border px-3 py-2 text-[12px]"
              }
              role="status"
            >
              <span>
                {retryReceipt.outcome === "complete"
                  ? `${retryReceipt.retried} failed item${retryReceipt.retried === 1 ? "" : "s"} accepted for retry.`
                  : `Retry stopped before all failed work was accepted. ${retryReceipt.retried} item${retryReceipt.retried === 1 ? "" : "s"} accepted; use manual Retry to continue safely.`}
              </span>
              {retryReceipt.outcome === "stalled" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retryFailed.isPending}
                  onClick={() => {
                    setRetryError(undefined);
                    setRetryOpen(true);
                  }}
                >
                  Manual Retry
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="border-line flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button
              variant="outline"
              disabled={retryFailed.isPending}
              onClick={() => {
                setRetryError(undefined);
                setRetryOpen(true);
              }}
            >
              {retryFailed.isPending ? "Retrying…" : "Retry failed work"}
            </Button>
            <Button
              disabled={rebuild.isPending || !snapshot?.readiness.aiConfigured}
              onClick={() => {
                setRebuildError(undefined);
                setRebuildOpen(true);
              }}
            >
              {rebuild.isPending ? "Requesting…" : "Rebuild knowledge"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={rebuildOpen}
        onOpenChange={(open) => {
          if (!rebuild.isPending) setRebuildOpen(open);
        }}
      >
        <DialogContent
          showCloseButton={!rebuild.isPending}
          aria-busy={rebuild.isPending}
        >
          <DialogHeader>
            <DialogTitle>Rebuild knowledge index?</DialogTitle>
            <DialogDescription>
              Git content is untouched. The active generation remains available
              while a shadow generation builds. Configured AI calls may run and
              incur cost.
            </DialogDescription>
          </DialogHeader>
          {rebuildError ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {rebuildError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={rebuild.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={rebuild.isPending}
              onClick={() => void requestRebuild()}
            >
              {rebuild.isPending ? "Requesting…" : "Request rebuild"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={retryOpen}
        onOpenChange={(open) => {
          if (!retryFailed.isPending) setRetryOpen(open);
        }}
      >
        <DialogContent
          showCloseButton={!retryFailed.isPending}
          aria-busy={retryFailed.isPending}
        >
          <DialogHeader>
            <DialogTitle>Retry failed knowledge work?</DialogTitle>
            <DialogDescription>
              Previously failed AI work may run again and configured AI calls
              may incur cost. Weaver retries bounded pages and stops if the
              server cannot make safe progress.
            </DialogDescription>
          </DialogHeader>
          {retryError ? (
            <p role="alert" className="text-danger m-0 text-[12px]">
              {retryError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={retryFailed.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={retryFailed.isPending}
              onClick={() => void requestRetry()}
            >
              {retryFailed.isPending ? "Retrying…" : "Retry failed work"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function KnowledgeStatusSnapshot({
  status,
  mounted,
}: {
  status: KnowledgeStatus;
  mounted: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <ReadinessLayer label="Keyword" value={status.readiness.keyword} />
        <ReadinessLayer label="Semantic" value={status.readiness.semantic} />
        <ReadinessLayer label="Graph" value={status.readiness.graph} />
      </div>

      <p className="text-text-2 m-0 text-[13px]">
        {status.readiness.aiConfigured
          ? "AI is configured. Semantic indexing and graph extraction may use configured AI calls."
          : "AI routing is not configured. Keyword search remains available; an administrator can assign knowledge models under Administration › Settings › AI."}
      </p>

      {outdatedExtractionMessage(
        status.outdatedExtraction,
        status.liveDocuments,
      ) ? (
        <p className="text-text-2 m-0 text-[13px]" role="note">
          {outdatedExtractionMessage(
            status.outdatedExtraction,
            status.liveDocuments,
          )}
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Live documents" value={status.liveDocuments} />
        <Metric label="Queued jobs" value={status.queue.queued} />
        <Metric label="Active jobs" value={status.queue.active} />
        <Metric
          label="Last completion"
          value={formatTimestamp(status.lastCompletedAt, mounted)}
        />
      </dl>

      <div className="grid gap-3 sm:grid-cols-2">
        <GenerationPanel
          label="Active generation"
          generation={status.activeGeneration}
          mounted={mounted}
        />
        <GenerationPanel
          label="Building generation"
          generation={status.buildingGeneration}
          mounted={mounted}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-text m-0 text-[13px] font-semibold">
            Recent failures
          </h3>
          <span className="text-text-muted text-[11px]">
            Up to 50 bounded safe summaries
          </span>
        </div>
        {status.failures.length === 0 ? (
          <p className="text-text-3 m-0 text-[12px]">
            No active or building knowledge failures.
          </p>
        ) : (
          <ul className="border-line m-0 max-h-56 overflow-y-auto rounded-lg border p-0">
            {status.failures.map((failure, index) => (
              <li
                key={`${failure.generationId}:${failure.documentId ?? "generation"}:${index}`}
                className="border-line-faint flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
              >
                <span className="text-text text-[12px] font-medium">
                  {failure.documentId ? "Document" : "Generation"} ·{" "}
                  {humanize(failure.status)} · {humanize(failure.kind)}
                </span>
                <span className="text-text-2 text-[12px] break-words">
                  {failure.summary}
                </span>
                <span className="text-text-muted text-[11px]">
                  {formatTimestamp(failure.occurredAt, mounted)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {status.failures.length === 50 ? (
          <p className="text-text-3 m-0 text-[11px]">
            The response is capped; additional failures may exist.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ReadinessLayer({ label, value }: { label: string; value: string }) {
  const stateClass =
    value === "ready"
      ? "border-approved-border bg-approved-bg text-approved"
      : value === "degraded"
        ? "border-danger-border bg-danger-bg text-danger"
        : "border-info-border bg-info-bg text-info";

  return (
    <div className={`rounded-lg border px-3 py-2 ${stateClass}`}>
      <span className="block text-[11px] font-medium">{label}</span>
      <span className="block text-[13px] font-semibold">{humanize(value)}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-text-muted text-[11px]">{label}</dt>
      <dd className="text-text m-0 mt-0.5 text-[13px] font-medium">{value}</dd>
    </div>
  );
}

function GenerationPanel({
  label,
  generation,
  mounted,
}: {
  label: string;
  generation: GenerationStatus | null;
  mounted: boolean;
}) {
  const headingId = `${label.toLowerCase().replaceAll(" ", "-")}-heading`;

  if (!generation) {
    return (
      <section
        aria-labelledby={headingId}
        className="border-line rounded-lg border p-3"
      >
        <h3 id={headingId} className="text-text m-0 text-[13px] font-semibold">
          {label}
        </h3>
        <p className="text-text-3 mt-1 mb-0 text-[12px]">None</p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="border-line flex flex-col gap-2 rounded-lg border p-3"
    >
      <h3 id={headingId} className="text-text m-0 text-[13px] font-semibold">
        {label}
      </h3>
      <p className="text-text-2 m-0 text-[12px]">
        {generation.documentReadyCount} ready · {generation.documentFailedCount}{" "}
        failed · {generation.documentTotal} total
      </p>
      {generation.graphCarried && generation.status === "building" ? (
        <p className="text-text-3 m-0 text-[12px]">
          Graph kept from the previous index
        </p>
      ) : null}
      <dl className="grid gap-1">
        <Metric
          label="Embedding"
          value={describeGenerationEmbedding(generation.embedding)}
        />
        <Metric
          label="Created"
          value={formatTimestamp(generation.createdAt, mounted)}
        />
        <Metric
          label="Completed"
          value={formatTimestamp(generation.completedAt, mounted)}
        />
      </dl>
    </section>
  );
}

function StatusRefreshError({
  hasSnapshot,
  accessError,
  retrying,
  onRetry,
}: {
  hasSnapshot: boolean;
  accessError: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className="border-danger-border bg-danger-bg text-danger flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12px]"
      role="alert"
    >
      <span>
        {accessError
          ? "Knowledge status is no longer available for this project."
          : hasSnapshot
            ? "Status refresh failed. The last accepted snapshot remains visible."
            : "Knowledge status could not be loaded."}
      </span>
      {!accessError ? (
        <Button
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? "Retrying…" : "Retry status"}
        </Button>
      ) : null}
    </div>
  );
}

function formatTimestamp(
  value: Date | string | null | undefined,
  mounted: boolean,
): string {
  if (!value) return "Not recorded";
  if (!mounted) return "Loading timestamp…";
  return new Date(value).toLocaleString();
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function safeOperationError(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object" || !("message" in error)) {
    return fallback;
  }
  const message = String(error.message).replace(/\s+/g, " ").trim();
  return (message || fallback).slice(0, 300);
}

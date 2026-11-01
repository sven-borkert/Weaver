"use client";

import Link from "next/link";
import { LocateFixed, Network } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import {
  graphCitationPresentation,
  graphDetailTruncationLabel,
} from "~/lib/knowledge/graphPresentation";
import type {
  GraphPresentationNode,
  GraphSelection,
} from "~/lib/knowledge/graphState";
import type { RouterOutputs } from "~/trpc/react";

type EntityDetail = RouterOutputs["graph"]["entityDetail"];
type RelationDetail = RouterOutputs["graph"]["relationDetail"];

export function GraphDetails({
  projectId,
  selection,
  entityDetail,
  relationDetail,
  loading,
  failed,
  onRetry,
  onFocus,
  onExpand,
  onSelect,
  focusRequest,
  expansionAtCapacity,
  graphActionLoading,
}: {
  projectId: string;
  selection?: GraphSelection;
  entityDetail?: EntityDetail;
  relationDetail?: RelationDetail;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onFocus: (node: GraphPresentationNode) => void;
  onExpand: (node: GraphPresentationNode) => void;
  onSelect: (selection: GraphSelection, requestDetailFocus: boolean) => void;
  focusRequest?: string;
  expansionAtCapacity: boolean;
  graphActionLoading: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const handledFocusRequest = useRef<string | undefined>(undefined);
  const detailReady = Boolean(
    entityDetail ?? relationDetail ?? (failed ? true : undefined),
  );

  useEffect(() => {
    if (
      !detailReady ||
      !focusRequest ||
      handledFocusRequest.current === focusRequest
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      handledFocusRequest.current = focusRequest;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailReady, focusRequest]);

  if (!selection) {
    return (
      <div className="p-4">
        <h2 className="text-text m-0 text-[15px] font-semibold">
          Graph details
        </h2>
        <p className="text-text-3 mt-2 mb-0 text-sm">
          Select an entity or relation to inspect its active provenance.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4" aria-busy="true">
        <h2 className="text-text m-0 text-[15px] font-semibold">
          Loading graph details
        </h2>
        <p role="status" className="text-text-3 mt-2 mb-0 text-sm">
          Loading the selected {selection.kind}.
        </p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="p-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-text m-0 text-[15px] font-semibold outline-none"
        >
          Graph details unavailable
        </h2>
        <div
          role="alert"
          className="border-danger-border bg-danger-bg text-danger mt-3 rounded-lg border p-3 text-sm"
        >
          <p className="m-0">
            The selected details could not be loaded. The graph remains
            available.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onRetry}
          >
            Retry details
          </Button>
        </div>
      </div>
    );
  }

  if (selection.kind === "entity" && entityDetail) {
    const { entity, mentions, truncated } = entityDetail;
    return (
      <div className="p-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-text m-0 text-lg font-semibold break-words outline-none"
        >
          {entity.canonicalName}
        </h2>
        <p className="text-text-3 mt-1 mb-0 text-xs">
          {entity.entityType} · {entity.projectName}
        </p>
        {entity.description ? (
          <p className="text-text-2 mt-3 mb-0 text-sm break-words">
            {entity.description}
          </p>
        ) : null}
        {entity.aliases.length > 0 ? (
          <p className="text-text-3 mt-3 mb-0 text-xs break-words">
            <span className="text-text-2 font-medium">Aliases:</span>{" "}
            {entity.aliases.join(", ")}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Focus ${entity.canonicalName}`}
            onClick={() => onFocus(entity)}
          >
            <LocateFixed aria-hidden />
            Focus
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Expand ${entity.canonicalName}`}
            disabled={expansionAtCapacity || graphActionLoading}
            title={
              expansionAtCapacity
                ? "Expand is unavailable because the graph reached the 100-entity or 200-relation limit. Focus remains available."
                : graphActionLoading
                  ? "Expand is unavailable while another graph action is running."
                  : undefined
            }
            onClick={() => onExpand(entity)}
          >
            <Network aria-hidden />
            Expand
          </Button>
        </div>
        {expansionAtCapacity ? (
          <p className="text-text-3 mt-2 mb-0 text-xs">
            Expand is unavailable because the graph reached the 100-entity or
            200-relation limit. Focus remains available.
          </p>
        ) : graphActionLoading ? (
          <p className="text-text-3 mt-2 mb-0 text-xs">
            Expand is unavailable while another graph action is running. Focus
            remains available.
          </p>
        ) : null}
        <CitationList
          projectId={projectId}
          heading={`Active mentions (${mentions.length})`}
          citations={mentions}
          truncationLabel={graphDetailTruncationLabel("mentions", truncated)}
        />
      </div>
    );
  }

  if (selection.kind === "relation" && relationDetail) {
    const { relation, evidence, truncated } = relationDetail;
    const relationName = `${relation.source.canonicalName} ${relation.relationType.replaceAll("_", " ")} ${relation.target.canonicalName}`;
    return (
      <div className="p-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-text m-0 text-lg font-semibold break-words outline-none"
        >
          {relationName}
        </h2>
        <p className="text-text-3 mt-1 mb-0 text-xs">
          Relation · {relation.projectName}
        </p>
        <div className="mt-4 grid gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-auto justify-start whitespace-normal"
            aria-label={`Inspect source entity ${relation.source.canonicalName} for relation ${relationName}`}
            onClick={(event) =>
              onSelect(
                { kind: "entity", id: relation.source.entityId },
                event.detail === 0,
              )
            }
          >
            Source: {relation.source.canonicalName}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto justify-start whitespace-normal"
            aria-label={`Inspect target entity ${relation.target.canonicalName} for relation ${relationName}`}
            onClick={(event) =>
              onSelect(
                { kind: "entity", id: relation.target.entityId },
                event.detail === 0,
              )
            }
          >
            Target: {relation.target.canonicalName}
          </Button>
        </div>
        <CitationList
          projectId={projectId}
          heading={`Active evidence (${evidence.length})`}
          citations={evidence}
          truncationLabel={graphDetailTruncationLabel("evidence", truncated)}
        />
      </div>
    );
  }

  return (
    <div className="p-4" aria-busy="true">
      <h2 className="text-text m-0 text-[15px] font-semibold">
        Loading graph details
      </h2>
    </div>
  );
}

function CitationList({
  projectId,
  heading,
  citations,
  truncationLabel,
}: {
  projectId: string;
  heading: string;
  citations: Array<{
    sourceCommitSha: string;
    headingPath: string[];
    excerpt: string;
    confidence: number;
    validFrom: Date | null;
    validTo: Date | null;
    navigation: {
      documentId: string;
      title: string;
      slug: string;
      path: string;
      navigationAnchor: string | null;
    } | null;
  }>;
  truncationLabel: string | null;
}) {
  return (
    <section className="mt-5" aria-label={heading}>
      <h3 className="text-text-2 m-0 text-xs font-semibold tracking-wide uppercase">
        {heading}
      </h3>
      {citations.length > 0 ? (
        <ul className="mt-2 space-y-3">
          {citations.map((citation, index) => {
            const presentation = graphCitationPresentation(projectId, citation);
            const content = (
              <>
                <span className="text-text block text-sm font-medium break-words">
                  {presentation.title}
                </span>
                {presentation.headingLabel ? (
                  <span className="text-text-3 mt-1 block text-xs break-words">
                    {presentation.headingLabel}
                  </span>
                ) : null}
              </>
            );
            return (
              <li
                key={`${citation.sourceCommitSha}:${citation.excerpt}:${index}`}
                className="border-line-faint bg-surface rounded-lg border p-3"
              >
                {presentation.href ? (
                  <Link
                    href={presentation.href}
                    className="focus-visible:ring-ring/50 hover:text-brand rounded-sm outline-none hover:underline focus-visible:ring-3"
                  >
                    {content}
                  </Link>
                ) : (
                  <span>{content}</span>
                )}
                <p className="text-text-3 mt-2 mb-0 text-xs">
                  Model-generated summary · Verify against the source
                </p>
                <p className="text-text-2 mt-1 mb-0 text-sm break-words">
                  {presentation.excerpt}
                </p>
                <p className="text-text-3 mt-2 mb-0 text-xs">
                  {presentation.confidenceLabel}
                  {presentation.temporalLabel
                    ? ` · ${presentation.temporalLabel}`
                    : ""}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-text-3 mt-2 mb-0 text-sm">
          No active provenance is available.
        </p>
      )}
      {truncationLabel ? (
        <p className="border-info-border bg-info-bg text-info mt-3 mb-0 rounded-lg border p-3 text-xs">
          {truncationLabel}
        </p>
      ) : null}
    </section>
  );
}

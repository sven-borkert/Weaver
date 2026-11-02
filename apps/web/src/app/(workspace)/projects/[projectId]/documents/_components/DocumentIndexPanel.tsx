"use client";

import { Cpu, Network, Orbit, TextSearch, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  indexLightLabel,
  type IndexLight,
} from "@weaver/core/documents/indexLight";
import { describeGenerationEmbedding } from "@weaver/core/knowledge/generationEmbedding";
import { Button } from "~/components/ui/button";
import { ClientDateTime } from "~/components/ui/client-date";
import { Skeleton } from "~/components/ui/skeleton";
import {
  documentIndexRefetchInterval,
  indexedVersionLabel,
} from "~/lib/knowledge/documentIndex";
import { graphHref } from "~/lib/knowledge/graphUrl";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type DocumentIndex = RouterOutputs["knowledge"]["document"];
type GenerationIndex = DocumentIndex["generations"][number];

const LIGHT_CLASS: Record<IndexLight, string> = {
  ready: "border-approved-border bg-approved-bg text-approved",
  failed: "border-danger-border bg-danger-bg text-danger",
  pending: "border-info-border bg-info-bg text-info",
  unavailable: "border-line text-text-3",
  skipped: "border-line text-text-3",
};

export function DocumentIndexPanel({
  projectId,
  documentId,
  currentSha,
  active,
}: {
  projectId: string;
  documentId: string;
  /** The version on screen; the panel polls until the index describes it. */
  currentSha: string;
  /** The rail mounts every tab, so the query runs only while this one is shown. */
  active: boolean;
}) {
  const query = api.knowledge.document.useQuery(
    { projectId, documentId },
    {
      enabled: active,
      refetchInterval: (current) =>
        documentIndexRefetchInterval(current.state.data, currentSha),
    },
  );

  if (query.data) {
    return <DocumentIndexDetails projectId={projectId} index={query.data} />;
  }
  if (query.error) {
    return (
      <div className="flex flex-col items-start gap-2 p-3">
        <p role="alert" className="text-danger m-0 text-[12px]">
          Could not load index details.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading index details" className="p-3">
      <span className="sr-only">Loading index details…</span>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="mt-3 h-20 w-full" />
      <Skeleton className="mt-3 h-28 w-full" />
    </div>
  );
}

function DocumentIndexDetails({
  projectId,
  index,
}: {
  projectId: string;
  index: DocumentIndex;
}) {
  const head = index.headCommitSha;
  const [primary, rebuild] = index.generations;
  const chunks = count(index.keyword.chunkCount, "chunk");

  return (
    <div className="flex flex-col gap-5 p-3">
      <IndexSection
        id="keyword"
        icon={TextSearch}
        title="Keyword"
        light={index.lights.keyword}
      >
        <Facts>
          <Fact label="Chunks">{chunks}</Fact>
          <Fact label="Version">
            {indexedVersionLabel(index.keyword.indexedSha, head)}
          </Fact>
          <Fact label="Attempts">{index.keyword.attempts}</Fact>
          <Fact label="Indexed">
            <Timestamp value={index.keyword.completedAt} />
          </Fact>
        </Facts>
        <Failure
          kind={index.keyword.failureKind}
          summary={index.keyword.failureSummary}
        />
      </IndexSection>

      {index.lights.semantic === "skipped" ? (
        <p className="text-text-2 m-0 text-[13px]">{index.lights.summary}</p>
      ) : null}
      {primary ? (
        <>
          <IndexSection
            id="semantic"
            icon={Orbit}
            title="Semantic"
            light={index.lights.semantic}
          >
            <Facts>
              <Fact label="Embedding">
                {describeGenerationEmbedding(primary.embedding)}
              </Fact>
              <Fact label="Embedded">
                {`${primary.document?.embeddedChunks ?? 0} of ${chunks}`}
              </Fact>
              <Fact label="Version">
                {indexedVersionLabel(
                  primary.document?.semanticIndexedSha ?? null,
                  head,
                )}
              </Fact>
            </Facts>
          </IndexSection>

          <IndexSection
            id="graph"
            icon={Network}
            title="Graph"
            light={index.lights.graph}
          >
            <GraphDetails
              projectId={projectId}
              documentId={index.documentId}
              head={head}
              generation={primary}
              graph={index.graph}
            />
          </IndexSection>

          <IndexSection id="processing" icon={Cpu} title="AI processing">
            <ProcessingFacts generation={primary} />
          </IndexSection>

          {rebuild ? (
            <IndexSection id="rebuild" icon={Cpu} title="Rebuild in progress">
              <Facts>
                <Fact label="Embedding">
                  {describeGenerationEmbedding(rebuild.embedding)}
                </Fact>
                <Fact label="Embedded">
                  {`${rebuild.document?.embeddedChunks ?? 0} of ${chunks}`}
                </Fact>
              </Facts>
              {rebuild.graphCarried ? (
                <p className="text-text-3 m-0 text-[12px]">
                  Graph kept from the previous index
                </p>
              ) : null}
              <ProcessingFacts generation={rebuild} />
            </IndexSection>
          ) : null}
        </>
      ) : (
        <p className="text-text-3 m-0 text-[12px]">
          AI indexing is not configured for this project yet, so there are no
          embeddings or graph entities. Keyword search works without it.
        </p>
      )}
    </div>
  );
}

function GraphDetails({
  projectId,
  documentId,
  head,
  generation,
  graph,
}: {
  projectId: string;
  documentId: string;
  head: string;
  generation: GenerationIndex;
  graph: DocumentIndex["graph"];
}) {
  const document = generation.document;
  const scope = { projectIds: [projectId], entityTypes: [], relationTypes: [] };

  return (
    <>
      <Facts>
        {document?.extractionModel ? (
          <Fact label="Model">{document.extractionModel}</Fact>
        ) : null}
        <Fact label="Version">
          {indexedVersionLabel(document?.graphIndexedSha ?? null, head)}
        </Fact>
        <Fact label="Extracted">
          {`${count(graph.entityTotal, "entity", "entities")} · ${count(graph.relationTotal, "relation")}`}
        </Fact>
      </Facts>
      {document?.extractionOutdated ? (
        <p className="text-text-2 m-0 text-[12px]" role="note">
          The graph was extracted with an older extraction model or prompt.
          Rebuilding the knowledge index re-extracts it.
        </p>
      ) : null}
      {graph.entities.length > 0 ? (
        <ul
          aria-label="Graph entities"
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
        >
          {graph.entities.map((entity) => (
            <li key={entity.id} className="min-w-0">
              <Link
                href={graphHref(projectId, { ...scope, focusId: entity.id })}
                title={`${entity.type} · ${count(entity.mentions, "mention")}`}
                className="border-line-faint hover:bg-hover focus-visible:ring-brand/50 inline-flex max-w-full items-baseline gap-1.5 rounded-[6px] border px-2 py-1 no-underline outline-none focus-visible:ring-3"
              >
                <span className="text-text truncate text-[12px]">
                  {entity.name}
                </span>
                <span className="text-text-muted shrink-0 text-[10px]">
                  {entity.type}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {graph.truncated ? (
        <p className="text-text-3 m-0 text-[11px]">
          Showing the {graph.entities.length} most-mentioned of{" "}
          {count(graph.entityTotal, "entity", "entities")}.
        </p>
      ) : null}
      {graph.generationId ? (
        <Link
          href={graphHref(projectId, { ...scope, documentId })}
          className="text-brand w-fit text-[12px] font-medium"
        >
          Open in graph
        </Link>
      ) : null}
    </>
  );
}

function ProcessingFacts({ generation }: { generation: GenerationIndex }) {
  const document = generation.document;
  if (!document) {
    return (
      <p className="text-text-3 m-0 text-[12px]">Not part of this index yet.</p>
    );
  }
  return (
    <>
      <Facts>
        <Fact label="Status">{humanize(document.status)}</Fact>
        <Fact label="Attempts">{document.attempts}</Fact>
        <Fact label="Last attempt">
          <Timestamp value={document.lastAttemptAt} />
        </Fact>
        <Fact label="Finished">
          <Timestamp value={document.completedAt} />
        </Fact>
      </Facts>
      <Failure kind={document.failureKind} summary={document.failureSummary} />
    </>
  );
}

function IndexSection({
  id,
  icon: Icon,
  title,
  light,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  light?: IndexLight;
  children: ReactNode;
}) {
  const headingId = `document-index-${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className="text-text-3 size-4" aria-hidden="true" />
        <h3 id={headingId} className="text-text m-0 text-[13px] font-semibold">
          {title}
        </h3>
        {light ? (
          <span
            data-light={light}
            className={cn(
              "ml-auto rounded-full border px-2 py-px text-[11px] font-medium",
              LIGHT_CLASS[light],
            )}
          >
            {humanize(indexLightLabel(light))}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
      {children}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-2 m-0 break-words">{children}</dd>
    </>
  );
}

function Failure({
  kind,
  summary,
}: {
  kind: string | null;
  summary: string | null;
}) {
  if (!summary) return null;
  return (
    <p className="border-danger-border bg-danger-bg text-danger m-0 rounded-lg border px-2.5 py-2 text-[12px] break-words">
      {kind ? `${humanize(kind)}: ` : null}
      {summary}
    </p>
  );
}

function Timestamp({ value }: { value: Date | null }) {
  return value ? <ClientDateTime value={value} /> : <>Not recorded</>;
}

function count(value: number, singular: string, plural = `${singular}s`) {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

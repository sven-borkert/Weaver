"use client";

import {
  Filter,
  LoaderCircle,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { knowledgeReadinessPresentation } from "~/lib/knowledge/graphPresentation";
import type {
  GraphPresentationNode,
  GraphPresentationState,
  GraphSelection,
} from "~/lib/knowledge/graphState";
import { remainingGraphCapacity } from "~/lib/knowledge/graphState";
import type { GraphUrlState } from "~/lib/knowledge/graphUrl";
import { cn } from "~/lib/utils";
import type { RouterOutputs } from "~/trpc/react";
import { GraphCanvas } from "./GraphCanvas";
import { GraphDetails } from "./GraphDetails";
import { GraphOutline } from "./GraphOutline";
import { GraphToolbar } from "./GraphToolbar";

type KnowledgeReadiness = RouterOutputs["knowledge"]["readiness"];
type ProjectList = RouterOutputs["project"]["list"];
type SeedSearch = RouterOutputs["graph"]["searchEntities"];
type DocumentSeeds = RouterOutputs["graph"]["fromDocument"];
type EntityDetail = RouterOutputs["graph"]["entityDetail"];
type RelationDetail = RouterOutputs["graph"]["relationDetail"];

type GraphDrawerState = {
  filtersOpen: boolean;
  detailsOpen: boolean;
};

type GraphFocusable = {
  isConnected: boolean;
  focus(options?: FocusOptions): void;
};

export function graphDrawerStateForLayout(
  narrowLayout: boolean,
  state: GraphDrawerState,
): GraphDrawerState {
  return narrowLayout ? state : { filtersOpen: false, detailsOpen: false };
}

export function graphDestinationFocusIdentity(urlState: GraphUrlState): string {
  if (urlState.focusId) return `focus:${urlState.focusId}`;
  if (urlState.documentId) return `document:${urlState.documentId}`;
  return "finder";
}

export function focusGraphDestination(input: {
  identity: string;
  handledIdentity: string | undefined;
  initialStateResolved: boolean;
  workspace: GraphFocusable | null;
}): string | undefined {
  if (
    !input.initialStateResolved ||
    input.identity === input.handledIdentity ||
    !input.workspace?.isConnected
  ) {
    return input.handledIdentity;
  }
  input.workspace.focus({ preventScroll: true });
  return input.identity;
}

export function restoreGraphDrawerFocus(input: {
  selectionIdentity: string | undefined;
  outlineControls: ReadonlyMap<string, GraphFocusable>;
  workspace: GraphFocusable | null;
}): "selection" | "workspace" | "none" {
  const selected = input.selectionIdentity
    ? input.outlineControls.get(input.selectionIdentity)
    : undefined;
  if (selected?.isConnected) {
    selected.focus({ preventScroll: true });
    return "selection";
  }
  if (input.workspace?.isConnected) {
    input.workspace.focus({ preventScroll: true });
    return "workspace";
  }
  return "none";
}

export function GraphWorkspace({
  projectName,
  urlState,
  readiness,
  projects,
  projectsUnavailable,
  rawSeedQuery,
  onRawSeedQueryChange,
  seedSearch,
  seedSearchLoading,
  seedSearchFailed,
  onRetrySeedSearch,
  documentSeeds,
  documentSeedsLoading,
  documentSeedsFailed,
  onRetryDocumentSeeds,
  graphState,
  neighborhoodLoading,
  neighborhoodFailed,
  focusNotFound,
  onRetryNeighborhood,
  graphAction,
  onExpand,
  onRetryExpand,
  onReset,
  selection,
  entityDetail,
  relationDetail,
  detailLoading,
  detailFailed,
  onRetryDetail,
  detailFocusRequest,
  onSelect,
  onFocus,
  entityTypeOptions,
  relationTypeOptions,
  onProjectIdsChange,
  onEntityTypesChange,
  onRelationTypesChange,
  initialStateResolved,
  statusAnnouncement,
}: {
  projectName: string;
  urlState: GraphUrlState;
  readiness: KnowledgeReadiness;
  projects: ProjectList;
  projectsUnavailable: boolean;
  rawSeedQuery: string;
  onRawSeedQueryChange: (query: string) => void;
  seedSearch?: SeedSearch;
  seedSearchLoading: boolean;
  seedSearchFailed: boolean;
  onRetrySeedSearch: () => void;
  documentSeeds?: DocumentSeeds;
  documentSeedsLoading: boolean;
  documentSeedsFailed: boolean;
  onRetryDocumentSeeds: () => void;
  graphState: GraphPresentationState | null;
  neighborhoodLoading: boolean;
  neighborhoodFailed: boolean;
  focusNotFound: boolean;
  onRetryNeighborhood: () => void;
  graphAction?: {
    kind: "expand" | "reset";
    status: "loading" | "failed";
    node?: GraphPresentationNode;
  };
  onExpand: (node: GraphPresentationNode) => void;
  onRetryExpand: () => void;
  onReset: () => void;
  selection?: GraphSelection;
  entityDetail?: EntityDetail;
  relationDetail?: RelationDetail;
  detailLoading: boolean;
  detailFailed: boolean;
  onRetryDetail: () => void;
  detailFocusRequest?: string;
  onSelect: (
    selection: GraphSelection | undefined,
    requestDetailFocus: boolean,
  ) => void;
  onFocus: (node: GraphPresentationNode) => void;
  entityTypeOptions: string[];
  relationTypeOptions: string[];
  onProjectIdsChange: (projectIds: string[]) => void;
  onEntityTypesChange: (entityTypes: string[]) => void;
  onRelationTypesChange: (relationTypes: string[]) => void;
  initialStateResolved: boolean;
  statusAnnouncement: string;
}) {
  const workspaceRef = useRef<HTMLElement>(null);
  const detailsDrawerTitleRef = useRef<HTMLHeadingElement>(null);
  const focusedDestinationIdentity = useRef<string | undefined>(undefined);
  const [fitRequest, setFitRequest] = useState(0);
  const [readyCanvasIdentity, setReadyCanvasIdentity] = useState<string>();
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const [detailsDrawerOpen, setDetailsDrawerOpen] = useState(false);
  const [detailsRailCollapsed, setDetailsRailCollapsed] = useState(false);
  const [narrowLayout, setNarrowLayout] = useState(false);
  const outlineControls = useRef(new Map<string, HTMLButtonElement>());
  const destinationFocusIdentity = graphDestinationFocusIdentity(urlState);

  useEffect(() => {
    if (
      !initialStateResolved ||
      focusedDestinationIdentity.current === destinationFocusIdentity
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      focusedDestinationIdentity.current = focusGraphDestination({
        identity: destinationFocusIdentity,
        handledIdentity: focusedDestinationIdentity.current,
        initialStateResolved,
        workspace: workspaceRef.current,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [destinationFocusIdentity, initialStateResolved]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1279px)");
    const update = () => {
      setNarrowLayout(query.matches);
      setFiltersDrawerOpen(
        (filtersOpen) =>
          graphDrawerStateForLayout(query.matches, {
            filtersOpen,
            detailsOpen: false,
          }).filtersOpen,
      );
      setDetailsDrawerOpen(
        (detailsOpen) =>
          graphDrawerStateForLayout(query.matches, {
            filtersOpen: false,
            detailsOpen,
          }).detailsOpen,
      );
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const selectionIdentity = selection
    ? `${selection.kind}:${selection.id}`
    : undefined;
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!selectionIdentity) setDetailsDrawerOpen(false);
      else if (narrowLayout) setDetailsDrawerOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [narrowLayout, selectionIdentity]);

  useEffect(() => {
    if (!detailFocusRequest) return;
    const frame = window.requestAnimationFrame(() => {
      if (narrowLayout) setDetailsDrawerOpen(true);
      else setDetailsRailCollapsed(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailFocusRequest, narrowLayout]);

  const readinessPresentation = knowledgeReadinessPresentation(readiness);
  const trimmedQuery = rawSeedQuery.trim();
  const showFinderSeeds = trimmedQuery.length >= 2;
  const seeds = useMemo(
    () =>
      showFinderSeeds
        ? (seedSearch?.entities ?? [])
        : trimmedQuery.length === 0 && urlState.documentId
          ? (documentSeeds?.entities ?? [])
          : [],
    [
      documentSeeds?.entities,
      seedSearch?.entities,
      showFinderSeeds,
      trimmedQuery.length,
      urlState.documentId,
    ],
  );
  const seedHeading = showFinderSeeds
    ? "Entity finder results"
    : "Entities from source document";
  const seedResponseTruncated = showFinderSeeds
    ? seedSearch?.truncated
    : trimmedQuery.length === 0
      ? documentSeeds?.truncated
      : false;
  const selectedNode =
    graphState && selection?.kind === "entity"
      ? graphState.nodes.find((node) => node.entityId === selection.id)
      : undefined;
  const capacity = graphState ? remainingGraphCapacity(graphState) : undefined;
  const expansionAtCapacity = Boolean(
    capacity && (capacity.maxNodes === 0 || capacity.maxEdges === 0),
  );
  const graphActionLoading = graphAction?.status === "loading";
  const canvasIdentity = graphState
    ? `${graphState.projectId}:${graphState.focusId}`
    : undefined;
  const canvasReady =
    canvasIdentity !== undefined && readyCanvasIdentity === canvasIdentity;
  const statusParts = [
    seedSearchLoading ? "Searching for entities." : "",
    documentSeedsLoading ? "Loading entities from the source document." : "",
    neighborhoodLoading ? "Loading the focused graph neighborhood." : "",
    graphAction?.kind === "expand" && graphAction.status === "loading"
      ? `Expanding ${graphAction.node?.canonicalName ?? "the selected entity"}.`
      : "",
    graphAction?.kind === "reset" && graphAction.status === "loading"
      ? "Resetting the focused graph neighborhood."
      : "",
  ].filter(Boolean);
  const renderToolbar = (
    mode: "all" | "filters" | "actions",
    className?: string,
  ) => (
    <GraphToolbar
      projects={projects}
      selectedProjectIds={urlState.projectIds}
      entityTypes={entityTypeOptions}
      selectedEntityTypes={urlState.entityTypes}
      relationTypes={relationTypeOptions}
      selectedRelationTypes={urlState.relationTypes}
      onProjectIdsChange={onProjectIdsChange}
      onEntityTypesChange={onEntityTypesChange}
      onRelationTypesChange={onRelationTypesChange}
      focusedNode={graphState?.nodes.find(
        (node) => node.entityId === graphState.focusId,
      )}
      selectedNode={selectedNode}
      expansionAtCapacity={expansionAtCapacity}
      graphActionLoading={graphActionLoading}
      hasGraph={Boolean(graphState)}
      canvasReady={canvasReady}
      onFocus={onFocus}
      onExpand={onExpand}
      onReset={onReset}
      onFit={() => setFitRequest((request) => request + 1)}
      mode={mode}
      className={className}
    />
  );
  const renderDetails = (focusRequest?: string) => (
    <GraphDetails
      projectId={graphState?.projectId ?? ""}
      selection={selection}
      entityDetail={entityDetail}
      relationDetail={relationDetail}
      loading={detailLoading}
      failed={detailFailed}
      onRetry={onRetryDetail}
      onFocus={onFocus}
      onExpand={onExpand}
      onSelect={onSelect}
      focusRequest={focusRequest}
      expansionAtCapacity={expansionAtCapacity}
      graphActionLoading={graphActionLoading}
    />
  );
  const restoreSelectedOutlineFocus = () => {
    window.requestAnimationFrame(() => {
      restoreGraphDrawerFocus({
        selectionIdentity,
        outlineControls: outlineControls.current,
        workspace: workspaceRef.current,
      });
    });
  };

  return (
    <section
      ref={workspaceRef}
      role="region"
      tabIndex={-1}
      aria-label={`${projectName} knowledge graph`}
      className="border-line bg-surface focus-visible:ring-ring/50 flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border outline-none focus-visible:ring-3"
    >
      <header className="border-line-faint flex-none border-b px-5 py-4">
        <p className="text-text-3 m-0 text-xs font-medium">{projectName}</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-text m-0 text-xl font-semibold">
            Knowledge graph
          </h1>
          <span
            className={readinessToneClass(readinessPresentation.tone)}
            title={readinessPresentation.description}
          >
            {readinessPresentation.label}
          </span>
        </div>
      </header>

      {renderToolbar("all", "hidden xl:flex")}

      <div className="border-line-faint flex flex-none items-center gap-2 overflow-x-auto border-b px-3 py-2 xl:hidden">
        <Dialog open={filtersDrawerOpen} onOpenChange={setFiltersDrawerOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Filter aria-hidden />
              Filters
            </Button>
          </DialogTrigger>
          <DialogContent
            className="bg-surface top-0 left-0 h-dvh max-h-dvh w-[min(22rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-y-0 border-l-0 p-0 sm:max-w-none xl:hidden"
            onCloseAutoFocus={(event) => {
              if (narrowLayout) return;
              event.preventDefault();
              window.requestAnimationFrame(() => {
                restoreGraphDrawerFocus({
                  selectionIdentity: undefined,
                  outlineControls: outlineControls.current,
                  workspace: workspaceRef.current,
                });
              });
            }}
          >
            <DialogHeader className="border-line border-b px-4 py-4 pr-12">
              <DialogTitle>Graph filters</DialogTitle>
              <DialogDescription>
                Filter entity discovery and the focused neighborhood.
              </DialogDescription>
            </DialogHeader>
            <div className="scrollarea min-h-0 overflow-y-auto">
              {renderToolbar(
                "filters",
                "flex-col items-stretch border-0 [&>button]:justify-between",
              )}
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={detailsDrawerOpen} onOpenChange={setDetailsDrawerOpen}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selection}
            >
              <PanelRight aria-hidden />
              Details
            </Button>
          </DialogTrigger>
          <DialogContent
            className="bg-surface top-0 right-0 left-auto h-dvh max-h-dvh w-[min(26rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-none xl:hidden"
            onOpenAutoFocus={(event) => {
              const title = detailsDrawerTitleRef.current;
              if (!title) return;
              event.preventDefault();
              title.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreSelectedOutlineFocus();
            }}
          >
            <DialogHeader className="border-line border-b px-4 py-4 pr-12">
              <DialogTitle ref={detailsDrawerTitleRef} tabIndex={-1}>
                Graph details
              </DialogTitle>
              <DialogDescription className="sr-only">
                Inspect the selected graph item and its active provenance.
              </DialogDescription>
            </DialogHeader>
            <div className="scrollarea min-h-0 overflow-y-auto">
              {renderDetails(narrowLayout ? detailFocusRequest : undefined)}
            </div>
          </DialogContent>
        </Dialog>

        {renderToolbar(
          "actions",
          "min-w-max flex-1 border-0 p-0 [&>span]:hidden",
        )}
      </div>

      <div className="scrollarea min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div
          className={cn(
            "grid w-full gap-4",
            detailsRailCollapsed
              ? "xl:grid-cols-[minmax(0,1fr)_3rem]"
              : "xl:grid-cols-[minmax(0,1fr)_22rem]",
          )}
        >
          <div className="flex min-w-0 flex-col gap-4">
            <section
              aria-labelledby="entity-finder-heading"
              className="border-line bg-surface-2 rounded-[10px] border p-4"
            >
              <h2
                id="entity-finder-heading"
                className="text-text m-0 text-[15px] font-semibold"
              >
                Find an entity
              </h2>
              <p className="text-text-3 mt-1 mb-3 text-xs">
                Search the selected accessible projects, then focus an entity to
                load its single-project neighborhood.
              </p>
              <div className="relative max-w-2xl">
                <Search
                  className="text-text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={rawSeedQuery}
                  maxLength={200}
                  onChange={(event) => onRawSeedQueryChange(event.target.value)}
                  aria-label="Find graph entities"
                  aria-describedby="graph-entity-finder-description"
                  aria-busy={seedSearchLoading}
                  placeholder="Search entity names, aliases, or descriptions"
                  className="bg-surface pr-10 pl-9"
                />
                {seedSearchLoading ? (
                  <LoaderCircle
                    className="text-text-muted absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin"
                    aria-hidden
                  />
                ) : null}
              </div>
              <p
                id="graph-entity-finder-description"
                className="text-text-3 mt-2 mb-0 text-xs"
              >
                {trimmedQuery.length === 1
                  ? "Type one more character to search."
                  : readinessPresentation.description}
              </p>
            </section>

            {projectsUnavailable ? (
              <InlineNotice>
                Project filter labels could not be refreshed. Cross-project
                route changes remain disabled until access can be verified.
              </InlineNotice>
            ) : null}
            {seedSearchFailed ? (
              <InlineError
                message="Could not search graph entities."
                onRetry={onRetrySeedSearch}
                loading={seedSearchLoading}
              />
            ) : null}
            {showFinderSeeds &&
            !seedSearchLoading &&
            seedSearch?.entities.length === 0 ? (
              <InlineNotice>
                No entities matched “{trimmedQuery}” in the selected projects.
              </InlineNotice>
            ) : null}
            {!showFinderSeeds &&
            trimmedQuery.length === 0 &&
            urlState.documentId &&
            !documentSeedsLoading &&
            documentSeeds?.entities.length === 0 ? (
              <InlineNotice>
                No indexed entities were found for the source document.
              </InlineNotice>
            ) : null}
            {documentSeedsFailed ? (
              <InlineError
                message="Could not load entities from the source document."
                onRetry={onRetryDocumentSeeds}
                loading={documentSeedsLoading}
              />
            ) : null}
            {neighborhoodFailed ? (
              <InlineError
                message="Could not load the focused graph neighborhood."
                onRetry={onRetryNeighborhood}
                loading={neighborhoodLoading}
              />
            ) : null}
            {graphAction?.kind === "expand" &&
            graphAction.status === "failed" ? (
              <InlineError
                message="Could not expand the selected entity. The existing graph and selection were retained."
                onRetry={onRetryExpand}
              />
            ) : null}
            {graphAction?.kind === "reset" &&
            graphAction.status === "failed" ? (
              <InlineError
                message="Could not reset the focused neighborhood. The existing graph and selection were retained."
                onRetry={onReset}
              />
            ) : null}
            {focusNotFound ? (
              <div
                role="alert"
                className="border-review-border bg-review-bg text-review rounded-lg border px-4 py-3 text-sm"
              >
                Graph was refreshed; choose an entity again
              </div>
            ) : null}
            {neighborhoodLoading ? (
              <InlineNotice>
                Loading the focused graph neighborhood.
              </InlineNotice>
            ) : null}
            {seedResponseTruncated ? (
              <InlineNotice>
                Entity seeds were truncated by the server. Narrow the filters to
                see a more specific set.
              </InlineNotice>
            ) : null}
            {graphState?.truncated ? (
              <InlineNotice>
                The focused graph was truncated by the server.
              </InlineNotice>
            ) : null}
            {graphState?.atCapacity ? (
              <InlineNotice>
                The graph reached the 100-entity or 200-relation canvas limit.
              </InlineNotice>
            ) : null}

            <div className="xl:order-2">
              <GraphOutline
                state={focusNotFound ? null : graphState}
                seeds={seeds}
                seedHeading={seedHeading}
                selection={selection}
                onSelect={onSelect}
                onFocus={onFocus}
                onExpand={onExpand}
                expandDisabled={expansionAtCapacity || graphActionLoading}
                registerSelectionControl={(item, control) => {
                  const identity = `${item.kind}:${item.id}`;
                  if (control) outlineControls.current.set(identity, control);
                  else outlineControls.current.delete(identity);
                }}
              />
            </div>

            {graphState ? (
              <div className="min-w-0 overflow-x-auto xl:order-1">
                <GraphCanvas
                  key={canvasIdentity}
                  graph={graphState}
                  selection={selection}
                  fitRequest={fitRequest}
                  onSelectionChange={onSelect}
                  onReadyChange={(ready) =>
                    setReadyCanvasIdentity((current) =>
                      ready
                        ? canvasIdentity
                        : current === canvasIdentity
                          ? undefined
                          : current,
                    )
                  }
                />
              </div>
            ) : null}
          </div>

          <aside
            aria-label="Graph details"
            className="border-line bg-surface sticky top-0 hidden max-h-[calc(100dvh-10rem)] min-h-0 overflow-hidden rounded-[10px] border xl:flex xl:flex-col"
          >
            <div className="border-line-faint flex flex-none items-center justify-between border-b p-2">
              {!detailsRailCollapsed ? (
                <span className="text-text-2 pl-2 text-xs font-semibold tracking-wide uppercase">
                  Details
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label={
                  detailsRailCollapsed
                    ? "Show graph details"
                    : "Collapse graph details"
                }
                onClick={() =>
                  setDetailsRailCollapsed((collapsed) => !collapsed)
                }
              >
                {detailsRailCollapsed ? (
                  <PanelRightOpen aria-hidden />
                ) : (
                  <PanelRightClose aria-hidden />
                )}
              </Button>
            </div>
            {!detailsRailCollapsed ? (
              <div className="scrollarea min-h-0 overflow-y-auto">
                {renderDetails(narrowLayout ? undefined : detailFocusRequest)}
              </div>
            ) : null}
          </aside>
        </div>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {statusAnnouncement}
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {statusParts.join(" ")}
      </div>
    </section>
  );
}

function InlineError({
  message,
  onRetry,
  loading = false,
}: {
  message: string;
  onRetry: () => void;
  loading?: boolean;
}) {
  return (
    <div
      role="alert"
      className="border-danger-border bg-danger-bg text-danger flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
    >
      <span>{message}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={loading}
      >
        {loading ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

function InlineNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-info-border bg-info-bg text-info m-0 rounded-lg border px-4 py-3 text-sm">
      {children}
    </p>
  );
}

function readinessToneClass(tone: "neutral" | "info" | "success" | "warning") {
  switch (tone) {
    case "info":
      return "border-info-border bg-info-bg text-info rounded-full border px-2.5 py-1 text-xs font-medium";
    case "success":
      return "border-approved-border bg-approved-bg text-approved rounded-full border px-2.5 py-1 text-xs font-medium";
    case "warning":
      return "border-review-border bg-review-bg text-review rounded-full border px-2.5 py-1 text-xs font-medium";
    case "neutral":
      return "border-line bg-subtle text-text-2 rounded-full border px-2.5 py-1 text-xs font-medium";
  }
}

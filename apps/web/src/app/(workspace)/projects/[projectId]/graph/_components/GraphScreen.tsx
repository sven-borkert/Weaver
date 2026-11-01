"use client";

import { skipToken } from "@tanstack/react-query";
import { queryErrorCode } from "~/lib/query-presentation";

import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  accessibleGraphRouteScope,
  createGraphRouteVerificationCoordinator,
  focusedGraphRouteDisposition,
  graphDetailFailureDisposition,
  graphSelectionLabel,
} from "~/lib/knowledge/graphPresentation";
import {
  DEFAULT_GRAPH_EDGE_LIMIT,
  DEFAULT_GRAPH_NODE_LIMIT,
  graphExpansionBounds,
  mergeGraphNeighborhood,
  startFocusedGraph,
  type GraphPresentationNode,
  type GraphSelection,
} from "~/lib/knowledge/graphState";
import { graphHref, type GraphUrlState } from "~/lib/knowledge/graphUrl";
import { resolveQueryPresentation } from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { GraphError, GraphLoading, GraphNotFound } from "./GraphStates";
import { GraphWorkspace } from "./GraphWorkspace";

function isAccessFailure(error: unknown) {
  return ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"].includes(
    queryErrorCode(error) ?? "",
  );
}

export function GraphScreen({
  projectId,
  urlState,
}: {
  projectId: string;
  urlState: GraphUrlState;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [routeVerification] = useState(() =>
    createGraphRouteVerificationCoordinator(),
  );
  const [rawSeedQuery, setRawSeedQuery] = useState("");
  const [debouncedSeedQuery, setDebouncedSeedQuery] = useState("");
  const [selection, setSelection] = useState<GraphSelection>();
  const [detailFocusRequest, setDetailFocusRequest] = useState<string>();
  const detailFocusSequence = useRef(0);
  const [suppressedViewIdentity, setSuppressedViewIdentity] =
    useState<string>();
  const [navigationStatus, setNavigationStatus] = useState("");
  const [routeFeedback, setRouteFeedback] = useState("");
  const [graphSnapshot, setGraphSnapshot] = useState<{
    identity: string;
    graph: ReturnType<typeof startFocusedGraph>;
  }>();
  const [graphAction, setGraphAction] = useState<{
    identity: string;
    kind: "expand" | "reset";
    status: "loading" | "failed";
    node?: GraphPresentationNode;
  }>();
  const [graphActionAccessFailure, setGraphActionAccessFailure] = useState<{
    identity: string;
    code: string;
  }>();
  const graphActionRequest = useRef(0);
  const graphActionPending = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSeedQuery(rawSeedQuery.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [rawSeedQuery]);

  const projectQuery = api.project.get.useQuery(
    { projectId },
    { enabled: projectId.length > 0, retry: false },
  );
  const projectAccessFailed = isAccessFailure(projectQuery.error);
  const project = projectAccessFailed ? undefined : projectQuery.data;
  const projectPresentation = resolveQueryPresentation({
    ...projectQuery,
    data: project,
  });

  const projectsQuery = api.project.list.useQuery(undefined, {
    enabled: Boolean(project),
    retry: false,
  });
  const readinessQuery = api.knowledge.readiness.useQuery(
    { projectId },
    { enabled: Boolean(project), retry: false },
  );
  const readinessAccessFailed = isAccessFailure(readinessQuery.error);
  const readiness = readinessAccessFailed ? undefined : readinessQuery.data;
  const readinessPresentation = resolveQueryPresentation({
    ...readinessQuery,
    data: readiness,
  });
  const viewIdentity = responseIdentity(projectId, [
    "focus",
    urlState.focusId ?? "",
    "document",
    urlState.documentId ?? "",
    "projects",
    ...urlState.projectIds,
    "entities",
    ...urlState.entityTypes,
    "relations",
    ...urlState.relationTypes,
  ]);
  const navigationPending = suppressedViewIdentity === viewIdentity;
  const previousViewIdentity = useRef(viewIdentity);
  const visibleGraphAction =
    graphAction?.identity === viewIdentity ? graphAction : undefined;
  const visibleGraphActionAccessFailure =
    graphActionAccessFailure?.identity === viewIdentity
      ? graphActionAccessFailure
      : undefined;

  useLayoutEffect(() => {
    routeVerification.invalidate();
    graphActionRequest.current += 1;
    graphActionPending.current = undefined;
    return () => routeVerification.invalidate();
  }, [routeVerification, viewIdentity]);

  useEffect(() => {
    if (previousViewIdentity.current === viewIdentity) return;
    previousViewIdentity.current = viewIdentity;
    const frame = window.requestAnimationFrame(() => {
      setSuppressedViewIdentity(undefined);
      setGraphAction(undefined);
      setGraphActionAccessFailure(undefined);
      setSelection(undefined);
      setNavigationStatus("");
      setRouteFeedback("");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [viewIdentity]);

  const currentSeedIdentity = responseIdentity(rawSeedQuery.trim(), [
    "projects",
    ...urlState.projectIds,
    "entities",
    ...urlState.entityTypes,
  ]);
  const submittedSeedIdentity = responseIdentity(debouncedSeedQuery, [
    "projects",
    ...urlState.projectIds,
    "entities",
    ...urlState.entityTypes,
  ]);
  const seedSearch = api.graph.searchEntities.useQuery(
    {
      query: debouncedSeedQuery,
      projectIds: urlState.projectIds,
      entityTypes: urlState.entityTypes,
      limit: 20,
    },
    {
      enabled: Boolean(project) && debouncedSeedQuery.length >= 2,
      retry: false,
    },
  );
  const visibleSeedSearch =
    currentSeedIdentity === submittedSeedIdentity && !seedSearch.isError
      ? seedSearch.data
      : undefined;

  const documentSeeds = api.graph.fromDocument.useQuery(
    project && urlState.documentId && !urlState.focusId
      ? {
          projectId,
          documentId: urlState.documentId,
          entityTypes: urlState.entityTypes,
          limit: 20,
        }
      : skipToken,
    { retry: false },
  );
  const neighborhood = api.graph.neighborhood.useQuery(
    project && urlState.focusId
      ? {
          entityId: urlState.focusId,
          entityTypes: urlState.entityTypes,
          relationTypes: urlState.relationTypes,
          maxNodes: DEFAULT_GRAPH_NODE_LIMIT,
          maxEdges: DEFAULT_GRAPH_EDGE_LIMIT,
        }
      : skipToken,
    { retry: false },
  );
  const neighborhoodResponse = neighborhood.data;
  const baseGraphState = useMemo(
    () =>
      navigationPending || !urlState.focusId || !neighborhoodResponse
        ? null
        : startFocusedGraph(neighborhoodResponse, urlState.focusId),
    [navigationPending, neighborhoodResponse, urlState.focusId],
  );
  const graphState =
    graphSnapshot?.identity === viewIdentity
      ? graphSnapshot.graph
      : baseGraphState;
  const visibleSelection =
    graphState && selection && selectionExists(graphState, selection)
      ? selection
      : undefined;
  const entityDetail = api.graph.entityDetail.useQuery(
    {
      entityId: visibleSelection?.kind === "entity" ? visibleSelection.id : "",
    },
    { enabled: visibleSelection?.kind === "entity", retry: false },
  );
  const relationDetail = api.graph.relationDetail.useQuery(
    {
      relationId:
        visibleSelection?.kind === "relation" ? visibleSelection.id : "",
    },
    { enabled: visibleSelection?.kind === "relation", retry: false },
  );
  const detailError =
    visibleSelection?.kind === "entity"
      ? entityDetail.error
      : visibleSelection?.kind === "relation"
        ? relationDetail.error
        : undefined;
  const detailFailureDisposition = graphDetailFailureDisposition(
    visibleSelection,
    urlState.focusId,
    queryErrorCode(detailError),
  );
  const visibleEntityDetail =
    visibleSelection?.kind === "entity" &&
    !entityDetail.isError &&
    entityDetail.data?.entity.entityId === visibleSelection.id
      ? entityDetail.data
      : undefined;
  const visibleRelationDetail =
    visibleSelection?.kind === "relation" &&
    !relationDetail.isError &&
    relationDetail.data?.relation.relationId === visibleSelection.id
      ? relationDetail.data
      : undefined;

  useEffect(() => {
    if (
      detailFailureDisposition !== "clear-selection" &&
      detailFailureDisposition !== "invalidate-focus"
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setRouteFeedback(
        "This graph item is no longer available in the active generation. Choose another entity or reset the graph.",
      );
      if (detailFailureDisposition === "invalidate-focus") {
        setGraphSnapshot({ identity: viewIdentity, graph: null });
      }
      setSelection(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailFailureDisposition, viewIdentity]);

  const projectsAccessFailed = isAccessFailure(projectsQuery.error);
  const accessibleProjects = projectsQuery.isError
    ? []
    : (projectsQuery.data ?? []);
  const accessibleProjectIds = useMemo(
    () =>
      new Set([
        projectId,
        ...(projectsQuery.data ?? []).map(
          (accessibleProject) => accessibleProject.id,
        ),
      ]),
    [projectId, projectsQuery.data],
  );
  const focusedRouteDisposition = useMemo(
    () =>
      baseGraphState &&
      !projectsQuery.isFetching &&
      !projectsQuery.isError &&
      projectsQuery.data !== undefined
        ? focusedGraphRouteDisposition({
            routeProjectId: projectId,
            graph: baseGraphState,
            accessibleProjectIds: [...accessibleProjectIds],
            urlState,
          })
        : undefined,
    [
      baseGraphState,
      accessibleProjectIds,
      projectId,
      projectsQuery.data,
      projectsQuery.isError,
      projectsQuery.isFetching,
      urlState,
    ],
  );
  const lastDirectRedirect = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (focusedRouteDisposition?.status !== "redirect") {
      lastDirectRedirect.current = undefined;
      return;
    }
    if (lastDirectRedirect.current === focusedRouteDisposition.href) return;
    lastDirectRedirect.current = focusedRouteDisposition.href;
    routeVerification.invalidate();
    graphActionRequest.current += 1;
    graphActionPending.current = undefined;
    router.replace(focusedRouteDisposition.href, { scroll: false });
  }, [focusedRouteDisposition, routeVerification, router]);

  const observedEntityTypes = boundedOptions(
    urlState.entityTypes,
    [
      ...(visibleSeedSearch?.entities ?? []),
      ...(isAccessFailure(documentSeeds.error)
        ? []
        : (documentSeeds.data?.entities ?? [])),
      ...(graphState?.nodes ?? []),
    ].map((node) => node.entityType),
  );
  const observedRelationTypes = boundedOptions(
    urlState.relationTypes,
    (graphState?.edges ?? []).map((edge) => edge.relationType),
  );

  const replaceFilters = (nextState: GraphUrlState) => {
    const nextHref = graphHref(projectId, nextState);
    if (nextHref === graphHref(projectId, urlState)) return;
    routeVerification.invalidate();
    graphActionRequest.current += 1;
    graphActionPending.current = undefined;
    setGraphSnapshot(undefined);
    setGraphAction(undefined);
    setGraphActionAccessFailure(undefined);
    setSelection(undefined);
    setSuppressedViewIdentity(viewIdentity);
    setNavigationStatus("Graph filters changed. Reloading the current view.");
    setRouteFeedback("");
    router.replace(nextHref, { scroll: false });
  };

  const focusNode = async (node: GraphPresentationNode) => {
    let retainedScope = urlState.projectIds;
    if (node.projectId !== projectId) {
      setRouteFeedback("Verifying access to the selected project.");
      const verification = await routeVerification.verify(() =>
        utils.client.project.list.query(),
      );
      if (verification.status === "superseded") return;
      if (verification.status === "failed") {
        setRouteFeedback(
          "Could not verify access to that project. Try again before switching.",
        );
        return;
      }
      utils.project.list.setData(undefined, verification.value);
      const verifiedScope = accessibleGraphRouteScope(
        urlState.projectIds,
        verification.value.map((accessibleProject) => accessibleProject.id),
        node.projectId,
      );
      if (!verifiedScope) {
        setRouteFeedback(
          "That project is no longer available. Choose another entity.",
        );
        return;
      }
      retainedScope = verifiedScope;
    } else {
      routeVerification.invalidate();
      if (retainedScope.length === 0) retainedScope = [projectId];
    }

    const nextHref = graphHref(node.projectId, {
      focusId: node.entityId,
      projectIds: retainedScope,
      entityTypes: urlState.entityTypes,
      relationTypes: urlState.relationTypes,
    });
    if (nextHref === graphHref(projectId, urlState)) {
      setRouteFeedback(`${node.canonicalName} is already focused.`);
      return;
    }

    setRouteFeedback("");
    graphActionRequest.current += 1;
    graphActionPending.current = undefined;
    setGraphSnapshot(undefined);
    setGraphAction(undefined);
    setGraphActionAccessFailure(undefined);
    setSelection(undefined);
    setSuppressedViewIdentity(viewIdentity);
    setNavigationStatus(`Loading ${node.canonicalName}.`);
    router.push(nextHref, { scroll: false });
  };

  const expandNode = async (node: GraphPresentationNode) => {
    const graph = graphState;
    if (
      node.projectId !== graph?.projectId ||
      graphActionPending.current !== undefined
    ) {
      return;
    }
    const bounds = graphExpansionBounds(graph);
    if (!bounds) {
      setRouteFeedback(
        "Expand is unavailable because the graph reached its canvas capacity.",
      );
      return;
    }

    const requestId = ++graphActionRequest.current;
    graphActionPending.current = requestId;
    setGraphAction({
      identity: viewIdentity,
      kind: "expand",
      status: "loading",
      node,
    });
    setGraphActionAccessFailure(undefined);
    setRouteFeedback(`Expanding ${node.canonicalName}.`);
    try {
      const response = await utils.graph.neighborhood.fetch({
        entityId: node.entityId,
        entityTypes: urlState.entityTypes,
        relationTypes: urlState.relationTypes,
        maxNodes: bounds.maxNodes,
        maxEdges: bounds.maxEdges,
      });
      if (graphActionRequest.current !== requestId) return;
      graphActionPending.current = undefined;
      setGraphSnapshot((current) => {
        const currentGraph =
          current?.identity === viewIdentity ? current.graph : graph;
        if (
          currentGraph?.projectId !== graph.projectId ||
          currentGraph.focusId !== graph.focusId
        ) {
          return current;
        }
        return {
          identity: viewIdentity,
          graph: mergeGraphNeighborhood(currentGraph, response),
        };
      });
      setGraphAction(undefined);
      setRouteFeedback(`${node.canonicalName} was expanded.`);
    } catch (error) {
      if (graphActionRequest.current !== requestId) return;
      graphActionPending.current = undefined;
      const code = queryErrorCode(error);
      if (code && isAccessFailure(error)) {
        setGraphSnapshot({ identity: viewIdentity, graph: null });
        setSelection(undefined);
        setGraphAction(undefined);
        setGraphActionAccessFailure({ identity: viewIdentity, code });
        setRouteFeedback("");
        return;
      }
      setGraphAction({
        identity: viewIdentity,
        kind: "expand",
        status: "failed",
        node,
      });
      setRouteFeedback("");
    }
  };

  const resetGraph = async () => {
    const graph = graphState;
    if (
      !urlState.focusId ||
      !graph ||
      graphActionPending.current !== undefined
    ) {
      return;
    }
    const requestId = ++graphActionRequest.current;
    graphActionPending.current = requestId;
    setGraphAction({
      identity: viewIdentity,
      kind: "reset",
      status: "loading",
    });
    setGraphActionAccessFailure(undefined);
    setRouteFeedback("Resetting the focused graph neighborhood.");
    try {
      const response = await utils.graph.neighborhood.fetch({
        entityId: urlState.focusId,
        entityTypes: urlState.entityTypes,
        relationTypes: urlState.relationTypes,
        maxNodes: DEFAULT_GRAPH_NODE_LIMIT,
        maxEdges: DEFAULT_GRAPH_EDGE_LIMIT,
      });
      if (graphActionRequest.current !== requestId) return;
      graphActionPending.current = undefined;
      const reset = startFocusedGraph(response, urlState.focusId);
      setGraphSnapshot({ identity: viewIdentity, graph: reset });
      setSelection((current) =>
        current && reset && selectionExists(reset, current)
          ? current
          : undefined,
      );
      setGraphAction(undefined);
      setRouteFeedback("The focused graph neighborhood was reset.");
    } catch (error) {
      if (graphActionRequest.current !== requestId) return;
      graphActionPending.current = undefined;
      const code = queryErrorCode(error);
      if (code && isAccessFailure(error)) {
        setGraphSnapshot({ identity: viewIdentity, graph: null });
        setSelection(undefined);
        setGraphAction(undefined);
        setGraphActionAccessFailure({ identity: viewIdentity, code });
        setRouteFeedback("");
        return;
      }
      setGraphAction({
        identity: viewIdentity,
        kind: "reset",
        status: "failed",
      });
      setRouteFeedback("");
    }
  };

  if (projectAccessFailed || readinessAccessFailed || projectsAccessFailed) {
    return <GraphNotFound />;
  }
  if (projectPresentation === "loading") return <GraphLoading />;
  if (projectPresentation === "error") {
    return (
      <GraphError
        title="Could not load project"
        description="Refresh the page or retry loading this project."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void projectQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }
  if (!project) return <GraphNotFound />;
  if (readinessPresentation === "loading") {
    return (
      <GraphLoading
        title="Loading knowledge graph"
        description="Checking what indexed knowledge is available."
      />
    );
  }
  if (readinessPresentation === "error") {
    return (
      <GraphError
        title="Could not load knowledge readiness"
        description="The project is available, but its graph readiness could not be checked."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void readinessQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }
  if (!readiness) {
    return (
      <GraphError
        title="Knowledge readiness is unavailable"
        description="Retry to check the project’s indexed knowledge."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void readinessQuery.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const focusedProjectMismatch = Boolean(
    baseGraphState && baseGraphState.projectId !== projectId,
  );
  if (focusedProjectMismatch) {
    if (projectsQuery.isError) {
      return (
        <GraphError
          title="Could not verify the focused graph"
          description="Retry before opening this graph in its project."
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void projectsQuery.refetch()}
            >
              Retry
            </Button>
          }
        />
      );
    }
    if (focusedRouteDisposition?.status === "not-found") {
      return (
        <GraphNotFound
          title="Graph unavailable"
          description="This graph may have changed, or you may no longer have access to it."
        />
      );
    }
    return (
      <GraphLoading
        title="Opening focused graph"
        description="Verifying the graph project before showing its canvas."
      />
    );
  }

  const neighborhoodErrorCode = queryErrorCode(neighborhood.error);
  const focusNotFound =
    neighborhoodErrorCode === "NOT_FOUND" ||
    visibleGraphActionAccessFailure?.code === "NOT_FOUND" ||
    detailFailureDisposition === "invalidate-focus";
  const focusResponseMissing = Boolean(
    !navigationPending &&
    urlState.focusId &&
    neighborhoodResponse &&
    !graphState,
  );
  const focusInvalid = focusNotFound || focusResponseMissing;
  if (
    detailFailureDisposition === "deny-access" ||
    ["FORBIDDEN", "UNAUTHORIZED"].includes(
      visibleGraphActionAccessFailure?.code ?? neighborhoodErrorCode ?? "",
    )
  ) {
    return (
      <GraphNotFound
        title="Graph unavailable"
        description="This graph may have changed, or you may no longer have access to it."
      />
    );
  }
  const initialStateResolved = urlState.focusId
    ? !neighborhood.isLoading && !neighborhood.isFetching
    : urlState.documentId
      ? !documentSeeds.isLoading && !documentSeeds.isFetching
      : true;
  const selectedAnnouncement =
    graphState && visibleSelection
      ? `Selected ${graphSelectionLabel(visibleSelection, graphState)}`
      : "";

  return (
    <GraphWorkspace
      projectName={project.name}
      urlState={urlState}
      readiness={readiness}
      projects={accessibleProjects}
      projectsUnavailable={projectsQuery.isError}
      rawSeedQuery={rawSeedQuery}
      onRawSeedQueryChange={(query) => {
        setRawSeedQuery(query);
      }}
      seedSearch={visibleSeedSearch}
      seedSearchLoading={
        rawSeedQuery.trim().length >= 2 &&
        (currentSeedIdentity !== submittedSeedIdentity || seedSearch.isFetching)
      }
      seedSearchFailed={
        currentSeedIdentity === submittedSeedIdentity && seedSearch.isError
      }
      onRetrySeedSearch={() => void seedSearch.refetch()}
      documentSeeds={
        isAccessFailure(documentSeeds.error) ? undefined : documentSeeds.data
      }
      documentSeedsLoading={documentSeeds.isFetching}
      documentSeedsFailed={documentSeeds.isError}
      onRetryDocumentSeeds={() => void documentSeeds.refetch()}
      graphState={focusInvalid ? null : graphState}
      neighborhoodLoading={Boolean(urlState.focusId && neighborhood.isFetching)}
      neighborhoodFailed={
        Boolean(urlState.focusId && neighborhood.isError) && !focusNotFound
      }
      focusNotFound={focusInvalid}
      onRetryNeighborhood={() => void neighborhood.refetch()}
      graphAction={visibleGraphAction}
      onExpand={(node) => void expandNode(node)}
      onRetryExpand={() => {
        if (visibleGraphAction?.node) void expandNode(visibleGraphAction.node);
      }}
      onReset={() => void resetGraph()}
      selection={focusInvalid ? undefined : visibleSelection}
      entityDetail={focusInvalid ? undefined : visibleEntityDetail}
      relationDetail={focusInvalid ? undefined : visibleRelationDetail}
      detailLoading={
        !focusInvalid &&
        Boolean(visibleSelection) &&
        (visibleSelection?.kind === "entity"
          ? entityDetail.isFetching
          : relationDetail.isFetching)
      }
      detailFailed={
        !focusInvalid &&
        Boolean(visibleSelection && detailError) &&
        detailFailureDisposition === "local"
      }
      onRetryDetail={() => {
        if (visibleSelection?.kind === "entity") {
          void entityDetail.refetch();
        } else if (visibleSelection?.kind === "relation") {
          void relationDetail.refetch();
        }
      }}
      detailFocusRequest={detailFocusRequest}
      onSelect={(nextSelection, requestDetailFocus) => {
        setSelection(nextSelection);
        if (nextSelection && requestDetailFocus) {
          detailFocusSequence.current += 1;
          setDetailFocusRequest(
            `${nextSelection.kind}:${nextSelection.id}:${detailFocusSequence.current}`,
          );
        } else {
          setDetailFocusRequest(undefined);
        }
        setNavigationStatus("");
        setRouteFeedback("");
      }}
      onFocus={focusNode}
      entityTypeOptions={observedEntityTypes}
      relationTypeOptions={observedRelationTypes}
      onProjectIdsChange={(projectIds) => {
        const accessibleIds = projectIds
          .filter((selectedProjectId) =>
            accessibleProjectIds.has(selectedProjectId),
          )
          .slice(0, 50);
        replaceFilters({ ...urlState, projectIds: accessibleIds });
      }}
      onEntityTypesChange={(entityTypes) =>
        replaceFilters({ ...urlState, entityTypes })
      }
      onRelationTypesChange={(relationTypes) =>
        replaceFilters({ ...urlState, relationTypes })
      }
      initialStateResolved={initialStateResolved}
      statusAnnouncement={
        routeFeedback ||
        (navigationPending ? navigationStatus : "") ||
        selectedAnnouncement
      }
    />
  );
}

function responseIdentity(primary: string, filters: string[]) {
  return JSON.stringify([primary, ...filters]);
}

function boundedOptions(selected: string[], observed: string[]) {
  const values = [...new Set(selected)].sort().slice(0, 20);
  const seen = new Set(values);
  for (const value of [...new Set(observed)].sort()) {
    if (values.length >= 20) break;
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function selectionExists(
  graph: NonNullable<ReturnType<typeof startFocusedGraph>>,
  selection: GraphSelection,
) {
  return selection.kind === "entity"
    ? graph.nodes.some((node) => node.entityId === selection.id)
    : graph.edges.some((edge) => edge.relationId === selection.id);
}

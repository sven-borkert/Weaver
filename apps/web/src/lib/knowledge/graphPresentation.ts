import type { ElementDefinition } from "cytoscape";

import { documentSectionHref } from "~/lib/documents/section-navigation";
import type {
  GraphPresentationEdge,
  GraphPresentationNode,
  GraphPresentationState,
  GraphSelection,
} from "./graphState";
import { graphHref, type GraphUrlState } from "./graphUrl";

export type GraphCitationLike = {
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
};

export type GraphCitationPresentation = {
  title: string;
  headingLabel: string | null;
  excerpt: string;
  confidenceLabel: string;
  temporalLabel: string | null;
  href?: string;
};

export function graphCitationPresentation(
  projectId: string,
  citation: GraphCitationLike,
): GraphCitationPresentation {
  const navigation = citation.navigation;
  return {
    title: navigation?.title ?? "Source unavailable",
    headingLabel:
      citation.headingPath.length > 0 ? citation.headingPath.join(" › ") : null,
    excerpt: citation.excerpt,
    confidenceLabel: `${Math.round(citation.confidence * 100)}% confidence`,
    temporalLabel: temporalLabel(citation.validFrom, citation.validTo),
    ...(navigation
      ? {
          href: documentSectionHref({
            projectId,
            documentId: navigation.documentId,
            navigation: navigation.navigationAnchor
              ? {
                  section: navigation.navigationAnchor,
                  sourceCommitSha: citation.sourceCommitSha,
                }
              : undefined,
          }),
        }
      : {}),
  };
}

export function graphDetailTruncationLabel(
  kind: "mentions" | "evidence",
  truncated: boolean,
): string | null {
  if (!truncated) return null;
  return kind === "mentions"
    ? "Additional active mentions were omitted by the server."
    : "Additional active evidence was omitted by the server.";
}

export type GraphDetailFailureDisposition =
  "none" | "local" | "clear-selection" | "invalidate-focus" | "deny-access";

export function graphDetailFailureDisposition(
  selection: GraphSelection | undefined,
  focusId: string | undefined,
  errorCode: string | undefined,
): GraphDetailFailureDisposition {
  if (!selection || !errorCode) return "none";
  if (errorCode === "FORBIDDEN" || errorCode === "UNAUTHORIZED") {
    return "deny-access";
  }
  if (errorCode !== "NOT_FOUND") return "local";
  return selection.kind === "entity" && selection.id === focusId
    ? "invalidate-focus"
    : "clear-selection";
}

export type KnowledgeReadinessLike = {
  keyword: "empty" | "building" | "ready" | "degraded";
  semantic: "empty" | "building" | "ready" | "degraded";
  graph: "empty" | "building" | "ready" | "degraded";
  aiConfigured: boolean;
};

export function accessibleGraphRouteScope(
  selectedProjectIds: string[],
  accessibleProjectIds: string[],
  targetProjectId: string,
): string[] | null {
  const accessible = new Set(accessibleProjectIds);
  if (!accessible.has(targetProjectId)) return null;

  const retained = [
    ...new Set(
      selectedProjectIds.filter((projectId) => accessible.has(projectId)),
    ),
  ].slice(0, 50);
  return retained.length > 0 ? retained : [targetProjectId];
}

export function focusedGraphRouteDisposition(input: {
  routeProjectId: string;
  graph: GraphPresentationState;
  accessibleProjectIds: string[];
  urlState: GraphUrlState;
}):
  | { status: "current" }
  | { status: "not-found" }
  | { status: "redirect"; href: string } {
  if (input.graph.projectId === input.routeProjectId) {
    return { status: "current" };
  }

  const projectIds = accessibleGraphRouteScope(
    input.urlState.projectIds,
    input.accessibleProjectIds,
    input.graph.projectId,
  );
  if (!projectIds) return { status: "not-found" };

  return {
    status: "redirect",
    href: graphHref(input.graph.projectId, {
      focusId: input.graph.focusId,
      projectIds,
      entityTypes: input.urlState.entityTypes,
      relationTypes: input.urlState.relationTypes,
    }),
  };
}

export type GraphRouteVerificationResult<T> =
  | { status: "verified"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "superseded" };

export function createGraphRouteVerificationCoordinator(): {
  invalidate: () => void;
  verify: <T>(
    verification: () => Promise<T>,
  ) => Promise<GraphRouteVerificationResult<T>>;
} {
  let latestRequest = 0;
  let queue: Promise<void> = Promise.resolve();

  const invalidate = () => {
    latestRequest += 1;
  };
  const verify = <T>(verification: () => Promise<T>) => {
    const requestId = ++latestRequest;
    const run = queue.then(
      async (): Promise<GraphRouteVerificationResult<T>> => {
        if (requestId !== latestRequest) return { status: "superseded" };
        try {
          const value = await verification();
          return requestId === latestRequest
            ? { status: "verified", value }
            : { status: "superseded" };
        } catch (error) {
          return requestId === latestRequest
            ? { status: "failed", error }
            : { status: "superseded" };
        }
      },
    );
    queue = run.then(() => undefined);
    return run;
  };

  return { invalidate, verify };
}

export function orderedGraphNodes(
  state: GraphPresentationState,
): GraphPresentationNode[] {
  return [...state.nodes].sort((left, right) => {
    if (left.entityId === state.focusId) return -1;
    if (right.entityId === state.focusId) return 1;
    return (
      compareText(left.canonicalName, right.canonicalName) ||
      compareText(left.entityId, right.entityId)
    );
  });
}

export function orderedGraphEdges(
  state: GraphPresentationState,
): GraphPresentationEdge[] {
  const names = new Map(
    state.nodes.map((node) => [node.entityId, node.canonicalName]),
  );

  return [...state.edges].sort(
    (left, right) =>
      compareText(
        names.get(left.sourceEntityId) ?? left.sourceEntityId,
        names.get(right.sourceEntityId) ?? right.sourceEntityId,
      ) ||
      compareText(left.relationType, right.relationType) ||
      compareText(
        names.get(left.targetEntityId) ?? left.targetEntityId,
        names.get(right.targetEntityId) ?? right.targetEntityId,
      ) ||
      compareText(left.relationId, right.relationId),
  );
}

export function toCytoscapeElements(
  state: GraphPresentationState,
): ElementDefinition[] {
  const nodes: ElementDefinition[] = orderedGraphNodes(state).map((node) => ({
    group: "nodes",
    data: {
      id: node.entityId,
      label: node.canonicalName,
      entityType: node.entityType,
      projectId: node.projectId,
    },
  }));
  const edges: ElementDefinition[] = orderedGraphEdges(state).map((edge) => ({
    group: "edges",
    data: {
      id: edge.relationId,
      source: edge.sourceEntityId,
      target: edge.targetEntityId,
      label: edge.relationType,
    },
  }));
  return [...nodes, ...edges];
}

export function graphSelectionFromCanvasTap(target?: {
  group: "nodes" | "edges";
  id: string;
}): GraphSelection | undefined {
  if (!target) return undefined;
  return target.group === "nodes"
    ? { kind: "entity", id: target.id }
    : { kind: "relation", id: target.id };
}

export function graphCanvasTopologyIdentity(
  state: GraphPresentationState,
): string {
  return JSON.stringify([
    state.projectId,
    state.focusId,
    orderedGraphNodes(state).map((node) => node.entityId),
    orderedGraphEdges(state).map((edge) => [
      edge.relationId,
      edge.sourceEntityId,
      edge.targetEntityId,
    ]),
  ]);
}

export function graphSelectionText(
  selection: GraphSelection,
  state: GraphPresentationState,
): string {
  if (selection.kind === "entity") {
    const node = state.nodes.find((item) => item.entityId === selection.id);
    if (!node) return "Graph selection cleared.";
    return `${node.canonicalName}, ${node.entityType} in ${node.projectName}.`;
  }

  const edge = state.edges.find((item) => item.relationId === selection.id);
  if (!edge) return "Graph selection cleared.";
  const source = state.nodes.find(
    (item) => item.entityId === edge.sourceEntityId,
  );
  const target = state.nodes.find(
    (item) => item.entityId === edge.targetEntityId,
  );
  return `${source?.canonicalName ?? edge.sourceEntityId} ${edge.relationType.replaceAll("_", " ")} ${target?.canonicalName ?? edge.targetEntityId}.`;
}

export function graphSelectionLabel(
  selection: GraphSelection,
  state: GraphPresentationState,
): string {
  const text = graphSelectionText(selection, state);
  if (
    selection.kind === "entity"
      ? !state.nodes.some((node) => node.entityId === selection.id)
      : !state.edges.some((edge) => edge.relationId === selection.id)
  )
    return text;
  return `${text} ${selection.kind === "entity" ? "Entity" : "Relation"} ID ${selection.id}.`;
}

export function knowledgeReadinessPresentation(
  readiness: KnowledgeReadinessLike,
): {
  tone: "neutral" | "info" | "success" | "warning";
  label: string;
  description: string;
} {
  const layers = [readiness.keyword, readiness.semantic, readiness.graph];
  if (layers.includes("degraded")) {
    return {
      tone: "warning",
      label: "Knowledge partially available",
      description: "Some current items could not be indexed.",
    };
  }
  if (layers.includes("building")) {
    return {
      tone: "info",
      label: "Knowledge is being indexed",
      description: "Current project knowledge is still being prepared.",
    };
  }
  if (!readiness.aiConfigured) {
    return {
      tone: "neutral",
      label: "Keyword-only mode",
      description:
        "AI routing is not configured. Keyword search remains available; an administrator can assign knowledge models under Administration › Settings › AI.",
    };
  }
  if (layers.every((layer) => layer === "ready")) {
    return {
      tone: "success",
      label: "Knowledge ready",
      description:
        "Current documents are represented across keyword, semantic, and graph indexes.",
    };
  }
  if (layers.every((layer) => layer === "empty")) {
    return {
      tone: "neutral",
      label: "No indexed knowledge yet",
      description: "No indexed content is available yet.",
    };
  }
  return {
    tone: "neutral",
    label: "Knowledge partly ready",
    description: "Some knowledge layers do not have indexed content yet.",
  };
}

function compareText(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function temporalLabel(validFrom: Date | null, validTo: Date | null) {
  const from = validFrom?.toISOString().slice(0, 10);
  const to = validTo?.toISOString().slice(0, 10);
  if (from && to) return `Valid ${from} to ${to}`;
  if (from) return `Valid from ${from}`;
  if (to) return `Valid until ${to}`;
  return null;
}

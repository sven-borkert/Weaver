export const DEFAULT_GRAPH_NODE_LIMIT = 50;
export const DEFAULT_GRAPH_EDGE_LIMIT = 100;
export const MAX_GRAPH_CANVAS_NODES = 100;
export const MAX_GRAPH_CANVAS_EDGES = 200;

export type GraphPresentationNode = {
  entityId: string;
  projectId: string;
  projectName: string;
  canonicalName: string;
  aliases: string[];
  entityType: string;
  description: string | null;
};

export type GraphPresentationEdge = {
  relationId: string;
  projectId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  maxConfidence: number;
};

export type GraphNeighborhoodLike = {
  nodes: GraphPresentationNode[];
  edges: GraphPresentationEdge[];
  truncated: boolean;
};

export type GraphSelection =
  { kind: "entity"; id: string } | { kind: "relation"; id: string };

export type GraphPresentationState = {
  projectId: string;
  focusId: string;
  nodes: GraphPresentationNode[];
  edges: GraphPresentationEdge[];
  truncated: boolean;
  atCapacity: boolean;
};

export function startFocusedGraph(
  response: GraphNeighborhoodLike,
  focusId: string,
): GraphPresentationState | null {
  const focus = response.nodes.find((node) => node.entityId === focusId);
  if (!focus) return null;

  const nodes = uniqueNodesForProject(response.nodes, focus.projectId, focus);
  const edges = uniqueEdgesForNodes(response.edges, focus.projectId, nodes);

  return {
    projectId: focus.projectId,
    focusId,
    nodes,
    edges,
    truncated: response.truncated,
    atCapacity:
      nodes.length === MAX_GRAPH_CANVAS_NODES ||
      edges.length === MAX_GRAPH_CANVAS_EDGES,
  };
}

export function mergeGraphNeighborhood(
  current: GraphPresentationState,
  response: GraphNeighborhoodLike,
): GraphPresentationState {
  const nodes = uniqueNodesForProject(
    [...current.nodes, ...response.nodes],
    current.projectId,
  );
  const edges = uniqueEdgesForNodes(
    [...current.edges, ...response.edges],
    current.projectId,
    nodes,
  );

  return {
    ...current,
    nodes,
    edges,
    truncated: current.truncated || response.truncated,
    atCapacity:
      current.atCapacity ||
      nodes.length === MAX_GRAPH_CANVAS_NODES ||
      edges.length === MAX_GRAPH_CANVAS_EDGES,
  };
}

export function remainingGraphCapacity(state: GraphPresentationState): {
  maxNodes: number;
  maxEdges: number;
} {
  return {
    maxNodes: Math.max(0, MAX_GRAPH_CANVAS_NODES - state.nodes.length),
    maxEdges: Math.max(0, MAX_GRAPH_CANVAS_EDGES - state.edges.length),
  };
}

/** The server's bounds size the whole response and cannot exclude visible items, so expansion asks for the full canvas and the merge dedupes. */
export function graphExpansionBounds(state: GraphPresentationState): {
  maxNodes: number;
  maxEdges: number;
} | null {
  const capacity = remainingGraphCapacity(state);
  if (capacity.maxNodes === 0 || capacity.maxEdges === 0) return null;
  return { maxNodes: MAX_GRAPH_CANVAS_NODES, maxEdges: MAX_GRAPH_CANVAS_EDGES };
}

function uniqueNodesForProject(
  candidates: GraphPresentationNode[],
  projectId: string,
  first?: GraphPresentationNode,
) {
  const nodes: GraphPresentationNode[] = [];
  const seen = new Set<string>();

  const add = (node: GraphPresentationNode) => {
    if (
      nodes.length >= MAX_GRAPH_CANVAS_NODES ||
      node.projectId !== projectId ||
      seen.has(node.entityId)
    ) {
      return;
    }
    seen.add(node.entityId);
    nodes.push(node);
  };

  if (first) add(first);
  for (const candidate of candidates) add(candidate);
  return nodes;
}

function uniqueEdgesForNodes(
  candidates: GraphPresentationEdge[],
  projectId: string,
  nodes: GraphPresentationNode[],
) {
  const nodeIds = new Set(nodes.map((node) => node.entityId));
  const edges: GraphPresentationEdge[] = [];
  const seen = new Set<string>();

  for (const edge of candidates) {
    if (edges.length >= MAX_GRAPH_CANVAS_EDGES) break;
    if (
      edge.projectId !== projectId ||
      seen.has(edge.relationId) ||
      !nodeIds.has(edge.sourceEntityId) ||
      !nodeIds.has(edge.targetEntityId)
    ) {
      continue;
    }
    seen.add(edge.relationId);
    edges.push(edge);
  }
  return edges;
}

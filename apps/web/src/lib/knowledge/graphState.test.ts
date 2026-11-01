import { describe, expect, it } from "vitest";

import {
  graphExpansionBounds,
  MAX_GRAPH_CANVAS_EDGES,
  MAX_GRAPH_CANVAS_NODES,
  mergeGraphNeighborhood,
  remainingGraphCapacity,
  startFocusedGraph,
  type GraphPresentationEdge,
  type GraphPresentationNode,
} from "./graphState";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function node(entityId: string, projectId = PROJECT_ID): GraphPresentationNode {
  return {
    entityId,
    projectId,
    projectName: projectId === PROJECT_ID ? "Atlas" : "Beacon",
    canonicalName: `Entity ${entityId}`,
    aliases: [],
    entityType: "service",
    description: null,
  };
}

function edge(
  relationId: string,
  sourceEntityId: string,
  targetEntityId: string,
  projectId = PROJECT_ID,
): GraphPresentationEdge {
  return {
    relationId,
    projectId,
    sourceEntityId,
    targetEntityId,
    relationType: "depends_on",
    maxConfidence: 0.9,
  };
}

describe("focused graph state", () => {
  it("finds focus by identity and keeps only its deduplicated project graph", () => {
    const focus = node("focus");
    const neighbor = node("neighbor");
    const relation = edge("relation", focus.entityId, neighbor.entityId);

    const state = startFocusedGraph(
      {
        nodes: [node("foreign", FOREIGN_PROJECT_ID), neighbor, focus, neighbor],
        edges: [
          relation,
          relation,
          edge(
            "foreign-relation",
            "foreign",
            focus.entityId,
            FOREIGN_PROJECT_ID,
          ),
          edge("dangling", focus.entityId, "missing"),
        ],
        truncated: false,
      },
      focus.entityId,
    );

    expect(state).toMatchObject({
      projectId: PROJECT_ID,
      focusId: "focus",
      truncated: false,
      atCapacity: false,
    });
    expect(state?.nodes.map((item) => item.entityId)).toEqual([
      "focus",
      "neighbor",
    ]);
    expect(state?.edges.map((item) => item.relationId)).toEqual(["relation"]);
    expect(remainingGraphCapacity(state!)).toEqual({
      maxNodes: 98,
      maxEdges: 199,
    });
  });

  it("returns null instead of treating array order as a substitute focus", () => {
    expect(
      startFocusedGraph(
        { nodes: [node("neighbor")], edges: [], truncated: false },
        "missing-focus",
      ),
    ).toBeNull();
  });

  it("enforces hard caps and carries server truncation into presentation state", () => {
    const nodes = Array.from(
      { length: MAX_GRAPH_CANVAS_NODES + 5 },
      (_, index) => node(`node-${index}`),
    );
    const edges = Array.from(
      { length: MAX_GRAPH_CANVAS_EDGES + 5 },
      (_, index) =>
        edge(
          `edge-${index}`,
          nodes[index % nodes.length]!.entityId,
          nodes[(index + 1) % nodes.length]!.entityId,
        ),
    );

    const state = startFocusedGraph(
      { nodes, edges, truncated: true },
      nodes.at(-1)!.entityId,
    );

    expect(state?.nodes).toHaveLength(MAX_GRAPH_CANVAS_NODES);
    expect(state?.nodes[0]?.entityId).toBe(nodes.at(-1)?.entityId);
    expect(state?.edges.length).toBeLessThanOrEqual(MAX_GRAPH_CANVAS_EDGES);
    expect(state).toMatchObject({ truncated: true, atCapacity: true });
    expect(remainingGraphCapacity(state!)).toEqual({
      maxNodes: 0,
      maxEdges: MAX_GRAPH_CANVAS_EDGES - state!.edges.length,
    });
  });

  it("enforces the relation cap independently of node capacity", () => {
    const edges = Array.from(
      { length: MAX_GRAPH_CANVAS_EDGES + 5 },
      (_, index) => edge(`edge-${index}`, "focus", "neighbor"),
    );

    const state = startFocusedGraph(
      {
        nodes: [node("focus"), node("neighbor")],
        edges,
        truncated: false,
      },
      "focus",
    );

    expect(state?.edges).toHaveLength(MAX_GRAPH_CANVAS_EDGES);
    expect(state?.atCapacity).toBe(true);
    expect(remainingGraphCapacity(state!)).toEqual({
      maxNodes: 98,
      maxEdges: 0,
    });
  });

  it("merges unseen same-project items without evicting existing state", () => {
    const current = startFocusedGraph(
      {
        nodes: [node("focus"), node("existing")],
        edges: [edge("existing-edge", "focus", "existing")],
        truncated: false,
      },
      "focus",
    )!;
    const oversizedNodes = Array.from(
      { length: MAX_GRAPH_CANVAS_NODES + 5 },
      (_, index) => node(`new-${index}`),
    );

    const merged = mergeGraphNeighborhood(current, {
      nodes: [
        node("focus"),
        node("foreign", FOREIGN_PROJECT_ID),
        ...oversizedNodes,
      ],
      edges: [
        edge("existing-edge", "focus", "existing"),
        edge("new-edge", "focus", "new-0"),
        edge("foreign-edge", "focus", "foreign"),
      ],
      truncated: true,
    });

    expect(merged.nodes.slice(0, 2).map((item) => item.entityId)).toEqual([
      "focus",
      "existing",
    ]);
    expect(merged.nodes).toHaveLength(MAX_GRAPH_CANVAS_NODES);
    expect(merged.nodes.some((item) => item.entityId === "foreign")).toBe(
      false,
    );
    expect(merged.edges.map((item) => item.relationId)).toEqual([
      "existing-edge",
      "new-edge",
    ]);
    expect(merged).toMatchObject({
      projectId: PROJECT_ID,
      focusId: "focus",
      truncated: true,
      atCapacity: true,
    });
  });

  it("starts a new focus without carrying nodes from the previous focus", () => {
    const previous = startFocusedGraph(
      {
        nodes: [node("old-focus"), node("old-neighbor")],
        edges: [edge("old-edge", "old-focus", "old-neighbor")],
        truncated: false,
      },
      "old-focus",
    );
    expect(previous?.nodes).toHaveLength(2);

    const reset = startFocusedGraph(
      { nodes: [node("new-focus")], edges: [], truncated: false },
      "new-focus",
    );

    expect(reset?.focusId).toBe("new-focus");
    expect(reset?.nodes.map((item) => item.entityId)).toEqual(["new-focus"]);
    expect(reset?.edges).toEqual([]);
  });

  describe("expansion", () => {
    const star = (count: number) => {
      const neighbors = Array.from({ length: count - 1 }, (_, index) =>
        node(`n${String(index).padStart(3, "0")}`),
      );
      return {
        nodes: [node("focus"), ...neighbors],
        edges: neighbors.map((item) =>
          edge(`e-${item.entityId}`, "focus", item.entityId),
        ),
        truncated: false,
      };
    };
    const fullBounds = {
      maxNodes: MAX_GRAPH_CANVAS_NODES,
      maxEdges: MAX_GRAPH_CANVAS_EDGES,
    };

    it("requests the whole canvas so a repeated focus still adds its unseen neighbours", () => {
      const state = startFocusedGraph(star(50), "focus")!;
      expect(graphExpansionBounds(state)).toEqual(fullBounds);

      // The server ranks deterministically: the first 50 nodes are the visible ones.
      const merged = mergeGraphNeighborhood(state, star(100));
      expect(merged.nodes).toHaveLength(100);
      expect(merged.nodes.slice(0, 50)).toEqual(state.nodes);
      expect(merged.edges).toHaveLength(99);
    });

    it("lets a 99-node canvas gain its final node", () => {
      const state = startFocusedGraph(star(99), "focus")!;
      expect(remainingGraphCapacity(state).maxNodes).toBe(1);
      expect(graphExpansionBounds(state)).toEqual(fullBounds);

      const merged = mergeGraphNeighborhood(state, star(100));
      expect(merged.nodes).toHaveLength(MAX_GRAPH_CANVAS_NODES);
      expect(merged.nodes.at(-1)?.entityId).toBe("n098");
      expect(merged.atCapacity).toBe(true);
    });

    it("returns null once the canvas has no node or edge capacity left", () => {
      const fullNodes = startFocusedGraph(star(100), "focus")!;
      expect(graphExpansionBounds(fullNodes)).toBeNull();

      const focus = node("focus");
      const other = node("other");
      const fullEdges = startFocusedGraph(
        {
          nodes: [focus, other],
          edges: Array.from({ length: MAX_GRAPH_CANVAS_EDGES }, (_, index) =>
            edge(`e${index}`, "focus", "other"),
          ),
          truncated: false,
        },
        "focus",
      )!;
      expect(fullEdges.edges).toHaveLength(MAX_GRAPH_CANVAS_EDGES);
      expect(graphExpansionBounds(fullEdges)).toBeNull();
    });
  });
});

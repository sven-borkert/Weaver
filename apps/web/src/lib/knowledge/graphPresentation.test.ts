import { describe, expect, it } from "vitest";

import {
  accessibleGraphRouteScope,
  createGraphRouteVerificationCoordinator,
  graphCitationPresentation,
  graphDetailFailureDisposition,
  graphDetailTruncationLabel,
  graphCanvasTopologyIdentity,
  focusedGraphRouteDisposition,
  graphSelectionFromCanvasTap,
  graphSelectionLabel,
  knowledgeReadinessPresentation,
  orderedGraphEdges,
  orderedGraphNodes,
  toCytoscapeElements,
} from "./graphPresentation";
import { startFocusedGraph } from "./graphState";
import type {
  GraphPresentationEdge,
  GraphPresentationNode,
  GraphPresentationState,
} from "./graphState";

function node(entityId: string, canonicalName: string): GraphPresentationNode {
  return {
    entityId,
    projectId: "project",
    projectName: "Atlas",
    canonicalName,
    aliases: [],
    entityType: "service",
    description: null,
  };
}

function edge(
  relationId: string,
  sourceEntityId: string,
  targetEntityId: string,
  relationType: string,
): GraphPresentationEdge {
  return {
    relationId,
    projectId: "project",
    sourceEntityId,
    targetEntityId,
    relationType,
    maxConfidence: 0.8,
  };
}

const state: GraphPresentationState = {
  projectId: "project",
  focusId: "focus",
  nodes: [
    node("beta", "Beta"),
    node("alpha-z", "Alpha"),
    node("focus", "Zeta"),
    node("alpha-a", "Alpha"),
  ],
  edges: [
    edge("relation-z", "beta", "focus", "owns"),
    edge("relation-c", "alpha-z", "beta", "uses"),
    edge("relation-b", "alpha-a", "beta", "uses"),
    edge("relation-a", "alpha-a", "beta", "uses"),
    edge("relation-first", "alpha-a", "focus", "depends_on"),
  ],
  truncated: false,
  atCapacity: false,
};

describe("graph outline presentation", () => {
  it("maps node, edge, and background canvas taps into React selection", () => {
    expect(
      graphSelectionFromCanvasTap({ group: "nodes", id: "focus" }),
    ).toEqual({ kind: "entity", id: "focus" });
    expect(
      graphSelectionFromCanvasTap({ group: "edges", id: "relation-a" }),
    ).toEqual({ kind: "relation", id: "relation-a" });
    expect(graphSelectionFromCanvasTap(undefined)).toBeUndefined();
  });

  it("keeps topology identity stable across equivalent presentation objects", () => {
    const equivalent = structuredClone(state);
    expect(graphCanvasTopologyIdentity(equivalent)).toBe(
      graphCanvasTopologyIdentity(state),
    );

    expect(
      graphCanvasTopologyIdentity({
        ...equivalent,
        nodes: [...equivalent.nodes, node("new", "New")],
      }),
    ).not.toBe(graphCanvasTopologyIdentity(state));
    expect(
      graphCanvasTopologyIdentity({ ...equivalent, focusId: "beta" }),
    ).not.toBe(graphCanvasTopologyIdentity(state));
  });

  it("adapts ordered React state to plain Cytoscape elements", () => {
    expect(toCytoscapeElements(state)).toEqual([
      ...orderedGraphNodes(state).map((item) => ({
        group: "nodes",
        data: {
          id: item.entityId,
          label: item.canonicalName,
          entityType: item.entityType,
          projectId: item.projectId,
        },
      })),
      ...orderedGraphEdges(state).map((item) => ({
        group: "edges",
        data: {
          id: item.relationId,
          source: item.sourceEntityId,
          target: item.targetEntityId,
          label: item.relationType,
        },
      })),
    ]);
  });

  it("orders the focus first and breaks canonical-name ties by entity ID", () => {
    expect(orderedGraphNodes(state).map((item) => item.entityId)).toEqual([
      "focus",
      "alpha-a",
      "alpha-z",
      "beta",
    ]);
  });

  it("orders relations by source name, type, target name, and relation ID", () => {
    expect(orderedGraphEdges(state).map((item) => item.relationId)).toEqual([
      "relation-first",
      "relation-a",
      "relation-b",
      "relation-c",
      "relation-z",
    ]);
  });

  it("produces descriptive selection labels that remain unique for duplicate names", () => {
    expect(graphSelectionLabel({ kind: "entity", id: "alpha-a" }, state)).toBe(
      "Alpha, service in Atlas. Entity ID alpha-a.",
    );
    expect(graphSelectionLabel({ kind: "entity", id: "alpha-z" }, state)).toBe(
      "Alpha, service in Atlas. Entity ID alpha-z.",
    );
    expect(
      graphSelectionLabel({ kind: "relation", id: "relation-a" }, state),
    ).toBe("Alpha uses Beta. Relation ID relation-a.");
    expect(graphSelectionLabel({ kind: "entity", id: "missing" }, state)).toBe(
      "Graph selection cleared.",
    );
  });
});

describe("graph route access scope", () => {
  it("refuses a target that is absent from the verified accessible list", () => {
    expect(
      accessibleGraphRouteScope(["current", "revoked"], ["current"], "revoked"),
    ).toBeNull();
  });

  it("retains only verified selected projects and falls back to the target", () => {
    expect(
      accessibleGraphRouteScope(
        ["current", "revoked", "target"],
        ["target", "current"],
        "target",
      ),
    ).toEqual(["current", "target"]);
    expect(accessibleGraphRouteScope([], ["target"], "target")).toEqual([
      "target",
    ]);
  });

  it("redirects a valid foreign-project focus response to its owning route", () => {
    const routeProjectId = "11111111-1111-4111-8111-111111111111";
    const focusedProjectId = "22222222-2222-4222-8222-222222222222";
    const focusId = "33333333-3333-4333-8333-333333333333";
    const graph = startFocusedGraph(
      {
        nodes: [
          {
            entityId: focusId,
            projectId: focusedProjectId,
            projectName: "Beacon",
            canonicalName: "Foreign focus",
            aliases: [],
            entityType: "Service",
            description: null,
          },
        ],
        edges: [],
        truncated: false,
      },
      focusId,
    );

    expect(
      focusedGraphRouteDisposition({
        routeProjectId,
        graph: graph!,
        accessibleProjectIds: [routeProjectId, focusedProjectId],
        urlState: {
          focusId,
          projectIds: [routeProjectId],
          entityTypes: ["Service"],
          relationTypes: [],
        },
      }),
    ).toEqual({
      status: "redirect",
      href: `/projects/${focusedProjectId}/graph?focus=${focusId}&project=${routeProjectId}&entityType=Service`,
    });
  });

  it("refuses to redirect a foreign focus outside verified access", () => {
    expect(
      focusedGraphRouteDisposition({
        routeProjectId: "11111111-1111-4111-8111-111111111111",
        graph: {
          ...state,
          projectId: "22222222-2222-4222-8222-222222222222",
          focusId: "33333333-3333-4333-8333-333333333333",
        },
        accessibleProjectIds: ["11111111-1111-4111-8111-111111111111"],
        urlState: {
          focusId: "33333333-3333-4333-8333-333333333333",
          projectIds: ["11111111-1111-4111-8111-111111111111"],
          entityTypes: [],
          relationTypes: [],
        },
      }),
    ).toEqual({ status: "not-found" });
  });
});

describe("cross-project verification coordination", () => {
  it("serializes network checks and permits only the latest completed action", async () => {
    const coordinator = createGraphRouteVerificationCoordinator();
    const firstNetwork = deferred<string[]>();
    const secondNetwork = deferred<string[]>();
    let firstCalls = 0;
    let secondCalls = 0;

    const first = coordinator.verify(() => {
      firstCalls += 1;
      return firstNetwork.promise;
    });
    await Promise.resolve();
    expect(firstCalls).toBe(1);

    const second = coordinator.verify(() => {
      secondCalls += 1;
      return secondNetwork.promise;
    });
    expect(secondCalls).toBe(0);

    firstNetwork.resolve(["stale"]);
    await expect(first).resolves.toEqual({ status: "superseded" });
    await Promise.resolve();
    expect(secondCalls).toBe(1);

    secondNetwork.resolve(["fresh"]);
    await expect(second).resolves.toEqual({
      status: "verified",
      value: ["fresh"],
    });
  });

  it("invalidates in-flight and queued actions without starting stale checks", async () => {
    const coordinator = createGraphRouteVerificationCoordinator();
    const network = deferred<string[]>();
    let queuedCalls = 0;

    const inFlight = coordinator.verify(() => network.promise);
    await Promise.resolve();
    const queued = coordinator.verify(() => {
      queuedCalls += 1;
      return Promise.resolve(["must-not-run"]);
    });
    coordinator.invalidate();
    network.resolve(["late"]);

    await expect(inFlight).resolves.toEqual({ status: "superseded" });
    await expect(queued).resolves.toEqual({ status: "superseded" });
    expect(queuedCalls).toBe(0);
  });

  it("reports a verification failure only while its action is current", async () => {
    const coordinator = createGraphRouteVerificationCoordinator();
    const error = new Error("network unavailable");

    await expect(
      coordinator.verify(() => Promise.reject(error)),
    ).resolves.toEqual({ status: "failed", error });
  });
});

describe("knowledge readiness presentation", () => {
  it.each([
    [
      {
        keyword: "ready",
        semantic: "ready",
        graph: "ready",
        aiConfigured: true,
      },
      {
        tone: "success",
        label: "Knowledge ready",
        description:
          "Current documents are represented across keyword, semantic, and graph indexes.",
      },
    ],
    [
      {
        keyword: "building",
        semantic: "empty",
        graph: "empty",
        aiConfigured: true,
      },
      {
        tone: "info",
        label: "Knowledge is being indexed",
        description: "Current project knowledge is still being prepared.",
      },
    ],
    [
      {
        keyword: "ready",
        semantic: "degraded",
        graph: "ready",
        aiConfigured: true,
      },
      {
        tone: "warning",
        label: "Knowledge partially available",
        description: "Some current items could not be indexed.",
      },
    ],
    [
      {
        keyword: "ready",
        semantic: "empty",
        graph: "empty",
        aiConfigured: true,
      },
      {
        tone: "neutral",
        label: "Knowledge partly ready",
        description: "Some knowledge layers do not have indexed content yet.",
      },
    ],
    [
      {
        keyword: "ready",
        semantic: "ready",
        graph: "empty",
        aiConfigured: true,
      },
      {
        tone: "neutral",
        label: "Knowledge partly ready",
        description: "Some knowledge layers do not have indexed content yet.",
      },
    ],
    [
      {
        keyword: "degraded",
        semantic: "empty",
        graph: "empty",
        aiConfigured: false,
      },
      {
        tone: "warning",
        label: "Knowledge partially available",
        description: "Some current items could not be indexed.",
      },
    ],
    [
      {
        keyword: "ready",
        semantic: "empty",
        graph: "empty",
        aiConfigured: false,
      },
      {
        tone: "neutral",
        label: "Keyword-only mode",
        description:
          "AI routing is not configured. Keyword search remains available; an administrator can assign knowledge models under Administration › Settings › AI.",
      },
    ],
    [
      {
        keyword: "empty",
        semantic: "empty",
        graph: "empty",
        aiConfigured: true,
      },
      {
        tone: "neutral",
        label: "No indexed knowledge yet",
        description: "No indexed content is available yet.",
      },
    ],
  ] as const)("maps bounded readiness to %s", (readiness, expected) => {
    expect(knowledgeReadinessPresentation(readiness)).toEqual(expected);
  });
});

describe("graph detail provenance presentation", () => {
  const projectId = "project-id";
  const documentId = "document-id";
  const source = {
    sourceCommitSha: "a".repeat(40),
    headingPath: ["Guide", "Deployment"],
    excerpt: "Deploy the service",
    confidence: 0.9,
    validFrom: null,
    validTo: null,
    navigation: {
      documentId,
      title: "Guide",
      slug: "guide",
      path: "guide.md",
      navigationAnchor: "section-deployment",
    },
  };

  it("links live citations to their exact document section and source SHA", () => {
    expect(graphCitationPresentation(projectId, source)).toEqual({
      title: "Guide",
      headingLabel: "Guide › Deployment",
      excerpt: "Deploy the service",
      confidenceLabel: "90% confidence",
      temporalLabel: null,
      href: `/projects/${projectId}/documents/${documentId}?section=section-deployment&source=${"a".repeat(40)}`,
    });
  });

  it("links live top-level citations without manufacturing section state", () => {
    expect(
      graphCitationPresentation(projectId, {
        ...source,
        headingPath: [],
        navigation: { ...source.navigation, navigationAnchor: null },
      }),
    ).toEqual({
      title: "Guide",
      headingLabel: null,
      excerpt: "Deploy the service",
      confidenceLabel: "90% confidence",
      temporalLabel: null,
      href: `/projects/${projectId}/documents/${documentId}`,
    });
  });

  it("keeps missing sources as plain bounded citation text", () => {
    expect(
      graphCitationPresentation(projectId, {
        ...source,
        navigation: null,
      }),
    ).toEqual({
      title: "Source unavailable",
      headingLabel: "Guide › Deployment",
      excerpt: "Deploy the service",
      confidenceLabel: "90% confidence",
      temporalLabel: null,
    });
  });

  it.each([
    [new Date("2024-01-02T12:00:00.000Z"), null, "Valid from 2024-01-02"],
    [null, new Date("2024-03-04T12:00:00.000Z"), "Valid until 2024-03-04"],
    [
      new Date("2024-01-02T12:00:00.000Z"),
      new Date("2024-03-04T12:00:00.000Z"),
      "Valid 2024-01-02 to 2024-03-04",
    ],
  ])("formats bounded temporal provenance", (validFrom, validTo, expected) => {
    expect(
      graphCitationPresentation(projectId, {
        ...source,
        validFrom,
        validTo,
      }).temporalLabel,
    ).toBe(expected);
  });

  it("states when the server truncated active provenance", () => {
    expect(graphDetailTruncationLabel("mentions", false)).toBeNull();
    expect(graphDetailTruncationLabel("mentions", true)).toBe(
      "Additional active mentions were omitted by the server.",
    );
    expect(graphDetailTruncationLabel("evidence", true)).toBe(
      "Additional active evidence was omitted by the server.",
    );
  });
});

describe("graph detail failure disposition", () => {
  it("invalidates the graph when current-focus details disappear", () => {
    expect(
      graphDetailFailureDisposition(
        { kind: "entity", id: "focus" },
        "focus",
        "NOT_FOUND",
      ),
    ).toBe("invalidate-focus");
  });

  it("clears only a non-focus selection whose details disappear", () => {
    expect(
      graphDetailFailureDisposition(
        { kind: "entity", id: "neighbor" },
        "focus",
        "NOT_FOUND",
      ),
    ).toBe("clear-selection");
    expect(
      graphDetailFailureDisposition(
        { kind: "relation", id: "relation" },
        "focus",
        "NOT_FOUND",
      ),
    ).toBe("clear-selection");
  });

  it.each(["FORBIDDEN", "UNAUTHORIZED"])(
    "replaces graph access for %s detail failures",
    (code) => {
      expect(
        graphDetailFailureDisposition(
          { kind: "entity", id: "neighbor" },
          "focus",
          code,
        ),
      ).toBe("deny-access");
    },
  );

  it("keeps transient detail failures local", () => {
    expect(
      graphDetailFailureDisposition(
        { kind: "entity", id: "focus" },
        "focus",
        "INTERNAL_SERVER_ERROR",
      ),
    ).toBe("local");
    expect(graphDetailFailureDisposition(undefined, "focus", "NOT_FOUND")).toBe(
      "none",
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Core,
  EventObjectCore,
  EventObjectEdge,
  EventObjectNode,
} from "cytoscape";

import {
  createGraphCanvasStyles,
  graphCanvasLayout,
  graphCanvasViewport,
} from "~/lib/knowledge/graphCanvas";
import {
  graphCanvasTopologyIdentity,
  graphSelectionFromCanvasTap,
  toCytoscapeElements,
} from "~/lib/knowledge/graphPresentation";
import type {
  GraphPresentationState,
  GraphSelection,
} from "~/lib/knowledge/graphState";

export function GraphCanvas({
  graph,
  selection,
  fitRequest,
  onSelectionChange,
  onReadyChange,
}: {
  graph: GraphPresentationState;
  selection?: GraphSelection;
  fitRequest: number;
  onSelectionChange: (
    selection: GraphSelection | undefined,
    requestDetailFocus: boolean,
  ) => void;
  onReadyChange: (ready: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<Core | undefined>(undefined);
  const graphRef = useRef(graph);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onReadyChangeRef = useRef(onReadyChange);
  const selectionRef = useRef(selection);
  const appliedFitRequest = useRef(fitRequest);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onReadyChangeRef.current = onReadyChange;
  }, [onReadyChange]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    let disposed = false;
    let instance: Core | undefined;
    let themeObserver: MutationObserver | undefined;

    void import("cytoscape")
      .then(({ default: cytoscape }) => {
        if (disposed || !containerRef.current) return;
        const root = document.documentElement;
        const prefersReducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        instance = cytoscape({
          container: containerRef.current,
          elements: toCytoscapeElements(graphRef.current),
          style: createGraphCanvasStyles(getComputedStyle(root)),
          layout: { name: "preset" },
          autounselectify: true,
        });
        instanceRef.current = instance;
        const canvas = instance;
        canvas.one("layoutstop", () => fitGraphCanvas(canvas));
        canvas
          .layout({ ...graphCanvasLayout, animate: !prefersReducedMotion })
          .run();
        instance.on("tap", "node", (event: EventObjectNode) =>
          onSelectionChangeRef.current(
            graphSelectionFromCanvasTap({
              group: "nodes",
              id: event.target.id(),
            }),
            false,
          ),
        );
        instance.on("tap", "edge", (event: EventObjectEdge) =>
          onSelectionChangeRef.current(
            graphSelectionFromCanvasTap({
              group: "edges",
              id: event.target.id(),
            }),
            false,
          ),
        );
        instance.on("tap", (event: EventObjectCore) => {
          if (event.target !== instance) return;
          onSelectionChangeRef.current(
            graphSelectionFromCanvasTap(undefined),
            false,
          );
        });
        themeObserver = new MutationObserver(() => {
          if (!instance || instance.destroyed()) return;
          instance
            .style()
            .fromJson(createGraphCanvasStyles(getComputedStyle(root)))
            .update();
        });
        themeObserver.observe(root, {
          attributes: true,
          attributeFilter: ["class", "data-theme", "style"],
        });
        projectGraphSelection(instance, selectionRef.current);
        setStatus("ready");
        onReadyChangeRef.current(true);
      })
      .catch(() => {
        if (!disposed) {
          setStatus("failed");
          onReadyChangeRef.current(false);
        }
      });

    return () => {
      disposed = true;
      themeObserver?.disconnect();
      if (instanceRef.current === instance) instanceRef.current = undefined;
      instance?.destroy();
      onReadyChangeRef.current(false);
    };
  }, [graph.focusId, graph.projectId]);

  const topologyIdentity = useMemo(
    () => graphCanvasTopologyIdentity(graph),
    [graph],
  );
  const elementDataIdentity = useMemo(
    () => JSON.stringify(toCytoscapeElements(graph)),
    [graph],
  );

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance || instance.destroyed()) return;
    const definitions = toCytoscapeElements(graphRef.current);
    const nextIds = new Set(
      definitions.map((definition) => String(definition.data.id)),
    );
    const viewport = { pan: instance.pan(), zoom: instance.zoom() };

    instance.batch(() => {
      instance
        .elements()
        .filter((element) => !nextIds.has(element.id()))
        .remove();
      const missing = definitions.filter(
        (definition) => !instance.hasElementWithId(String(definition.data.id)),
      );
      if (missing.length > 0) instance.add(missing);
    });

    instance.layout(graphCanvasLayout).run();
    instance.viewport(viewport);
  }, [topologyIdentity]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance || instance.destroyed()) return;
    const definitions = toCytoscapeElements(graphRef.current);
    instance.batch(() => {
      for (const definition of definitions) {
        const element = instance.getElementById(String(definition.data.id));
        if (element.nonempty()) element.data(definition.data);
      }
    });
  }, [elementDataIdentity]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance || instance.destroyed()) return;
    projectGraphSelection(instance, selection);
  }, [selection]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (
      status !== "ready" ||
      !instance ||
      instance.destroyed() ||
      fitRequest === appliedFitRequest.current
    ) {
      return;
    }
    fitGraphCanvas(instance);
    appliedFitRequest.current = fitRequest;
  }, [fitRequest, status]);

  return (
    <section
      aria-labelledby="graph-canvas-heading"
      className="border-line bg-canvas min-w-[42rem] overflow-hidden rounded-[10px] border xl:min-w-0"
    >
      <div className="border-line-faint border-b px-4 py-3">
        <h2
          id="graph-canvas-heading"
          className="text-text m-0 text-[15px] font-semibold"
        >
          Visual graph
        </h2>
        <p className="text-text-3 mt-1 mb-0 text-xs">
          Select an entity or relation here, or use the complete keyboard
          outline below.
        </p>
      </div>
      <div className="relative h-[32rem] min-h-80 min-w-0">
        {/* Cytoscape forces relative positioning, so size its host explicitly. */}
        <div ref={containerRef} aria-hidden className="h-full w-full" />
        {status === "loading" ? (
          <p
            role="status"
            className="text-text-3 bg-surface/90 absolute inset-x-4 top-4 m-0 rounded-lg px-3 py-2 text-sm"
          >
            Loading visual graph…
          </p>
        ) : null}
        {status === "failed" ? (
          <p
            role="alert"
            className="border-review-border bg-review-bg text-review absolute inset-x-4 top-4 m-0 rounded-lg border px-3 py-2 text-sm"
          >
            The visual graph could not be loaded. Every graph item and action
            remains available in the outline.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function projectGraphSelection(instance: Core, selection?: GraphSelection) {
  instance.elements(".react-selected").removeClass("react-selected");
  if (!selection) return;
  const selected = instance.getElementById(selection.id);
  if (selected.nonempty()) selected.addClass("react-selected");
}

function fitGraphCanvas(instance: Core) {
  if (instance.destroyed() || instance.elements().empty()) return;
  instance.viewport(
    graphCanvasViewport(instance.elements().boundingBox(), {
      width: instance.width(),
      height: instance.height(),
    }),
  );
}

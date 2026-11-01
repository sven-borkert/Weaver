import cytoscape from "cytoscape";
import { describe, expect, it } from "vitest";

import {
  createGraphCanvasStyles,
  graphCanvasLayout,
  graphCanvasViewport,
} from "./graphCanvas";

function theme(fill: string) {
  const tokens: Record<string, string> = {
    "--brand-bg-2": fill,
    "--brand": "#6b8eff",
    "--text": "#edf0f7",
    "--text-2": "#c3c9d5",
    "--surface": "#202430",
    "--line-strong": "#596274",
  };
  return { getPropertyValue: (name: string) => tokens[name] ?? "" };
}

describe("graph canvas theme colors", () => {
  it.each([
    ["#6b8eff2e", "rgb(107,142,255)", 46 / 255],
    ["#68f3", "rgb(102,136,255)", 0.2],
    ["rgba(107, 142, 255, 0.18)", "rgb(107,142,255)", 0.18],
    ["#e7edff", "rgb(231,237,255)", 1],
  ])("renders %s with its token color and alpha", (fill, color, opacity) => {
    const graph = cytoscape({
      headless: true,
      styleEnabled: true,
      elements: [{ data: { id: "node", label: "Audacity" } }],
      style: createGraphCanvasStyles(theme(fill)),
    });
    try {
      const node = graph.nodes()[0]!;
      expect(node.style("background-color")).toBe(color);
      expect(Number(node.style("background-opacity"))).toBeCloseTo(opacity);
    } finally {
      graph.destroy();
    }
  });

  it("keeps the node marker size when selected", () => {
    const graph = cytoscape({
      headless: true,
      styleEnabled: true,
      elements: [{ data: { id: "node", label: "Audacity" } }],
      style: createGraphCanvasStyles(theme("#e7edff")),
    });
    try {
      const node = graph.nodes()[0]!;
      const width = node.width();
      node.addClass("react-selected");
      expect(node.width()).toBe(width);
    } finally {
      graph.destroy();
    }
  });
});

describe("graph canvas layout", () => {
  it("leaves room for labels between neighboring nodes", () => {
    const graph = cytoscape({
      headless: true,
      styleEnabled: true,
      layout: { name: "preset" },
      elements: [
        ...["Audacity", "Audio editor", "GNU license", "Windows", "macOS"].map(
          (label, i) => ({
            data: { id: String(i), label },
            position: { x: i * 40, y: (i % 2) * 40 },
          }),
        ),
        ...[1, 2, 3, 4].map((i) => ({
          data: {
            id: `edge${i}`,
            source: "0",
            target: String(i),
            label: "AVAILABLE_ON",
          },
        })),
      ],
      style: createGraphCanvasStyles(theme("#e7edff")),
    });
    try {
      graph.viewport({ zoom: 0.8, pan: { x: 27, y: 51 } });
      graph.layout(graphCanvasLayout).run();
      for (const edge of graph.edges()) {
        const from = edge.source().position();
        const to = edge.target().position();
        expect(Math.hypot(from.x - to.x, from.y - to.y)).toBeGreaterThan(150);
      }
      expect(graph.zoom()).toBe(0.8);
      expect(graph.pan()).toEqual({ x: 27, y: 51 });
    } finally {
      graph.destroy();
    }
  });

  it("centers a small graph without enlarging its labels", () => {
    expect(
      graphCanvasViewport(
        { x1: 20, y1: 30, w: 100, h: 80 },
        { width: 1000, height: 512 },
      ),
    ).toEqual({
      zoom: 1,
      pan: { x: 430, y: 186 },
    });
  });

  it("fits a large graph with room around every edge", () => {
    const viewport = graphCanvasViewport(
      { x1: -100, y1: -50, w: 2000, h: 1000 },
      { width: 1000, height: 512 },
    );
    expect(viewport.zoom).toBeCloseTo(0.416);
    expect(viewport.pan.x - 100 * viewport.zoom).toBeGreaterThanOrEqual(48);
    expect(viewport.pan.y - 50 * viewport.zoom).toBeCloseTo(48);
    expect(viewport.pan.y + 950 * viewport.zoom).toBeCloseTo(464);
  });
});

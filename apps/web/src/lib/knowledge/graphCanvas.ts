import type { CoseLayoutOptions, StylesheetJson } from "cytoscape";

export function createGraphCanvasStyles(
  styles: Pick<CSSStyleDeclaration, "getPropertyValue">,
): StylesheetJson {
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const fill = graphCanvasColor(token("--brand-bg-2"));
  return [
    {
      selector: "node",
      style: {
        "background-color": fill.color,
        "background-opacity": fill.opacity,
        "border-color": token("--brand"),
        "border-width": 2,
        color: token("--text"),
        label: "data(label)",
        "font-size": 12,
        "text-background-color": token("--surface"),
        "text-background-opacity": 0.9,
        "text-background-padding": "3px",
        "text-wrap": "ellipsis",
        "text-max-width": "130px",
        "text-valign": "bottom",
        "text-margin-y": 8,
      },
    },
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "line-color": token("--line-strong"),
        "target-arrow-color": token("--line-strong"),
        "target-arrow-shape": "triangle",
        width: 2,
        color: token("--text-2"),
        label: "data(label)",
        "font-size": 10,
        "text-rotation": "autorotate",
        "text-wrap": "ellipsis",
        "text-max-width": "100px",
        "text-margin-y": -8,
        "text-background-color": token("--surface"),
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
      },
    },
    {
      selector: "node.react-selected",
      style: {
        "border-color": token("--brand"),
        "border-width": 5,
        "z-index": 10,
      },
    },
    {
      selector: "edge.react-selected",
      style: {
        "line-color": token("--brand"),
        "target-arrow-color": token("--brand"),
        width: 5,
        "z-index": 10,
      },
    },
  ];
}

function graphCanvasColor(value: string): { color: string; opacity: number } {
  const hex = /^#([\da-f]{4}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const expanded =
      hex.length === 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return {
      color: `#${expanded.slice(0, 6)}`,
      opacity: parseInt(expanded.slice(6), 16) / 255,
    };
  }
  const rgba =
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(value);
  if (rgba) {
    return {
      color: `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`,
      opacity: Number(rgba[4]),
    };
  }
  return { color: value, opacity: 1 };
}

export const graphCanvasLayout: CoseLayoutOptions = {
  name: "cose",
  animate: false,
  fit: false,
  nodeDimensionsIncludeLabels: true,
  idealEdgeLength: 80,
  nodeRepulsion: 500_000,
  componentSpacing: 100,
};

export function graphCanvasViewport(
  bounds: { x1: number; y1: number; w: number; h: number },
  size: { width: number; height: number },
) {
  const zoom = Math.min(
    1,
    Math.max(1, size.width - 96) / Math.max(1, bounds.w),
    Math.max(1, size.height - 96) / Math.max(1, bounds.h),
  );
  return {
    zoom,
    pan: {
      x: size.width / 2 - (bounds.x1 + bounds.w / 2) * zoom,
      y: size.height / 2 - (bounds.y1 + bounds.h / 2) * zoom,
    },
  };
}

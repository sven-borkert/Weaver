import {
  parsePlotSpec,
  samplePlotCurve,
  samplePlotSurface,
  type PlotPoint,
  type PlotRange,
  type PlotSpec,
} from "@weaver/core/editor/plot-spec";

type Point = { x: number; y: number };
type SurfacePoint = Point & { z: number };

type Curve = {
  type: "curve";
  points: (PlotPoint | null)[];
  x: PlotRange;
  y: PlotRange;
  preserveAspect: boolean;
};

type Surface = {
  type: "surface";
  rows: (SurfacePoint | null)[][];
  x: PlotRange;
  y: PlotRange;
  z: PlotRange;
};

export type PlotRotation = { azimuth: number; elevation: number };

export const DEFAULT_PLOT_ROTATION: PlotRotation = {
  azimuth: -35,
  elevation: 35,
};

const WIDTH = 520;
const HEIGHT = 310;
const GRID_COLOR = "var(--line, #dce4ef)";
const AXIS_COLOR = "var(--line-strong, #b6c6dc)";
const TEXT_COLOR = "var(--text-2, #52647e)";
const PLOT_COLOR = "var(--brand-text, #124cc4)";
const SURFACE_COLOR = "var(--surface, #fff)";
const SURFACE_SHADES = Array.from(
  { length: 13 },
  (_, shade) =>
    `--plot-shade-${shade}:color-mix(in srgb, ${SURFACE_COLOR}, ${PLOT_COLOR} ${16 + 3 * shade}%)`,
).join(";");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extent(values: number[], padding: number): PlotRange {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const margin =
    min === max
      ? Math.max(1, Math.abs(min) * 0.05)
      : max * padding - min * padding;
  const lower = min - margin;
  const upper = max + margin;
  return [
    Number.isFinite(lower) ? lower : min,
    Number.isFinite(upper) ? upper : max,
  ];
}

export function sampleMathPlot(
  spec: PlotSpec,
  parameters?: Readonly<Record<string, number>>,
): Curve | Surface | null {
  if (spec.type === "surface") {
    const rows = samplePlotSurface(spec, parameters, 17);
    const values = rows.flatMap((row) =>
      row.flatMap((point) => (point ? [point.z] : [])),
    );
    return values.length
      ? {
          type: "surface",
          rows,
          x: spec.x,
          y: spec.y,
          z: spec.z ?? extent(values, 0),
        }
      : null;
  }

  const points = samplePlotCurve(spec, parameters);
  const finite = points.filter((point) => point !== null);
  return finite.length
    ? {
        type: "curve",
        points,
        preserveAspect: spec.type === "parametric",
        x:
          spec.x ??
          extent(
            finite.map((point) => point.x),
            0.05,
          ),
        y:
          spec.y ??
          extent(
            finite.map((point) => point.y),
            0.05,
          ),
      }
    : null;
}

function fraction(value: number, [min, max]: PlotRange): number {
  const width = max - min;
  if (Number.isFinite(width)) return (value - min) / width;
  return (value / 2 - min / 2) / (max / 2 - min / 2);
}

function interpolate([min, max]: PlotRange, position: number): number {
  return min * (1 - position) + max * position;
}

function coordinate(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function formatPlotValue(value: number, precision = 6): string {
  const rounded = Number(value.toPrecision(precision));
  return String(Number.isFinite(rounded) ? rounded : value);
}

function line(from: Point, to: Point, color: string): string {
  return `<line x1="${coordinate(from.x)}" y1="${coordinate(from.y)}" x2="${coordinate(to.x)}" y2="${coordinate(to.y)}" stroke="${color}"/>`;
}

function label(
  { x, y }: Point,
  text: string,
  anchor: "start" | "middle" | "end" = "middle",
): string {
  return `<text x="${coordinate(x)}" y="${coordinate(y)}" fill="${TEXT_COLOR}" font-size="${text.length > 10 ? 11 : 14}" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
}

function ticks(range: PlotRange) {
  const values = [
    ...new Set(
      Array.from({ length: 5 }, (_, index) => interpolate(range, index / 4)),
    ),
  ];
  const labelTolerance = range[1] / 400 - range[0] / 400;
  for (let precision = 6; precision < 17; precision++) {
    const labels = values.map((value) => formatPlotValue(value, precision));
    if (
      values.every(
        (value, index) =>
          Math.abs(value - Number(labels[index])) <= labelTolerance,
      )
    ) {
      return values.map((value, index) => [value, labels[index]!] as const);
    }
  }
  return values.map((value) => [value, String(value)] as const);
}

function clipCurveSegment(
  from: Point,
  to: Point,
  x: PlotRange,
  y: PlotRange,
): [Point, Point] | null {
  for (const [axis, range] of [
    ["x", x],
    ["y", y],
  ] as const) {
    const other = axis === "x" ? "y" : "x";
    const bounds: PlotRange = [from[axis], to[axis]];
    if (
      (bounds[0] < range[0] && bounds[1] < range[0]) ||
      (bounds[0] > range[1] && bounds[1] > range[1])
    )
      return null;
    const otherBounds: PlotRange = [from[other], to[other]];
    const constrain = (point: Point): Point => {
      const bound = Math.min(range[1], Math.max(range[0], point[axis]));
      return bound === point[axis]
        ? point
        : {
            ...point,
            [axis]: bound,
            [other]: interpolate(otherBounds, fraction(bound, bounds)),
          };
    };
    from = constrain(from);
    to = constrain(to);
  }
  return [from, to];
}

function renderCurve({ points, x, y, preserveAspect }: Curve): string {
  const frameWidth = WIDTH - 113;
  const frameHeight = HEIGHT - 60;
  const xSpan = x[1] / 2 - x[0] / 2;
  const ySpan = y[1] / 2 - y[0] / 2;
  const aspect = xSpan / ySpan;
  const sameScale = preserveAspect && aspect >= 0.65 && aspect <= 3;
  const width = sameScale
    ? Math.round(Math.min(frameWidth, frameHeight * aspect))
    : frameWidth;
  const height = sameScale
    ? Math.round(Math.min(frameHeight, frameWidth / aspect))
    : frameHeight;
  const left = 86 + (frameWidth - width) / 2;
  const top = 20 + (frameHeight - height) / 2;
  const right = left + width;
  const bottom = top + height;
  const projectX = (value: number) => fraction(value, x) * width;
  const projectY = (value: number) => (1 - fraction(value, y)) * height;
  const project = (point: Point) =>
    `${coordinate(projectX(point.x))} ${coordinate(projectY(point.y))}`;
  const vertical = (at: number, color: string) =>
    line({ x: at, y: top }, { x: at, y: bottom }, color);
  const horizontal = (at: number, color: string) =>
    line({ x: left, y: at }, { x: right, y: at }, color);

  const gridX = ticks(x).map(([tick, text]) => {
    const at = left + projectX(tick);
    return vertical(at, GRID_COLOR) + label({ x: at, y: bottom + 19 }, text);
  });
  const gridY = ticks(y).map(([tick, text]) => {
    const at = top + projectY(tick);
    return (
      horizontal(at, GRID_COLOR) +
      label({ x: left - 8, y: at + 5 }, text, "end")
    );
  });
  const verticalAxis =
    x[0] <= 0 && x[1] >= 0 ? vertical(left + projectX(0), AXIS_COLOR) : "";
  const horizontalAxis =
    y[0] <= 0 && y[1] >= 0 ? horizontal(top + projectY(0), AXIS_COLOR) : "";

  let path = "";
  let previous: Point | null = null;
  let pathEnd = "";
  for (const point of points) {
    if (point?.breakBefore) {
      previous = null;
      pathEnd = "";
    }
    const segment = point && clipCurveSegment(previous ?? point, point, x, y);
    if (segment) {
      const start = project(segment[0]);
      const end = project(segment[1]);
      if (start !== pathEnd) path += `M${start}`;
      path += start === end ? "h0" : `L${end}`;
      pathEnd = end;
    } else {
      pathEnd = "";
    }
    previous = point;
  }

  return `${gridX.join("")}${gridY.join("")}${verticalAxis}${horizontalAxis}${label({ x: right + 14, y: bottom + 5 }, "x")}${label({ x: left - 8, y: top - 6 }, "y", "end")}<svg x="${left}" y="${top}" width="${width}" height="${height}" overflow="hidden"><path data-plot-curve="" d="${path}" fill="none" stroke="${PLOT_COLOR}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function clipAtHeight(
  vertices: SurfacePoint[],
  z: number,
  keepAbove: boolean,
): SurfacePoint[] {
  const inside = (height: number) => (keepAbove ? height >= z : height <= z);
  const clipped: SurfacePoint[] = [];
  let previous = vertices.at(-1);
  for (const point of vertices) {
    if (previous && inside(previous.z) !== inside(point.z)) {
      const t = fraction(z, [previous.z, point.z]);
      clipped.push({
        x: interpolate([previous.x, point.x], t),
        y: interpolate([previous.y, point.y], t),
        z,
      });
    }
    if (inside(point.z)) clipped.push(point);
    previous = point;
  }
  return clipped;
}

function renderSurface(
  { rows, x, y, z }: Surface,
  rotation: PlotRotation,
): string | null {
  const azimuth = (rotation.azimuth * Math.PI) / 180;
  const elevation = (rotation.elevation * Math.PI) / 180;
  const sinAz = Math.sin(azimuth);
  const cosAz = Math.cos(azimuth);
  const sinEl = Math.sin(elevation);
  const cosEl = Math.cos(elevation);
  const scale = 75;
  const zExtent = 0.74;
  const project = (x: number, y: number, z: number) => {
    const u = cosAz * x - sinAz * y;
    const v = sinAz * x + cosAz * y;
    return {
      x: WIDTH / 2 + u * scale,
      y: HEIGHT / 2 + (sinEl * v - cosEl * z) * scale,
      depth: cosEl * v + sinEl * z,
    };
  };

  const grid = [-1, -0.5, 0, 0.5, 1].map(
    (offset) =>
      line(
        project(offset, -1, -zExtent),
        project(offset, 1, -zExtent),
        GRID_COLOR,
      ) +
      line(
        project(-1, offset, -zExtent),
        project(1, offset, -zExtent),
        GRID_COLOR,
      ),
  );
  const origin = project(-1, -1, -zExtent);
  const xAxis = project(1, -1, -zExtent);
  const yAxis = project(-1, 1, -zExtent);
  const zAxis = project(-1, -1, zExtent);
  const axisLabel = (axis: Point, text: string) => {
    const side = axis.x >= origin.x ? 1 : -1;
    return label(
      { x: axis.x + side * 8, y: axis.y + 5 },
      text,
      side === 1 ? "start" : "end",
    );
  };

  const faces: { depth: number; shade: number; points: string }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const previous = rows[i - 1]!;
    for (let j = 1; j < row.length; j++) {
      const corners = [previous[j - 1], previous[j], row[j], row[j - 1]];
      const valid = corners.filter((point) => point != null);
      if (valid.length !== 4) continue;
      const visible = valid.every((point) => point.z >= z[0] && point.z <= z[1])
        ? valid
        : clipAtHeight(clipAtHeight(valid, z[0], true), z[1], false);
      if (visible.length < 3) continue;

      const heights = visible.map((point) => fraction(point.z, z));
      const projected = visible.map((point, index) =>
        project(
          fraction(point.x, x) * 2 - 1,
          fraction(point.y, y) * 2 - 1,
          (heights[index]! * 2 - 1) * zExtent,
        ),
      );
      faces.push({
        depth:
          projected.reduce((sum, point) => sum + point.depth, 0) /
          projected.length,
        shade: Math.round(
          12 *
            (heights.reduce((sum, height) => sum + height, 0) / heights.length),
        ),
        points: projected
          .map(({ x, y }) => `${coordinate(x)},${coordinate(y)}`)
          .join(" "),
      });
    }
  }
  if (!faces.length) return null;

  const mesh = faces
    .sort((a, b) => a.depth - b.depth)
    .map(
      ({ shade, points }) =>
        `<polygon points="${points}" fill="var(--plot-shade-${shade})"/>`,
    );

  const ranges = (
    [
      ["x", x],
      ["y", y],
      ["z", z],
    ] as const
  ).map(([axis, range], index) =>
    label(
      { x: (WIDTH * (index + 0.5)) / 3, y: HEIGHT - 10 },
      `${axis} ${formatPlotValue(range[0])} to ${formatPlotValue(range[1])}`,
    ),
  );

  return `${grid.join("")}${line(origin, xAxis, AXIS_COLOR)}${line(origin, yAxis, AXIS_COLOR)}${line(origin, zAxis, AXIS_COLOR)}<g style="${SURFACE_SHADES}" stroke="${PLOT_COLOR}" stroke-opacity=".5" stroke-width=".65" stroke-linejoin="round">${mesh.join("")}</g>${axisLabel(xAxis, "x")}${axisLabel(yAxis, "y")}${axisLabel(zAxis, "z")}${ranges.join("")}`;
}

export function renderMathPlotChart(
  plot: ReturnType<typeof sampleMathPlot>,
  title?: string,
  rotation = DEFAULT_PLOT_ROTATION,
): string | null {
  if (!plot) return null;
  const content =
    plot.type === "curve" ? renderCurve(plot) : renderSurface(plot, rotation);
  if (!content) return null;
  const description =
    title ?? (plot.type === "curve" ? "2D math plot" : "3D surface plot");
  return `<svg xmlns="http://www.w3.org/2000/svg" data-plot-chart="" class="block h-auto w-full" role="img" aria-label="${escapeHtml(description)}" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${content}</svg>`;
}

export const EMPTY_MATH_PLOT = "No plottable values in the selected range.";

export function renderStaticMathPlotHtml(source: string): string {
  const parsed = parsePlotSpec(source);
  if (!parsed.ok)
    return `<figure data-math-plot=""><p data-plot-error="">${escapeHtml(parsed.error)}</p></figure>`;

  const { spec } = parsed;
  const svg = renderMathPlotChart(sampleMathPlot(spec), spec.title);
  const caption = spec.title
    ? `<figcaption>${escapeHtml(spec.title)}</figcaption>`
    : "";
  const parameters = Object.entries(spec.parameters).map(
    ([name, { value }]) => `${escapeHtml(name)} = ${value}`,
  );
  const context = parameters.length
    ? `<p data-plot-parameters="">${parameters.join(", ")}</p>`
    : "";
  const chart = svg ?? `<p data-plot-error="">${EMPTY_MATH_PLOT}</p>`;
  return `<figure data-math-plot="">${caption}${chart}${context}</figure>`;
}

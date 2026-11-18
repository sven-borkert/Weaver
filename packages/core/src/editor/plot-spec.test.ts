import { describe, expect, it } from "vitest";
import { parsePlotSpec, samplePlotCurve, samplePlotSurface } from "./plot-spec";

const cartesian = { type: "cartesian", expression: "x", x: [-1, 1] };

function parse(spec: object) {
  const result = parsePlotSpec(JSON.stringify(spec));
  if (!result.ok) throw new Error(result.error);
  return result.spec;
}

describe("parsePlotSpec", () => {
  it("normalizes slider intervals and keeps the chart title and viewport", () => {
    const spec = parse({
      ...cartesian,
      expression: "a*x+b",
      y: [-5, 5],
      title: "Line",
      parameters: {
        a: { min: 0, max: 2, value: 1 },
        b: { min: -2, max: 2, value: 0, step: 0.5 },
      },
    });
    expect(spec).toMatchObject({
      title: "Line",
      y: [-5, 5],
      parameters: {
        a: { min: 0, max: 2, value: 1, step: 0.02 },
        b: { min: -2, max: 2, value: 0, step: 0.5 },
      },
    });
  });

  it.each([
    ["bad JSON", "{x:"],
    ["unsupported shape", "[]"],
    ["oversized source", " ".repeat(100_000)],
    [
      "unbounded JSON number",
      '{"type":"cartesian","expression":"x","x":[0,1e999]}',
    ],
  ])("rejects %s", (_label, source) => {
    expect(parsePlotSpec(source).ok).toBe(false);
  });

  it.each([
    { ...cartesian, type: "unknown" },
    { ...cartesian, x: [1, 0] },
    { ...cartesian, x: [-1e308, 1e308] },
    { ...cartesian, y: [0, 0] },
    { ...cartesian, parameters: { a: { min: 0, max: 1, value: 2 } } },
    { ...cartesian, parameters: { a: { min: 0, max: 1, value: 0, step: 0 } } },
    { ...cartesian, parameters: { x: { min: 0, max: 1, value: 0 } } },
    { ...cartesian, parameters: { pi: { min: 0, max: 1, value: 0 } } },
    {
      ...cartesian,
      parameters: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `p${i}`,
          { min: 0, max: 1, value: 0 },
        ]),
      ),
    },
  ])("rejects an invalid plot shape: %j", (spec) => {
    expect(parsePlotSpec(JSON.stringify(spec)).ok).toBe(false);
  });

  it.each([
    "x + y",
    "x + a",
    "x + Math.sin(x)",
    "globalThis.alert(x)",
    "x; alert(x)",
    "constructor(x)",
    "sin()",
    "sin(x, x)",
    "x(2)",
    "1e999",
    "x+".repeat(256) + "x",
    "(".repeat(64) + "x" + ")".repeat(64),
  ])("rejects unsupported expressions: %s", (expression) => {
    const result = parsePlotSpec(JSON.stringify({ ...cartesian, expression }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expression");
  });
});

describe("samplePlotCurve", () => {
  it("evaluates arithmetic precedence, scientific numbers and real-valued functions", () => {
    const spec = parse({
      ...cartesian,
      expression:
        "-2^2 + 2^-2 + 2^3^2 + 2.5e-1 + ln(e) + cos(pi) + abs(x) + max(x, 0)",
    });
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    expect(samplePlotCurve(spec, {}, 3)).toEqual([
      { x: -1, y: 509.5 },
      { x: 0, y: 508.5 },
      { x: 1, y: 510.5 },
    ]);
  });

  it("uses the default slider value and accepts current slider values", () => {
    const spec = parse({
      ...cartesian,
      expression: "a*x",
      parameters: { a: { min: 0, max: 4, value: 1 } },
    });
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    expect(samplePlotCurve(spec, undefined, 2)[1]).toEqual({ x: 1, y: 1 });
    expect(samplePlotCurve(spec, { a: 3 }, 2)[1]).toEqual({ x: 1, y: 3 });
    expect(samplePlotCurve(spec, { a: Number.NaN }, 2)[1]).toEqual({
      x: 1,
      y: 1,
    });
  });

  it("keeps a gap at undefined values instead of joining both sides", () => {
    const spec = parse({ ...cartesian, expression: "1/x" });
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    expect(samplePlotCurve(spec, {}, 3)).toEqual([
      { x: -1, y: -1 },
      null,
      { x: 1, y: 1 },
    ]);
  });

  it("keeps a gap at the tangent pole", () => {
    const spec = parse({ ...cartesian, expression: "tan(x)", x: [0, Math.PI] });
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    expect(samplePlotCurve(spec, {}, 3)[1]).toBeNull();
  });

  it("breaks the segment across an off-grid division pole", () => {
    const spec = parse({ ...cartesian, expression: "1/(x-0.001)" });
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    const points = samplePlotCurve(spec);
    expect(points).toHaveLength(401);
    expect(points[200]).toEqual({ x: 0, y: -1000 });
    expect(points[201]).toMatchObject({ breakBefore: true });
    expect(points[201]?.x).toBeCloseTo(0.005);
  });

  it.each([
    ["tan(x)", "tan(t)", [0, 3]],
    ["1/(x-0.001)", "1/(t-0.001)", [-1, 1]],
  ])(
    "breaks equivalent Cartesian and parametric curves for %s",
    (expression, parametric, range) => {
      const cartesian = parse({ type: "cartesian", expression, x: range });
      const parametricY = parse({
        type: "parametric",
        xExpression: "t",
        yExpression: parametric,
        t: range,
      });
      const parametricX = parse({
        type: "parametric",
        xExpression: parametric,
        yExpression: "-t",
        t: range,
      });
      if (
        cartesian.type !== "cartesian" ||
        parametricY.type !== "parametric" ||
        parametricX.type !== "parametric"
      )
        throw new Error("Unexpected plot type");
      const points = samplePlotCurve(cartesian);
      const gaps = points.map((point) => Boolean(point?.breakBefore));
      expect(gaps.filter(Boolean)).toHaveLength(1);
      expect(samplePlotCurve(parametricY)).toEqual(points);
      expect(
        samplePlotCurve(parametricX).map((point) =>
          Boolean(point?.breakBefore),
        ),
      ).toEqual(gaps);
    },
  );

  it.each([
    "1e8*(x-0.001)/(1+abs(x))",
    "(2*floor(x-0.001)+1)/(2*floor(x-0.001)+1)",
  ])("keeps a continuous curve connected: %s", (expression) => {
    const spec = parse({ ...cartesian, expression });
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    const points = samplePlotCurve(spec);
    expect(points.every((point) => point && !("breakBefore" in point))).toBe(
      true,
    );
  });

  it("keeps gaps when an intermediate expression is undefined", () => {
    const spec = parse({ ...cartesian, expression: "(1/x)^0" });
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    expect(samplePlotCurve(spec, {}, 3)).toEqual([
      { x: -1, y: 1 },
      null,
      { x: 1, y: 1 },
    ]);
  });

  it("samples both coordinates of a parametric curve at each t", () => {
    const spec = parse({
      type: "parametric",
      xExpression: "cos(t)",
      yExpression: "sin(t)",
      t: [0, Math.PI],
    });
    if (spec.type !== "parametric") throw new Error("Expected parametric plot");
    const points = samplePlotCurve(spec, {}, 3);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ x: 1, y: 0 });
    expect(points[1]?.x).toBeCloseTo(0);
    expect(points[1]?.y).toBeCloseTo(1);
    expect(points[2]?.x).toBeCloseTo(-1);
    expect(points[2]?.y).toBeCloseTo(0);
  });

  it("caps sampling requests", () => {
    const spec = parse(cartesian);
    if (spec.type !== "cartesian") throw new Error("Expected Cartesian plot");
    expect(samplePlotCurve(spec, {}, 1_000_000)).toHaveLength(1_025);
    expect(samplePlotCurve(spec, {}, -1)).toHaveLength(2);
  });
});

describe("samplePlotSurface", () => {
  it("samples x across each row and y between rows", () => {
    const spec = parse({
      type: "surface",
      expression: "a*x + y",
      x: [-1, 1],
      y: [0, 3],
      z: [-5, 5],
      parameters: { a: { min: 0, max: 4, value: 1 } },
    });
    if (spec.type !== "surface") throw new Error("Expected surface plot");
    expect(spec.z).toEqual([-5, 5]);
    expect(samplePlotSurface(spec, { a: 2 }, 2)).toEqual([
      [
        { x: -1, y: 0, z: -2 },
        { x: 1, y: 0, z: 2 },
      ],
      [
        { x: -1, y: 3, z: 1 },
        { x: 1, y: 3, z: 5 },
      ],
    ]);
  });

  it("keeps undefined surface points as gaps and caps grid size", () => {
    const spec = parse({
      type: "surface",
      expression: "sqrt(x)",
      x: [-1, 1],
      y: [-1, 1],
    });
    if (spec.type !== "surface") throw new Error("Expected surface plot");
    expect(samplePlotSurface(spec, {}, 2)[0]).toEqual([
      null,
      { x: 1, y: -1, z: 1 },
    ]);
    const grid = samplePlotSurface(spec, {}, 1_000_000);
    expect(grid).toHaveLength(65);
    expect(grid[0]).toHaveLength(65);
  });
});

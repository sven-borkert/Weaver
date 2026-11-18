import { describe, expect, it } from "vitest";
import { renderStaticMathPlotHtml } from "./plot-render";

describe("renderStaticMathPlotHtml", () => {
  it("draws a function with its documented starting parameter and escapes its title", () => {
    const html = renderStaticMathPlotHtml(
      JSON.stringify({
        type: "cartesian",
        title: '<img src="https://example.test">',
        expression: "a*x",
        x: [-2, 2],
        y: [-2, 2],
        parameters: { a: { min: 0, max: 2, value: 1, step: 0.5 } },
      }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("data-plot-curve");
    expect(html).toContain("a = 1");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<input");
  });

  it("draws a surface mesh with three labeled axes", () => {
    const html = renderStaticMathPlotHtml(
      JSON.stringify({
        type: "surface",
        expression: "sin(x)*cos(y)",
        x: [-3, 3],
        y: [-3, 3],
      }),
    );
    expect(html).toContain("<polygon");
    expect(html).toContain(">x</text>");
    expect(html).toContain(">y</text>");
    expect(html).toContain(">z</text>");
    expect(html).not.toContain("NaN");
  });

  it("draws visible surface fragments across a narrow height range", () => {
    const html = renderStaticMathPlotHtml(
      JSON.stringify({
        type: "surface",
        expression: "x",
        x: [-5, 5],
        y: [-5, 5],
        z: [0.21, 0.22],
      }),
    );
    expect(html).toContain("<polygon");
    expect(html).not.toContain("data-plot-error");
  });

  it("does not draw an out-of-bounds diagonal across the viewport", () => {
    const html = renderStaticMathPlotHtml(
      JSON.stringify({
        type: "parametric",
        xExpression: "1000000*(t-0.001)",
        yExpression: "1000000*(t-0.0015)",
        t: [0, 1],
        x: [-1, 1],
        y: [-1, 1],
      }),
    );
    expect(html).toContain('data-plot-curve="" d=""');
  });

  it("leaves a gap where a pole falls between two samples", () => {
    const html = renderStaticMathPlotHtml(
      JSON.stringify({
        type: "cartesian",
        expression: "1/(x-0.003)",
        x: [-1, 1],
        y: [-10, 10],
      }),
    );
    const path = /data-plot-curve="" d="([^"]+)"/.exec(html)?.[1];
    expect(path?.match(/M/g)).toHaveLength(2);
  });

  it("labels distinct ticks on a narrow range with a large offset", () => {
    const html = renderStaticMathPlotHtml(
      JSON.stringify({
        type: "cartesian",
        expression: "x-1000000",
        x: [1000000, 1000001],
      }),
    );
    expect(html).toContain(">1000000.25</text>");
    expect(html).toContain(">1000000.75</text>");
  });

  it("reports unusable specifications without injecting the expression", () => {
    const html = renderStaticMathPlotHtml(
      JSON.stringify({
        type: "cartesian",
        expression: "<script>alert(1)</script>",
        x: [-2, 2],
      }),
    );
    expect(html).toContain("data-plot-error");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg");
  });
});

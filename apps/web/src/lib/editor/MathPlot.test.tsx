import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MathPlot } from "./MathPlot";

let renderer: ReactTestRenderer;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

function chart() {
  const viewport = renderer.root.findByProps({ "data-plot-viewport": "" })
    .props as { dangerouslySetInnerHTML: { __html: string } };
  return viewport.dangerouslySetInnerHTML.__html;
}

function changeSlider(label: string, valueAsNumber: number) {
  const { onChange } = renderer.root.findByProps({
    "aria-label": label,
    type: "range",
  }).props as {
    onChange: (event: { currentTarget: { valueAsNumber: number } }) => void;
  };
  return act(() => onChange({ currentTarget: { valueAsNumber } }));
}

describe("MathPlot", () => {
  it("redraws the curve as a parameter changes and resets to its published value", async () => {
    const source = JSON.stringify({
      type: "cartesian",
      expression: "a*x",
      x: [-2, 2],
      y: [-6, 6],
      parameters: { a: { min: 0, max: 3, value: 1 } },
    });
    await act(() => {
      renderer = create(<MathPlot source={source} />);
    });
    const initial = chart();

    await changeSlider("a", 2);
    expect(chart()).not.toBe(initial);

    const { onClick } = renderer.root.findByProps({ "data-reset-plot": "" })
      .props as { onClick: () => void };
    await act(() => onClick());
    expect(chart()).toBe(initial);
  });

  it("shows another view of the same surface when its rotation changes", async () => {
    const source = JSON.stringify({
      type: "surface",
      expression: "x^2-y^2",
      x: [-2, 2],
      y: [-2, 2],
    });
    await act(() => {
      renderer = create(<MathPlot source={source} />);
    });
    const initial = chart();

    await changeSlider("Horizontal rotation", 45);
    expect(chart()).not.toBe(initial);
    expect(chart()).toContain("<polygon");
  });
});

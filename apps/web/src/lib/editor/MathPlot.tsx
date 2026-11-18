"use client";

import { useMemo, useState } from "react";
import { parsePlotSpec, type PlotSpec } from "@weaver/core/editor/plot-spec";
import { Button } from "~/components/ui/button";
import {
  DEFAULT_PLOT_ROTATION,
  EMPTY_MATH_PLOT,
  renderMathPlotChart,
  sampleMathPlot,
} from "./plot-render";

const frameClass =
  "border-line bg-surface my-3 min-w-0 overflow-hidden rounded-lg border";

function PlotSlider({
  label,
  value,
  min,
  max,
  step,
  degrees = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number | "any";
  degrees?: boolean;
  onChange: (value: number) => void;
}) {
  const displayed = String(value);

  return (
    <label className="grid min-w-0 grid-cols-[1fr_auto] items-center gap-x-3 text-xs">
      <span className="text-text-2 font-medium">{label}</span>
      <span aria-hidden="true" className="text-text-3 tabular-nums">
        {displayed}
        {degrees && "°"}
      </span>
      <input
        className="accent-brand col-span-2 h-6 w-full cursor-pointer"
        type="range"
        aria-label={label}
        aria-valuetext={degrees ? `${displayed} degrees` : displayed}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

function parameterStep({
  min,
  max,
  value,
  step,
}: PlotSpec["parameters"][string]): number | "any" {
  // Native ranges round to the step grid, so an off-grid endpoint or default requires continuous adjustment.
  const followsGrid = (position: number) => {
    const steps = (position - min) / step;
    return (
      Math.abs(steps - Math.round(steps)) <=
      Number.EPSILON * Math.max(1, steps) * 2
    );
  };
  return followsGrid(value) && followsGrid(max) ? step : "any";
}

function PlotError({ children }: { children: string }) {
  return (
    <p
      className="text-danger px-4 py-3 text-sm"
      data-plot-error=""
      role="status"
    >
      {children}
    </p>
  );
}

function InteractiveMathPlot({ spec }: { spec: PlotSpec }) {
  const [parameters, setParameters] = useState<Record<string, number>>({});
  const [rotation, setRotation] = useState(DEFAULT_PLOT_ROTATION);
  const plot = useMemo(
    () => sampleMathPlot(spec, parameters),
    [spec, parameters],
  );
  const html = useMemo(
    () => renderMathPlotChart(plot, spec.title, rotation),
    [plot, spec.title, rotation],
  );
  const definitions = Object.entries(spec.parameters);
  const isSurface = spec.type === "surface";
  const changed =
    definitions.some(
      ([name, { value }]) => (parameters[name] ?? value) !== value,
    ) ||
    rotation.azimuth !== DEFAULT_PLOT_ROTATION.azimuth ||
    rotation.elevation !== DEFAULT_PLOT_ROTATION.elevation;

  return (
    <figure data-math-plot="" className={frameClass}>
      {spec.title && (
        <figcaption className="text-text px-4 pt-3 text-sm font-medium">
          {spec.title}
        </figcaption>
      )}
      {html ? (
        <div
          className="mx-auto max-w-[40rem]"
          data-plot-viewport=""
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <PlotError>{EMPTY_MATH_PLOT}</PlotError>
      )}
      {(isSurface || definitions.length > 0) && (
        <div className="border-line bg-subtle border-t px-4 pt-3 pb-2">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-x-6 gap-y-2">
            {definitions.map(([name, definition]) => (
              <PlotSlider
                key={name}
                {...definition}
                label={name}
                step={parameterStep(definition)}
                value={parameters[name] ?? definition.value}
                onChange={(value) =>
                  setParameters((current) => ({ ...current, [name]: value }))
                }
              />
            ))}
            {isSurface && (
              <>
                <PlotSlider
                  label="Horizontal rotation"
                  min={-180}
                  max={180}
                  step={1}
                  value={rotation.azimuth}
                  onChange={(azimuth) =>
                    setRotation((current) => ({ ...current, azimuth }))
                  }
                  degrees
                />
                <PlotSlider
                  label="Vertical rotation"
                  min={5}
                  max={85}
                  step={1}
                  value={rotation.elevation}
                  onChange={(elevation) =>
                    setRotation((current) => ({ ...current, elevation }))
                  }
                  degrees
                />
              </>
            )}
          </div>
          <div className="mt-1 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-reset-plot=""
              disabled={!changed}
              onClick={() => {
                setParameters({});
                setRotation(DEFAULT_PLOT_ROTATION);
              }}
            >
              Reset plot
            </Button>
          </div>
        </div>
      )}
    </figure>
  );
}

export function MathPlot({ source }: { source: string }) {
  const parsed = useMemo(() => parsePlotSpec(source), [source]);
  return parsed.ok ? (
    <InteractiveMathPlot key={source} spec={parsed.spec} />
  ) : (
    <figure data-math-plot="" className={frameClass}>
      <PlotError>{parsed.error}</PlotError>
    </figure>
  );
}

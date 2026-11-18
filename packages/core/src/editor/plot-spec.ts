import {
  compilePlotExpression,
  isPlotExpressionNameReserved,
} from "./plot-expression";

export type PlotRange = [number, number];

export type PlotParameter = {
  min: number;
  max: number;
  value: number;
  step: number;
};

type PlotBase = {
  title?: string;
  parameters: Record<string, PlotParameter>;
};

export type CartesianPlotSpec = PlotBase & {
  type: "cartesian";
  expression: string;
  x: PlotRange;
  y?: PlotRange;
};

export type ParametricPlotSpec = PlotBase & {
  type: "parametric";
  xExpression: string;
  yExpression: string;
  t: PlotRange;
  x?: PlotRange;
  y?: PlotRange;
};

export type SurfacePlotSpec = PlotBase & {
  type: "surface";
  expression: string;
  x: PlotRange;
  y: PlotRange;
  z?: PlotRange;
};

export type PlotSpec = CartesianPlotSpec | ParametricPlotSpec | SurfacePlotSpec;
export type PlotPoint = { x: number; y: number; breakBefore?: true };
export type PlotSurfacePoint = { x: number; y: number; z: number };

type ParsePlotSpecResult =
  { ok: true; spec: PlotSpec } | { ok: false; error: string };
type ParameterValues = Readonly<Record<string, number>>;

const maxSourceLength = 8_192;
const maxParameters = 8;
const maxTitleLength = 120;
const maxPoleProbes = 64;
const commonFields = ["type", "title", "parameters"];
const fieldsByType = {
  cartesian: ["expression", "x", "y"],
  parametric: ["xExpression", "yExpression", "t", "x", "y"],
  surface: ["expression", "x", "y", "z"],
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function validateFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined)
    throw new Error(`${label} has an unknown field "${unexpected}".`);
}

function readRange(value: unknown, name: string): PlotRange {
  if (Array.isArray(value) && value.length === 2) {
    const [min, max] = value as unknown[];
    if (
      isFiniteNumber(min) &&
      isFiniteNumber(max) &&
      max > min &&
      Number.isFinite(max - min)
    ) {
      return [min, max];
    }
  }
  throw new Error(
    `"${name}" must be two finite numbers in increasing order with a finite span.`,
  );
}

function readOptionalRange(
  value: unknown,
  name: string,
): PlotRange | undefined {
  return value === undefined ? undefined : readRange(value, name);
}

function readTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxTitleLength) {
    throw new Error(`"title" must be text up to ${maxTitleLength} characters.`);
  }
  return value.trim() || undefined;
}

function readParameters(value: unknown): Record<string, PlotParameter> {
  if (value === undefined) return {};
  const entries = Object.entries(readObject(value, '"parameters"'));
  if (entries.length > maxParameters)
    throw new Error(`Use at most ${maxParameters} parameters.`);
  return Object.fromEntries(
    entries.map(([name, value]) => {
      if (
        !/^[a-z][a-z\d_]{0,23}$/i.test(name) ||
        isPlotExpressionNameReserved(name) ||
        Object.hasOwn(Object.prototype, name)
      ) {
        throw new Error(`Invalid parameter name "${name}".`);
      }
      const label = `Parameter "${name}"`;
      const parameter = readObject(value, label);
      validateFields(parameter, ["min", "max", "value", "step"], label);
      const [min, max] = readRange(
        [parameter.min, parameter.max],
        `${name}.min and ${name}.max`,
      );
      if (
        !isFiniteNumber(parameter.value) ||
        parameter.value < min ||
        parameter.value > max
      ) {
        throw new Error(
          `${label} needs a value between its minimum and maximum.`,
        );
      }
      const span = max - min;
      const step =
        parameter.step === undefined
          ? Math.max(span / 100, Number.MIN_VALUE)
          : parameter.step;
      if (!isFiniteNumber(step) || step <= 0 || step > span) {
        throw new Error(
          `${label} needs a positive step no greater than its range.`,
        );
      }
      return [name, { min, max, value: parameter.value, step }];
    }),
  );
}

function readExpression(
  value: unknown,
  name: string,
  variableNames: readonly string[],
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`"${name}" must contain an expression.`);
  }
  try {
    compilePlotExpression(value, variableNames);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid expression.";
    throw new Error(`"${name}": ${message}`);
  }
  return value;
}

export function parsePlotSpec(source: string): ParsePlotSpecResult {
  if (source.length > maxSourceLength) {
    return {
      ok: false,
      error: `Use at most ${maxSourceLength} characters for a plot.`,
    };
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    return { ok: false, error: "Enter the plot as valid JSON." };
  }

  try {
    const config = readObject(input, "Plot");
    const type = config.type;
    if (type !== "cartesian" && type !== "parametric" && type !== "surface") {
      throw new Error(
        'Use "cartesian", "parametric" or "surface" as the plot type.',
      );
    }
    validateFields(config, [...commonFields, ...fieldsByType[type]], "Plot");
    const parameters = readParameters(config.parameters);
    const title = readTitle(config.title);
    const common = { parameters, title };
    const names = Object.keys(parameters);
    switch (type) {
      case "cartesian":
        return {
          ok: true,
          spec: {
            ...common,
            type,
            expression: readExpression(config.expression, "expression", [
              "x",
              ...names,
            ]),
            x: readRange(config.x, "x"),
            y: readOptionalRange(config.y, "y"),
          },
        };
      case "parametric":
        return {
          ok: true,
          spec: {
            ...common,
            type,
            xExpression: readExpression(config.xExpression, "xExpression", [
              "t",
              ...names,
            ]),
            yExpression: readExpression(config.yExpression, "yExpression", [
              "t",
              ...names,
            ]),
            t: readRange(config.t, "t"),
            x: readOptionalRange(config.x, "x"),
            y: readOptionalRange(config.y, "y"),
          },
        };
      case "surface":
        return {
          ok: true,
          spec: {
            ...common,
            type,
            expression: readExpression(config.expression, "expression", [
              "x",
              "y",
              ...names,
            ]),
            x: readRange(config.x, "x"),
            y: readRange(config.y, "y"),
            z: readOptionalRange(config.z, "z"),
          },
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid plot.",
    };
  }
}

function parameterValues(
  parameters: PlotBase["parameters"],
  overrides: ParameterValues,
) {
  return Object.entries(parameters).map(([name, { min, max, value }]) => {
    const override = Object.hasOwn(overrides, name)
      ? overrides[name]
      : undefined;
    return isFiniteNumber(override) && override >= min && override <= max
      ? override
      : value;
  });
}

function sampleCount(value: number, fallback: number, max: number): number {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(2, Math.trunc(value)))
    : fallback;
}

function sampleCoordinate(
  [min, max]: PlotRange,
  index: number,
  count: number,
): number {
  return index === count - 1 ? max : min + (max - min) * (index / (count - 1));
}

function divisionPoleCandidate(
  before: readonly number[],
  after: readonly number[],
) {
  for (const [index, right] of after.entries()) {
    const left = before[index];
    if (left === undefined || left < 0 === right < 0) continue;
    const leftMagnitude = Math.abs(left);
    const rightMagnitude = Math.abs(right);
    const scale = Math.max(leftMagnitude, rightMagnitude);
    const fraction =
      leftMagnitude / scale / (leftMagnitude / scale + rightMagnitude / scale);
    return {
      index,
      fraction,
      tolerance: Math.min(leftMagnitude, rightMagnitude) / 4,
    };
  }
}

export function samplePlotCurve(
  spec: CartesianPlotSpec | ParametricPlotSpec,
  overrides: ParameterValues = {},
  count = 401,
): (PlotPoint | null)[] {
  const cartesian = spec.type === "cartesian";
  const variableNames = [
    cartesian ? "x" : "t",
    ...Object.keys(spec.parameters),
  ];
  const values = [0, ...parameterValues(spec.parameters, overrides)];
  const range = cartesian ? spec.x : spec.t;
  const evaluateX = cartesian
    ? null
    : compilePlotExpression(spec.xExpression, variableNames);
  const evaluateY = compilePlotExpression(
    cartesian ? spec.expression : spec.yExpression,
    variableNames,
  );
  const samples = sampleCount(count, 401, 1_025);
  const denominators: [number[], number[]] = [[], []];
  const probe: number[] = [];
  let probesRemaining = maxPoleProbes;
  let previous: PlotPoint | null = null;

  return Array.from({ length: samples }, (_, index) => {
    const coordinate = sampleCoordinate(range, index, samples);
    values[0] = coordinate;
    const x = evaluateX ? evaluateX(values) : coordinate;
    const buffer = index % 2 === 0 ? 0 : 1;
    const currentDenominators = denominators[buffer];
    const y = evaluateY(values, cartesian ? currentDenominators : undefined);
    const point: PlotPoint | null =
      Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    if (cartesian && point && previous && probesRemaining > 0) {
      const previousDenominators = denominators[buffer === 0 ? 1 : 0];
      const candidate = divisionPoleCandidate(
        previousDenominators,
        currentDenominators,
      );
      if (candidate) {
        const crossing = previous.x + (x - previous.x) * candidate.fraction;
        if (crossing > previous.x && crossing < x) {
          probesRemaining -= 1;
          values[0] = crossing;
          evaluateY(values, probe);
          // A jump in the denominator alone does not confirm a nearby zero.
          if (Math.abs(probe[candidate.index] ?? NaN) <= candidate.tolerance)
            point.breakBefore = true;
        }
      }
    }
    previous = point;
    return point;
  });
}

export function samplePlotSurface(
  spec: SurfacePlotSpec,
  overrides: ParameterValues = {},
  count = 33,
): (PlotSurfacePoint | null)[][] {
  const evaluate = compilePlotExpression(spec.expression, [
    "x",
    "y",
    ...Object.keys(spec.parameters),
  ]);
  const values = [0, 0, ...parameterValues(spec.parameters, overrides)];
  const samples = sampleCount(count, 33, 65);

  return Array.from({ length: samples }, (_, row) => {
    const y = sampleCoordinate(spec.y, row, samples);
    values[1] = y;
    return Array.from({ length: samples }, (_, column) => {
      const x = sampleCoordinate(spec.x, column, samples);
      values[0] = x;
      const z = evaluate(values);
      return Number.isFinite(z) ? { x, y, z } : null;
    });
  });
}

export const DEFAULT_MATH_PLOT_SOURCE = `{
  "type": "cartesian",
  "expression": "a*sin(x)",
  "x": [-6.28, 6.28],
  "y": [-3, 3],
  "parameters": {
    "a": {"min": 0, "max": 3, "value": 1, "step": 0.1}
  }
}`;

export const MATH_PLOT_EXAMPLES = [
  { label: "Cartesian", source: DEFAULT_MATH_PLOT_SOURCE },
  {
    label: "Parametric",
    source: `{
  "type": "parametric",
  "xExpression": "cos(t)",
  "yExpression": "sin(t)",
  "t": [0, 6.283185307179586],
  "x": [-1.2, 1.2],
  "y": [-1.2, 1.2]
}`,
  },
  {
    label: "3D surface",
    source: `{
  "type": "surface",
  "expression": "sin(x)*cos(y)",
  "x": [-5, 5],
  "y": [-5, 5],
  "z": [-1, 1]
}`,
  },
] as const;

type Evaluate = (values: readonly number[], denominators?: number[]) => number;
type UnaryFunction = (value: number) => number;
type BinaryFunction = (left: number, right: number) => number;

const maxExpressionLength = 512;
const maxTokens = 256;
const maxDepth = 32;

const constants = new Map([
  ["pi", Math.PI],
  ["e", Math.E],
]);

const unaryFunctions = new Map<string, UnaryFunction>([
  ["abs", Math.abs],
  ["acos", Math.acos],
  ["asin", Math.asin],
  ["atan", Math.atan],
  ["cbrt", Math.cbrt],
  ["ceil", Math.ceil],
  ["cos", Math.cos],
  ["cosh", Math.cosh],
  ["exp", Math.exp],
  ["floor", Math.floor],
  ["ln", Math.log],
  ["log", Math.log],
  ["log10", Math.log10],
  ["round", Math.round],
  ["sign", Math.sign],
  ["sin", Math.sin],
  ["sinh", Math.sinh],
  ["sqrt", Math.sqrt],
  [
    "tan",
    (value) =>
      Math.abs(Math.cos(value)) <= Number.EPSILON ? NaN : Math.tan(value),
  ],
  ["tanh", Math.tanh],
]);

const binaryFunctions = new Map<string, BinaryFunction>([
  ["atan2", Math.atan2],
  ["max", Math.max],
  ["min", Math.min],
]);

const binaryOperators = new Map<string, [number, number, BinaryFunction]>([
  ["+", [1, 2, (left, right) => left + right]],
  ["-", [1, 2, (left, right) => left - right]],
  ["*", [2, 3, (left, right) => left * right]],
  ["/", [2, 3, (left, right) => left / right]],
  ["^", [4, 4, Math.pow]],
]);

export function isPlotExpressionNameReserved(name: string): boolean {
  return (
    name === "x" ||
    name === "y" ||
    name === "t" ||
    constants.has(name) ||
    unaryFunctions.has(name) ||
    binaryFunctions.has(name)
  );
}

function tokenize(source: string): string[] {
  if (source.length > maxExpressionLength) {
    throw new Error(`Use at most ${maxExpressionLength} characters.`);
  }
  const pattern =
    /\s*((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z][a-z\d_]*|[-+*/^(),])/iy;
  const input = source.trim();
  const tokens: string[] = [];
  while (pattern.lastIndex < input.length) {
    const start = pattern.lastIndex;
    const match = pattern.exec(input);
    if (match?.[1] === undefined) {
      throw new Error(`Unexpected character near position ${start + 1}.`);
    }
    tokens.push(match[1]);
    if (tokens.length > maxTokens)
      throw new Error("The expression has too many terms.");
  }
  return tokens;
}

function unary(operation: UnaryFunction, operand: Evaluate): Evaluate {
  return (values, denominators) => {
    const value = operand(values, denominators);
    return Number.isFinite(value) ? operation(value) : NaN;
  };
}

function binary(
  operation: BinaryFunction,
  left: Evaluate,
  right: Evaluate,
  divisionIndex?: number,
): Evaluate {
  return (values, denominators) => {
    const lhs = left(values, denominators);
    const rhs = right(values, denominators);
    if (denominators && divisionIndex !== undefined)
      denominators[divisionIndex] = rhs;
    return Number.isFinite(lhs) && Number.isFinite(rhs)
      ? operation(lhs, rhs)
      : NaN;
  };
}

export function compilePlotExpression(
  source: string,
  variableNames: readonly string[],
): Evaluate {
  const tokens = tokenize(source);
  let index = 0;
  let divisionCount = 0;

  function consume(expected: string) {
    if (tokens[index] !== expected) throw new Error(`Expected "${expected}".`);
    index += 1;
  }

  function parseValue(depth: number): Evaluate {
    const token = tokens[index++];
    if (token === undefined)
      throw new Error("Expected a number, variable or function.");
    if (token === "(") {
      const expression = parse(0, depth + 1);
      consume(")");
      return expression;
    }
    if (token === "+" || token === "-") {
      const operand = parse(3, depth + 1);
      return token === "+" ? operand : unary((value) => -value, operand);
    }
    if (/^[.\d]/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error("Numbers must be finite.");
      return () => value;
    }
    const constant = constants.get(token);
    if (constant !== undefined) return () => constant;
    const variableIndex = variableNames.indexOf(token);
    if (variableIndex >= 0) return (values) => values[variableIndex] ?? NaN;

    const unaryFunction = unaryFunctions.get(token);
    const binaryFunction = binaryFunctions.get(token);
    if (unaryFunction === undefined && binaryFunction === undefined) {
      throw new Error(`Unknown value "${token}".`);
    }
    consume("(");
    const first = parse(0, depth + 1);
    if (binaryFunction !== undefined) {
      consume(",");
      const second = parse(0, depth + 1);
      consume(")");
      return binary(binaryFunction, first, second);
    }
    consume(")");
    if (unaryFunction === undefined)
      throw new Error(`Unknown function "${token}".`);
    return unary(unaryFunction, first);
  }

  function parse(minPrecedence: number, depth: number): Evaluate {
    if (depth > maxDepth)
      throw new Error("The expression is nested too deeply.");
    let left = parseValue(depth);
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const operator = binaryOperators.get(token);
      if (operator === undefined || operator[0] < minPrecedence) break;
      index += 1;
      const [, rightPrecedence, operation] = operator;
      const right = parse(rightPrecedence, depth + 1);
      left = binary(
        operation,
        left,
        right,
        token === "/" ? divisionCount++ : undefined,
      );
    }
    return left;
  }

  const evaluate = parse(0, 0);
  if (index < tokens.length) throw new Error(`Unexpected "${tokens[index]}".`);
  return evaluate;
}

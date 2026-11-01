/**
 * Minimal JSONPath subset (RFC 9535 inspired), hand-rolled so no eval-based
 * dependency is needed. Grammar:
 *   $                       root
 *   .key | ['key']          child
 *   .* | [*]                wildcard (array items or object values)
 *   [n] | [-n]              array index
 *   [start:end]             array slice — yields the sub-array as ONE match
 *                           (does not spread elements; non-RFC spread)
 *   ..key                   descendant key search (any depth)
 *   .length                 array length (on array values only)
 *   [?(cond [&& cond...])]  array filter; cond = @.key.chain (or @['key'])
 *                           with optional ==/!=/</<=/>/>= literal, bare
 *                           existence, or `contains` (case-insensitive
 *                           substring; string values and string literals
 *                           only, whitespace-separated). Literals: 'str',
 *                           "str", number, true, false, null. Numeric ops
 *                           need numbers.
 * Missing keys never throw — they yield no match.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export class JsonPathError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (position ${position})`);
    this.name = "JsonPathError";
  }
}

/** Thrown when evaluation (not parsing) exceeds a resource guard below;
 *  distinguishable from JsonPathError so callers can map it separately. */
export class JsonPathLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonPathLimitError";
  }
}

/**
 * Deliberate deviation from the ported source: it has no bound on
 * intermediate match growth, so a pathological path (chained descendant
 * searches, or a wildcard over a huge array) can build an unbounded array,
 * or recurse without limit, before json.ts's page/byte-budget clip ever
 * runs. MAX_JSON_PATH_MATCHES is set above the largest legitimate single
 * expansion this package's own tests exercise (150,000 elements), so it
 * only trips on pathological growth, not on an ordinarily large array.
 */
const MAX_JSON_PATH_MATCHES = 200_000;
const MAX_JSON_DEPTH = 512;

type Literal = string | number | boolean | null;

interface Condition {
  path: string[];
  op: "exists" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "contains";
  value?: Literal;
}

type Segment =
  | { type: "child"; key: string }
  | { type: "wildcard" }
  | { type: "index"; index: number }
  | { type: "slice"; start: number | null; end: number | null }
  | { type: "descendant"; key: string }
  | { type: "filter"; conditions: Condition[] };

/** Evaluate path against root and return every match (possibly empty). */
export function queryJsonPath(root: JsonValue, path: string): JsonValue[] {
  const segments = parseJsonPath(path);
  let current: JsonValue[] = [root];
  for (const segment of segments) {
    const next: JsonValue[] = [];
    for (const value of current) applySegment(value, segment, next);
    current = next;
  }
  return current;
}

function parseJsonPath(path: string): Segment[] {
  if (!path.startsWith("$")) {
    throw new JsonPathError("Path must start with $", 0);
  }
  const segments: Segment[] = [];
  let pos = 1;
  while (pos < path.length) {
    if (path.startsWith("..", pos)) {
      const { key, pos: next } = readBareKey(path, pos + 2);
      if (key === "*") {
        throw new JsonPathError(
          "Descendant wildcard '..*' is not supported",
          pos,
        );
      }
      segments.push({ type: "descendant", key });
      pos = next;
    } else if (path[pos] === ".") {
      if (path[pos + 1] === "*") {
        segments.push({ type: "wildcard" });
        pos += 2;
      } else {
        const { key, pos: next } = readBareKey(path, pos + 1);
        segments.push({ type: "child", key });
        pos = next;
      }
    } else if (path[pos] === "[") {
      const close = findBracketClose(path, pos);
      segments.push(parseBracket(path.slice(pos + 1, close).trim(), pos));
      pos = close + 1;
    } else {
      throw new JsonPathError(`Unexpected character '${path[pos]}'`, pos);
    }
  }
  return segments;
}

function readBareKey(path: string, pos: number): { key: string; pos: number } {
  const start = pos;
  while (pos < path.length && path[pos] !== "." && path[pos] !== "[") pos++;
  if (pos === start) throw new JsonPathError("Expected a key", start);
  return { key: path.slice(start, pos), pos };
}

function findBracketClose(path: string, open: number): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = open + 1; i < path.length; i++) {
    const c = path[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "[") {
      depth++;
    } else if (c === "]") {
      if (depth === 0) return i;
      depth--;
    }
  }
  throw new JsonPathError("Unclosed '['", open);
}

function parseBracket(inner: string, pos: number): Segment {
  if (inner === "*") return { type: "wildcard" };
  if (inner.startsWith("?(") && inner.endsWith(")")) {
    return { type: "filter", conditions: parseFilter(inner.slice(2, -1), pos) };
  }
  if (/^'([^'\\]|\\.)*'$/.test(inner) || /^"([^"\\]|\\.)*"$/.test(inner)) {
    return { type: "child", key: unquote(inner) };
  }
  if (/^-?\d+$/.test(inner)) {
    return { type: "index", index: Number.parseInt(inner, 10) };
  }
  if (/^-?\d*:-?\d*$/.test(inner)) {
    const [a, b] = inner.split(":");
    if (a === "" && b === "") throw new JsonPathError("Empty slice [:]", pos);
    return {
      type: "slice",
      start: a === "" ? null : Number.parseInt(a!, 10),
      end: b === "" ? null : Number.parseInt(b!, 10),
    };
  }
  throw new JsonPathError(`Unsupported bracket expression '[${inner}]'`, pos);
}

function unquote(quoted: string): string {
  const body = quoted.slice(1, -1);
  return body.replace(/\\(.)/g, "$1");
}

function parseFilter(src: string, pos: number): Condition[] {
  return splitTopLevel(src).map((part) => parseCondition(part.trim(), pos));
}

/** Split on && that appears outside quoted literals. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "&" && src[i + 1] === "&") {
      parts.push(src.slice(start, i));
      i++;
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

const CONDITION_RE =
  /^@((?:\.[A-Za-z0-9_$-]+|\[['"][^'"]+['"]\])*)(?:\s*(==|!=|<=|>=|<|>)\s*(.+)|\s+(contains)\s+(.+))?$/;

function parseCondition(src: string, pos: number): Condition {
  const m = CONDITION_RE.exec(src);
  if (!m) {
    throw new JsonPathError(`Unsupported filter condition '${src}'`, pos);
  }
  const path = parseRelativePath(m[1]!, pos);
  const op = m[2] ?? m[4];
  const rawValue = m[3] ?? m[5];
  if (op === undefined) return { path, op: "exists" };
  return {
    path,
    op: op as Condition["op"],
    value: parseLiteral(rawValue!.trim(), pos),
  };
}

function parseRelativePath(src: string, pos: number): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === ".") {
      const start = ++i;
      while (i < src.length && /[A-Za-z0-9_$-]/.test(src[i]!)) i++;
      if (i === start) throw new JsonPathError("Expected a key after '.'", pos);
      keys.push(src.slice(start, i));
    } else if (src[i] === "[") {
      const close = src.indexOf("]", i);
      if (close === -1) throw new JsonPathError("Unclosed '[' in filter", pos);
      keys.push(unquote(src.slice(i + 1, close).trim()));
      i = close + 1;
    } else {
      throw new JsonPathError(`Unexpected '${src[i]}' in filter path`, pos);
    }
  }
  return keys;
}

function parseLiteral(src: string, pos: number): Literal {
  if (/^'([^'\\]|\\.)*'$/.test(src) || /^"([^"\\]|\\.)*"$/.test(src)) {
    return unquote(src);
  }
  if (src === "true") return true;
  if (src === "false") return false;
  if (src === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(src)) return Number(src);
  throw new JsonPathError(`Unsupported literal '${src}'`, pos);
}

function isRecord(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every match push goes through here so growth is capped as it happens,
 *  not only after a segment has already built an unbounded array. */
function pushMatch(out: JsonValue[], value: JsonValue): void {
  if (out.length >= MAX_JSON_PATH_MATCHES) {
    throw new JsonPathLimitError(
      `query matches more than ${MAX_JSON_PATH_MATCHES} values; narrow the path`,
    );
  }
  out.push(value);
}

function applySegment(
  value: JsonValue,
  segment: Segment,
  out: JsonValue[],
): void {
  switch (segment.type) {
    case "child":
      if (Array.isArray(value)) {
        if (segment.key === "length") pushMatch(out, value.length);
        return;
      }
      if (isRecord(value) && Object.hasOwn(value, segment.key)) {
        pushMatch(out, value[segment.key]!);
      }
      return;
    case "wildcard":
      if (Array.isArray(value)) {
        for (const v of value) pushMatch(out, v);
      } else if (isRecord(value)) {
        for (const v of Object.values(value)) pushMatch(out, v);
      }
      return;
    case "index":
      if (Array.isArray(value)) {
        const i =
          segment.index < 0 ? value.length + segment.index : segment.index;
        if (i >= 0 && i < value.length) pushMatch(out, value[i]!);
      }
      return;
    case "slice":
      if (Array.isArray(value)) {
        pushMatch(
          out,
          value.slice(segment.start ?? 0, segment.end ?? undefined),
        );
      }
      return;
    case "descendant":
      collectDescendant(value, segment.key, out, 0);
      return;
    case "filter":
      if (Array.isArray(value)) {
        for (const item of value) {
          if (segment.conditions.every((c) => matchesCondition(item, c))) {
            pushMatch(out, item);
          }
        }
      }
      return;
  }
}

function collectDescendant(
  value: JsonValue,
  key: string,
  out: JsonValue[],
  depth: number,
): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new JsonPathLimitError(
      `descendant search exceeds ${MAX_JSON_DEPTH} levels of nesting`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDescendant(item, key, out, depth + 1);
    return;
  }
  if (isRecord(value)) {
    if (Object.hasOwn(value, key)) pushMatch(out, value[key]!);
    for (const v of Object.values(value)) {
      collectDescendant(v, key, out, depth + 1);
    }
  }
}

function matchesCondition(item: JsonValue, condition: Condition): boolean {
  let cursor: unknown = item;
  for (const key of condition.path) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, key)) return false;
    cursor = cursor[key];
  }
  if (condition.op === "exists") return true;
  return compareLiteral(cursor as JsonValue, condition.op, condition.value!);
}

function compareLiteral(
  actual: JsonValue,
  op: Exclude<Condition["op"], "exists">,
  expected: Literal,
): boolean {
  if (op === "==") return actual === expected;
  if (op === "!=") return actual !== expected;
  if (op === "contains") {
    return (
      typeof actual === "string" &&
      typeof expected === "string" &&
      actual.toLowerCase().includes(expected.toLowerCase())
    );
  }
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  if (op === "<") return actual < expected;
  if (op === "<=") return actual <= expected;
  if (op === ">") return actual > expected;
  return actual >= expected;
}

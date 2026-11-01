import { createHash } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { RE2JS } from "re2js";
import { ExternalMcpError } from "./errors";
import type { JsonObject, JsonValue, RemoteToolDefinition } from "./types";

export function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => isJson(item, depth + 1));
  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((item) => isJson(item, depth + 1))
  );
}
export function isObject(value: unknown): value is JsonObject {
  return (
    isJson(value) &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object"
  );
}
export function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const MAX_EXPANDED_SCHEMA_NODES = 20_000;
const MAX_REF_CHAIN = 64;
// Holds every reviewed tool a user can enable, so listing them never recompiles.
const MAX_CACHED_VALIDATORS = 2_048;
const SCALAR_TYPES = ["string", "number", "integer", "boolean"];
const SCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
];
const SCHEMA_KEYWORDS = [
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
  "unevaluatedProperties",
  "unevaluatedItems",
];
const SAME_INSTANCE_KEYWORDS = [
  "dependentSchemas",
  "dependencies",
  "not",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
];

function resolveLocalRef(root: JsonObject, ref: string): JsonValue | undefined {
  if (ref === "#") return root;
  let segments: string[];
  try {
    segments = decodeURIComponent(ref)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  } catch {
    return undefined;
  }
  if (segments.shift() !== "#") return undefined;
  let node: JsonValue = root;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      node = node[Number(segment)] as JsonValue;
    } else if (node && typeof node === "object" && Object.hasOwn(node, segment))
      node = node[segment] as JsonValue;
    else return undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

type RefFrame = {
  ref: string;
  descent: number;
  backRefs: number;
  // cycle target → whether some path from this frame reaches it without descending
  reaches: Map<string, boolean>;
};

function exceedsValidationBudget(root: JsonObject): boolean {
  let rejected = false;
  const done = new Map<
    string,
    { cost: number; reaches: Map<string, boolean> }
  >();
  const stack: RefFrame[] = [];
  const add = (a: number, b: number) =>
    Math.min(a + b, MAX_EXPANDED_SCHEMA_NODES + 1);
  // Depth-32 data makes one recursive ref cheap, but two refs back into the same cycle can double per level, so those are rejected.
  function closeCycle(target: string, flat: boolean, descent: number) {
    const start = stack.findIndex((frame) => frame.ref === target);
    if (start < 0) return;
    stack.slice(start).forEach((frame, offset) => {
      const flatFromFrame = flat && frame.descent === descent;
      if (++frame.backRefs > 1 || (offset === 0 && flatFromFrame))
        rejected = true;
      if (offset > 0)
        frame.reaches.set(
          target,
          flatFromFrame || frame.reaches.get(target) === true,
        );
    });
  }
  function refCost(ref: string, descent: number): number {
    if (stack.some((frame) => frame.ref === ref)) {
      closeCycle(ref, true, descent);
      return 1;
    }
    const known = done.get(ref);
    if (known) {
      for (const [target, flat] of known.reaches)
        closeCycle(target, flat, descent);
      return known.cost;
    }
    const target = resolveLocalRef(root, ref);
    if (target === undefined || stack.length >= MAX_REF_CHAIN) {
      rejected = true;
      return 1;
    }
    const frame: RefFrame = {
      ref,
      descent,
      backRefs: 0,
      reaches: new Map(),
    };
    stack.push(frame);
    const cost = nodeCost(target, descent);
    stack.pop();
    done.set(ref, { cost, reaches: frame.reaches });
    return cost;
  }
  function nodeCost(value: JsonValue, descent: number): number {
    if (rejected || !value || typeof value !== "object") return 1;
    if (Array.isArray(value))
      return value.reduce<number>(
        (sum, item) => add(sum, nodeCost(item, descent)),
        0,
      );
    let cost = 1;
    for (const [key, child] of Object.entries(value)) {
      const next = SAME_INSTANCE_KEYWORDS.includes(key) ? descent : descent + 1;
      if (key === "$ref" && typeof child === "string")
        cost = add(cost, refCost(child, descent));
      else if (SCHEMA_KEYWORDS.includes(key))
        cost = add(cost, nodeCost(child, next));
      else if (
        SCHEMA_MAPS.includes(key) &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      )
        for (const entry of Object.values(child))
          if (entry && typeof entry === "object" && !Array.isArray(entry))
            cost = add(cost, nodeCost(entry, next));
    }
    return cost;
  }
  stack.push({ ref: "#", descent: 0, backRefs: 0, reaches: new Map() });
  const total = nodeCost(root, 0);
  return rejected || total > MAX_EXPANDED_SCHEMA_NODES;
}

// Remote schemas choose their own regexes; RE2 matches in linear time, so none can backtrack catastrophically.
const re2 = Object.assign(
  (pattern: string) => {
    const compiled = RE2JS.compile(pattern);
    // Ajv deduplicates compiled patterns by toString().
    return {
      test: (value: string) => compiled.test(value),
      toString: () => `re2:${pattern}`,
    };
  },
  { code: "re2js" },
);

const validators = new Map<string, ValidateFunction | null>();
function compile(schema: JsonObject): ValidateFunction | null {
  const digest = createHash("sha256")
    .update(JSON.stringify(schema))
    .digest("hex");
  const cached = validators.get(digest);
  if (cached !== undefined) {
    validators.delete(digest);
    validators.set(digest, cached);
    return cached;
  }
  const validate = compileUncached(schema);
  if (validators.size >= MAX_CACHED_VALIDATORS)
    validators.delete(validators.keys().next().value!);
  validators.set(digest, validate);
  return validate;
}
function compileUncached(schema: JsonObject): ValidateFunction | null {
  const ajv = new Ajv({
    strict: true,
    allowUnionTypes: true,
    allErrors: false,
    validateFormats: true,
    addUsedSchema: false,
    code: { regExp: re2 },
  });
  addFormats(ajv, ["date", "time", "date-time", "uuid", "email", "uri"]);
  let unsupported = false;
  const inspected = new Set<object>();
  function inspect(value: JsonValue) {
    if (unsupported || !value || typeof value !== "object") return;
    if (inspected.has(value)) return;
    inspected.add(value);
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    // Ajv only hashes scalar items; anything else is an O(n²) deep comparison.
    if (value.uniqueItems === true) {
      const items = value.items;
      if (
        !items ||
        typeof items !== "object" ||
        Array.isArray(items) ||
        typeof items.type !== "string" ||
        !SCALAR_TYPES.includes(items.type)
      )
        unsupported = true;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "$ref" &&
          (typeof child !== "string" || !child.startsWith("#"))) ||
        ["$id", "$async", "$dynamicRef", "$recursiveRef"].includes(key)
      )
        unsupported = true;
      // Pointers may target data positions (default, examples, …) that Ajv still compiles as schemas.
      else if (key === "$ref" && typeof child === "string") {
        const target = resolveLocalRef(schema, child);
        if (target === undefined) unsupported = true;
        else inspect(target);
      }
      if (
        [...SCHEMA_MAPS, "$defs", "definitions"].includes(key) &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      )
        Object.values(child).forEach(inspect);
      else if (SCHEMA_KEYWORDS.includes(key)) inspect(child);
    }
  }
  inspect(schema);
  if (!unsupported && exceedsValidationBudget(schema)) unsupported = true;
  try {
    const structuralSchema = { ...schema };
    delete structuralSchema.$schema;
    if (!ajv.validateSchema(structuralSchema))
      throw new ExternalMcpError("INVALID_CATALOG");
  } catch (error) {
    if (error instanceof ExternalMcpError) throw error;
    unsupported = true;
  }
  if (unsupported) return null;
  try {
    return ajv.compile(schema);
  } catch {
    return null;
  }
}

export function parseToolDefinitions(
  values: unknown[],
): RemoteToolDefinition[] {
  if (values.length > 500) throw new ExternalMcpError("INVALID_CATALOG");
  const names = new Set<string>();
  return values.map((value) => {
    if (
      !isObject(value) ||
      jsonBytes(value) > 65536 ||
      typeof value.name !== "string" ||
      !value.name ||
      names.has(value.name) ||
      !isObject(value.inputSchema) ||
      value.inputSchema.type !== "object" ||
      (value.outputSchema !== undefined &&
        (!isObject(value.outputSchema) ||
          value.outputSchema.type !== "object")) ||
      (value.description !== undefined &&
        typeof value.description !== "string") ||
      (value.annotations !== undefined && !isObject(value.annotations))
    )
      throw new ExternalMcpError("INVALID_CATALOG");
    names.add(value.name);
    const input = compile(value.inputSchema);
    const output = value.outputSchema ? compile(value.outputSchema) : true;
    return {
      name: value.name,
      ...(value.description !== undefined
        ? {
            description: value.description
              .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
              .slice(0, 2000),
          }
        : {}),
      inputSchema: value.inputSchema,
      ...(value.outputSchema ? { outputSchema: value.outputSchema } : {}),
      ...(value.annotations ? { annotations: value.annotations } : {}),
      supportStatus:
        input && output
          ? { available: true }
          : { available: false, reason: "UNSUPPORTED_SCHEMA" },
    };
  });
}
export function validateArguments(
  tool: RemoteToolDefinition,
  args: unknown,
): asserts args is JsonObject {
  if (!tool.supportStatus.available)
    throw new ExternalMcpError("UNSUPPORTED_SCHEMA");
  if (!isObject(args) || jsonBytes(args) > 16384)
    throw new ExternalMcpError("INVALID_ARGUMENTS");
  const validate = compile(tool.inputSchema);
  if (!validate) throw new ExternalMcpError("UNSUPPORTED_SCHEMA");
  if (!validate(args)) throw new ExternalMcpError("INVALID_ARGUMENTS");
}
export function validateOutput(tool: RemoteToolDefinition, output: unknown) {
  if (!tool.outputSchema) return;
  const validate = compile(tool.outputSchema);
  if (!validate?.(output)) throw new ExternalMcpError("INVALID_RESULT");
}

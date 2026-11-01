import { ArtifactReadError } from "./errors";
import type { JsonValue } from "./jsonPath";
import { normalizeLimit, normalizeOffset, utf8Prefix } from "./limits";

export type StructuredReadInput = {
  pointer?: string;
  depth?: number;
  limit?: number;
  offset?: number;
  includeSamples?: boolean;
};
export type StructuredNode = {
  pointer: string;
  queryPath: string;
  type: "array" | "object" | "string" | "number" | "boolean" | "null";
  childCount: number | null;
  sampled: boolean;
  sampledCount: number;
  samples?: Array<string | number | boolean | null>;
  samplesTruncated?: boolean;
};
export type StructuredOverview = {
  pointer: string;
  total: number;
  offset: number;
  nodes: StructuredNode[];
  nextOffset: number | null;
};
type PathPart = string | number;
const ARRAY_SAMPLE_COUNT = 20;
const ADDRESS_MAX_BYTES = 8 * 1024;

function invalidPointer(): never {
  throw new ArtifactReadError(
    "invalid_path",
    "pointer must identify an existing own key or canonical array index using JSON Pointer escaping",
  );
}

function select(
  value: JsonValue,
  pointer: string,
): { value: JsonValue; path: PathPart[] } {
  if (pointer === "") return { value, path: [] };
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) invalidPointer();
  const path: PathPart[] = [];
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) invalidPointer();
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index >= value.length ||
        !Object.hasOwn(value, index)
      )
        invalidPointer();
      path.push(index);
      value = value[index]!;
    } else if (
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, key)
    ) {
      path.push(key);
      value = value[key]!;
    } else invalidPointer();
  }
  return { value, path };
}

function addresses(path: PathPart[]): { pointer: string; queryPath: string } {
  let pointer = "";
  let queryPath = "$";
  for (const part of path) {
    pointer += "/" + String(part).replace(/~/g, "~0").replace(/\//g, "~1");
    // JSONPath unquotes literal escapes, rather than decoding JSON escapes.
    queryPath +=
      typeof part === "number"
        ? `[${part}]`
        : `['${part.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
  }
  if (
    new TextEncoder().encode(JSON.stringify({ pointer, queryPath })).length >
    ADDRESS_MAX_BYTES
  ) {
    throw new ArtifactReadError(
      "resource_limit",
      "structure node addresses exceed 8192 UTF-8 bytes; inspect a different pointer or page, or use raw-source reads",
    );
  }
  return { pointer, queryPath };
}

function addSamples(
  node: StructuredNode,
  value: JsonValue,
  keys: string[] | null,
): void {
  const samples: NonNullable<StructuredNode["samples"]> = [];
  let truncated = false;
  function add(candidate: JsonValue): boolean {
    if (candidate !== null && typeof candidate === "object") return true;
    if (samples.length === 3) {
      truncated = true;
      return false;
    }
    if (typeof candidate === "string") {
      const sample = utf8Prefix(candidate, 80);
      truncated ||= sample.length < candidate.length;
      samples.push(sample);
    } else samples.push(candidate);
    return true;
  }
  if (Array.isArray(value)) {
    for (
      let index = 0;
      index < Math.min(value.length, ARRAY_SAMPLE_COUNT);
      index++
    ) {
      if (!add(value[index]!)) break;
    }
  } else if (keys && value !== null && typeof value === "object") {
    for (const key of keys) if (!add(value[key]!)) break;
  } else add(value);
  node.samples = samples;
  node.samplesTruncated = truncated;
}

export function inspectStructuredValue(
  value: JsonValue,
  input: StructuredReadInput,
): StructuredOverview {
  const depth = input.depth ?? 2;
  if (!Number.isInteger(depth) || depth < 0 || depth > 5) {
    throw new ArtifactReadError(
      "invalid_input",
      "depth must be between 0 and 5",
    );
  }
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: 50,
    hardMax: 200,
    label: "limit",
  });
  const offset = normalizeOffset({ value: input.offset, label: "offset" });
  const pointer = input.pointer ?? "";
  const selected = select(value, pointer);
  // The selected pointer is emitted even when the node page is empty.
  addresses(selected.path);
  const nodes: StructuredNode[] = [];
  let total = 0;

  function visit(current: JsonValue, level: number): void {
    const array = Array.isArray(current);
    const object = current !== null && typeof current === "object" && !array;
    const keys = object ? Object.keys(current).sort() : null;
    if (total >= offset && nodes.length < limit) {
      const node: StructuredNode = {
        ...addresses(selected.path),
        type:
          current === null
            ? "null"
            : array
              ? "array"
              : object
                ? "object"
                : (typeof current as StructuredNode["type"]),
        childCount: array ? current.length : keys ? keys.length : null,
        sampled: array && current.length > ARRAY_SAMPLE_COUNT,
        sampledCount: array ? Math.min(current.length, ARRAY_SAMPLE_COUNT) : 0,
      };
      if (input.includeSamples) addSamples(node, current, keys);
      nodes.push(node);
    }
    total++;
    if (level >= depth) return;
    if (array) {
      for (
        let index = 0;
        index < Math.min(current.length, ARRAY_SAMPLE_COUNT);
        index++
      ) {
        selected.path.push(index);
        visit(current[index]!, level + 1);
        selected.path.pop();
      }
    } else if (keys && current !== null && typeof current === "object") {
      for (const key of keys) {
        selected.path.push(key);
        visit(current[key]!, level + 1);
        selected.path.pop();
      }
    }
  }
  visit(selected.value, 0);
  return {
    pointer,
    total,
    offset,
    nodes,
    nextOffset: offset + nodes.length < total ? offset + nodes.length : null,
  };
}

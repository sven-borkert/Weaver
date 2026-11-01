import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Alias,
  type Node,
  type YAMLMap,
} from "yaml";
import { ArtifactReadError } from "./errors";
import {
  overviewJsonValue,
  queryJsonValue,
  type JsonOverview,
  type JsonQueryResult,
  type JsonValue,
} from "./json";
import { decodeUtf8 } from "./text";
import {
  inspectStructuredValue,
  type StructuredReadInput,
  type StructuredOverview,
} from "./structured";

const MAX_ALIASES = 100;
const MAX_DEPTH = 512;
const MAX_NODES = 200_000;
const CORE_TAGS = new Set(
  ["map", "seq", "str", "null", "bool", "int", "float"].map(
    (name) => `tag:yaml.org,2002:${name}`,
  ),
);
type YamlNode = Node | null;
type Metrics = { count: number; depth: number };

function malformed(): never {
  throw new ArtifactReadError(
    "malformed",
    "artifact is not supported valid YAML",
  );
}
function resourceLimit(): never {
  throw new ArtifactReadError(
    "resource_limit",
    "YAML exceeds alias, depth or normalized node limits",
  );
}
function checkedNode(value: unknown): YamlNode {
  if (value === null || isNode(value)) return value;
  return malformed();
}
function scalarValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  return malformed();
}
function stringKey(value: unknown): string {
  if (!isScalar(value) || typeof value.value !== "string") malformed();
  return value.value;
}
function children(node: YamlNode): YamlNode[] {
  if (isMap(node)) return node.items.map((pair) => checkedNode(pair.value));
  if (isSeq(node)) return node.items.map(checkedNode);
  return [];
}

function validateAst(root: YamlNode): { aliases: Alias[]; maps: YAMLMap[] } {
  const pending = [root];
  const aliases: Alias[] = [];
  const maps: YAMLMap[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node === null) continue;
    if (node.tag && !CORE_TAGS.has(node.tag)) malformed();
    if (isAlias(node)) {
      aliases.push(node);
      if (aliases.length > MAX_ALIASES) resourceLimit();
    } else if (isScalar(node)) {
      scalarValue(node.value);
    } else if (isMap(node)) {
      maps.push(node);
      for (const pair of node.items) {
        if (!isAlias(pair.key)) stringKey(pair.key);
        pending.push(checkedNode(pair.key), checkedNode(pair.value));
      }
    } else if (isSeq(node)) {
      for (const child of node.items) pending.push(checkedNode(child));
    } else malformed();
  }
  return { aliases, maps };
}

function resolveMappingKeys(
  maps: YAMLMap[],
  targets: Map<Alias, Node>,
): Map<YAMLMap, string[]> {
  const resolved = new Map<YAMLMap, string[]>();
  for (const map of maps) {
    const unique = new Set<string>();
    const names: string[] = [];
    for (const pair of map.items) {
      const key = stringKey(
        isAlias(pair.key) ? targets.get(pair.key) : pair.key,
      );
      if (unique.has(key)) malformed();
      unique.add(key);
      names.push(key);
    }
    resolved.set(map, names);
  }
  return resolved;
}

function checkExpansion(root: YamlNode, targets: Map<Alias, Node>): void {
  const metrics = new Map<YamlNode, Metrics>();
  const active = new Set<YamlNode>();
  const pending = [{ node: root, exit: false }];
  while (pending.length) {
    const { node, exit } = pending.pop()!;
    if (metrics.has(node)) continue;
    const descendants = isAlias(node) ? [targets.get(node)!] : children(node);
    if (!exit) {
      if (active.has(node)) malformed();
      active.add(node);
      pending.push({ node, exit: true });
      for (const child of descendants)
        pending.push({ node: child, exit: false });
      continue;
    }
    let count = isAlias(node) ? 0 : 1;
    let depth = 0;
    for (const child of descendants) {
      const result = metrics.get(child)!;
      // Every occurrence contributes its full subtree, including memoized aliases.
      count += result.count;
      depth = Math.max(depth, result.depth + (isAlias(node) ? 0 : 1));
      if (count > MAX_NODES || depth > MAX_DEPTH) resourceLimit();
    }
    metrics.set(node, { count, depth });
    active.delete(node);
  }
}

function normalize(
  root: YamlNode,
  targets: Map<Alias, Node>,
  keys: Map<YAMLMap, string[]>,
): JsonValue {
  const output: JsonValue[] = [];
  const pending: Array<{
    node: YamlNode;
    parent: JsonValue[] | Record<string, JsonValue>;
    key: string | number;
  }> = [{ node: root, parent: output, key: 0 }];
  while (pending.length) {
    const { node: original, parent, key } = pending.pop()!;
    const node = isAlias(original) ? targets.get(original)! : original;
    let value: JsonValue;
    if (node === null) value = null;
    else if (isScalar(node)) value = scalarValue(node.value);
    else if (isSeq(node)) {
      const array: JsonValue[] = [];
      value = array;
      for (let index = node.items.length - 1; index >= 0; index--)
        pending.push({
          node: checkedNode(node.items[index]),
          parent: array,
          key: index,
        });
    } else if (isMap(node)) {
      const record: Record<string, JsonValue> = {};
      value = record;
      for (let index = node.items.length - 1; index >= 0; index--) {
        const pair = node.items[index]!;
        pending.push({
          node: checkedNode(pair.value),
          parent: record,
          key: keys.get(node)![index]!,
        });
      }
    } else return malformed();
    Object.defineProperty(parent, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output[0]!;
}

export function parseYamlValue(data: Uint8Array): JsonValue {
  try {
    const doc = parseDocument(decodeUtf8(data), {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      strict: true,
      prettyErrors: false,
    });
    if (
      doc.errors.length ||
      doc.warnings.length ||
      doc.directives.yaml.version !== "1.2"
    )
      malformed();
    const { aliases, maps } = validateAst(doc.contents);
    const targets = new Map<Alias, Node>();
    for (const alias of aliases) {
      const target = alias.resolve(doc);
      if (!target) malformed();
      targets.set(alias, target);
    }
    const keys = resolveMappingKeys(maps, targets);
    checkExpansion(doc.contents, targets);
    return normalize(doc.contents, targets, keys);
  } catch (error) {
    if (error instanceof ArtifactReadError) throw error;
    if (error instanceof RangeError) resourceLimit();
    return malformed();
  }
}

export function readYamlOverview(data: Uint8Array): JsonOverview {
  return overviewJsonValue(parseYamlValue(data), data.length);
}
export function inspectYaml(
  data: Uint8Array,
  input: StructuredReadInput,
): StructuredOverview {
  return inspectStructuredValue(parseYamlValue(data), input);
}
export function queryYaml(
  data: Uint8Array,
  input: { path: string; fields?: string[]; offset?: number; limit?: number },
): JsonQueryResult {
  return queryJsonValue(parseYamlValue(data), input);
}

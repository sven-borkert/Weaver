/**
 * Pure reader for .json artifacts: parse and produce a bounded, normalized
 * overview plus a JSONPath escape-hatch query. No DB, no fs.
 */
import { ArtifactReadError, rethrowAsReadError } from "./errors";
import { capEntries } from "./limits";
import {
  inspectStructuredValue,
  type StructuredReadInput,
  type StructuredOverview,
} from "./structured";
import {
  JsonPathError,
  JsonPathLimitError,
  queryJsonPath,
  type JsonValue,
} from "./jsonPath";

export type { JsonValue };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_FIELDS = 20;

/** Byte budget for one query response — a single match can be a whole
 *  subtree, so count-based paging alone can't cap the payload. */
const QUERY_MAX_RESULT_BYTES = 128 * 1024;

export type JsonTopLevelEntry = {
  key: string;
  type: "array" | "object" | "string" | "number" | "boolean" | "null";
  count: number | null;
};

export type JsonOverview = {
  sizeBytes: number;
  topLevel: JsonTopLevelEntry[];
  /** `topLevel` was cut at OVERVIEW_ENTRY_CAP keys. */
  truncated: boolean;
  rootType: "array" | "object" | "string" | "number" | "boolean" | "null";
  rootCount: number | null;
};

export type JsonQueryResult = {
  path: string;
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  items: JsonValue[];
};

/** Extract only a numeric offset from a native parse error, never its text —
 *  V8's JSON.parse message quotes a snippet of the input around the failure
 *  (e.g. a leaked secret), so the message itself must never reach callers. */
function nativeErrorPosition(cause: unknown): string {
  const nativeMessage = cause instanceof Error ? cause.message : "";
  const match = /position (\d+)/.exec(nativeMessage);
  return match ? ` (position ${match[1]})` : "";
}

export function parseJsonValue(data: Uint8Array): JsonValue {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (cause) {
    throw new ArtifactReadError(
      "malformed",
      `artifact is not valid UTF-8${nativeErrorPosition(cause)}`,
    );
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch (cause) {
    throw new ArtifactReadError(
      "malformed",
      `artifact is not valid JSON${nativeErrorPosition(cause)}`,
    );
  }
}

export function inspectJson(
  data: Uint8Array,
  input: StructuredReadInput,
): StructuredOverview {
  return inspectStructuredValue(parseJsonValue(data), input);
}

interface PageOpts {
  offset?: number;
  limit?: number;
}

function page<T>(
  items: T[],
  opts: PageOpts,
): {
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  pageItems: T[];
} {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const pageItems = items.slice(offset, offset + limit);
  return {
    total: items.length,
    offset,
    limit,
    truncated: offset + pageItems.length < items.length,
    pageItems,
  };
}

function asRecord(v: unknown): Record<string, JsonValue> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : null;
}

function typeOf(v: JsonValue): JsonTopLevelEntry["type"] {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v as "string" | "number" | "boolean";
}

export function readJsonOverview(data: Uint8Array): JsonOverview {
  try {
    return overviewJsonValue(parseJsonValue(data), data.length);
  } catch (cause) {
    rethrowAsReadError(cause);
  }
}

export function overviewJsonValue(
  doc: JsonValue,
  sizeBytes: number,
): JsonOverview {
  try {
    const rec = asRecord(doc);
    const entries = capEntries(rec ? Object.entries(rec) : []);
    const topLevel: JsonTopLevelEntry[] = entries.items.map(([key, v]) => ({
      key,
      type: typeOf(v),
      count: Array.isArray(v)
        ? v.length
        : asRecord(v)
          ? Object.keys(asRecord(v)!).length
          : null,
    }));
    return {
      sizeBytes,
      topLevel,
      truncated: entries.truncated,
      rootType: typeOf(doc),
      rootCount: Array.isArray(doc)
        ? doc.length
        : rec
          ? Object.keys(rec).length
          : null,
    };
  } catch (cause) {
    rethrowAsReadError(cause);
  }
}

/** Project each object match down to the requested dot-paths; the output is
 *  flat, keyed by the path string. Non-object matches pass through. */
function projectFields(items: JsonValue[], fields: string[]): JsonValue[] {
  return items.map((item) => {
    if (!asRecord(item)) return item;
    const out: Record<string, JsonValue> = {};
    for (const field of fields) {
      let cursor: JsonValue | undefined = item;
      for (const key of field.split(".")) {
        const rec = asRecord(cursor);
        cursor = rec && Object.hasOwn(rec, key) ? rec[key] : undefined;
        if (cursor === undefined) break;
      }
      if (cursor !== undefined)
        Object.defineProperty(out, field, {
          value: cursor,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    return out;
  });
}

/** Keeps whole items while they fit. A first item larger than the whole
 *  budget is kept anyway, flagged `clipped`, so the caller can clamp it and
 *  still advance past it instead of getting an empty page at that offset. */
function clipToByteBudget(
  items: JsonValue[],
  maxBytes: number,
): { items: JsonValue[]; clipped: boolean } {
  const kept: JsonValue[] = [];
  let bytes = 2; // "[]"
  for (const item of items) {
    const size = JSON.stringify(item).length + 1; // comma
    if (bytes + size > maxBytes) {
      if (kept.length === 0) kept.push(item);
      return { items: kept, clipped: true };
    }
    kept.push(item);
    bytes += size;
  }
  return { items: kept, clipped: false };
}

export function queryJson(
  data: Uint8Array,
  input: { path: string; fields?: string[]; offset?: number; limit?: number },
): JsonQueryResult {
  validateFields(input.fields);
  return queryJsonValue(parseJsonValue(data), input);
}

function validateFields(fields: string[] | undefined): void {
  if (fields && fields.length > MAX_FIELDS) {
    throw new ArtifactReadError(
      "resource_limit",
      `at most ${MAX_FIELDS} fields`,
    );
  }
}

export function queryJsonValue(
  doc: JsonValue,
  input: { path: string; fields?: string[]; offset?: number; limit?: number },
): JsonQueryResult {
  validateFields(input.fields);
  try {
    let matches: JsonValue[];
    try {
      matches = queryJsonPath(doc, input.path);
    } catch (cause) {
      if (cause instanceof JsonPathLimitError) {
        throw new ArtifactReadError(
          "resource_limit",
          "query matches too many values; narrow the path",
        );
      }
      if (cause instanceof JsonPathError) {
        throw new ArtifactReadError("invalid_path", cause.message);
      }
      throw cause;
    }
    const { pageItems, ...rest } = page(matches, input);
    const projected = input.fields?.length
      ? projectFields(pageItems, input.fields)
      : pageItems;
    const { items, clipped } = clipToByteBudget(
      projected,
      QUERY_MAX_RESULT_BYTES,
    );
    return {
      path: input.path,
      ...rest,
      truncated: rest.truncated || clipped,
      items,
    };
  } catch (cause) {
    rethrowAsReadError(cause);
  }
}

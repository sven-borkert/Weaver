/**
 * One place for the bounded-input checks the readers share. A caller-supplied
 * limit outside the documented range is reported as invalid_input.
 * Defaults and hard maxima stay each reader's own.
 */
import { ArtifactReadError } from "./errors";

export function normalizeLimit(args: {
  value: number | undefined;
  defaultValue: number;
  hardMax: number;
  label: string;
}): number {
  if (args.value === undefined) return args.defaultValue;
  if (
    !Number.isInteger(args.value) ||
    args.value < 1 ||
    args.value > args.hardMax
  ) {
    throw new ArtifactReadError(
      "invalid_input",
      `${args.label} must be between 1 and ${args.hardMax}`,
    );
  }
  return args.value;
}

/** A window start (block or row index) is any non-negative integer. */
export function normalizeOffset(args: {
  value: number | undefined;
  label: string;
}): number {
  if (args.value === undefined) return 0;
  if (!Number.isInteger(args.value) || args.value < 0) {
    throw new ArtifactReadError(
      "invalid_input",
      `${args.label} must be a non-negative integer`,
    );
  }
  return args.value;
}

/** Overview lists (chapters, tables, top-level keys) are cut here so a huge
 *  document's overview still fits the child's result cap. */
export const OVERVIEW_ENTRY_CAP = 5_000;

export function utf8Prefix(text: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  while (end < text.length) {
    const code = text.codePointAt(end)!;
    const cost = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    end += code > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

export function capEntries<T>(items: readonly T[]): {
  items: T[];
  truncated: boolean;
} {
  return items.length > OVERVIEW_ENTRY_CAP
    ? { items: items.slice(0, OVERVIEW_ENTRY_CAP), truncated: true }
    : { items: [...items], truncated: false };
}

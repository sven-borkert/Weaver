import { isValidDateTimeCell } from "@weaver/core/tables/validation";

const pad = (n: number) => String(n).padStart(2, "0");

/** Minutes east of UTC for the viewer's local timezone, e.g. CEST is 120. */
export function currentOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/**
 * Minutes east of UTC to seed an editor with, using the runtime's DST rules
 * as they apply to the cell's own instant (not "now") — so editing a
 * January date while it's currently July picks standard time, not DST.
 * Falls back to `currentOffsetMinutes()` for an absent or unparsable cell.
 */
export function offsetMinutesFor(cell: string | undefined): number {
  if (typeof cell === "string") {
    const ms = Date.parse(cell);
    if (Number.isFinite(ms)) return -new Date(ms).getTimezoneOffset();
  }
  return currentOffsetMinutes();
}

/** ISO cell -> value for <input type="datetime-local"> in the given offset. */
export function toDateTimeInputValue(
  cell: string,
  offsetMinutes: number,
): string {
  const ms = Date.parse(cell);
  if (!Number.isFinite(ms)) return "";
  const shifted = new Date(ms + offsetMinutes * 60_000);
  const base = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  const seconds = shifted.getUTCSeconds();
  return seconds === 0 ? base : `${base}:${pad(seconds)}`;
}

/** datetime-local input value + offset -> ISO cell with seconds and zone. */
export function fromDateTimeInputValue(
  input: string,
  offsetMinutes: number,
): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    input,
  );
  if (!match) return undefined;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const zone =
    offsetMinutes === 0
      ? "Z"
      : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const candidate = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}${zone}`;
  return isValidDateTimeCell(candidate) ? candidate : undefined;
}

/** Minutes east of UTC that apply at a given instant. */
export type OffsetAt = (utcMs: number) => number;

const localOffsetAt: OffsetAt = (utcMs) => -new Date(utcMs).getTimezoneOffset();

/**
 * datetime-local input value -> ISO cell, using the offset that applies to the
 * entered wall time rather than to the cell being edited. `preferredOffset`
 * wins only when it is valid for that wall time (same season, or the second
 * pass of a DST overlap); an overlap otherwise takes its first occurrence, and
 * a wall time inside a DST gap is moved forward to the instant that exists.
 */
export function localDateTimeInputToCell(
  input: string,
  preferredOffset?: number,
  offsetAt: OffsetAt = localOffsetAt,
): string | undefined {
  const asUtc = fromDateTimeInputValue(input, 0);
  if (!asUtc) return undefined;
  const wallMs = Date.parse(asUtc);
  const before = offsetAt(wallMs - 86_400_000);
  const candidates = [preferredOffset, before, offsetAt(wallMs + 86_400_000)];
  const valid = candidates.find(
    (offset) =>
      offset !== undefined && offsetAt(wallMs - offset * 60_000) === offset,
  );
  if (valid !== undefined) return fromDateTimeInputValue(input, valid);
  const instant = wallMs - before * 60_000;
  const actual = offsetAt(instant);
  const shifted = new Date(instant + actual * 60_000);
  return fromDateTimeInputValue(shifted.toISOString().slice(0, 19), actual);
}

/** Formats a datetime cell for display in the viewer's own locale/zone. */
export function formatDateTimeCell(cell: string, locale?: string): string {
  const ms = Date.parse(cell);
  return Number.isFinite(ms)
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(ms)
    : cell;
}

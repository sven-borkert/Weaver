import { describe, expect, it } from "vitest";

import {
  currentOffsetMinutes,
  formatDateTimeCell,
  fromDateTimeInputValue,
  localDateTimeInputToCell,
  offsetMinutesFor,
  toDateTimeInputValue,
} from "./datetime";

describe("toDateTimeInputValue / fromDateTimeInputValue", () => {
  it("round-trips between cell and input value at a fixed offset", () => {
    expect(toDateTimeInputValue("2026-09-18T12:30:00Z", 120)).toBe(
      "2026-09-18T14:30",
    );
    expect(fromDateTimeInputValue("2026-09-18T14:30", 120)).toBe(
      "2026-09-18T14:30:00+02:00",
    );
    expect(fromDateTimeInputValue("2026-09-18T14:30", 0)).toBe(
      "2026-09-18T14:30:00Z",
    );
    expect(fromDateTimeInputValue("2026-09-18T14:30", -330)).toBe(
      "2026-09-18T14:30:00-05:30",
    );
    expect(fromDateTimeInputValue("", 120)).toBeUndefined();
    expect(fromDateTimeInputValue("2026-02-30T14:30", 120)).toBeUndefined();
  });

  it("round-trips seconds present in the input value", () => {
    expect(fromDateTimeInputValue("2026-09-18T14:30:45", 0)).toBe(
      "2026-09-18T14:30:45Z",
    );
  });

  it("keeps non-zero seconds from the cell in the seeded input value", () => {
    expect(toDateTimeInputValue("2026-09-18T12:30:45Z", 0)).toBe(
      "2026-09-18T12:30:45",
    );
    expect(fromDateTimeInputValue("2026-09-18T12:30:45", 0)).toBe(
      "2026-09-18T12:30:45Z",
    );
  });

  it("omits seconds from the seeded input value when they are zero", () => {
    expect(toDateTimeInputValue("2026-09-18T12:30:00Z", 0)).toBe(
      "2026-09-18T12:30",
    );
  });

  it("returns an empty string for an unparsable cell", () => {
    expect(toDateTimeInputValue("not-a-date", 0)).toBe("");
  });

  it("rejects malformed input shapes", () => {
    expect(fromDateTimeInputValue("2026-09-18", 0)).toBeUndefined();
    expect(fromDateTimeInputValue("garbage", 0)).toBeUndefined();
  });
});

describe("localDateTimeInputToCell", () => {
  // EU rule for 2026: DST from 29 March 01:00Z until 25 October 01:00Z.
  const berlin = (utcMs: number) =>
    utcMs >= Date.parse("2026-03-29T01:00:00Z") &&
    utcMs < Date.parse("2026-10-25T01:00:00Z")
      ? 120
      : 60;

  it("uses the offset of the entered date, not of the edited cell", () => {
    expect(localDateTimeInputToCell("2026-01-15T10:00", 120, berlin)).toBe(
      "2026-01-15T10:00:00+01:00",
    );
    expect(localDateTimeInputToCell("2026-07-15T10:00", 60, berlin)).toBe(
      "2026-07-15T10:00:00+02:00",
    );
    expect(
      localDateTimeInputToCell("2026-01-15T10:00", undefined, berlin),
    ).toBe("2026-01-15T10:00:00+01:00");
    expect(localDateTimeInputToCell("2026-07-15T10:00:30", 120, berlin)).toBe(
      "2026-07-15T10:00:30+02:00",
    );
  });

  it("moves a wall time inside the spring gap forward", () => {
    expect(localDateTimeInputToCell("2026-03-29T02:30", 60, berlin)).toBe(
      "2026-03-29T03:30:00+02:00",
    );
  });

  it("keeps the edited cell's pass of the autumn overlap, else the first", () => {
    expect(localDateTimeInputToCell("2026-10-25T02:30", 60, berlin)).toBe(
      "2026-10-25T02:30:00+01:00",
    );
    expect(
      localDateTimeInputToCell("2026-10-25T02:30", undefined, berlin),
    ).toBe("2026-10-25T02:30:00+02:00");
  });

  it("handles half-hour zones and rejects malformed input", () => {
    expect(localDateTimeInputToCell("2026-09-18T14:30", 0, () => -330)).toBe(
      "2026-09-18T14:30:00-05:30",
    );
    expect(localDateTimeInputToCell("garbage", 0, berlin)).toBeUndefined();
  });
});

describe("currentOffsetMinutes", () => {
  it("matches the negated timezone offset of the runtime", () => {
    expect(currentOffsetMinutes()).toBe(-new Date().getTimezoneOffset());
  });
});

describe("offsetMinutesFor", () => {
  it("returns a finite offset for a parseable cell", () => {
    expect(Number.isFinite(offsetMinutesFor("2026-09-18T12:30:00Z"))).toBe(
      true,
    );
  });

  it("falls back to currentOffsetMinutes for an absent or unparsable cell", () => {
    expect(offsetMinutesFor(undefined)).toBe(currentOffsetMinutes());
    expect(offsetMinutesFor("not-a-date")).toBe(currentOffsetMinutes());
  });
});

describe("formatDateTimeCell", () => {
  it("formats a valid cell through Intl in a fixed locale", () => {
    const formatted = formatDateTimeCell("2026-09-18T12:30:00Z", "en-US");
    expect(formatted).toContain("2026");
    expect(formatted).not.toBe("2026-09-18T12:30:00Z");
  });

  it("returns the raw cell for an unparsable value", () => {
    expect(formatDateTimeCell("not-a-date", "en-US")).toBe("not-a-date");
  });
});

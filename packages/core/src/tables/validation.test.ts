import { describe, expect, it } from "vitest";
import {
  dateTimeInstant,
  isValidDateTimeCell,
  isValidUrlCell,
  normalizeDateTimeCell,
} from "./validation";

describe("datetime cells", () => {
  it("requires a zone designator and a real calendar date", () => {
    expect(isValidDateTimeCell("2026-09-18T14:30:00+02:00")).toBe(true);
    expect(isValidDateTimeCell("2026-09-18T14:30Z")).toBe(true);
    expect(isValidDateTimeCell("2026-09-18T14:30:00.250Z")).toBe(true);
    expect(isValidDateTimeCell("2026-09-18T14:30:00")).toBe(false);
    expect(isValidDateTimeCell("2026-02-30T00:00:00Z")).toBe(false);
    expect(isValidDateTimeCell("2026-09-18")).toBe(false);
    expect(isValidDateTimeCell("2026-09-18T24:00:00Z")).toBe(false);
  });
  it("normalises missing seconds and compares instants", () => {
    expect(normalizeDateTimeCell("2026-09-18T14:30Z")).toBe(
      "2026-09-18T14:30:00Z",
    );
    expect(normalizeDateTimeCell("2026-09-18T14:30:05+02:00")).toBe(
      "2026-09-18T14:30:05+02:00",
    );
    expect(dateTimeInstant("2026-09-18T14:30:00+02:00")).toBe(
      dateTimeInstant("2026-09-18T12:30:00Z"),
    );
  });
});
describe("url cells", () => {
  it("accepts http(s) without whitespace up to 2048 chars", () => {
    expect(isValidUrlCell("https://example.test/a?b=1#c")).toBe(true);
    expect(isValidUrlCell("http://example.test")).toBe(true);
    expect(isValidUrlCell("HTTPS://x.test")).toBe(true);
    expect(isValidUrlCell("ftp://example.test")).toBe(false);
    expect(isValidUrlCell("https://exa mple.test")).toBe(false);
    expect(isValidUrlCell("https://" + "a".repeat(2_041))).toBe(false);
    expect(isValidUrlCell("javascript:alert(1)")).toBe(false);
  });
});

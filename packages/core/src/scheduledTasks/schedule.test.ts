import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./schedule";

describe("nextOccurrence", () => {
  it("honours the timezone on both sides of a DST change", () => {
    expect(
      nextOccurrence(
        "0 7 * * *",
        "Europe/Berlin",
        new Date("2026-01-10T10:00:00Z"),
      ),
    ).toEqual(new Date("2026-01-11T06:00:00Z"));
    expect(
      nextOccurrence(
        "0 7 * * *",
        "Europe/Berlin",
        new Date("2026-07-10T10:00:00Z"),
      ),
    ).toEqual(new Date("2026-07-11T05:00:00Z"));
  });

  it("finds the next weekday and the next monthly day", () => {
    expect(
      nextOccurrence(
        "0 7 * * 1",
        "Europe/Berlin",
        new Date("2026-01-10T10:00:00Z"),
      ),
    ).toEqual(new Date("2026-01-12T06:00:00Z"));
    expect(
      nextOccurrence("0 7 28 * *", "UTC", new Date("2026-01-29T00:00:00Z")),
    ).toEqual(new Date("2026-02-28T07:00:00Z"));
  });

  it("never returns the instant itself", () => {
    const at = new Date("2026-01-10T07:00:00Z");
    expect(nextOccurrence("0 7 * * *", "UTC", at).getTime()).toBeGreaterThan(
      at.getTime(),
    );
  });
});

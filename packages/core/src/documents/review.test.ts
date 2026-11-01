import { describe, expect, it } from "vitest";
import {
  addMonthsUtc,
  canonicalReviewers,
  reviewDueAt,
  type DocumentReview,
} from "./review";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("addMonthsUtc", () => {
  it("adds calendar months in UTC", () => {
    expect(addMonthsUtc("2026-10-07T09:30:00.000Z", 12).toISOString()).toBe(
      "2027-10-07T09:30:00.000Z",
    );
  });
  it("clamps to the end of a shorter month", () => {
    expect(addMonthsUtc("2026-01-31T00:00:00.000Z", 1).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(addMonthsUtc("2027-11-30T23:00:00.000Z", 3).toISOString()).toBe(
      "2028-02-29T23:00:00.000Z",
    );
  });
});

describe("reviewDueAt", () => {
  const base: DocumentReview = {
    reviewers: [],
    everyMonths: 6,
    since: "2026-01-15T00:00:00.000Z",
    lastReviewed: null,
    reviewedBy: null,
  };
  it("is due at since until the first review", () => {
    expect(reviewDueAt(base).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
  it("ignores the interval of a never-reviewed document", () => {
    expect(reviewDueAt({ ...base, everyMonths: 60 })).toEqual(
      reviewDueAt(base),
    );
  });
  it("counts from the last review afterwards", () => {
    expect(
      reviewDueAt({
        ...base,
        lastReviewed: "2026-03-01T00:00:00.000Z",
        reviewedBy: { id: A, name: "Ada" },
      }).toISOString(),
    ).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("canonicalReviewers", () => {
  it("sorts by type then id and drops duplicates", () => {
    expect(
      canonicalReviewers([
        { type: "user", id: B, name: "Bob" },
        { type: "group", id: B, name: "Ops" },
        { type: "user", id: A, name: "Ada" },
        { type: "user", id: B, name: "Bob again" },
      ]),
    ).toEqual([
      { type: "group", id: B, name: "Ops" },
      { type: "user", id: A, name: "Ada" },
      { type: "user", id: B, name: "Bob" },
    ]);
  });
});

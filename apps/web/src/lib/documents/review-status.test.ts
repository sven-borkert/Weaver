import { describe, expect, it } from "vitest";
import {
  documentReviewStatus,
  reviewFolderLabel,
  reviewStatus,
  reviewerSummary,
} from "./review-status";

const now = new Date("2026-10-07T12:00:00Z");
const daysFromNow = (days: number) =>
  new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

describe("reviewStatus", () => {
  it("is overdue when the due date has passed", () => {
    expect(reviewStatus(daysFromNow(-1), now)).toBe("overdue");
  });

  it("is overdue exactly at the due date", () => {
    expect(reviewStatus(now, now)).toBe("overdue");
  });

  it("is due soon within 30 days", () => {
    expect(reviewStatus(daysFromNow(10), now)).toBe("due-soon");
    expect(reviewStatus(daysFromNow(30), now)).toBe("due-soon");
  });

  it("is ok beyond 30 days", () => {
    expect(reviewStatus(daysFromNow(31), now)).toBe("ok");
  });
});

describe("reviewerSummary", () => {
  it("falls back to the project owners without reviewers", () => {
    expect(reviewerSummary([])).toBe("Project owners");
  });

  it("lists up to three names", () => {
    expect(reviewerSummary([{ name: "Ada" }, { name: "Ops" }])).toBe(
      "Ada, Ops",
    );
    expect(
      reviewerSummary([{ name: "Ada" }, { name: "Bob" }, { name: "Cy" }]),
    ).toBe("Ada, Bob, Cy");
  });

  it("counts the rest beyond three", () => {
    expect(
      reviewerSummary(
        ["Ada", "Bob", "Cy", "Di", "Ed"].map((name) => ({ name })),
      ),
    ).toBe("Ada, Bob, Cy and 2 more");
  });
});

describe("reviewFolderLabel", () => {
  it("shows a dash for a document at the project root", () => {
    expect(reviewFolderLabel("plan.md")).toBe("—");
  });

  it("joins the folder segments without the file name", () => {
    expect(reviewFolderLabel("guides/setup/plan.md")).toBe("guides / setup");
    expect(reviewFolderLabel("guides/plan.md")).toBe("guides");
  });
});

describe("documentReviewStatus", () => {
  it("is null without a review schedule", () => {
    expect(
      documentReviewStatus({ reviewDueAt: null, lastReviewedAt: null }, now),
    ).toBeNull();
  });

  it("shows a never-reviewed document as due soon", () => {
    expect(
      documentReviewStatus(
        { reviewDueAt: daysFromNow(90), lastReviewedAt: null },
        now,
      ),
    ).toBe("due-soon");
    expect(
      documentReviewStatus(
        { reviewDueAt: daysFromNow(-5), lastReviewedAt: null },
        now,
      ),
    ).toBe("due-soon");
  });

  it("reports reviewed documents by their next due date", () => {
    expect(
      documentReviewStatus(
        { reviewDueAt: daysFromNow(120), lastReviewedAt: daysFromNow(-60) },
        now,
      ),
    ).toBe("ok");
    expect(
      documentReviewStatus(
        { reviewDueAt: daysFromNow(12), lastReviewedAt: daysFromNow(-60) },
        now,
      ),
    ).toBe("due-soon");
    expect(
      documentReviewStatus(
        { reviewDueAt: daysFromNow(-1), lastReviewedAt: daysFromNow(-365) },
        now,
      ),
    ).toBe("overdue");
  });
});

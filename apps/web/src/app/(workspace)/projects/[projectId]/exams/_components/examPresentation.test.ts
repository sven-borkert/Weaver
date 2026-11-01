import { describe, it, expect } from "vitest";
import {
  formatRemaining,
  scoreLabel,
  traineeExamState,
} from "./examPresentation";
describe("exam presentation", () => {
  it("formats a nonnegative server timer", () => {
    expect(formatRemaining(90000)).toBe("01:30");
    expect(formatRemaining(3725000)).toBe("1:02:05");
    expect(formatRemaining(-5)).toBe("00:00");
  });
  it("distinguishes archived exams and waiting attempts", () => {
    expect(traineeExamState({ status: "published", attempts: [] })).toBe(
      "not_started",
    );
    expect(
      traineeExamState({
        status: "archived",
        attempts: [{ status: "released" }],
      }),
    ).toBe("closed");
    expect(
      traineeExamState({
        status: "published",
        attempts: [{ status: "in_review" }],
      }),
    ).toBe("waiting");
    expect(
      traineeExamState({
        status: "archived",
        attempts: [{ status: "in_progress" }],
      }),
    ).toBe("in_progress");
  });
  it("omits a verdict without a threshold", () => {
    expect(
      scoreLabel({ totalScore: 8.5, maxScore: 10, percent: 85, passed: null }),
    ).toBe("8.5 / 10 (85 %)");
    expect(
      scoreLabel({ totalScore: 0, maxScore: 10, percent: 0, passed: false }),
    ).toContain("not passed");
  });
});

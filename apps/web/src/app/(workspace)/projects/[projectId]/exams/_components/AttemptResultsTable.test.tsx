import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { TraineeAttemptSummary } from "@weaver/core/services/exams";
import { AttemptResultsTable } from "./AttemptResultsTable";

const attempt: TraineeAttemptSummary & {
  examTitle: string;
  traineeName: string;
} = {
  id: "attempt",
  examId: "exam",
  examTitle: "Safety",
  traineeName: "Alex",
  attemptNumber: 2,
  status: "released",
  startedAt: new Date(),
  deadlineAt: new Date(),
  submittedAt: new Date(),
  submissionKind: "manual",
  releasedAt: new Date(),
  totalScore: 8,
  maxScore: 10,
  percent: 80,
  passed: true,
};
it("shows trainee results in a table with an explicit result button", () => {
  const html = renderToStaticMarkup(
    <AttemptResultsTable
      projectId="project"
      attempts={[attempt]}
      trainer={false}
    />,
  );
  expect(html).toContain("<table");
  expect(html).toContain("Safety");
  expect(html).toContain("8 / 10 (80 %)");
  expect(html).toContain('href="/projects/project/exams/attempts/attempt"');
  expect(html).toContain('data-slot="button"');
  expect(html).toContain("View result");
  expect(html).not.toContain("Alex");
});
it("hides unreleased grades from the trainee while allowing the attempt to open", () => {
  const html = renderToStaticMarkup(
    <AttemptResultsTable
      projectId="project"
      attempts={[{ ...attempt, status: "in_review" }]}
      trainer={false}
    />,
  );
  expect(html).toContain("Open attempt");
  expect(html).not.toContain("8 / 10");
});
it.each([
  ["submitted", "Review attempt"],
  ["in_review", "Review grade"],
  ["released", "View result"],
] as const)("gives trainers a clear %s action", (status, label) => {
  const html = renderToStaticMarkup(
    <AttemptResultsTable
      projectId="project"
      attempts={[{ ...attempt, status }]}
      trainer
    />,
  );
  expect(html).toContain("Alex");
  expect(html).toContain(label);
  expect(html).toContain('data-slot="button"');
});

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted((): { role: string | null; error: unknown } => ({
  role: "trainee",
  error: null,
}));
const now = new Date();
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));
const attempt = {
  id: "result",
  examId: "exam",
  attemptNumber: 1,
  status: "released",
  submittedAt: now,
  startedAt: now,
  releasedAt: now,
  deadlineAt: now,
  totalScore: 8,
  maxScore: 10,
  percent: 80,
  passed: true,
  submissionKind: "manual",
};
vi.mock("~/trpc/react", () => ({
  api: {
    project: {
      get: { useQuery: () => ({ data: { myTrainingRole: mocks.role } }) },
    },
    exam: {
      listAvailable: {
        useQuery: () => ({
          data: [
            {
              id: "exam",
              title: "Safety",
              attempts: [
                attempt,
                { ...attempt, id: "open", status: "in_progress" },
              ],
            },
          ],
          error: mocks.error,
        }),
      },
      listAttempts: {
        useQuery: ({
          status,
          cursor,
        }: {
          status: string;
          cursor?: string;
        }) => ({
          data: {
            items: [
              {
                ...attempt,
                id: cursor ? "next-result" : "first-result",
                examTitle: `${status} ${cursor ? "second" : "first"}`,
                trainee: { name: "Alex", email: "alex@example.test" },
                status: status === "waiting" ? "submitted" : status,
              },
            ],
            nextCursor: cursor ? null : "next",
          },
          error: mocks.error,
        }),
      },
    },
  },
}));
import { ExamResultsScreen } from "./ExamResultsScreen";
import { ExamsScreen } from "./ExamsScreen";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  mocks.role = "trainee";
  mocks.error = null;
});
async function mount() {
  await act(async () => {
    renderer = create(<ExamResultsScreen projectId="project" />);
  });
}
const links = () =>
  renderer!.root
    .findAllByType("a")
    .map((n) => (n.props as { href: string }).href);
it("puts completed trainee attempts on Results and leaves ongoing attempts on Exams", async () => {
  await mount();
  expect(renderer!.root.findAllByType("table")).toHaveLength(1);
  expect(links()).toContain("/projects/project/exams/attempts/result");
  expect(links()).not.toContain("/projects/project/exams/attempts/open");
});
it("replaces inline trainee result links on Exams with navigation to Results", async () => {
  await act(async () => {
    renderer = create(<ExamsScreen projectId="project" />);
  });
  expect(links()).toContain("/projects/project/exams/results");
  expect(links()).not.toContain("/projects/project/exams/attempts/result");
});
it("paginates trainer results and resets pagination when the status changes", async () => {
  mocks.role = "trainer";
  await mount();
  const click = (label: string) => {
    const node = renderer!.root
      .findAllByType("button")
      .find((n) => (n.props as { children: unknown }).children === label)!;
    (node.props as { onClick: () => void }).onClick();
  };
  expect(links()).toContain("/projects/project/exams/attempts/first-result");
  await act(async () => click("Next"));
  expect(links()).toContain("/projects/project/exams/attempts/next-result");
  await act(async () =>
    (
      renderer!.root.findByType("select").props as {
        onChange: (e: { target: { value: string } }) => void;
      }
    ).onChange({ target: { value: "released" } }),
  );
  expect(links()).toContain("/projects/project/exams/attempts/first-result");
  expect(links()).not.toContain("/projects/project/exams/attempts/next-result");
  expect(
    renderer!.root
      .findAllByType("td")
      .some((n) => n.children.includes("released first")),
  ).toBe(true);
});
it("hides cached results after an access error", async () => {
  mocks.error = { data: { code: "FORBIDDEN" } };
  await mount();
  expect(renderer!.root.findAllByType("table")).toHaveLength(0);
});
it("hides Results when training is off", async () => {
  mocks.role = null;
  await mount();
  expect(renderer!.root.findAllByType("table")).toHaveLength(0);
});

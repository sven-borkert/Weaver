import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BackgroundWorkRow } from "./BackgroundWorkRow";

describe("BackgroundWorkRow", () => {
  it("renders status, unread text and an accessible source link", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkRow
        item={{
          id: "run-1",
          kind: "task",
          title: "Weekly report",
          projectId: "project-1",
          projectName: "Research",
          state: "failed",
          sourceStatus: "failed",
          createdAt: "2026-09-08T08:00:00.000Z",
          startedAt: "2026-09-08T08:01:00.000Z",
          finishedAt: "2026-09-08T08:02:00.000Z",
          sortAt: "2026-09-08T08:02:00.000Z",
          progress: null,
          errorCode: "PROVIDER_ERROR",
          errorMessage: "Provider outage detected (ref abc123)",
          destination: {
            kind: "task",
            projectId: "project-1",
            taskId: "task-1",
          },
          acknowledgement: {
            kind: "task",
            id: "00000000-0000-4000-8000-000000000001",
            revision: "a".repeat(32),
          },
          unseen: true,
        }}
      />,
    );
    expect(html).toContain("Weekly report");
    expect(html).toContain("Failed");
    expect(html).toContain("Unseen result");
    expect(html).toContain('href="/projects/project-1/tasks/task-1"');
    expect(html).toContain('aria-label="Open Weekly report"');
    expect(html).toContain("Provider outage detected (ref abc123)");
    expect(html).toContain('title="Provider outage detected (ref abc123)"');
  });

  it("falls back to a generic message when no error text is stored", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkRow
        item={{
          id: "run-2",
          kind: "task",
          title: "Weekly report",
          projectId: "project-1",
          projectName: "Research",
          state: "failed",
          sourceStatus: "failed",
          createdAt: "2026-09-08T08:00:00.000Z",
          startedAt: "2026-09-08T08:01:00.000Z",
          finishedAt: "2026-09-08T08:02:00.000Z",
          sortAt: "2026-09-08T08:02:00.000Z",
          progress: null,
          errorCode: "PROVIDER_ERROR",
          errorMessage: null,
          destination: {
            kind: "task",
            projectId: "project-1",
            taskId: "task-1",
          },
          acknowledgement: null,
          unseen: false,
        }}
      />,
    );
    expect(html).toContain(
      "This work did not finish. Open its source for details.",
    );
  });
});

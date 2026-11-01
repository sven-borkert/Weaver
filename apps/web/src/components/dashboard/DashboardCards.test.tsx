import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityRow } from "./ActivityRow";
import { ReportShortcutsCard } from "./ReportShortcutsCard";

describe("dashboard components", () => {
  it("renders missing work attribution and time safely", () => {
    const html = renderToStaticMarkup(
      <ActivityRow
        entry={{
          id: "run",
          source: "task",
          category: "work_result",
          title: "Weekly report",
          projectId: "p",
          projectName: "Research",
          sortAt: "2026-09-09T10:00:00.000Z",
          occurredAt: null,
          editorName: null,
          isOwnChange: null,
          state: "failed",
          sourceStatus: "failed",
          destination: { kind: "task", projectId: "p", taskId: "t" },
          currentReport: null,
        }}
      />,
    );
    expect(html).toContain("Time unavailable");
    expect(html).toContain("Failed");
    expect(html).toContain('href="/projects/p/tasks/t"');
    expect(html).not.toContain("null");
  });

  it("describes a report link as current content", () => {
    const html = renderToStaticMarkup(
      <ActivityRow
        entry={{
          id: "run",
          source: "task",
          category: "work_result",
          title: "Weekly report",
          projectId: "p",
          projectName: "Research",
          sortAt: "2026-09-09T10:00:00.000Z",
          occurredAt: "2026-09-09T10:00:00.000Z",
          editorName: null,
          isOwnChange: null,
          state: "succeeded",
          sourceStatus: "completed",
          destination: { kind: "task", projectId: "p", taskId: "t" },
          currentReport: { kind: "document", projectId: "p", documentId: "d" },
        }}
      />,
    );
    expect(html).toContain("Current report");
    expect(html).toContain('href="/projects/p/documents/d"');
  });

  it("renders scheduled report status and current report copy", () => {
    const html = renderToStaticMarkup(
      <ReportShortcutsCard
        items={[
          {
            taskId: "t",
            title: "Weekly report",
            projectId: "p",
            projectName: "Research",
            status: "active",
            lastRunStatus: "succeeded",
            nextRunAt: null,
            destination: { kind: "task", projectId: "p", taskId: "t" },
            currentReport: {
              kind: "document",
              projectId: "p",
              documentId: "d",
            },
          },
        ]}
      />,
    );
    expect(html).toContain("Scheduled reports");
    expect(html).toContain("Current report");
    expect(html).toContain("No next run scheduled");
    expect(html).toContain("Last run: Completed");
    expect(html).toContain('href="/account/tasks"');
  });
});

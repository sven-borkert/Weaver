import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/trpc/react", () => ({ api: {} }));
vi.mock("./TaskDialog", () => ({ TaskDialog: () => null }));

import { TasksTable } from "./TasksScreen";

const task = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Weekly digest",
  ownerId: "o",
  ownerName: "Alice",
  ownerEmail: "alice@weaver.local",
  outputProjectId: "p",
  outputProjectName: "Ops",
  outputDocumentId: null,
  schedule: { kind: "weekly" as const, weekday: 1, hour: 7, minute: 0 },
  timezone: "Europe/Berlin",
  scheduleText: "Weekly on Monday at 07:00, Europe/Berlin",
  status: "paused" as const,
  pauseReason: "failing" as const,
  nextRunAt: null,
  lastRunAt: new Date("2026-09-08T05:00:00Z"),
  lastRunStatus: "failed" as const,
  consecutiveFailures: 5,
  canManage: true,
  canEditDefinition: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("TasksTable", () => {
  it("renders schedule, last run, pause reason, and the manage menu", () => {
    const html = renderToStaticMarkup(
      <TasksTable
        projectId="p"
        tasks={[task]}
        onEdit={() => undefined}
        onAction={() => undefined}
      />,
    );
    expect(html).toContain("Weekly on Monday at 07:00, Europe/Berlin");
    expect(html).toContain("Failed");
    expect(html).toContain("paused after repeated failures");
    expect(html).toContain("Not yet written");
    expect(html).toContain("Actions for Weekly digest");
  });

  it("renders run timestamps with the date-and-time variant", () => {
    const html = renderToStaticMarkup(
      <TasksTable
        projectId="p"
        tasks={[{ ...task, nextRunAt: new Date("2026-09-09T05:00:00Z") }]}
        onEdit={() => undefined}
        onAction={() => undefined}
      />,
    );
    // Both run cells render the clock-bearing variant, not the date-only one.
    expect(html.match(/aria-label="Date and time loading"/g)?.length).toBe(2);
    expect(html).not.toContain('aria-label="Date loading"');
  });

  it("hides the manage menu for members who cannot manage", () => {
    const html = renderToStaticMarkup(
      <TasksTable
        projectId="p"
        tasks={[{ ...task, canManage: false }]}
        onEdit={() => undefined}
        onAction={() => undefined}
      />,
    );
    expect(html).not.toContain("Actions for Weekly digest");
  });
});

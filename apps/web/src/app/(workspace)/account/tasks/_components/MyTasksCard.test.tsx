import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TaskFixture = {
  canEditDefinition?: boolean;
  id: string;
  name: string;
  outputProjectId: string;
  outputProjectName: string;
  outputDocumentId: string | null;
  scheduleText: string;
  status: "active" | "paused";
  pauseReason: "manual" | "failing" | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus:
    "queued" | "running" | "succeeded" | "failed" | "skipped" | null;
};

type Query = {
  data: TaskFixture[] | undefined;
  error: unknown;
  isLoading: boolean;
};

const query = vi.hoisted((): Query => ({
  data: undefined,
  error: undefined,
  isLoading: false,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ scheduledTask: { listMine: { invalidate: vi.fn() } } }),
    scheduledTask: {
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      listMine: { useQuery: () => query },
      get: {
        useQuery: () => ({
          isLoading: false,
          error: null,
          data: query.data?.[0],
        }),
      },
    },
  },
}));

vi.mock("../../../projects/[projectId]/tasks/_components/TaskDialog", () => ({
  TaskDialog: ({ projectId }: { projectId: string }) => (
    <div data-shared-task-editor={projectId} />
  ),
}));
import { AccountTaskEditor, MyTasksCard } from "./MyTasksCard";

const taskWithoutOutput: TaskFixture = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Weekly digest",
  outputProjectId: "project-1",
  outputProjectName: "Ops",
  outputDocumentId: null,
  scheduleText: "Weekly on Monday at 07:00, Europe/Berlin",
  status: "active",
  pauseReason: null,
  nextRunAt: new Date("2026-09-09T05:00:00Z"),
  lastRunAt: new Date("2026-09-08T05:00:00Z"),
  lastRunStatus: "succeeded",
};

const taskWithOutput: TaskFixture = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Monthly report",
  outputProjectId: "project-2",
  outputProjectName: "Research",
  outputDocumentId: "doc-1",
  scheduleText: "Monthly on the 1st at 09:00, UTC",
  status: "paused",
  pauseReason: "manual",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: null,
};

describe("MyTasksCard", () => {
  it("uses the shared task dialog only with live management permission", () => {
    query.data = [{ ...taskWithoutOutput, canEditDefinition: true }];
    const props = {
      taskId: taskWithoutOutput.id,
      projectId: "project-1",
      onClose: vi.fn(),
      onCloseAutoFocus: vi.fn(),
    };
    expect(renderToStaticMarkup(<AccountTaskEditor {...props} />)).toContain(
      'data-shared-task-editor="project-1"',
    );
    query.data = [{ ...taskWithoutOutput, canEditDefinition: false }];
    expect(renderToStaticMarkup(<AccountTaskEditor {...props} />)).toContain(
      "no longer editable",
    );
    expect(
      renderToStaticMarkup(<AccountTaskEditor {...props} />),
    ).not.toContain("data-shared-task-editor");
  });
  beforeEach(() => {
    query.data = undefined;
    query.error = undefined;
    query.isLoading = false;
  });

  it("keeps deletion available when an owned task is no longer editable", () => {
    query.data = [{ ...taskWithoutOutput, canEditDefinition: false }];
    const html = renderToStaticMarkup(<MyTasksCard />);
    expect(html).toContain(`Delete ${taskWithoutOutput.name}`);
    expect(html).not.toContain(`Edit ${taskWithoutOutput.name}`);
  });

  it("shows a skeleton while loading", () => {
    query.isLoading = true;

    const html = renderToStaticMarkup(<MyTasksCard />);

    expect(html).toContain('data-slot="skeleton"');
  });

  it("shows an alert when the query fails", () => {
    query.error = new Error("failed");

    const html = renderToStaticMarkup(<MyTasksCard />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load your tasks.");
  });

  it("shows the empty state when there are no tasks", () => {
    query.data = [];

    const html = renderToStaticMarkup(<MyTasksCard />);

    expect(html).toContain("You have no scheduled tasks");
  });

  it("lists each task's name, project, schedule, next run, output, and status", () => {
    query.data = [taskWithoutOutput, taskWithOutput];

    const html = renderToStaticMarkup(<MyTasksCard />);

    expect(html).toContain("Weekly digest");
    expect(html).toContain(
      'href="/projects/project-1/tasks/11111111-1111-4111-8111-111111111111"',
    );
    expect(html).toContain("Ops");
    expect(html).toContain("Weekly on Monday at 07:00, Europe/Berlin");
    expect(html).toContain("Not yet written");
    expect(html).toContain("Active");

    expect(html).toContain("Monthly report");
    expect(html).toContain("Research");
    expect(html).toContain("Monthly on the 1st at 09:00, UTC");
    expect(html).toContain("Open document");
    expect(html).toContain('href="/projects/project-2/documents/doc-1"');
    expect(html).toContain("Paused");
  });
});

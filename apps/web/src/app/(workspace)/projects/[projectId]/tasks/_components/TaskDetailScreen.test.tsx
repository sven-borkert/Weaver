import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  canManage: false,
  status: "active",
  mutate: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  options: undefined as
    { onError: (error: { message: string }) => void } | undefined,
}));
vi.mock("sonner", () => ({
  toast: { error: mocked.error, success: mocked.success },
}));
vi.mock("./TaskDialog", () => ({
  TaskDialog: () => <div data-testid="editable-task-dialog" />,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      scheduledTask: {
        get: { invalidate: vi.fn() },
        listRuns: { invalidate: vi.fn() },
        listForProject: { invalidate: vi.fn() },
      },
    }),
    scheduledTask: {
      listRuns: {
        useInfiniteQuery: () => ({
          data: { pages: [{ runs: [] }] },
          isLoading: false,
          error: null,
        }),
      },
      get: {
        useQuery: () => ({
          isLoading: false,
          error: null,
          data: {
            id: "task",
            name: "Daily",
            canManage: mocked.canManage,
            canEditDefinition: false,
            scheduleText: "Daily",
            ownerName: "Owner",
            ownerEmail: "owner@weaver.local",
            status: mocked.status,
            scopeSnapshot: { kind: "project", projectIds: ["p"] },
            outputFolderPath: [],
            externalInputs: [
              {
                name: "Counts",
                toolId: "tool",
                arguments: { hours: { kind: "literal", value: 24 } },
              },
            ],
          },
        }),
      },
      runNow: {
        useMutation: (options: typeof mocked.options) => {
          mocked.options = options;
          return { mutate: mocked.mutate, isPending: false };
        },
      },
    },
  },
}));
import { TaskDetailScreen } from "./TaskDetailScreen";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  mocked.canManage = false;
  mocked.status = "active";
  mocked.mutate.mockReset();
  mocked.error.mockReset();
  mocked.success.mockReset();
});
describe("task detail permissions and run admission", () => {
  it("hides stored inputs and the editing dialog from read-only viewers", () => {
    const html = renderToStaticMarkup(
      <TaskDetailScreen projectId="p" taskId="task" />,
    );
    expect(html).not.toContain("Counts");
    expect(html).toContain("Visible only to the task owner");
    expect(html).not.toContain("editable-task-dialog");
    expect(html).not.toContain("Run now");
    expect(html).not.toContain("textarea");
  });
  it("sends run-now to current server admission and surfaces a changed connection", async () => {
    mocked.canManage = true;
    const html = renderToStaticMarkup(
      <TaskDetailScreen projectId="p" taskId="task" />,
    );
    expect(html).not.toContain("editable-task-dialog");
    expect(html).not.toContain("Counts");
    expect(html).toContain("Visible only to the task owner");
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<TaskDetailScreen projectId="p" taskId="task" />);
    });
    const run = r.root
      .findAllByType("button")
      .find((node) => node.children.includes("Run now"))!;
    const click = run.props.onClick as () => void;
    await act(async () => click());
    expect(mocked.mutate).toHaveBeenCalledWith({ taskId: "task" });
    await act(async () =>
      mocked.options?.onError({
        message:
          "External inputs need your own enabled read tools on a connection that does not ask before every call",
      }),
    );
    expect(mocked.error).toHaveBeenCalledWith(
      expect.stringContaining("does not ask before every call"),
    );
    expect(mocked.success).not.toHaveBeenCalled();
    await act(async () => r.unmount());
  });
  it("requires resuming a paused task before Run now", async () => {
    mocked.canManage = true;
    mocked.status = "paused";
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TaskDetailScreen projectId="p" taskId="task" />);
    });
    const run = renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Run now"))!;
    expect(run.props.disabled).toBe(true);
    expect(run.props.title).toBe("Resume the task before running it now");
    expect(mocked.mutate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});

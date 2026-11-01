import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ComponentProps } from "react";
import type { BackgroundWorkItem } from "@weaver/core/jobs/backgroundWorkSchema";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ markSeen: vi.fn() }));
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("~/components/ui/dialog", () => ({
  DialogContent: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogHeader: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogTitle: ({ children }: ComponentProps<"h2">) => <h2>{children}</h2>,
  DialogDescription: ({ children }: ComponentProps<"p">) => <p>{children}</p>,
  DialogFooter: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
}));
vi.mock("./BackgroundWorkProvider", () => ({
  useBackgroundWork: () => ({
    open: true,
    setOpen: vi.fn(),
    pageVisible: true,
    openGeneration: 1,
    openedAt: 1,
    refreshSummary: vi.fn(),
  }),
}));
const items: BackgroundWorkItem[] = [1, 2].map((n) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  title: `Exam result ${n}`,
  kind: "exam",
  projectId: "project",
  projectName: "Training",
  state: "succeeded",
  sourceStatus: "released",
  createdAt: "2026-10-20T10:00:00Z",
  startedAt: null,
  finishedAt: "2026-10-20T10:00:00Z",
  sortAt: "2026-10-20T10:00:00Z",
  errorCode: null,
  errorMessage: null,
  progress: null,
  destination: {
    kind: "exam",
    projectId: "project",
    attemptId: `attempt-${n}`,
  },
  acknowledgement: {
    kind: "exam",
    id: `00000000-0000-4000-8000-00000000000${n}`,
    revision: "a".repeat(32),
  },
  unseen: true,
}));
const utils = {
  backgroundWork: {
    list: { cancel: vi.fn(), invalidate: vi.fn() },
    summary: { invalidate: vi.fn() },
  },
};
vi.mock("~/trpc/react", () => ({
  usePrincipalId: () => "trainee",
  api: {
    useUtils: () => utils,
    backgroundWork: {
      list: {
        useQuery: ({ view }: { view: string }) => ({
          data: { items: view === "recent" ? items : [] },
          dataUpdatedAt: 2,
          isLoading: false,
          isFetching: false,
          isSuccess: true,
          refetch: vi.fn(),
        }),
      },
      markSeen: { useMutation: () => ({ mutate: mocks.markSeen }) },
    },
  },
}));
import { BackgroundWorkTray } from "./BackgroundWorkTray";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
});
it("pages results without acknowledging items that have not been displayed", async () => {
  await act(async () => {
    renderer = create(<BackgroundWorkTray />);
  });
  const sourceLinks = () =>
    renderer!.root.findAllByType("a").map((node) => node.props.href as string);
  expect(sourceLinks()).toContain("/projects/project/exams/attempts/attempt-1");
  expect(sourceLinks()).not.toContain(
    "/projects/project/exams/attempts/attempt-2",
  );
  expect(mocks.markSeen).toHaveBeenCalledTimes(1);
  expect(mocks.markSeen.mock.calls[0]![0]).toEqual({
    items: [items[0]!.acknowledgement],
  });
  await act(async () => {
    const button = renderer!.root
      .findAllByType("button")
      .find((n) => n.props["aria-label"] === "Next recent results item")!;
    (button.props as { onClick: () => void }).onClick();
  });
  expect(sourceLinks()).toContain("/projects/project/exams/attempts/attempt-2");
  expect(sourceLinks()).not.toContain(
    "/projects/project/exams/attempts/attempt-1",
  );
  expect(mocks.markSeen).toHaveBeenCalledTimes(2);
  expect(mocks.markSeen.mock.calls[1]![0]).toEqual({
    items: [items[1]!.acknowledgement],
  });
  await act(async () => {
    const button = renderer!.root
      .findAllByType("button")
      .find((n) => n.props["aria-pressed"] === false)!;
    (button.props as { onClick: () => void }).onClick();
  });
  expect(sourceLinks()).not.toContain(
    "/projects/project/exams/attempts/attempt-2",
  );
  expect(mocks.markSeen).toHaveBeenCalledTimes(2);
});

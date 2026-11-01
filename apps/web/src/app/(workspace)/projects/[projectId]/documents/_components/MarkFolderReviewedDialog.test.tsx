import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const invalidateFolderReview = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => undefined,
);
vi.mock("~/lib/documents/review-cache-invalidation", () => ({
  invalidateFolderReview: (...args: unknown[]) =>
    invalidateFolderReview(...args),
}));
const mutate = vi.fn();
let options: { onSuccess: (result: { changedDocumentCount: number }) => void };
let preview: Record<string, unknown>;
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    folder: {
      previewMarkReviewed: {
        useQuery: () => ({
          data: preview,
          isFetching: false,
          refetch: vi.fn(),
        }),
      },
      markReviewedRecursively: {
        useMutation: (given: typeof options) => {
          options = given;
          return { isPending: false, mutate };
        },
      },
    },
  },
}));

import { toast } from "sonner";
import { MarkFolderReviewedDialog } from "./MarkFolderReviewedDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const head = "a".repeat(40);
const onOpenChange = vi.fn();
function render() {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MarkFolderReviewedDialog
        projectId="p1"
        path={["notes"]}
        open
        onOpenChange={onOpenChange}
        triggerSelector="[data-trigger]"
      />,
    );
  });
  return renderer;
}
const text = (renderer: ReactTestRenderer) =>
  JSON.stringify(renderer.toJSON()).replace(/","/g, "");
const confirm = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByType("button").at(-1)!;

beforeEach(() => vi.clearAllMocks());

it("shows what will be marked and sends the previewed revision", async () => {
  preview = {
    baseProjectCommitSha: head,
    documentCount: 15,
    eligibleDocumentCount: 12,
    skippedDocumentCount: 3,
    exceedsLimits: false,
  };
  const renderer = render();
  expect(text(renderer)).toContain("12 of 15 documents will be marked");
  expect(text(renderer)).toContain("3 documents are not assigned to you");
  act(() => (confirm(renderer).props.onClick as () => void)());
  expect(mutate).toHaveBeenCalledWith({
    projectId: "p1",
    path: ["notes"],
    expectedHeadCommitSha: head,
  });
  await act(async () => options.onSuccess({ changedDocumentCount: 12 }));
  expect(invalidateFolderReview).toHaveBeenCalledWith({}, "p1");
  expect(toast.success).toHaveBeenCalledWith("Marked 12 documents as reviewed");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("offers nothing to confirm when no document is the viewer's to review", () => {
  preview = {
    baseProjectCommitSha: head,
    documentCount: 1,
    eligibleDocumentCount: 0,
    skippedDocumentCount: 1,
    exceedsLimits: false,
  };
  const renderer = render();
  expect(text(renderer)).toContain("is assigned to you for review");
  expect(confirm(renderer).props.disabled).toBe(true);
});

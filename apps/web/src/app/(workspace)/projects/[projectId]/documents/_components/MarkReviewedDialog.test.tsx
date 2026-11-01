import { useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

type Permissions =
  { canMarkReviewed: boolean; canEditReview: boolean } | undefined;
type Mocked = {
  permissions: Permissions;
  markReviewed: Mock<(input: unknown) => Promise<unknown>>;
  invalidate: Record<
    | "get"
    | "fetch"
    | "reviewPermissions"
    | "history"
    | "dueCount"
    | "listDue"
    | "listRecent",
    Mock
  >;
  onOpenChange: ((open: boolean) => void) | undefined;
  toastError: Mock;
  toastSuccess: Mock;
};

const mocked = vi.hoisted((): Mocked => ({
  permissions: { canMarkReviewed: true, canEditReview: false },
  markReviewed: vi.fn(),
  invalidate: {
    get: vi.fn(),
    fetch: vi.fn(),
    reviewPermissions: vi.fn(),
    history: vi.fn(),
    dueCount: vi.fn(),
    listDue: vi.fn(),
    listRecent: vi.fn(),
  },
  onOpenChange: undefined,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocked.toastError, success: mocked.toastSuccess },
}));
vi.mock("~/components/ui/dialog", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) => {
      mocked.onOpenChange = onOpenChange;
      return open ? <div>{children}</div> : null;
    },
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogClose: Container,
  };
});
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      document: {
        get: {
          invalidate: mocked.invalidate.get,
          fetch: mocked.invalidate.fetch,
        },
        reviewPermissions: { invalidate: mocked.invalidate.reviewPermissions },
        history: { invalidate: mocked.invalidate.history },
      },
      review: {
        dueCount: { invalidate: mocked.invalidate.dueCount },
        listDue: { invalidate: mocked.invalidate.listDue },
        listRecent: { invalidate: mocked.invalidate.listRecent },
      },
    }),
    document: {
      reviewPermissions: {
        useQuery: () => ({ data: mocked.permissions }),
      },
      markReviewed: {
        useMutation: (options: {
          onSuccess: () => void;
          onError: (err: unknown) => void;
        }) => ({
          isPending: false,
          mutate: (input: unknown) => {
            mocked.markReviewed(input).then(
              () => options.onSuccess(),
              (err: unknown) => options.onError(err),
            );
          },
        }),
      },
    },
  },
}));

import { MarkReviewedDialog } from "./MarkReviewedDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sha = "a".repeat(40);
let renderer: ReactTestRenderer;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} />
      <MarkReviewedDialog
        projectId="p1"
        documentId="d1"
        baseCommitSha={sha}
        open={open}
        onOpenChange={setOpen}
        triggerRef={{ current: null }}
      />
    </>
  );
}
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}
const dialogOpen = () =>
  JSON.stringify(renderer.toJSON()).includes("Mark this");
async function openDialog() {
  await act(async () => {
    (
      renderer.root.findAllByType("button")[0]!.props as { onClick: () => void }
    ).onClick();
  });
}
const confirmControl = () =>
  renderer.root
    .findAllByType("button")
    .filter(
      (node) =>
        node.children.includes("Mark as reviewed") ||
        node.children.includes("Saving…"),
    )
    .at(-1)!;
async function confirm() {
  await openDialog();
  const confirmButton = renderer.root
    .findAllByType("button")
    .filter(
      (node) =>
        node.children.length === 1 && node.children[0] === "Mark as reviewed",
    )
    .at(-1)!;
  await act(async () => {
    (confirmButton.props as { onClick: () => void }).onClick();
  });
}

beforeEach(() => {
  mocked.permissions = { canMarkReviewed: true, canEditReview: false };
  mocked.markReviewed.mockReset().mockResolvedValue({ headCommitSha: "b" });
  mocked.invalidate.fetch.mockReset().mockResolvedValue(undefined);
  for (const fn of [
    ...Object.values(mocked.invalidate),
    mocked.toastError,
    mocked.toastSuccess,
  ])
    fn.mockReset();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

describe("MarkReviewedDialog", () => {
  it("confirms with the base commit it was given and refreshes review data", async () => {
    await mount();
    await confirm();
    expect(mocked.markReviewed).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      expectedHeadCommitSha: sha,
    });
    expect(mocked.toastSuccess).toHaveBeenCalledWith("Marked as reviewed");
    const input = { projectId: "p1", documentId: "d1" };
    expect(mocked.invalidate.get).toHaveBeenCalledWith(input, {
      refetchType: "none",
    });
    expect(mocked.invalidate.fetch).toHaveBeenCalledWith(input);
    expect(mocked.invalidate.reviewPermissions).toHaveBeenCalledWith(input);
    expect(mocked.invalidate.history).toHaveBeenCalledWith(input);
    expect(mocked.invalidate.dueCount).toHaveBeenCalled();
    expect(mocked.invalidate.listDue).toHaveBeenCalled();
  });

  it("tells the user to reload on a CONFLICT and does not claim success", async () => {
    mocked.markReviewed.mockRejectedValue(
      Object.assign(new Error("The document changed. Reload and try again."), {
        data: { code: "CONFLICT" },
      }),
    );
    await mount();
    await confirm();
    expect(mocked.toastError).toHaveBeenCalledWith(
      "The document changed. Reload and try again.",
    );
    expect(mocked.toastSuccess).not.toHaveBeenCalled();
    expect(mocked.invalidate.dueCount).not.toHaveBeenCalled();
    expect(mocked.invalidate.get).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
    });
    expect(dialogOpen()).toBe(false);
  });

  it("opens the dialog from the trigger and closes it after success", async () => {
    await mount();
    expect(dialogOpen()).toBe(false);
    await openDialog();
    expect(dialogOpen()).toBe(true);
    await confirm();
    expect(dialogOpen()).toBe(false);
  });

  it("keeps the dialog open and busy until the refreshed document arrives", async () => {
    let finish!: () => void;
    mocked.invalidate.fetch.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    await confirm();
    expect(mocked.markReviewed).toHaveBeenCalledTimes(1);
    expect(dialogOpen()).toBe(true);
    expect(confirmControl().props.disabled).toBe(true);
    expect(mocked.toastSuccess).not.toHaveBeenCalled();
    await act(async () => mocked.onOpenChange?.(false));
    expect(dialogOpen()).toBe(true);
    await act(async () => {
      finish();
    });
    expect(dialogOpen()).toBe(false);
    expect(mocked.toastSuccess).toHaveBeenCalledWith("Marked as reviewed");
    expect(mocked.toastError).not.toHaveBeenCalled();
  });

  it("closes and asks for a reload when the refresh fails", async () => {
    mocked.invalidate.fetch.mockRejectedValue(new Error("offline"));
    await mount();
    await confirm();
    expect(dialogOpen()).toBe(false);
    expect(mocked.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Reload the page before editing"),
    );
    expect(mocked.toastSuccess).toHaveBeenCalledWith("Marked as reviewed");
  });

  it("reports other failures with the server message", async () => {
    mocked.markReviewed.mockRejectedValue(
      Object.assign(new Error("boom"), { data: { code: "FORBIDDEN" } }),
    );
    await mount();
    await confirm();
    expect(mocked.toastError).toHaveBeenCalledWith("boom");
  });
});

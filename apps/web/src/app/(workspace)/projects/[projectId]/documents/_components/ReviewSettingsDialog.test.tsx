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
type QueryState = { data: unknown[]; error: unknown; isLoading: boolean };
type Mocked = {
  permissions: Permissions;
  groups: QueryState;
  members: QueryState;
  setReview: Mock<(input: unknown) => Promise<unknown>>;
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
  defaults: { data: unknown; error: unknown; isLoading: boolean };
  onOpenChange: ((open: boolean) => void) | undefined;
  toastError: Mock;
  toastSuccess: Mock;
};

const mocked = vi.hoisted((): Mocked => ({
  permissions: { canMarkReviewed: false, canEditReview: true },
  groups: { data: [], error: null, isLoading: false },
  members: { data: [], error: null, isLoading: false },
  setReview: vi.fn(),
  invalidate: {
    get: vi.fn(),
    fetch: vi.fn(),
    reviewPermissions: vi.fn(),
    history: vi.fn(),
    dueCount: vi.fn(),
    listDue: vi.fn(),
    listRecent: vi.fn(),
  },
  defaults: { data: undefined, error: null, isLoading: false },
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
    reviewerGroup: {
      list: { useQuery: () => mocked.groups },
      getDefaults: { useQuery: () => mocked.defaults },
    },
    projectMember: { list: { useQuery: () => mocked.members } },
    document: {
      reviewPermissions: { useQuery: () => ({ data: mocked.permissions }) },
      setReview: {
        useMutation: (options: {
          onMutate?: () => void;
          onSettled?: () => void;
          onSuccess: () => void;
          onError: (err: unknown) => void;
        }) => ({
          isPending: false,
          mutate: (input: unknown) => {
            options.onMutate?.();
            void mocked.setReview(input).then(
              () => {
                options.onSettled?.();
                options.onSuccess();
              },
              (err: unknown) => {
                options.onSettled?.();
                options.onError(err);
              },
            );
          },
        }),
      },
    },
  },
}));

import { ReviewerPicker } from "~/components/review/ReviewerPicker";
import { ReviewSettingsDialog } from "./ReviewSettingsDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sha = "a".repeat(40);
const ada = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";
const gone = "99999999-9999-9999-9999-999999999999";
const legal = "33333333-3333-3333-3333-333333333333";

const baseDocument = {
  id: "d1",
  baseCommitSha: "b".repeat(40),
  review: {
    reviewers: [
      { type: "user" as const, id: ada, name: "Ada", resolved: true },
    ],
    everyMonths: 12,
    since: new Date("2025-01-01T00:00:00Z"),
    lastReviewedAt: null,
    reviewedBy: null,
    dueAt: new Date("2026-01-01T00:00:00Z"),
  },
};

const withGone = () => ({
  ...baseDocument.review,
  reviewers: [
    ...baseDocument.review.reviewers,
    { type: "user" as const, id: gone, name: "Zed", resolved: false },
  ],
});

const trpcError = (message: string, code: string, field?: string) =>
  Object.assign(new Error(message), { data: { code, field } });

let renderer: ReactTestRenderer;
const nodes = new Map<string, { name: string; value: string }>();

function Harness({ document }: { document: never }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} />
      <ReviewSettingsDialog
        projectId="p1"
        document={document}
        baseCommitSha={sha}
        open={open}
        onOpenChange={setOpen}
        triggerRef={{ current: null }}
      />
    </>
  );
}
async function mount(
  overrides: Partial<{ review: unknown; open: boolean }> = {},
) {
  const { open = true, ...rest } = overrides;
  await act(async () => {
    renderer = create(
      <Harness document={{ ...baseDocument, ...rest } as never} />,
      {
        createNodeMock: ({ type, props }) => {
          if (type !== "input") return {};
          const { name = "", type: inputType } = props as {
            name?: string;
            type?: string;
          };
          const node = {
            name,
            type: inputType,
            value: "",
            focus: vi.fn(),
          };
          nodes.set(name, node);
          return node;
        },
      },
    );
  });
  if (open) await openDialog();
}
async function openDialog() {
  await act(async () => {
    (
      renderer.root.findAllByType("button")[0]!.props as { onClick: () => void }
    ).onClick();
  });
}
const dialogOpen = () => text().includes("Who reviews this document");
const saveButton = () =>
  renderer.root
    .findAllByType("button")
    .find((node) => node.props.type === "submit")!;
async function setMonths(value: number) {
  const node = nodes.get("everyMonths")!;
  node.value = String(value);
  await act(async () => {
    await (
      renderer.root.findByProps({ name: "everyMonths" }).props.onChange as (
        e: unknown,
      ) => unknown
    )({ type: "change", target: node });
  });
}
async function setReviewers(targets: { type: "user" | "group"; id: string }[]) {
  await act(async () => {
    (
      renderer.root.findByType(ReviewerPicker).props as {
        onChange: (next: typeof targets) => void;
      }
    ).onChange(targets);
  });
}
async function submit() {
  await act(async () => {
    await (
      renderer.root.findByType("form").props.onSubmit as (e: unknown) => unknown
    )({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}
const text = () => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  mocked.permissions = { canMarkReviewed: false, canEditReview: true };
  mocked.groups = {
    data: [{ id: legal, name: "Legal", members: [{ userId: ada }] }],
    error: null,
    isLoading: false,
  };
  mocked.members = {
    data: [
      { userId: ada, email: "ada@example.test", user: { name: "Ada" } },
      { userId: bob, email: "bob@example.test", user: { name: "Bob" } },
    ],
    error: null,
    isLoading: false,
  };
  mocked.setReview.mockReset().mockResolvedValue({ headCommitSha: "b" });
  mocked.invalidate.fetch.mockReset().mockResolvedValue(undefined);
  mocked.defaults = { data: undefined, error: null, isLoading: false };
  for (const fn of [
    ...Object.values(mocked.invalidate),
    mocked.toastError,
    mocked.toastSuccess,
  ])
    fn.mockReset();
  nodes.clear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

describe("ReviewSettingsDialog", () => {
  it("sends only the interval when only the interval changed", async () => {
    await mount();
    await setMonths(6);
    await submit();
    expect(mocked.setReview).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      expectedHeadCommitSha: sha,
      everyMonths: 6,
    });
    expect(mocked.toastSuccess).toHaveBeenCalledWith("Review settings saved");
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

  it("sends only the reviewers when only the reviewers changed", async () => {
    await mount();
    await setReviewers([
      { type: "user", id: ada },
      { type: "group", id: legal },
    ]);
    await submit();
    expect(mocked.setReview).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      expectedHeadCommitSha: sha,
      reviewers: [
        { type: "user", id: ada },
        { type: "group", id: legal },
      ],
    });
  });

  it("drops reviewers that are no longer selectable before sending", async () => {
    await mount();
    await setReviewers([
      { type: "user", id: bob },
      { type: "user", id: gone },
    ]);
    await submit();
    expect(mocked.setReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: [{ type: "user", id: bob }] }),
    );
  });

  it("closes without a call when nothing changed", async () => {
    await mount();
    await submit();
    expect(mocked.setReview).not.toHaveBeenCalled();
    expect(mocked.toastSuccess).not.toHaveBeenCalled();
    expect(mocked.invalidate.get).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(false);
  });

  it("opens from the trigger and closes after a successful save", async () => {
    await mount({ open: false });
    expect(dialogOpen()).toBe(false);
    await openDialog();
    expect(dialogOpen()).toBe(true);
    await setMonths(6);
    await submit();
    expect(dialogOpen()).toBe(false);
  });

  it("stays open and busy until the refreshed document arrives", async () => {
    let finish!: () => void;
    mocked.invalidate.fetch.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    await setMonths(6);
    await submit();
    expect(mocked.setReview).toHaveBeenCalledTimes(1);
    expect(dialogOpen()).toBe(true);
    expect(saveButton().props.disabled).toBe(true);
    expect(mocked.toastSuccess).not.toHaveBeenCalled();
    await act(async () => mocked.onOpenChange?.(false));
    expect(dialogOpen()).toBe(true);
    await act(async () => {
      finish();
    });
    expect(dialogOpen()).toBe(false);
    expect(mocked.toastSuccess).toHaveBeenCalledWith("Review settings saved");
  });

  it("closes and asks for a reload when the refresh fails", async () => {
    mocked.invalidate.fetch.mockRejectedValue(new Error("offline"));
    await mount();
    await setMonths(6);
    await submit();
    expect(dialogOpen()).toBe(false);
    expect(mocked.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Reload the page before editing"),
    );
  });

  it("shows the removal note only while unresolved reviewers are listed", async () => {
    const note = "are removed when you save a change to the reviewers";
    await mount();
    expect(text()).not.toContain(note);
    await act(async () => renderer.unmount());
    await mount({ review: withGone() });
    expect(text()).toContain(note);
    await act(async () => {
      (
        renderer.root.findByType(ReviewerPicker).props as {
          onRemoveUnresolved: (id: string) => void;
        }
      ).onRemoveUnresolved(gone);
    });
    expect(text()).not.toContain(note);
  });

  it("keeps unresolved reviewers on an interval-only save", async () => {
    await mount({ review: withGone() });
    await setMonths(6);
    await submit();
    expect(mocked.setReview.mock.calls[0]![0]).not.toHaveProperty("reviewers");
  });

  it("sends only resolved targets when a reviewer is added next to unresolved ones", async () => {
    await mount({ review: withGone() });
    await setReviewers([
      { type: "user", id: ada },
      { type: "user", id: bob },
    ]);
    await submit();
    expect(mocked.setReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewers: [
          { type: "user", id: ada },
          { type: "user", id: bob },
        ],
      }),
    );
  });

  it("does not send an untouched reviewers field that holds a resolved reviewer missing from the options", async () => {
    await mount({
      review: {
        ...baseDocument.review,
        reviewers: [{ type: "user", id: gone, name: "Zed", resolved: true }],
      },
    });
    await setMonths(6);
    await submit();
    expect(mocked.setReview.mock.calls[0]![0]).not.toHaveProperty("reviewers");
  });

  it("initialises a null review from the project defaults and sends both fields", async () => {
    mocked.defaults = {
      data: {
        everyMonths: 3,
        reviewers: [{ type: "user", id: bob }],
        canManage: false,
      },
      error: null,
      isLoading: false,
    };
    await mount({ review: null });
    expect(
      (renderer.root.findByType(ReviewerPicker).props as { value: unknown })
        .value,
    ).toEqual([{ type: "user", id: bob }]);
    await submit();
    expect(mocked.setReview).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      expectedHeadCommitSha: sha,
      reviewers: [{ type: "user", id: bob }],
      everyMonths: 3,
    });
  });

  it("shows a loading state while the defaults load for a null review", async () => {
    await mount({ review: null });
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
  });

  it("shows an error with retry when the defaults fail to load", async () => {
    mocked.defaults = {
      data: undefined,
      error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      isLoading: false,
    };
    await mount({ review: null });
    expect(text()).toContain("Could not load");
    expect(text()).toContain("Retry");
  });

  it("shows an error toast for a server error not tied to a field", async () => {
    mocked.setReview.mockRejectedValue(trpcError("Nope", "FORBIDDEN", "other"));
    await mount();
    await setMonths(6);
    await submit();
    expect(mocked.toastError).toHaveBeenCalledWith("Nope");
    expect(dialogOpen()).toBe(true);
  });

  it("treats removing an unresolved reviewer as a reviewers change", async () => {
    await mount({
      review: {
        ...baseDocument.review,
        reviewers: [
          ...baseDocument.review.reviewers,
          { type: "user", id: gone, name: "Zed", resolved: false },
        ],
      },
    });
    expect(text()).toContain("no longer in this project");
    await act(async () => {
      (
        renderer.root.findByType(ReviewerPicker).props as {
          onRemoveUnresolved: (id: string) => void;
        }
      ).onRemoveUnresolved(gone);
    });
    await submit();
    expect(mocked.setReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: [{ type: "user", id: ada }] }),
    );
    expect(mocked.setReview.mock.calls[0]![0]).not.toHaveProperty(
      "everyMonths",
    );
  });

  it("pins a reviewers error to the picker and stays open", async () => {
    mocked.setReview.mockRejectedValue(
      trpcError("Not a project member", "BAD_REQUEST", "reviewers"),
    );
    await mount();
    await setReviewers([{ type: "user", id: bob }]);
    await submit();
    expect(text()).toContain("Not a project member");
    expect(mocked.toastSuccess).not.toHaveBeenCalled();
    expect(mocked.toastError).not.toHaveBeenCalled();
  });

  it("pins an interval error to the interval field", async () => {
    mocked.setReview.mockRejectedValue(
      trpcError(
        "Review interval must be 1 to 120 months",
        "BAD_REQUEST",
        "everyMonths",
      ),
    );
    await mount();
    await setMonths(6);
    await submit();
    expect(text()).toContain("Review interval must be 1 to 120 months");
    expect(mocked.toastError).not.toHaveBeenCalled();
  });

  it("tells the user to reload on a stale head", async () => {
    mocked.setReview.mockRejectedValue(
      trpcError("The document changed. Reload and try again.", "CONFLICT"),
    );
    await mount();
    await setMonths(6);
    await submit();
    expect(mocked.toastError).toHaveBeenCalledWith(
      "The document changed. Reload and try again.",
    );
    expect(mocked.toastSuccess).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range interval before calling the server", async () => {
    await mount();
    await setMonths(0);
    await submit();
    expect(mocked.setReview).not.toHaveBeenCalled();
    expect(text()).toContain("Use at least 1 month");
  });
});

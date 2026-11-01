import {
  type QueryClient,
  QueryClientProvider,
  QueryObserver,
  useQuery,
} from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
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

import { createQueryClient } from "~/trpc/query-client";
import type { RouterInputs, RouterOutputs } from "~/trpc/react";

type Defaults = RouterOutputs["folder"]["reviewDefaults"];
type Preflight = RouterOutputs["folder"]["previewReview"];
type MockQuery<T> = {
  data: T | undefined;
  error: unknown;
  isFetching: boolean;
  refetch: Mock<() => Promise<unknown>>;
};
type Mocked = {
  defaults: MockQuery<Defaults>;
  members: MockQuery<
    { userId: string; user: { name: string }; email: string }[]
  >;
  groups: MockQuery<[]>;
  preview: Mock<
    (input: RouterInputs["folder"]["previewReview"]) => Promise<Preflight>
  >;
  apply: Mock<
    (input: RouterInputs["folder"]["setReviewRecursively"]) => Promise<unknown>
  >;
  clear: Mock<
    (input: RouterInputs["folder"]["clearReviewDefault"]) => Promise<unknown>
  >;
  cancel: Mock;
  invalidate: Mock;
  closeGuard: ((open: boolean) => void) | undefined;
};
const mocks = vi.hoisted((): Mocked => ({
  defaults: {
    data: {
      configuredReviewers: [{ type: "user", id: "u1", name: "One" }],
      reviewers: [{ type: "user", id: "u1", name: "One" }],
      inheritedFrom: ["parent"],
      hasOwnDefault: false,
      canManage: true,
      baseProjectCommitSha: "read-head",
    },
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  },
  members: {
    data: [
      { userId: "u1", user: { name: "One" }, email: "one@test" },
      { userId: "u2", user: { name: "Two" }, email: "two@test" },
    ],
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  },
  groups: { data: [], error: null, isFetching: false, refetch: vi.fn() },
  preview: vi.fn(),
  apply: vi.fn(),
  clear: vi.fn(),
  cancel: vi.fn(),
  invalidate: vi.fn(),
  closeGuard: undefined,
}));

vi.mock("~/components/ui/dialog", () => {
  const Container = ({ children, ...props }: { children?: ReactNode }) => (
    <div {...props}>{children}</div>
  );
  return {
    Dialog: ({
      children,
      open,
      onOpenChange,
    }: {
      children: ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => {
      mocks.closeGuard = onOpenChange;
      return open ? <>{children}</> : null;
    },
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogFooter: Container,
  };
});
vi.mock("~/lib/documents/review-cache-invalidation", () => ({
  invalidateFolderReview: mocks.invalidate,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ folder: { previewReview: { cancel: mocks.cancel } } }),
    folder: {
      reviewDefaults: { useQuery: () => mocks.defaults },
      previewReview: {
        useQuery: (
          input: RouterInputs["folder"]["previewReview"],
          options: {
            enabled: boolean;
            staleTime?: number;
            refetchOnMount?: "always";
          },
        ) =>
          useQuery({
            ...options,
            queryKey: ["preview", input],
            queryFn: () => mocks.preview(input),
            enabled: options.enabled,
            retry: false,
          }),
      },
      setReviewRecursively: {
        useMutation: () => ({ mutateAsync: mocks.apply }),
      },
      clearReviewDefault: { useMutation: () => ({ mutateAsync: mocks.clear }) },
    },
    projectMember: { list: { useQuery: () => mocks.members } },
    reviewerGroup: { list: { useQuery: () => mocks.groups } },
  },
}));

import { FolderReviewDialog } from "./FolderReviewDialog";
import { ReviewerPicker } from "~/components/review/ReviewerPicker";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
let client: QueryClient;
const onClose = vi.fn();
const counts = {
  baseProjectCommitSha: "preview-head",
  documentCount: 8,
  changedDocumentCount: 5,
  descendantDefaultOverrideCount: 2,
  rewrittenBytes: 2048,
  exceedsLimits: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function render() {
  client = createQueryClient();
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <FolderReviewDialog
          projectId="p1"
          path={["parent", "child"]}
          open
          onOpenChange={onClose}
        />
      </QueryClientProvider>,
    );
  });
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
const text = () => {
  const flatten = (value: unknown): string => {
    if (typeof value === "string" || typeof value === "number")
      return String(value);
    if (Array.isArray(value)) return value.map(flatten).join("");
    if (value && typeof value === "object" && "children" in value)
      return flatten(value.children);
    return "";
  };
  return flatten(renderer.toJSON());
};
const button = (label: string) =>
  renderer.root
    .findAllByType("button")
    .find(
      (node) =>
        node.children
          .filter((child): child is string => typeof child === "string")
          .join("") === label,
    )!;
async function apply() {
  await act(async () => {
    await (
      renderer.root.findByType("form").props.onSubmit as (event: {
        preventDefault: () => void;
        persist: () => void;
      }) => Promise<void>
    )({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}
const picker = () =>
  renderer.root.findByType(ReviewerPicker).props as ComponentProps<
    typeof ReviewerPicker
  >;
const click = (label: string) => (button(label).props.onClick as () => void)();
function defaults(patch: Partial<Defaults>) {
  if (!mocks.defaults.data) throw new Error("Missing defaults fixture");
  mocks.defaults.data = { ...mocks.defaults.data, ...patch };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.defaults.data = {
    configuredReviewers: [{ type: "user", id: "u1", name: "One" }],
    reviewers: [{ type: "user", id: "u1", name: "One" }],
    inheritedFrom: ["parent"],
    hasOwnDefault: false,
    canManage: true,
    baseProjectCommitSha: "read-head",
  };
  mocks.defaults.error = null;
  mocks.defaults.isFetching = false;
  mocks.members.error = null;
  mocks.preview.mockResolvedValue(counts);
  mocks.apply.mockResolvedValue({});
  mocks.clear.mockResolvedValue({});
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.defaults.refetch.mockResolvedValue({});
  mocks.members.refetch.mockResolvedValue({});
  mocks.groups.refetch.mockResolvedValue({});
});
afterEach(() => {
  act(() => renderer?.unmount());
  client?.clear();
});

describe("folder reviewer dialog", () => {
  it("dialog_shows_preview_counts_and_uses_its_head", async () => {
    await render();
    await settle();
    expect(text()).toContain("8 documents");
    expect(text()).toContain("5 documents will change");
    expect(text()).toContain("2 descendant defaults");
    expect(text()).toContain("parent");
    expect(button("Apply").props.disabled).toBe(false);
    await apply();
    expect(mocks.apply).toHaveBeenCalledWith({
      projectId: "p1",
      path: ["parent", "child"],
      reviewers: [{ type: "user", id: "u1" }],
      expectedHeadCommitSha: "preview-head",
    });
    expect(mocks.invalidate).toHaveBeenCalledWith(expect.anything(), "p1");
    expect(onClose).toHaveBeenCalledWith(false);
  });
  it("changed_selection_refreshes_preflight", async () => {
    await render();
    await settle();
    const next = deferred<typeof counts>();
    mocks.preview.mockReturnValueOnce(next.promise);
    await act(async () => picker().onChange([{ type: "user", id: "u2" }]));
    expect(button("Apply").props.disabled).toBe(true);
    expect(mocks.preview).toHaveBeenLastCalledWith({
      projectId: "p1",
      path: ["parent", "child"],
      reviewers: [{ type: "user", id: "u2" }],
    });
    expect(mocks.cancel).toHaveBeenCalled();
    await act(async () =>
      next.resolve({ ...counts, baseProjectCommitSha: "next-head" }),
    );
    await settle();
    await apply();
    expect(mocks.apply.mock.calls[0]?.[0].expectedHeadCommitSha).toBe(
      "next-head",
    );
  });
  it("does not allow obsolete preview results to enable Apply", async () => {
    const old = deferred<typeof counts>();
    mocks.preview.mockReturnValueOnce(old.promise);
    await render();
    const next = deferred<typeof counts>();
    mocks.preview.mockReturnValueOnce(next.promise);
    await act(async () => picker().onChange([{ type: "user", id: "u2" }]));
    await act(async () => old.resolve(counts));
    await settle();
    expect(button("Apply").props.disabled).toBe(true);
    expect(text()).not.toContain("5 documents will change");
    await act(async () => next.resolve({ ...counts, changedDocumentCount: 7 }));
    await settle();
    expect(button("Apply").props.disabled).toBe(false);
  });
  it("oversized_or_loading_preview_disables_apply", async () => {
    const pending = deferred<typeof counts>();
    mocks.preview.mockReturnValue(pending.promise);
    await render();
    expect(button("Apply").props.disabled).toBe(true);
    await act(async () => pending.resolve({ ...counts, exceedsLimits: true }));
    await settle();
    expect(button("Apply").props.disabled).toBe(true);
    expect(text()).toContain("1,000");
    expect(text()).toContain("50 MiB");
    await apply();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("stale_error_keeps_dialog_open_without_auto_replaying", async () => {
    mocks.apply.mockRejectedValue(
      Object.assign(new Error("stale"), { data: { code: "CONFLICT" } }),
    );
    await render();
    await settle();
    await apply();
    expect(onClose).not.toHaveBeenCalled();
    expect(text()).toContain("changed");
    expect(button("Apply").props.disabled).toBe(true);
    mocks.preview.mockResolvedValue({
      ...counts,
      baseProjectCommitSha: "refreshed-head",
    });
    await act(async () => click("Refresh preview"));
    await settle();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(button("Apply").props.disabled).toBe(false);
    expect(picker().value).toEqual([{ type: "user", id: "u1" }]);
  });
  it("uses explicit empty defaults instead of effective Owner refs", async () => {
    defaults({
      configuredReviewers: [],
      reviewers: [{ type: "user", id: "u1", name: "Owner" }],
      inheritedFrom: [],
    });
    await render();
    await settle();
    expect(picker().value).toEqual([]);
    expect(text()).toContain("document root");
    expect(text()).toContain("Owner");
    await apply();
    expect(mocks.apply.mock.calls[0]?.[0].reviewers).toEqual([]);
  });
  it("preserves explicit Owner refs and displays project inheritance", async () => {
    defaults({ inheritedFrom: null });
    await render();
    await settle();
    expect(text()).toContain("Project default");
    expect(picker().value).toEqual([{ type: "user", id: "u1" }]);
  });
  it("shows own defaults and clears only them with the defaults read HEAD", async () => {
    defaults({ hasOwnDefault: true, inheritedFrom: ["parent", "child"] });
    await render();
    await settle();
    expect(text()).toContain("This folder");
    expect(text()).toContain("Existing documents keep their reviewers");
    await act(async () => click("Use parent default"));
    expect(mocks.clear).toHaveBeenCalledWith({
      projectId: "p1",
      path: ["parent", "child"],
      expectedHeadCommitSha: "read-head",
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("allows unresolved targets to be removed without silently pruning", async () => {
    defaults({
      configuredReviewers: [
        { type: "user", id: "gone", name: "Former member" },
      ],
    });
    await render();
    await settle();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(button("Apply").props.disabled).toBe(true);
    expect(text()).toContain("Former member");
    await act(async () =>
      (
        renderer.root.findByProps({ "aria-label": "Remove Former member" })
          .props.onClick as () => void
      )(),
    );
    await settle();
    expect(picker().value).toEqual([]);
    expect(mocks.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewers: [] }),
    );
  });
  it("live canManage demotion disables writes in an already open dialog", async () => {
    defaults({ hasOwnDefault: true });
    await render();
    await settle();
    defaults({ canManage: false });
    await act(async () =>
      renderer.update(
        <QueryClientProvider client={client}>
          <FolderReviewDialog
            projectId="p1"
            path={["parent", "child"]}
            open
            onOpenChange={onClose}
          />
        </QueryClientProvider>,
      ),
    );
    expect(button("Apply").props.disabled).toBe(true);
    expect(button("Use parent default").props.disabled).toBe(true);
    await apply();
    await act(async () => click("Use parent default"));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it("guards close and all writes while pending through refresh", async () => {
    const pending = deferred<unknown>();
    mocks.apply.mockReturnValue(pending.promise);
    await render();
    await settle();
    await apply();
    expect(
      renderer.root.findAllByProps({ "aria-busy": true }),
    ).not.toHaveLength(0);
    act(() => mocks.closeGuard?.(false));
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Cancel").props.disabled).toBe(true);
    await act(async () => pending.resolve({}));
    expect(onClose).toHaveBeenCalledWith(false);
  });
  it("field pinned errors remain inline and require no automatic replay", async () => {
    mocks.apply.mockRejectedValue(
      Object.assign(new Error("Reviewer removed"), {
        data: { field: "reviewers", code: "BAD_REQUEST" },
      }),
    );
    await render();
    await settle();
    await apply();
    expect(text()).toContain("Reviewer removed");
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("preview failure provides retry and disables Apply", async () => {
    mocks.preview.mockRejectedValue(new Error("failed"));
    await render();
    await settle();
    expect(button("Apply").props.disabled).toBe(true);
    expect(text()).toContain("Could not preview");
    expect(button("Refresh preview")).toBeTruthy();
  });
  it("loading and access error branches keep the same close-focus handler", async () => {
    mocks.defaults.data = undefined;
    await render();
    expect(text()).toContain("Loading");
    let content = renderer.root.findAll(
      (node) => typeof node.props.onCloseAutoFocus === "function",
    )[0]!;
    const focusHandler = content.props.onCloseAutoFocus as (
      event: Event,
    ) => void;
    mocks.defaults.error = { data: { code: "FORBIDDEN" } };
    await act(async () =>
      renderer.update(
        <QueryClientProvider client={client}>
          <FolderReviewDialog
            projectId="p1"
            path={["parent", "child"]}
            open
            onOpenChange={onClose}
          />
        </QueryClientProvider>,
      ),
    );
    expect(text()).toContain("Could not load");
    content = renderer.root.findAll(
      (node) => typeof node.props.onCloseAutoFocus === "function",
    )[0]!;
    expect(content.props.onCloseAutoFocus).toBe(focusHandler);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

it("adopts refreshed configured defaults while preserving a changed selection", async () => {
  await render();
  await settle();
  defaults({ configuredReviewers: [{ type: "user", id: "u2", name: "Two" }] });
  await act(async () =>
    renderer.update(
      <QueryClientProvider client={client}>
        <FolderReviewDialog
          projectId="p1"
          path={["parent", "child"]}
          open
          onOpenChange={onClose}
        />
      </QueryClientProvider>,
    ),
  );
  expect(picker().value).toEqual([{ type: "user", id: "u2" }]);
  await act(async () => picker().onChange([]));
  defaults({ configuredReviewers: [{ type: "user", id: "u1", name: "One" }] });
  await act(async () =>
    renderer.update(
      <QueryClientProvider client={client}>
        <FolderReviewDialog
          projectId="p1"
          path={["parent", "child"]}
          open
          onOpenChange={onClose}
        />
      </QueryClientProvider>,
    ),
  );
  expect(picker().value).toEqual([]);
});

it("keeps the dialog pending until successful cache refresh completes", async () => {
  const refreshed = deferred<unknown>();
  mocks.invalidate.mockReturnValue(refreshed.promise);
  await render();
  await settle();
  await apply();
  expect(onClose).not.toHaveBeenCalled();
  expect(button("Cancel").props.disabled).toBe(true);
  await act(async () => refreshed.resolve(undefined));
  expect(onClose).toHaveBeenCalledWith(false);
});

it.each(["assignment", "clear"] as const)(
  "recovers canonical caches after accepted %s without permitting another write",
  async (operation) => {
    defaults({ hasOwnDefault: true });
    mocks.invalidate.mockRejectedValue(new Error("refresh failed"));
    await render();
    await settle();
    if (operation === "assignment") {
      await act(async () => picker().onChange([]));
      await settle();
      await apply();
    } else await act(async () => click("Use parent default"));
    expect(onClose).not.toHaveBeenCalled();
    expect(text()).toContain("saved, but refresh failed");
    expect(button("Apply").props.disabled).toBe(true);
    defaults({
      configuredReviewers: [{ type: "user", id: "u2", name: "Two" }],
      reviewers: [{ type: "user", id: "u2", name: "Two" }],
      baseProjectCommitSha: "another-maintainer-head",
    });
    mocks.preview.mockResolvedValue({
      ...counts,
      baseProjectCommitSha: "another-maintainer-head",
    });
    await act(async () =>
      renderer.update(
        <QueryClientProvider client={client}>
          <FolderReviewDialog
            projectId="p1"
            path={["parent", "child"]}
            open
            onOpenChange={onClose}
          />
        </QueryClientProvider>,
      ),
    );
    await act(async () => click("Refresh preview"));
    await settle();
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    expect(text()).toContain("saved, but refresh failed");
    expect(button("Apply").props.disabled).toBe(true);
    expect(button("Use parent default").props.disabled).toBe(true);
    await apply();
    await act(async () => click("Use parent default"));
    expect(mocks.apply).toHaveBeenCalledTimes(
      operation === "assignment" ? 1 : 0,
    );
    expect(mocks.clear).toHaveBeenCalledTimes(operation === "clear" ? 1 : 0);
    const recovered = deferred<unknown>();
    mocks.invalidate.mockReturnValueOnce(recovered.promise);
    await act(async () => click("Refresh preview"));
    expect(text()).toContain("saved, but refresh failed");
    expect(button("Cancel").props.disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledTimes(3);
    await act(async () => recovered.resolve(undefined));
    expect(onClose).toHaveBeenCalledWith(false);
    await apply();
    await act(async () => click("Use parent default"));
    expect(mocks.apply).toHaveBeenCalledTimes(
      operation === "assignment" ? 1 : 0,
    );
    expect(mocks.clear).toHaveBeenCalledTimes(operation === "clear" ? 1 : 0);
  },
);

it("clear conflict remains open and rechecks the refreshed defaults HEAD", async () => {
  defaults({ hasOwnDefault: true });
  mocks.clear.mockRejectedValueOnce(
    Object.assign(new Error("stale"), { data: { code: "CONFLICT" } }),
  );
  await render();
  await settle();
  await act(async () => click("Use parent default"));
  expect(onClose).not.toHaveBeenCalled();
  expect(button("Use parent default").props.disabled).toBe(true);
  defaults({ baseProjectCommitSha: "refreshed-defaults-head" });
  await act(async () =>
    renderer.update(
      <QueryClientProvider client={client}>
        <FolderReviewDialog
          projectId="p1"
          path={["parent", "child"]}
          open
          onOpenChange={onClose}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => click("Refresh preview"));
  await settle();
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  await act(async () => click("Use parent default"));
  expect(mocks.clear).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedHeadCommitSha: "refreshed-defaults-head",
    }),
  );
});

it("read-only defaults allow preview while disabling writes", async () => {
  defaults({ canManage: false, hasOwnDefault: true });
  await render();
  await settle();
  expect(mocks.preview).toHaveBeenCalled();
  expect(text()).toContain("8 documents");
  expect(button("Apply").props.disabled).toBe(true);
  expect(button("Use parent default").props.disabled).toBe(true);
});

it("routes close focus to a connected workspace when the menu trigger is removed", async () => {
  const trigger = { isConnected: true, disabled: false, focus: vi.fn() };
  const fallback = { isConnected: true, focus: vi.fn() };
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector.startsWith("[data-review-trigger") ? trigger : fallback,
  });
  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  try {
    await render();
    const content = renderer.root.findAll(
      (node) => typeof node.props.onCloseAutoFocus === "function",
    )[0]!;
    const restore = content.props.onCloseAutoFocus as (event: {
      preventDefault: () => void;
    }) => void;
    const preventDefault = vi.fn();
    restore({ preventDefault });
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    trigger.isConnected = false;
    restore({ preventDefault });
    expect(fallback.focus).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("revisiting a cached selection runs preflight with the production query defaults", async () => {
  mocks.preview
    .mockResolvedValueOnce({ ...counts, baseProjectCommitSha: "A-old-head" })
    .mockResolvedValueOnce({ ...counts, baseProjectCommitSha: "B-head" });
  await render();
  await settle();
  expect(client.getDefaultOptions().queries?.staleTime).toBe(30_000);
  const cachedA = new QueryObserver(client, {
    queryKey: [
      "preview",
      {
        projectId: "p1",
        path: ["parent", "child"],
        reviewers: [{ type: "user", id: "u1" }],
      },
    ],
    queryFn: () =>
      mocks.preview({
        projectId: "p1",
        path: ["parent", "child"],
        reviewers: [{ type: "user", id: "u1" }],
      }),
  });
  expect(cachedA.getCurrentResult().data?.baseProjectCommitSha).toBe(
    "A-old-head",
  );
  await act(async () => picker().onChange([{ type: "user", id: "u2" }]));
  await settle();
  const freshA = deferred<Preflight>();
  mocks.preview.mockReturnValueOnce(freshA.promise);
  await act(async () => picker().onChange([{ type: "user", id: "u1" }]));
  expect(button("Apply").props.disabled).toBe(true);
  expect(text()).not.toContain("5 documents will change");
  expect(mocks.preview).toHaveBeenCalledTimes(3);
  await act(async () =>
    freshA.resolve({
      ...counts,
      baseProjectCommitSha: "A-current-head",
      changedDocumentCount: 6,
    }),
  );
  await settle();
  expect(text()).toContain("6 documents will change");
  await apply();
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({ expectedHeadCommitSha: "A-current-head" }),
  );
  cachedA.destroy();
});

it("retains accepted-write recovery across the defaults access-error branch", async () => {
  defaults({ hasOwnDefault: true });
  mocks.invalidate.mockRejectedValue(new Error("refresh failed"));
  await render();
  await settle();
  await apply();
  mocks.defaults.error = { data: { code: "FORBIDDEN" } };
  await act(async () =>
    renderer.update(
      <QueryClientProvider client={client}>
        <FolderReviewDialog
          projectId="p1"
          path={["parent", "child"]}
          open
          onOpenChange={onClose}
        />
      </QueryClientProvider>,
    ),
  );
  expect(text()).toContain("saved, but refresh failed");
  mocks.defaults.error = null;
  await act(async () =>
    renderer.update(
      <QueryClientProvider client={client}>
        <FolderReviewDialog
          projectId="p1"
          path={["parent", "child"]}
          open
          onOpenChange={onClose}
        />
      </QueryClientProvider>,
    ),
  );
  await settle();
  expect(button("Apply").props.disabled).toBe(true);
  expect(button("Use parent default").props.disabled).toBe(true);
  await apply();
  await act(async () => click("Use parent default"));
  expect(mocks.apply).toHaveBeenCalledTimes(1);
  expect(mocks.clear).not.toHaveBeenCalled();
  await act(async () => click("Refresh preview"));
  expect(mocks.invalidate).toHaveBeenCalledTimes(2);
  expect(text()).toContain("saved, but refresh failed");
});

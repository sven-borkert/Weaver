import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryState = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  isFetching: boolean;
};

const mocked = vi.hoisted(() => {
  const ready = (data: unknown): QueryState => ({
    data,
    error: null,
    isLoading: false,
    isFetching: false,
  });
  return {
    ready,
    defaults: ready(undefined),
    groups: ready(undefined),
    members: ready(undefined),
    setDefaults: vi.fn(),
    removeGroup: vi.fn(),
    setDefaultsError: null as { message: string; data: object } | null,
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("~/components/ui/dialog", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogClose: Container,
  };
});

vi.mock("~/trpc/react", () => {
  const query = (key: "defaults" | "groups" | "members") => ({
    useQuery: () => ({ ...mocked[key], refetch: vi.fn() }),
  });
  const defaultsMutation = {
    useMutation: (options: { onError: (err: unknown) => void }) => ({
      isPending: false,
      mutate: (input: unknown) => {
        mocked.setDefaults(input);
        if (mocked.setDefaultsError) options.onError(mocked.setDefaultsError);
      },
    }),
  };
  const removeMutation = {
    useMutation: () => ({ isPending: false, mutate: mocked.removeGroup }),
  };
  const mutation = {
    useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  };
  return {
    api: {
      useUtils: () => ({
        reviewerGroup: {
          list: { invalidate: vi.fn() },
          getDefaults: { invalidate: vi.fn() },
        },
      }),
      reviewerGroup: {
        getDefaults: query("defaults"),
        list: query("groups"),
        setDefaults: defaultsMutation,
        create: mutation,
        rename: mutation,
        setMembers: mutation,
        delete: removeMutation,
      },
      projectMember: { list: query("members") },
    },
  };
});

import { ReviewerPicker } from "~/components/review/ReviewerPicker";
import { DocumentReviewCard } from "./DocumentReviewCard";

const ada = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";
const legal = "33333333-3333-3333-3333-333333333333";

const member = (userId: string, name: string | null, email: string) => ({
  userId,
  email,
  role: "Editor",
  user: { name, email, role: "User" },
});

function load(canManage: boolean) {
  mocked.defaults = mocked.ready({
    everyMonths: 12,
    reviewers: [{ type: "group", id: legal, name: "Legal" }],
    canManage,
  });
  mocked.groups = mocked.ready([
    {
      id: legal,
      name: "Legal",
      members: [
        { userId: ada, name: "Ada" },
        { userId: bob, name: "bob@example.test" },
      ],
    },
  ]);
  mocked.members = mocked.ready([
    member(ada, "Ada", "ada@example.test"),
    member(bob, null, "bob@example.test"),
  ]);
}

const render = () =>
  renderToStaticMarkup(<DocumentReviewCard projectId="p1" />);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type PickerProps = {
  onChange: (next: { type: "user" | "group"; id: string }[]) => void;
};
type ClickProps = { onClick: (event: unknown) => void };
let renderer: ReturnType<typeof create>;
const nodes = new Map<string, { name: string; value: string }>();
const mountCard = () =>
  act(async () => {
    renderer = create(<DocumentReviewCard projectId="p1" />, {
      createNodeMock: ({ type, props }) => {
        if (type !== "input") return { focus: vi.fn() };
        const name = (props as { name?: string }).name ?? "";
        const node = { name, value: "", focus: vi.fn() };
        nodes.set(name, node);
        return node;
      },
    });
  });
const rerenderCard = () =>
  act(async () => {
    renderer.update(<DocumentReviewCard projectId="p1" />);
  });
const pick = (targets: { type: "user" | "group"; id: string }[]) =>
  act(async () => {
    (
      renderer.root.findAllByType(ReviewerPicker)[0]!.props as PickerProps
    ).onChange(targets);
  });
const setMonths = async (value: string) => {
  const node = nodes.get("everyMonths")!;
  node.value = value;
  await act(async () => {
    await (
      renderer.root.findByProps({ name: "everyMonths" }).props.onChange as (
        e: unknown,
      ) => unknown
    )({ type: "change", target: node });
  });
};
const submitForm = () =>
  act(async () => {
    await (
      renderer.root.findByProps({ "aria-label": "Review defaults" }).props
        .onSubmit as (e: unknown) => unknown
    )({ preventDefault: vi.fn(), persist: vi.fn() });
  });
const serverDefaults = (everyMonths: number, reviewers: unknown[]) => {
  mocked.defaults = mocked.ready({ everyMonths, reviewers, canManage: true });
};

describe("DocumentReviewCard", () => {
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = undefined as never;
  });
  beforeEach(() => {
    nodes.clear();
    mocked.setDefaultsError = null;
    mocked.removeGroup.mockClear();
    mocked.setDefaults.mockClear();
    load(true);
  });

  it("submits the loaded defaults for Owners", async () => {
    await mountCard();
    await submitForm();
    expect(mocked.setDefaults).toHaveBeenCalledWith({
      projectId: "p1",
      everyMonths: 12,
      reviewers: [{ type: "group", id: legal }],
    });
  });

  it("never submits defaults when canManage is false", async () => {
    load(false);
    await mountCard();
    await submitForm();
    expect(mocked.setDefaults).not.toHaveBeenCalled();
  });

  it("shows the defaults, the helper text and the groups with their members", () => {
    const html = render();
    expect(html).toContain("Document review");
    expect(html).toContain("Review every (months)");
    expect(html).toContain(
      "With no default reviewer, the project Owners review.",
    );
    expect(html).toContain("Group · 2 members");
    expect(html).toContain("2 members: Ada, bob@example.test");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
  });

  it("offers management controls to Owners", () => {
    const html = render();
    expect(html).toContain(">Save<");
    expect(html).toContain("New group");
    expect(html).toContain('aria-label="Edit Legal"');
    expect(html).toContain('aria-label="Delete Legal"');
    expect(html).not.toMatch(/<input[^>]*\sdisabled=""/);
  });

  it("is read-only when canManage is false but still shows the data", () => {
    load(false);
    const html = render();
    expect(html).toContain("Legal");
    expect(html).not.toContain(">Save<");
    expect(html).not.toContain("New group");
    expect(html).not.toContain('aria-label="Edit Legal"');
    expect(html).not.toContain('aria-label="Delete Legal"');
    expect(html).toContain("<fieldset");
    expect(html).toMatch(/<fieldset[^>]*\sdisabled=""/);
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs.length).toBeGreaterThan(1);
    for (const input of inputs) expect(input).toContain('disabled=""');
  });

  it("shows the empty state without groups", () => {
    mocked.groups = mocked.ready([]);
    expect(render()).toContain("No reviewer groups yet.");
  });

  it("shows a skeleton while loading", () => {
    mocked.defaults = { ...mocked.ready(undefined), isLoading: true };
    const html = render();
    expect(html).not.toContain("Review every");
    expect(html).not.toContain("Could not load");
  });

  it("shows the retry state on a failed query", () => {
    mocked.groups = {
      ...mocked.ready(undefined),
      error: { data: { code: "INTERNAL_SERVER_ERROR" } },
    };
    const html = render();
    expect(html).toContain("Could not load the document review settings.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Review every");
  });

  it.each(["NOT_FOUND", "FORBIDDEN"])(
    "does not render stale cached data after a %s error",
    (code) => {
      mocked.defaults = {
        ...mocked.defaults,
        error: { data: { code } },
      };
      const html = render();
      expect(html).toContain("Could not load the document review settings.");
      expect(html).not.toContain("Review every");
      expect(html).not.toContain("Legal");
    },
  );

  it("adopts fresh server defaults while the form is pristine", async () => {
    await mountCard();
    serverDefaults(24, [{ type: "user", id: ada, name: "Ada" }]);
    await rerenderCard();
    await submitForm();
    expect(mocked.setDefaults).toHaveBeenCalledWith({
      projectId: "p1",
      everyMonths: 24,
      reviewers: [{ type: "user", id: ada }],
    });
  });

  it("keeps unsaved edits when the server defaults change", async () => {
    await mountCard();
    await setMonths("6");
    await pick([]);
    serverDefaults(24, [{ type: "user", id: ada, name: "Ada" }]);
    await rerenderCard();
    await submitForm();
    expect(mocked.setDefaults).toHaveBeenCalledWith({
      projectId: "p1",
      everyMonths: 6,
      reviewers: [],
    });
  });

  it("prunes a ticked target that disappears from the options and does not submit it", async () => {
    await mountCard();
    await pick([
      { type: "group", id: legal },
      { type: "user", id: ada },
    ]);
    mocked.members = mocked.ready([member(bob, null, "bob@example.test")]);
    await rerenderCard();
    await submitForm();
    expect(mocked.setDefaults).toHaveBeenCalledWith({
      projectId: "p1",
      everyMonths: 12,
      reviewers: [{ type: "group", id: legal }],
    });
  });

  it("stays pristine when a deleted default group is pruned, then adopts the refetched defaults", async () => {
    await mountCard();
    mocked.groups = mocked.ready([]);
    await rerenderCard();
    serverDefaults(24, []);
    await rerenderCard();
    await submitForm();
    expect(mocked.setDefaults).toHaveBeenCalledWith({
      projectId: "p1",
      everyMonths: 24,
      reviewers: [],
    });
  });

  it("shows a BAD_REQUEST on everyMonths at the interval field", async () => {
    mocked.setDefaultsError = {
      message: "Review interval is out of range",
      data: { code: "BAD_REQUEST", field: "everyMonths" },
    };
    await mountCard();
    await submitForm();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Review interval is out of range",
    );
  });

  it("deletes the confirmed group", async () => {
    await mountCard();
    await act(async () => {
      (
        renderer.root.findByProps({ "aria-label": "Delete Legal" })
          .props as ClickProps
      ).onClick({ currentTarget: {} });
    });
    await act(async () => {
      (
        renderer.root.findByProps({ variant: "destructive" })
          .props as ClickProps
      ).onClick({});
    });
    expect(mocked.removeGroup).toHaveBeenCalledWith({
      projectId: "p1",
      groupId: legal,
    });
  });
});

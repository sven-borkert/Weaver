import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  create: vi.fn(),
  rename: vi.fn(),
  setMembers: vi.fn(),
  invalidate: vi.fn(),
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
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogClose: Container,
  };
});
vi.mock("~/trpc/react", () => {
  const mutation = (key: "create" | "rename" | "setMembers") => ({
    useMutation: () => ({ isPending: false, mutateAsync: mocked[key] }),
  });
  return {
    api: {
      useUtils: () => ({
        reviewerGroup: {
          list: { invalidate: mocked.invalidate },
          getDefaults: { invalidate: mocked.invalidate },
        },
      }),
      reviewerGroup: {
        create: mutation("create"),
        rename: mutation("rename"),
        setMembers: mutation("setMembers"),
      },
    },
  };
});

import { ReviewerPicker } from "~/components/review/ReviewerPicker";
import { ReviewerGroupDialog } from "./ReviewerGroupDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ada = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";
const cyd = "44444444-4444-4444-4444-444444444444";
const legal = "33333333-3333-3333-3333-333333333333";

const memberOptions = [ada, bob, cyd].map((id, index) => ({
  type: "user" as const,
  id,
  label: ["Ada", "Bob", "Cyd"][index]!,
  detail: `${id}@example.test`,
}));
const group = {
  id: legal,
  name: "Legal",
  members: [{ userId: ada, name: "Ada" }],
};

const trpcError = (message: string, code: string, field?: string) =>
  Object.assign(new Error(message), { data: { code, field } });

let renderer: ReactTestRenderer;
const nodes = new Map<string, { name: string; value: string }>();
const onOpenChange = vi.fn();

async function mount(editing: boolean) {
  await act(async () => {
    renderer = create(
      <ReviewerGroupDialog
        projectId="p1"
        group={editing ? group : null}
        memberOptions={memberOptions}
        open
        onOpenChange={onOpenChange}
      />,
      {
        createNodeMock: ({ type, props }) => {
          if (type !== "input") return {};
          const name = (props as { name?: string }).name ?? "";
          const node = { name, value: "", focus: vi.fn() };
          nodes.set(name, node);
          return node;
        },
      },
    );
  });
}
async function setName(value: string) {
  const node = nodes.get("name")!;
  node.value = value;
  await act(async () => {
    await (
      renderer.root.findByProps({ name: "name" }).props.onChange as (
        e: unknown,
      ) => unknown
    )({ type: "change", target: node });
  });
}
async function setMembers(ids: string[]) {
  await act(async () => {
    (
      renderer.root.findByType(ReviewerPicker).props as {
        onChange: (next: { type: "user"; id: string }[]) => void;
      }
    ).onChange(ids.map((id) => ({ type: "user", id })));
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
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.create.mockResolvedValue({});
  mocked.rename.mockResolvedValue({});
  mocked.setMembers.mockResolvedValue({});
  onOpenChange.mockReset();
  nodes.clear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

describe("ReviewerGroupDialog", () => {
  it("creates a group with the trimmed name and selected members, then closes", async () => {
    await mount(false);
    await setName("  Finance  ");
    await setMembers([bob, cyd]);
    await submit();
    expect(mocked.create).toHaveBeenCalledWith({
      projectId: "p1",
      name: "Finance",
      memberIds: [bob, cyd],
    });
    expect(mocked.rename).not.toHaveBeenCalled();
    expect(mocked.setMembers).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocked.invalidate).toHaveBeenCalled();
  });

  it("sends only rename when only the name changed", async () => {
    await mount(true);
    await setName("Legal team");
    await submit();
    expect(mocked.rename).toHaveBeenCalledWith({
      projectId: "p1",
      groupId: legal,
      name: "Legal team",
    });
    expect(mocked.setMembers).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends only setMembers when only the members changed", async () => {
    await mount(true);
    await setMembers([ada, bob]);
    await submit();
    expect(mocked.rename).not.toHaveBeenCalled();
    expect(mocked.setMembers).toHaveBeenCalledWith({
      projectId: "p1",
      groupId: legal,
      memberIds: [ada, bob],
    });
  });

  it("sends rename then setMembers when both changed", async () => {
    await mount(true);
    await setName("Legal team");
    await setMembers([bob]);
    await submit();
    expect(mocked.rename).toHaveBeenCalledTimes(1);
    expect(mocked.setMembers).toHaveBeenCalledTimes(1);
    expect(mocked.rename.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.setMembers.mock.invocationCallOrder[0]!,
    );
  });

  it("pins a name CONFLICT to the name field and sends nothing else", async () => {
    mocked.rename.mockRejectedValue(
      trpcError("A group with this name already exists", "CONFLICT", "name"),
    );
    await mount(true);
    await setName("Taken");
    await setMembers([bob]);
    await submit();
    expect(mocked.setMembers).not.toHaveBeenCalled();
    expect(text()).toContain("A group with this name already exists");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("reports a partial failure, stays open, and retries only setMembers", async () => {
    mocked.setMembers.mockRejectedValueOnce(
      trpcError("Not a project member", "BAD_REQUEST", "memberIds"),
    );
    await mount(true);
    await setName("Legal team");
    await setMembers([bob]);
    await submit();
    expect(text()).toContain(
      "The name was saved, but the members could not be updated: Not a project member",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocked.invalidate).toHaveBeenCalled();

    await submit();
    expect(mocked.rename).toHaveBeenCalledTimes(1);
    expect(mocked.setMembers).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("toasts the partial failure when the server gives no field", async () => {
    mocked.setMembers.mockRejectedValueOnce(
      trpcError("boom", "INTERNAL_SERVER_ERROR"),
    );
    await mount(true);
    await setName("Legal team");
    await setMembers([bob]);
    await submit();
    expect(mocked.toastError).toHaveBeenCalledWith(
      "The name was saved, but the members could not be updated: boom",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

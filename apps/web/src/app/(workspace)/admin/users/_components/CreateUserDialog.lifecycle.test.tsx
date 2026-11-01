import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onSuccess: undefined as ((result: { password: string }) => void) | undefined,
  reset: vi.fn(),
  error: vi.fn(),
  password: "Generated-password-123",
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ user: { list: { invalidate: vi.fn() } } }),
    user: {
      create: {
        useMutation: (options: { onSuccess: typeof mocks.onSuccess }) => {
          mocks.onSuccess = options.onSuccess;
          return { isPending: false, mutate: vi.fn(), reset: mocks.reset };
        },
      },
    },
  },
}));
vi.mock("~/lib/users/generatePassword", () => ({
  generatePassword: () => mocks.password,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: mocks.error } }));
vi.mock("~/components/ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({ children, ...props }: { children: ReactNode }) => (
      <div data-dialog {...props}>
        {children}
      </div>
    ),
    DialogContent: Container,
    DialogClose: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogTrigger: Container,
  };
});
vi.mock("~/components/ui/select", () => {
  const Container = ({ children }: { children: ReactNode }) => <>{children}</>;
  return Object.fromEntries(
    [
      "Select",
      "SelectContent",
      "SelectItem",
      "SelectTrigger",
      "SelectValue",
    ].map((name) => [name, Container]),
  );
});

import { CreateUserDialog } from "./CreateUserDialog";

let renderer: ReactTestRenderer;
function clickButton(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find(
      (node) =>
        node.children.includes(label) || node.props["aria-label"] === label,
    )!;
  (button.props.onClick as () => void)();
}

function changeOpen(open: boolean) {
  const dialog = renderer.root.findAllByProps({ "data-dialog": true })[0]!;
  (dialog.props.onOpenChange as (open: boolean) => void)(open);
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<CreateUserDialog />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("keeps the creation dialog open to copy the generated password until Done", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const dialog = () =>
    renderer.root.findAllByProps({ "data-dialog": true })[0]!;
  await act(async () => {
    changeOpen(true);
  });
  await act(async () => {
    clickButton("Generate");
  });
  await act(async () => {
    mocks.onSuccess!({ password: mocks.password });
  });

  expect(dialog().props.open).toBe(true);
  expect(
    renderer.root.findByProps({ id: "revealed-password" }).props.value,
  ).toBe(mocks.password);
  await act(async () => {
    clickButton("Copy password");
  });
  expect(writeText).toHaveBeenCalledWith(mocks.password);
  await act(async () => {
    changeOpen(false);
  });
  expect(dialog().props.open).toBe(true);

  await act(async () => {
    clickButton("Done");
  });
  expect(dialog().props.open).toBe(false);
  expect(
    renderer.root.findAllByProps({ id: "revealed-password" }),
  ).toHaveLength(0);
  expect(mocks.reset).toHaveBeenCalled();
});

it("does not reveal a typed replacement for a generated password", async () => {
  await act(async () => {
    clickButton("Generate");
  });
  await act(async () => {
    mocks.onSuccess!({ password: "Typed-replacement-123" });
  });
  expect(
    renderer.root.findAllByProps({ id: "revealed-password" }),
  ).toHaveLength(0);
  expect(mocks.reset).toHaveBeenCalled();
});

it("keeps the password available for manual copying when clipboard access fails", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  await act(async () => {
    clickButton("Generate");
  });
  await act(async () => {
    mocks.onSuccess!({ password: mocks.password });
  });
  await act(async () => {
    clickButton("Copy password");
  });
  expect(mocks.error).toHaveBeenCalledWith(
    "Copy failed — select the password and copy manually",
  );
  expect(
    renderer.root.findByProps({ id: "revealed-password" }).props.value,
  ).toBe(mocks.password);
});

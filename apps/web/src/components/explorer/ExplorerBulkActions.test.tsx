import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { ExplorerBulkActions } from "./ExplorerBulkActions";
import type { ExplorerOperations } from "./useExplorerOperations";
import type { ExplorerEntry, ExplorerItem } from "~/lib/explorer/entries";

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <section>{children}</section> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));
vi.mock(
  "~/app/(workspace)/projects/[projectId]/documents/_components/FolderPicker",
  () => ({ FolderPicker: () => null }),
);
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const item: ExplorerEntry<ExplorerItem> = {
  kind: "item",
  id: "d1",
  title: "Intro",
  path: "intro.md",
  folderPath: [],
  lastEditedAt: new Date(),
  lastEditedBy: null,
};
const folder: ExplorerEntry<ExplorerItem> = {
  kind: "folder",
  name: "Guides",
  path: ["guides"],
  itemCount: 1,
};

it("confirms only eligible reviews with the previewed revision", async () => {
  const onRun = vi.fn();
  const operations: ExplorerOperations = {
    prepare: async () => ({
      keys: new Set(["item:d1"]),
      revisions: { "item:d1": "sha" },
    }),
    run: async () => undefined,
    refresh: async () => undefined,
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ExplorerBulkActions
        entries={[folder, item]}
        folders={[]}
        kind="documents"
        busy={false}
        operations={operations}
        onRun={onRun}
        total={3}
        onSelectAll={() => undefined}
        onClear={() => undefined}
      />,
    );
  });
  const findButtons = () =>
    renderer.root
      .findAllByType("button")
      .filter((button) => button.children.includes("Mark as reviewed"));
  await act(async () =>
    (findButtons()[0]!.props.onClick as (event: unknown) => Promise<void>)({
      currentTarget: {},
    }),
  );
  expect(
    renderer.root
      .findAllByProps({ role: "status" })
      .map((node) =>
        node.children
          .filter((child): child is string => typeof child === "string")
          .join(""),
      )
      .join(" "),
  ).toContain(
    "1 document will be marked as reviewed. 1 selected object skipped.",
  );
  expect(onRun).not.toHaveBeenCalled();
  await act(async () =>
    (findButtons()[1]!.props.onClick as () => Promise<void>)(),
  );
  expect(onRun).toHaveBeenCalledWith("review", [item], [], {
    "item:d1": "sha",
  });
  await act(async () => renderer.unmount());
});

it("prevents confirmation when the selection preview fails", async () => {
  let renderer!: ReactTestRenderer;
  const onRun = vi.fn();
  const operations: ExplorerOperations = {
    prepare: async () => {
      throw new Error("unavailable");
    },
    run: async () => undefined,
    refresh: async () => undefined,
  };
  await act(async () => {
    renderer = create(
      <ExplorerBulkActions
        entries={[item]}
        folders={[]}
        kind="tables"
        busy={false}
        operations={operations}
        onRun={onRun}
        total={3}
        onSelectAll={() => undefined}
        onClear={() => undefined}
      />,
    );
  });
  await act(async () =>
    (
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Delete selected"))!.props
        .onClick as (event: unknown) => Promise<void>
    )({ currentTarget: {} }),
  );
  const confirms = renderer.root
    .findAllByType("button")
    .filter((button) => button.children.includes("Delete selected"));
  expect(confirms[1]!.props.disabled).toBe(true);
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  expect(onRun).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

it("offers review without move or delete to a Viewer", async () => {
  let renderer!: ReactTestRenderer;
  const operations: ExplorerOperations = {
    prepare: async () => ({ keys: new Set(["item:d1"]), revisions: {} }),
    run: async () => undefined,
    refresh: async () => undefined,
  };
  await act(async () => {
    renderer = create(
      <ExplorerBulkActions
        entries={[item]}
        folders={[]}
        kind="documents"
        canEdit={false}
        busy={false}
        operations={operations}
        onRun={async () => undefined}
        total={3}
        onSelectAll={() => undefined}
        onClear={() => undefined}
      />,
    );
  });
  const buttons = renderer.root.findAllByType("button");
  expect(
    buttons.some((button) => button.children.includes("Move selected")),
  ).toBe(false);
  expect(
    buttons.some((button) => button.children.includes("Delete selected")),
  ).toBe(false);
  expect(
    buttons.some(
      (button) =>
        button.children.includes("Mark as reviewed") && !button.props.disabled,
    ),
  ).toBe(true);
  await act(async () => renderer.unmount());
});

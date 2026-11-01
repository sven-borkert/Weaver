import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

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
vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" data-menu-item onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("./FolderReviewDialog", () => ({
  FolderReviewDialog: () => null,
  folderReviewTriggerKey: () => "folder-review",
}));
vi.mock("./MarkFolderReviewedDialog", () => ({
  MarkFolderReviewedDialog: () => null,
}));
vi.mock("./FolderPicker", () => ({ FolderPicker: () => null }));
vi.mock("~/lib/documents/document-cache-invalidation", () => ({
  invalidateDocumentReferenceCaches: vi.fn(),
}));
vi.mock("~/trpc/react", () => {
  const invalidate = { invalidate: vi.fn() };
  const idle = {
    isPending: false,
    error: null,
    mutate: vi.fn(),
    reset: vi.fn(),
  };
  return {
    api: {
      project: { get: { useQuery: () => ({ data: { myRole: role } }) } },
      useUtils: () => ({
        document: {
          list: invalidate,
          get: invalidate,
          history: invalidate,
          backlinks: invalidate,
        },
        folder: { tree: invalidate },
      }),
      folder: {
        move: { useMutation: () => idle },
        delete: { useMutation: () => idle },
        rename: { useMutation: () => idle },
      },
    },
  };
});

let role = "Editor";

import { FolderReviewDialog } from "./FolderReviewDialog";
import { MarkFolderReviewedDialog } from "./MarkFolderReviewedDialog";
import { FolderMutations, DocumentRootReviewAction } from "./FolderMutations";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(canEdit: boolean) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <FolderMutations
        projectId="p1"
        path={["notes", "deep"]}
        folders={["notes", "notes/deep"]}
        folderNames={{ "notes/deep": "Deep thoughts" }}
        canEdit={canEdit}
      />,
    );
  });
  return renderer;
}

const labels = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByProps({ "data-menu-item": true }).map((item) =>
    item
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === "string")
      .join(""),
  );

describe("FolderMutations download", () => {
  it("offers a Viewer the folder archive alone", () => {
    const renderer = render(false);

    expect(labels(renderer)).toEqual([
      "Mark all as reviewed",
      "Download as ZIP",
    ]);
    expect(renderer.root.findByType("a").props).toMatchObject({
      href: "/api/projects/p1/folders/archive?path=notes%2Fdeep",
      download: "deep.zip",
    });
    expect(
      renderer.root.findByProps({ "aria-label": "Actions for Deep thoughts" }),
    ).toBeTruthy();
  });

  it("adds the folder archive to an Editor's actions", () => {
    expect(labels(render(true))).toEqual([
      "Mark all as reviewed",
      "Appearance",
      "Rename",
      "Move",
      "Download as ZIP",
      "Delete",
    ]);
  });
});

describe("recursive reviewer actions", () => {
  it("maintainer_sees_recursive_action_but_editor_does_not", () => {
    role = "Maintainer";
    expect(labels(render(true))).toContain("Set reviewers recursively");
    role = "Editor";
    expect(labels(render(true))).not.toContain("Set reviewers recursively");
  });

  it("root_can_assign_reviewers_without_visible_root_folder", () => {
    role = "Maintainer";
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<DocumentRootReviewAction projectId="p1" />);
    });
    const text = (button: (typeof renderer)["root"]) =>
      button.children
        .filter((child): child is string => typeof child === "string")
        .join("");
    const trigger = renderer.root
      .findAllByType("button")
      .find((button) => text(button) === "Set reviewers recursively")!;
    act(() => (trigger.props.onClick as () => void)());
    const dialog = renderer.root.findByType(FolderReviewDialog);
    expect(dialog.props.path).toEqual([]);
    role = "Editor";
    act(() => renderer.update(<DocumentRootReviewAction projectId="p1" />));
    expect(renderer.root.findAllByType("button").map(text)).toEqual([
      "Mark all as reviewed",
    ]);
  });
});

describe("mark all as reviewed", () => {
  it("opens for the folder from a Viewer's menu", () => {
    role = "Viewer";
    const renderer = render(false);
    const dialog = () => renderer.root.findByType(MarkFolderReviewedDialog);
    expect(dialog().props).toMatchObject({ open: false });
    const item = renderer.root
      .findAllByProps({ "data-menu-item": true })
      .find((node) => node.type === "button")!;
    act(() => (item.props.onClick as () => void)());
    expect(dialog().props).toMatchObject({
      open: true,
      projectId: "p1",
      path: ["notes", "deep"],
    });
  });

  it("opens for the project root for every member", () => {
    role = "Viewer";
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<DocumentRootReviewAction projectId="p1" />);
    });
    act(() =>
      (renderer.root.findByType("button").props.onClick as () => void)(),
    );
    expect(
      renderer.root.findByType(MarkFolderReviewedDialog).props,
    ).toMatchObject({ open: true, path: [] });
  });
});

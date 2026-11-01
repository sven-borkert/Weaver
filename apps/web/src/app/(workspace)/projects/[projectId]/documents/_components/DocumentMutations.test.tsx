import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(
  (): {
    query: { data: unknown; error: unknown; isLoading: boolean };
    updateMutate: ReturnType<typeof vi.fn>;
  } => ({
    query: { data: undefined, error: null, isLoading: false },
    updateMutate: vi.fn(),
  }),
);

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
      useUtils: () => ({
        document: {
          list: invalidate,
          get: invalidate,
          history: invalidate,
          backlinks: invalidate,
        },
        folder: { tree: invalidate },
      }),
      appearance: {
        get: {
          useQuery: () => ({
            data: { appearance: null, revision: "sha", canEdit: true },
            isFetching: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      document: {
        get: { useQuery: () => mocked.query },
        move: { useMutation: () => idle },
        delete: { useMutation: () => idle },
        update: {
          useMutation: () => ({
            isPending: false,
            error: null,
            mutate: mocked.updateMutate,
          }),
        },
      },
    },
  };
});

import { DocumentMutations } from "./DocumentMutations";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type NodeMock = {
  name: string;
  type: string;
  value: string;
  focus: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};
let titleNode: NodeMock | undefined;

const element = () => (
  <DocumentMutations
    projectId="p1"
    documentId="d1"
    documentTitle="Original"
    documentFolderPath={[]}
    folders={[]}
    canEdit
  />
);

const loaded = (baseCommitSha: string, title = "Original") => ({
  title,
  content: { kind: "markdown", contentJson: { type: "doc", content: [] } },
  baseCommitSha,
});

async function mountOpenRename() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element(), {
      createNodeMock: (el) => {
        if (el.type !== "input") return {};
        // register() re-attaches its ref every render; one node stands in for the DOM input.
        titleNode ??= {
          name: (el.props as { name?: string }).name ?? "",
          type: "text",
          value: "",
          focus: vi.fn(),
          select: vi.fn(),
        };
        return titleNode;
      },
    });
  });
  const rename = renderer.root
    .findAllByProps({ "data-menu-item": true })
    .find((node) => node.children.includes("Rename"));
  await act(async () => {
    (rename!.props.onClick as () => void)();
  });
  return renderer;
}

async function type(renderer: ReactTestRenderer, value: string) {
  const field = renderer.root.findByProps({ name: "title" });
  titleNode!.value = value;
  await act(async () => {
    (field.props.onChange as (event: unknown) => void)({
      type: "change",
      target: titleNode,
    });
  });
}

async function refresh(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.update(element());
  });
}

async function submit(renderer: ReactTestRenderer) {
  const onSubmit = renderer.root.findByType("form").props.onSubmit as (event: {
    preventDefault(): void;
    persist(): void;
  }) => Promise<void> | void;
  await act(async () => {
    await onSubmit({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}

describe("DocumentMutations rename dialog", () => {
  beforeEach(() => {
    titleNode = undefined;
    mocked.updateMutate.mockReset();
    mocked.query = { data: loaded("sha-1"), error: null, isLoading: false };
  });

  it("keeps a typed title across a refetch and submits against the latest base", async () => {
    const renderer = await mountOpenRename();
    await type(renderer, "My draft");

    mocked.query = {
      data: loaded("sha-2", "Remote title"),
      error: null,
      isLoading: false,
    };
    await refresh(renderer);

    expect(titleNode!.value).toBe("My draft");
    await submit(renderer);
    expect(mocked.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My draft", baseCommitSha: "sha-2" }),
    );
  });

  it("refreshes an untouched title from the refetched document", async () => {
    const renderer = await mountOpenRename();
    mocked.query = {
      data: loaded("sha-2", "Remote title"),
      error: null,
      isLoading: false,
    };
    await refresh(renderer);
    expect(titleNode!.value).toBe("Remote title");
  });

  it("keeps the form mounted on a transient error with retained data", async () => {
    const renderer = await mountOpenRename();
    await type(renderer, "My draft");

    mocked.query = {
      data: loaded("sha-1"),
      error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      isLoading: false,
    };
    await refresh(renderer);

    expect(renderer.root.findAllByType("form")).toHaveLength(1);
    expect(titleNode!.value).toBe("My draft");
  });

  it("replaces the form when the refetch reports an access error", async () => {
    const renderer = await mountOpenRename();
    mocked.query = {
      data: loaded("sha-1"),
      error: { data: { code: "NOT_FOUND" } },
      isLoading: false,
    };
    await refresh(renderer);

    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Could not load the document for renaming",
    );
  });
});

describe("DocumentMutations download", () => {
  const download = {
    fileName: "original.md",
    href: "/api/documents/d1/markdown?projectId=p1",
  };
  const render = (canEdit: boolean, withDownload: boolean) => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DocumentMutations
          projectId="p1"
          documentId="d1"
          documentTitle="Original"
          documentFolderPath={[]}
          folders={[]}
          canEdit={canEdit}
          download={withDownload ? download : undefined}
        />,
      );
    });
    return renderer;
  };
  const labels = (renderer: ReactTestRenderer) =>
    renderer.root.findAllByProps({ "data-menu-item": true }).map((item) =>
      item
        .findAll((node) => typeof node.type === "string")
        .flatMap((node) => node.children)
        .filter((child): child is string => typeof child === "string")
        .join(""),
    );

  it("offers a Viewer the download alone", () => {
    const renderer = render(false, true);

    expect(labels(renderer)).toEqual(["Download"]);
    const link = renderer.root.findByType("a");
    expect(link.props).toMatchObject({
      href: download.href,
      download: "original.md",
    });
  });

  it("adds the download to an Editor's actions", () => {
    expect(labels(render(true, true))).toEqual([
      "Appearance",
      "Rename",
      "Move",
      "Download",
      "Delete",
    ]);
  });

  it("routes appearance through an optional callback without fetching metadata", () => {
    const onAppearance = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <DocumentMutations
          projectId="p1"
          documentId="d1"
          documentTitle="Original"
          documentFolderPath={[]}
          folders={[]}
          canEdit
          onAppearance={onAppearance}
        />,
      );
    });
    const action = renderer.root
      .findAllByProps({ "data-menu-item": true })
      .find((node) => node.children.includes("Appearance"))!;
    act(() => {
      (action.props.onClick as () => void)();
    });
    expect(onAppearance).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    act(() => renderer.unmount());
  });
  it("clears an open appearance dialog when edit access is lost", () => {
    let renderer!: ReactTestRenderer;
    const renderFor = (canEdit: boolean) => (
      <DocumentMutations
        projectId="p1"
        documentId="d1"
        documentTitle="Original"
        documentFolderPath={[]}
        folders={[]}
        canEdit={canEdit}
        download={download}
      />
    );
    act(() => {
      renderer = create(renderFor(true));
    });
    const action = renderer.root
      .findAllByProps({ "data-menu-item": true })
      .find((node) => node.children.includes("Appearance"))!;
    act(() => {
      (action.props.onClick as () => void)();
    });
    expect(renderer.root.findAllByType("form")).toHaveLength(1);
    act(() => renderer.update(renderFor(false)));
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    act(() => renderer.update(renderFor(true)));
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    act(() => renderer.unmount());
  });
  it("renders nothing for a Viewer without a download", () => {
    expect(render(false, false).toJSON()).toBeNull();
  });
});

import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { FileText } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerAdapter } from "./adapter";
import type { ExplorerEntry, ExplorerItem } from "~/lib/explorer/entries";

const projectAccess = vi.hoisted(() => ({ myRole: "Editor" }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    project: {
      get: {
        useQuery: () => ({
          data: { name: "Project", myRole: projectAccess.myRole },
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));
vi.mock(
  "~/app/(workspace)/projects/[projectId]/documents/_components/DocumentsWorkspace",
  () => ({
    DocumentsWorkspace: ({ children }: { children: ReactNode }) => (
      <main>{children}</main>
    ),
  }),
);
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));
vi.mock("~/components/ui/toggle-group", () => ({
  ToggleGroup: ({
    children,
    onValueChange: _onValueChange,
    ...props
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => <div {...props}>{children}</div>,
  ToggleGroupItem: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
import { ContentExplorerScreen } from "./ContentExplorerScreen";
import { ContentExplorer } from "./ContentExplorer";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const adapter: ExplorerAdapter<ExplorerItem> = {
  kind: "documents",
  viewStorageKey: "documents-view",
  listLabel: "Content",
  itemNoun: ["document", "documents"],
  searchInputId: "search",
  itemIcon: () => FileText,
  base: () => "/documents",
  itemHref: () => "/document",
  useTree: () => ({
    data: {
      folders: [],
      items: [
        {
          id: "d1",
          title: "Name stays visible",
          path: "name.md",
          lastEditedAt: new Date(),
          lastEditedBy: null,
        },
      ],
    },
    isLoading: false,
    error: null,
    refetch: () => undefined,
  }),
  useMove: () => async () => undefined,
  useImport: () => null,
  FolderActions: () => null,
  ItemActions: () => null,
  CreateFolderDialog: () => null,
  CreateItemDialog: () => null,
  copy: {
    workspaceLabel: "Workspace",
    loadingTitle: "Loading",
    loadingDescription: "Loading",
    errorTitle: "Error",
    notFoundBackLabel: "Back",
    emptySearchTitle: "No results",
    emptySearchDescription: "Search",
    emptyFolderTitle: "Empty",
    emptyFolderDescription: "Create",
    dropZoneTestId: "drop",
  },
};
const element = () => (
  <ContentExplorerScreen projectId="p1" folderPath={[]} adapter={adapter} />
);
const frames: (() => void)[] = [];
async function mount(storage: Pick<Storage, "getItem" | "setItem">) {
  frames.length = 0;
  vi.stubGlobal("window", {
    localStorage: storage,
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: vi.fn(),
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element());
  });
  return renderer;
}
beforeEach(() => {
  projectAccess.myRole = "Editor";
  vi.stubGlobal("window", {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("explorer size preference", () => {
  it("uses hydration-safe defaults then restores compact and persists a changed size", async () => {
    const storage = {
      getItem: (key: string) =>
        key.endsWith(":iconSize") ? "compact" : "icons",
      setItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage: storage });
    const server = renderToStaticMarkup(element());
    expect(server).toContain("<table");
    expect(server).not.toContain('aria-label="Icon size"');
    const renderer = await mount(storage);
    expect(renderer.root.findByType(ContentExplorer).props.view).toBe("list");
    expect(renderer.root.findByType(ContentExplorer).props.iconSize).toBe(
      "standard",
    );
    await act(async () => {
      frames.splice(0).forEach((frame) => frame());
    });
    expect(renderer.root.findByType(ContentExplorer).props.iconSize).toBe(
      "compact",
    );
    const control = renderer.root.findByProps({ "aria-label": "Icon size" });
    await act(async () => {
      (control.props.onValueChange as (value: string) => void)("standard");
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      "documents-view:iconSize",
      "standard",
    );
    await act(async () => renderer.unmount());
  });
  it("blocked_local_storage_defaults_to_standard and leaves toggles usable", async () => {
    const renderer = await mount({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    await act(async () => {
      frames.splice(0).forEach((frame) => frame());
    });
    const view = renderer.root.findByProps({ "aria-label": "View" });
    await act(async () => {
      (view.props.onValueChange as (value: string) => void)("icons");
    });
    expect(renderer.root.findByType(ContentExplorer).props.iconSize).toBe(
      "standard",
    );
    const size = renderer.root.findByProps({ "aria-label": "Icon size" });
    await act(async () => {
      (size.props.onValueChange as (value: string) => void)("compact");
    });
    expect(renderer.root.findByType(ContentExplorer).props.iconSize).toBe(
      "compact",
    );
    await act(async () => {
      (view.props.onValueChange as (value: string) => void)("list");
    });
    expect(
      renderer.root.findAllByProps({ "aria-label": "Icon size" }),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
  });
});

describe("adapter value filter and optional columns", () => {
  type Typed = ExplorerItem & { kind?: string | null };
  const typed = (kinds: (string | null)[]): ExplorerAdapter<Typed> => ({
    ...adapter,
    useTree: () => ({
      data: {
        folders: [],
        items: kinds.map((kind, index) => ({
          id: `t${index}`,
          title: `Page ${index}`,
          path: `page-${index}.md`,
          lastEditedAt: new Date(),
          lastEditedBy: null,
          kind,
        })),
      },
      isLoading: false,
      error: null,
      refetch: () => undefined,
    }),
    filter: {
      id: "type",
      label: "Type",
      allLabel: "All types",
      value: (item) => item.kind,
    },
    columns: [
      {
        key: "kind",
        header: "Kind",
        cell: (item) => item.kind ?? "-",
        visible: (items) => items.some((item) => item.kind),
      },
    ],
  });
  const html = (a: ExplorerAdapter<Typed>) =>
    renderToStaticMarkup(
      <ContentExplorerScreen projectId="p1" folderPath={[]} adapter={a} />,
    );

  it("lists each distinct value once, case-insensitively, and shows the column", () => {
    const out = html(typed(["Entity", "entity", "concept", null]));
    expect(out).toContain("All types");
    expect(out).toContain("All typesconceptEntity</div>");
    expect(out).toContain("Kind");
  });

  it("hides the filter and the column while no item has a value", () => {
    const out = html(typed([null, null]));
    expect(out).not.toContain("All types");
    expect(out).not.toContain(">Kind<");
  });
});

describe("adapter root actions", () => {
  it("renders a root action without fabricating a visible root folder", () => {
    const withRootAction = {
      ...adapter,
      rootActions: () => <button>Root reviewers</button>,
    };
    const html = renderToStaticMarkup(
      <ContentExplorerScreen
        projectId="p1"
        folderPath={[]}
        adapter={withRootAction}
      />,
    );
    expect(html).toContain("Root reviewers");
    expect(html).toContain("data-explorer-workspace-focus");
    expect(html).not.toContain("Actions for root");
    const nested = renderToStaticMarkup(
      <ContentExplorerScreen
        projectId="p1"
        folderPath={["missing"]}
        adapter={withRootAction}
      />,
    );
    expect(nested).not.toContain("Root reviewers");
  });
  it("adapters without root actions do not receive reviewer controls", () => {
    const tables = { ...adapter, kind: "tables" as const };
    expect(
      renderToStaticMarkup(
        <ContentExplorerScreen
          projectId="p1"
          folderPath={[]}
          adapter={tables}
        />,
      ),
    ).not.toContain("Root reviewers");
  });
});

import { ExplorerBulkActions } from "./ExplorerBulkActions";
import type { ExplorerOperations } from "./useExplorerOperations";

it("retains failed objects for retry after a bulk delete", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error("changed"))
    .mockResolvedValueOnce(undefined);
  const operations: ExplorerOperations = {
    prepare: async () => ({ keys: new Set(), revisions: {} }),
    run,
    refresh: async () => undefined,
  };
  const tree = adapter.useTree("p1", true).data!;
  const other = {
    ...tree.items[0]!,
    id: "d2",
    title: "Second",
    path: "second.md",
  };
  const withOperations = {
    ...adapter,
    useOperations: () => operations,
    useTree: () => ({
      data: { ...tree, items: [...tree.items, other] },
      isLoading: false,
      error: null,
      refetch: () => undefined,
    }),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ContentExplorerScreen
        projectId="p1"
        folderPath={[]}
        adapter={withOperations}
      />,
    );
  });
  await act(async () =>
    (
      renderer.root.findByType(ContentExplorer).props.onSelectionChange as (
        keys: Set<string>,
      ) => void
    )(new Set(["item:d1", "item:d2"])),
  );
  const selected = renderer.root.findByType(ExplorerBulkActions).props
    .entries as ExplorerEntry<ExplorerItem>[];
  await act(async () =>
    (
      renderer.root.findByType(ExplorerBulkActions).props
        .onRun as ComponentProps<typeof ExplorerBulkActions>["onRun"]
    )("delete", selected, [], {}),
  );
  expect(run).toHaveBeenCalledTimes(2);
  expect([
    ...(renderer.root.findByType(ContentExplorer).props
      .selectedKeys as Set<string>),
  ]).toEqual(["item:d1"]);
  expect(
    renderer.root.findByType(ExplorerBulkActions).props.entries,
  ).toHaveLength(1);
  await act(async () => renderer.unmount());
});

it("drops a searched document Up relative to its own folder", async () => {
  const run = vi.fn();
  const operations: ExplorerOperations = {
    prepare: async () => ({ keys: new Set(), revisions: {} }),
    run,
    refresh: async () => undefined,
  };
  const original = adapter.useTree("p1", true).data!.items[0]!;
  const withOperations = {
    ...adapter,
    useOperations: () => operations,
    useTree: () => ({
      data: {
        folders: ["guides", "guides/nested"],
        items: [{ ...original, path: "guides/nested/name.md" }],
      },
      isLoading: false,
      error: null,
      refetch: () => undefined,
    }),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ContentExplorerScreen
        projectId="p1"
        folderPath={["guides"]}
        adapter={withOperations}
      />,
    );
  });
  await act(async () =>
    (
      renderer.root
        .findAllByType("input")
        .find((input) => input.props.id === "search")!.props.onChange as (
        event: unknown,
      ) => void
    )({ target: { value: "Name" } }),
  );
  const up = renderer.root
    .findAllByType("button")
    .find((button) => button.children.includes("Up"))!;
  const payload = JSON.stringify({
    kind: "documents",
    projectId: "p1",
    entries: [{ kind: "item", id: "d1" }],
  });
  await act(async () =>
    (up.props.onDrop as (event: unknown) => void)({
      dataTransfer: { getData: () => payload },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }),
  );
  expect(run).toHaveBeenCalledWith(
    "move",
    expect.objectContaining({ id: "d1" }),
    ["guides"],
    {},
  );
  await act(async () => renderer.unmount());
});

it("lets an assigned Viewer select and review documents", async () => {
  projectAccess.myRole = "Viewer";
  const run = vi.fn();
  const operations: ExplorerOperations = {
    prepare: async () => ({ keys: new Set(), revisions: {} }),
    run,
    refresh: async () => undefined,
  };
  const withOperations = { ...adapter, useOperations: () => operations };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ContentExplorerScreen
        projectId="p1"
        folderPath={[]}
        adapter={withOperations}
      />,
    );
  });
  const link = renderer.root.findByProps({ "data-explorer-entry": "item:d1" });
  await act(async () =>
    (link.props.onClick as (event: unknown) => void)({
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }),
  );
  const bulk = renderer.root.findByType(ExplorerBulkActions)
    .props as ComponentProps<typeof ExplorerBulkActions>;
  expect(bulk.canEdit).toBe(false);
  await act(async () =>
    bulk.onRun("review", bulk.entries, [], { "item:d1": "sha" }),
  );
  expect(run).toHaveBeenCalledWith(
    "review",
    expect.objectContaining({ id: "d1" }),
    [],
    { "item:d1": "sha" },
  );
  await act(async () => renderer.unmount());
});

it("discards selection across role changes", async () => {
  const operations: ExplorerOperations = {
    prepare: async () => ({ keys: new Set(), revisions: {} }),
    run: async () => undefined,
    refresh: async () => undefined,
  };
  const withOperations = { ...adapter, useOperations: () => operations };
  let renderer!: ReactTestRenderer;
  const element = () => (
    <ContentExplorerScreen
      projectId="p1"
      folderPath={[]}
      adapter={withOperations}
    />
  );
  await act(async () => {
    renderer = create(element());
  });
  await act(async () =>
    (
      renderer.root.findByType(ContentExplorer).props.onSelectionChange as (
        keys: Set<string>,
      ) => void
    )(new Set(["item:d1"])),
  );
  projectAccess.myRole = "Viewer";
  await act(async () => renderer.update(element()));
  expect(renderer.root.findByType(ContentExplorer).props.selectedKeys).toEqual(
    new Set(),
  );
  projectAccess.myRole = "Editor";
  await act(async () => renderer.update(element()));
  expect(renderer.root.findByType(ContentExplorer).props.selectedKeys).toEqual(
    new Set(),
  );
  await act(async () => renderer.unmount());
});

it("selects a failed dragged object so it can be retried", async () => {
  const operations: ExplorerOperations = {
    prepare: async () => ({ keys: new Set(), revisions: {} }),
    run: async () => {
      throw new Error("changed");
    },
    refresh: async () => undefined,
  };
  const withOperations = { ...adapter, useOperations: () => operations };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ContentExplorerScreen
        projectId="p1"
        folderPath={[]}
        adapter={withOperations}
      />,
    );
  });
  const props = renderer.root.findByType(ContentExplorer)
    .props as ComponentProps<typeof ContentExplorer>;
  await act(async () => {
    props.onMoveEntries?.(props.entries, ["other"]);
  });
  expect(renderer.root.findByType(ContentExplorer).props.selectedKeys).toEqual(
    new Set(["item:d1"]),
  );
  await act(async () => renderer.unmount());
});

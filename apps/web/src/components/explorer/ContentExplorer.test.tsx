import type { ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { FileText } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));

vi.mock("~/components/appearance/AppearanceDialog", () => ({
  AppearanceDialog: () => <div data-appearance-dialog />,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));

import { ContentExplorer } from "./ContentExplorer";
import type { ExplorerAdapter } from "./adapter";
import type { FolderEntry, ItemEntry } from "~/lib/explorer/entries";
import type { DocumentItem } from "~/lib/documents/explorer";
import { IndexLights } from "~/app/(workspace)/projects/[projectId]/documents/_components/IndexLights";
import { documentKindIcon } from "~/components/icons/document-kind-icon";
import { TooltipProvider } from "~/components/ui/tooltip";

const push = vi.hoisted(() => vi.fn());

const folder: FolderEntry = {
  kind: "folder",
  name: "Guides",
  path: ["guides"],
  itemCount: 2,
};
const document: ItemEntry<DocumentItem> = {
  kind: "item",
  id: "d1",
  title: "Welcome",
  path: "welcome.md",
  documentKind: "markdown",
  folderPath: [],
  createdAt: new Date("2026-08-01T10:00:00Z"),
  createdBy: { id: null, name: "Ada Lovelace" },
  lastEditedAt: new Date("2026-09-01T10:00:00Z"),
  lastEditedBy: { id: "u1", name: "Sven" },
  reviewDueAt: null,
  lastReviewedAt: null,
  index: {
    keyword: "ready",
    semantic: "pending",
    graph: "unavailable",
    summary: null,
  },
};

const adapter: ExplorerAdapter<DocumentItem> = {
  kind: "documents",
  viewStorageKey: "weaver-documents-view",
  listLabel: "Documents and folders",
  itemNoun: ["document", "documents"],
  searchInputId: "document-search",
  itemIcon: () => FileText,
  base: (projectId) => `/projects/${projectId}/documents`,
  itemHref: (projectId, item) => `/projects/${projectId}/documents/${item.id}`,
  useTree: () => ({
    data: undefined,
    isLoading: false,
    error: undefined,
    refetch: () => undefined,
  }),
  useMove: () => async () => undefined,
  useImport: () => null,
  itemBadge: (item) => <IndexLights lights={item.index} />,
  FolderActions: () => <button>folder actions</button>,
  ItemActions: () => <button>document actions</button>,
  CreateFolderDialog: () => null,
  CreateItemDialog: () => null,
  copy: {
    workspaceLabel: "Document workspace",
    loadingTitle: "Loading documents",
    loadingDescription: "Retrieving folders and documents.",
    errorTitle: "Could not load documents",
    notFoundBackLabel: "Back to all documents",
    emptySearchTitle: "No matching documents",
    emptySearchDescription: "Try another title or clear the search.",
    emptyFolderTitle: "This folder is empty",
    emptyFolderDescription: "Add a document here or go up a level.",
    dropZoneTestId: "documents-drop-zone",
  },
};

function renderWith(
  withAdapter: ExplorerAdapter<DocumentItem>,
  view: "list" | "icons",
  searchActive = false,
  onMoveItem?: () => void,
  canEdit = true,
  iconSize: "standard" | "compact" = "standard",
  entries: (FolderEntry | ItemEntry<DocumentItem>)[] = [folder, document],
) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ContentExplorer
        projectId="p1"
        folderPath={[]}
        entries={entries}
        view={view}
        iconSize={iconSize}
        searchActive={searchActive}
        sort="title"
        dir="asc"
        onSortChange={() => undefined}
        onNavigateUp={() => undefined}
        folders={["guides"]}
        folderNames={{ guides: "Guides" }}
        canEdit={canEdit}
        adapter={withAdapter}
        onMoveItem={onMoveItem}
      />
    </TooltipProvider>,
  );
}

describe("ContentExplorer", () => {
  it("renders the Python logo for Python documents", () => {
    const pythonAdapter: ExplorerAdapter<DocumentItem> = {
      ...adapter,
      itemIcon: (item) => documentKindIcon(item.documentKind),
    };
    const python: ItemEntry<DocumentItem> = {
      ...document,
      documentKind: "python",
    };
    const html = renderWith(
      pythonAdapter,
      "list",
      false,
      undefined,
      true,
      "standard",
      [python],
    );
    expect(html).toMatch(/<svg[^>]*>.*?<path fill="url\(#weaver-python-a\)"/s);
  });

  it("renders folders before documents as links in list view", () => {
    const html = renderWith(adapter, "list");
    expect(html).toContain("<table");
    expect(html.indexOf("Guides")).toBeLessThan(html.indexOf("Welcome"));
    expect(html).toContain('href="/projects/p1/documents?folder=guides"');
    expect(html).toContain('href="/projects/p1/documents/d1"');
    expect(html).toContain("folder actions");
    expect(html).toContain("document actions");
  });

  it("shows folder display names and marks items draggable when moves are wired", () => {
    for (const view of ["list", "icons"] as const) {
      const html = renderWith(adapter, view, false, () => undefined);
      expect(html).toContain(">Guides<");
      expect(html.match(/draggable="true"/g)).toHaveLength(1);
      expect(renderWith(adapter, view)).not.toContain('draggable="true"');
    }
  });

  it("renders tiles in icons view", () => {
    const html = renderWith(adapter, "icons");
    expect(html).not.toContain("<table");
    expect(html).toContain('aria-label="Documents and folders"');
    expect(html).toContain('href="/projects/p1/documents/d1"');
  });

  it("shows a Folder column while searching", () => {
    expect(renderWith(adapter, "list", true)).toContain(">Folder<");
    expect(renderWith(adapter, "list", false)).not.toContain(">Folder<");
  });

  it("shows three index lights per document in both views", () => {
    for (const view of ["list", "icons"] as const) {
      const html = renderWith(adapter, view);
      expect(html).toContain(
        'aria-label="Index: keyword ready, semantic pending, graph not configured"',
      );
      expect(html.match(/data-light=/g)).toHaveLength(3);
    }
  });

  it.each(["list", "icons"] as const)(
    "keeps named content and contrast surfaces in %s on custom backgrounds",
    (view) => {
      for (const [backgroundColor, foreground] of [
        ["#000000", "#ffffff"],
        ["#ffffff", "#000000"],
        ["#223355", "#ffffff"],
      ]) {
        const html = renderWith(
          adapter,
          view,
          false,
          undefined,
          true,
          "compact",
          [
            { ...folder, appearance: { backgroundColor } },
            { ...document, appearance: { backgroundColor } },
          ],
        );
        expect(html).toContain(
          `background-color:${backgroundColor};color:${foreground}`,
        );
        expect(html).toContain("Welcome");
        expect(html).toContain("Guides");
        expect(html).toContain("document actions");
        expect(html).toContain("folder actions");
        expect(html).toContain("bg-surface text-text");
      }
    },
  );

  it("renders adapter columns in list view only", () => {
    const withColumn = {
      ...adapter,
      columns: [{ key: "rows", header: "Rows", cell: () => "7" }],
    };
    const html = renderWith(withColumn, "list");
    expect(html).toContain(">Rows<");
    expect(renderWith(withColumn, "icons")).not.toContain(">Rows<");
  });

  it("keeps a Viewer's entries fixed and without actions by default", () => {
    for (const view of ["list", "icons"] as const) {
      const html = renderWith(adapter, view, false, () => undefined, false);
      expect(html).not.toContain('draggable="true"');
      expect(html).not.toContain("document actions");
      expect(html).not.toContain("folder actions");
    }
  });

  it("lets a Viewer drag documents out and open actions when downloads are offered", () => {
    const withDownloads: ExplorerAdapter<DocumentItem> = {
      ...adapter,
      itemDownload: (projectId, item) => ({
        fileName: "welcome.md",
        href: `/api/documents/${item.id}/markdown?projectId=${projectId}`,
      }),
      folderDownloadHref: (projectId, path) =>
        `/api/projects/${projectId}/folders/archive?path=${path.join("/")}`,
    };
    for (const view of ["list", "icons"] as const) {
      const html = renderWith(withDownloads, view, false, undefined, false);
      expect(html.match(/draggable="true"/g)).toHaveLength(1);
      expect(html).toContain("document actions");
      expect(html).toContain("folder actions");
    }
  });
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["standard", "compact"] as const)(
  "explorer %s interaction",
  (iconSize) => {
    async function mount(onMove = vi.fn()) {
      const nodes: { focus: ReturnType<typeof vi.fn> }[] = [];
      const nodeMap = new Map<string, { focus: ReturnType<typeof vi.fn> }>();
      vi.stubGlobal("window", {
        getComputedStyle: () => ({ gridTemplateColumns: "1fr 1fr" }),
      });
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <ContentExplorer
            projectId="p1"
            folderPath={[]}
            entries={[folder, document]}
            view="icons"
            iconSize={iconSize}
            searchActive={false}
            sort="title"
            dir="asc"
            onSortChange={() => undefined}
            onNavigateUp={() => undefined}
            folders={["guides"]}
            canEdit
            adapter={{ ...adapter, itemBadge: undefined }}
            onMoveItem={onMove}
          />,
          {
            createNodeMock: (el) => {
              const node = { focus: vi.fn() };
              if (el.type === "a") {
                const href = (el.props as { href: string }).href;
                if (!nodeMap.has(href)) {
                  nodeMap.set(href, node);
                  nodes.push(node);
                }
                return nodeMap.get(href);
              }
              return node;
            },
          },
        );
      });
      return { renderer, nodes };
    }
    it("compact_view_keeps_name_and_keyboard_navigation", async () => {
      const { renderer, nodes } = await mount();
      expect(JSON.stringify(renderer.toJSON())).toContain("Welcome");
      await act(async () => {
        (
          renderer.root.findByType("ul").props.onKeyDown as (
            event: unknown,
          ) => void
        )({ key: "ArrowRight", target: nodes[0], preventDefault: vi.fn() });
      });
      expect(nodes[1]!.focus).toHaveBeenCalled();
      await act(async () => {
        (
          renderer.root.findByType("ul").props.onKeyDown as (
            event: unknown,
          ) => void
        )({ key: "Enter", target: nodes[1], preventDefault: vi.fn() });
      });
      expect(push).toHaveBeenCalledWith("/projects/p1/documents/d1");
      const html = renderWith(
        adapter,
        "icons",
        false,
        () => undefined,
        true,
        iconSize,
      );
      expect(html).toContain(`width:${iconSize === "compact" ? 24 : 40}px`);
      expect(html).toContain(`height:${iconSize === "compact" ? 24 : 40}px`);
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    });
    it("keeps drag/drop and context menus at both sizes", async () => {
      const onMove = vi.fn();
      const { renderer } = await mount(onMove);
      const rows = renderer.root.findAllByType("li");
      const data = new Map<string, string>();
      const transfer = {
        setData: (key: string, value: string) => data.set(key, value),
        getData: (key: string) => data.get(key) ?? "",
        get types() {
          return [...data.keys()];
        },
      };
      await act(async () => {
        (rows[1]!.props.onDragStart as (event: unknown) => void)({
          dataTransfer: transfer,
        });
        (rows[0]!.props.onDrop as (event: unknown) => void)({
          dataTransfer: transfer,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });
      expect(onMove).toHaveBeenCalledWith(document, ["guides"]);
      await act(async () =>
        (rows[0]!.props.onContextMenu as (event: unknown) => void)({
          currentTarget: { contains: () => true },
          target: {},
          preventDefault: vi.fn(),
        }),
      );
      expect(renderer.root.findByType(adapter.FolderActions).props.open).toBe(
        true,
      );
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    });
  },
);

describe("explorer appearance permission", () => {
  it("discards the active appearance target on demotion", async () => {
    let renderer!: ReactTestRenderer;
    const renderFor = (canEdit: boolean) => (
      <ContentExplorer
        projectId="p1"
        folderPath={[]}
        entries={[folder, document]}
        view="icons"
        searchActive={false}
        sort="title"
        dir="asc"
        onSortChange={() => undefined}
        onNavigateUp={() => undefined}
        folders={["guides"]}
        canEdit={canEdit}
        adapter={{ ...adapter, itemBadge: undefined }}
      />
    );
    await act(async () => {
      renderer = create(renderFor(true));
    });
    await act(async () => {
      (
        renderer.root.findByType(adapter.FolderActions).props
          .onAppearance as () => void
      )();
    });
    expect(
      renderer.root.findAllByProps({ "data-appearance-dialog": true }),
    ).toHaveLength(1);
    await act(async () => renderer.update(renderFor(false)));
    expect(
      renderer.root.findAllByProps({ "data-appearance-dialog": true }),
    ).toHaveLength(0);
    await act(async () => renderer.update(renderFor(true)));
    expect(
      renderer.root.findAllByProps({ "data-appearance-dialog": true }),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
  });
});

it.each(["list", "icons"] as const)(
  "selects objects without opening them and drags the selection in %s",
  async (view) => {
    const onSelectionChange = vi.fn();
    const onMoveEntries = vi.fn();
    const other = { ...folder, name: "Other", path: ["other"] };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ContentExplorer
          projectId="p1"
          folderPath={[]}
          entries={[folder, document, other]}
          view={view}
          searchActive={false}
          sort="title"
          dir="asc"
          onSortChange={() => undefined}
          onNavigateUp={() => undefined}
          folders={["guides", "other"]}
          canEdit
          adapter={{ ...adapter, itemBadge: undefined }}
          selectedKeys={new Set(["folder:guides", "item:d1"])}
          onSelectionChange={onSelectionChange}
          onMoveEntries={onMoveEntries}
        />,
      );
    });
    const link = (key: string) =>
      renderer.root.findByProps({ "data-explorer-entry": key });
    const clickEvent = (modifiers: Record<string, boolean>) => ({
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...modifiers,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    const click = async (key: string, event: ReturnType<typeof clickEvent>) =>
      act(async () => {
        (link(key).props.onClick as (event: unknown) => void)(event);
      });
    const plain = clickEvent({});
    await click("item:d1", plain);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
    const toggled = clickEvent({ ctrlKey: true });
    await click("item:d1", toggled);
    expect(toggled.preventDefault).toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(["folder:guides"]));
    await click("folder:other", clickEvent({ shiftKey: true }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      new Set(["folder:guides", "item:d1", "folder:other"]),
    );
    const container =
      view === "icons"
        ? renderer.root.findByType("ul")
        : renderer.root.findByProps({ "data-explorer-focus": true });
    const keyDown = container.props.onKeyDown as (event: unknown) => void;
    const keyEvent = (
      key: string,
      modifiers: Record<string, boolean> = {},
    ) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...modifiers,
      target: { dataset: { explorerEntry: "item:d1" } },
      preventDefault: vi.fn(),
    });
    const press = async (event: ReturnType<typeof keyEvent>) =>
      act(async () => {
        keyDown(event);
      });
    await press(keyEvent("a", { metaKey: true }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      new Set(["folder:guides", "item:d1", "folder:other"]),
    );
    await press(keyEvent(" "));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      new Set(["folder:guides"]),
    );
    const escape = keyEvent("Escape");
    await press(escape);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
    expect(
      renderer.root
        .findAllByType("input")
        .filter((input) => input.props.type === "checkbox"),
    ).toHaveLength(0);
    const rows =
      view === "icons"
        ? renderer.root.findAllByType("li")
        : renderer.root.findAllByType("tr").slice(1);
    const values = new Map<string, string>();
    const transfer = {
      effectAllowed: "none",
      setData: (key: string, value: string) => values.set(key, value),
      getData: (key: string) => values.get(key) ?? "",
    };
    await act(async () => {
      (rows[0]!.props.onDragStart as (event: unknown) => void)({
        dataTransfer: transfer,
      });
      (rows[0]!.props.onDrop as (event: unknown) => void)({
        dataTransfer: transfer,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    expect(onMoveEntries).not.toHaveBeenCalled();
    await act(async () => {
      (rows[2]!.props.onDrop as (event: unknown) => void)({
        dataTransfer: transfer,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    expect(onMoveEntries).toHaveBeenCalledWith([folder, document], ["other"]);
    await act(async () => renderer.unmount());
  },
);

it("keeps single-file drag downloads available to Viewers with multiple selected documents", async () => {
  const downloads: ExplorerAdapter<DocumentItem> = {
    ...adapter,
    itemBadge: undefined,
    itemDownload: () => ({ fileName: "welcome.md", href: "/download" }),
  };
  let renderer!: ReactTestRenderer;
  vi.stubGlobal("window", { location: { origin: "https://weaver.example" } });
  await act(async () => {
    renderer = create(
      <ContentExplorer
        projectId="p1"
        folderPath={[]}
        entries={[document, { ...document, id: "d2" }]}
        view="icons"
        searchActive={false}
        sort="title"
        dir="asc"
        onSortChange={() => undefined}
        onNavigateUp={() => undefined}
        folders={[]}
        canEdit={false}
        adapter={downloads}
        selectedKeys={new Set(["item:d1", "item:d2"])}
        onSelectionChange={() => undefined}
      />,
    );
  });
  const data = new Map<string, string>();
  await act(async () =>
    (
      renderer.root.findAllByType("li")[0]!.props.onDragStart as (
        event: unknown,
      ) => void
    )({
      dataTransfer: {
        effectAllowed: "none",
        setData: (key: string, value: string) => data.set(key, value),
      },
    }),
  );
  expect(data.get("DownloadURL")).toBe(
    "text/markdown:welcome.md:https://weaver.example/download",
  );
  expect(data.has("application/x-weaver-explorer-item")).toBe(false);
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/p1/tables",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));
vi.mock("~/components/background-work/BackgroundWorkProvider", () => ({
  useBackgroundWork: () => ({ pageVisible: true }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    tableFolder: {
      tree: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
          error: undefined,
          refetch: vi.fn(),
        }),
      },
    },
    table: {
      importCsv: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
    useUtils: () => ({
      tableFolder: { tree: { invalidate: vi.fn() } },
      table: { list: { invalidate: vi.fn() } },
    }),
  },
}));
vi.mock("./TableMutations", () => ({
  TableMutations: () => <button type="button">table actions</button>,
}));
vi.mock("./TableFolderMutations", () => ({
  TableFolderMutations: () => <button type="button">folder actions</button>,
  CreateTableFolderDialog: () => null,
}));
vi.mock("./CreateTableDialog", () => ({
  CreateTableDialog: () => null,
}));

import { ContentExplorer } from "~/components/explorer/ContentExplorer";
import type { FolderEntry, ItemEntry } from "~/lib/explorer/entries";
import type { TableItem } from "~/lib/tables/explorer";
import { TooltipProvider } from "~/components/ui/tooltip";
import { tablesExplorerAdapter } from "./tablesExplorerAdapter";

const folder: FolderEntry = {
  kind: "folder",
  name: "finance",
  path: ["finance"],
  itemCount: 1,
};
const table: ItemEntry<TableItem> = {
  kind: "item",
  id: "t1",
  title: "Budget",
  path: "budget.table",
  folderPath: [],
  lastEditedAt: new Date("2026-09-01T10:00:00Z"),
  lastEditedBy: null,
  rowCount: 3,
};

describe("tablesExplorerAdapter", () => {
  it("does not provide document-root reviewer actions", () => {
    expect(tablesExplorerAdapter.rootActions).toBeUndefined();
  });
  it("renders a Rows column and no index lights", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ContentExplorer
          projectId="p1"
          folderPath={[]}
          entries={[folder, table]}
          view="list"
          searchActive={false}
          sort="title"
          dir="asc"
          onSortChange={() => undefined}
          onNavigateUp={() => undefined}
          folders={["finance"]}
          canEdit
          adapter={tablesExplorerAdapter}
        />
      </TooltipProvider>,
    );
    expect(html).toContain(">Rows<");
    expect(html).toContain(">3<");
    expect(html).toContain('href="/projects/p1/tables?folder=finance"');
    expect(html).toContain('href="/projects/p1/tables/t1"');
    expect(html).not.toContain("data-light=");
    expect(html).toContain('aria-label="Tables and folders"');
  });

  it("labels the workspace canvas as the table workspace", () => {
    expect(tablesExplorerAdapter.copy.workspaceLabel).toBe("Table workspace");
  });
});

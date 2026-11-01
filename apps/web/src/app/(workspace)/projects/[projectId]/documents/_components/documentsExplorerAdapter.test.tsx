import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/p1/documents",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));
vi.mock("~/components/background-work/BackgroundWorkProvider", () => ({
  useBackgroundWork: () => ({ pageVisible: true }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    folder: {
      tree: {
        useQuery: () => ({
          data: undefined,
          isLoading: false,
          error: undefined,
          refetch: vi.fn(),
        }),
      },
    },
    document: {
      importFile: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
    useUtils: () => ({
      folder: { tree: { invalidate: vi.fn() } },
      document: { list: { invalidate: vi.fn() } },
    }),
  },
}));
vi.mock("./DocumentMutations", () => ({
  DocumentMutations: () => <button type="button">document actions</button>,
}));
vi.mock("./FolderMutations", () => ({
  FolderMutations: () => <button type="button">folder actions</button>,
  DocumentRootReviewAction: () => <button type="button">root reviewers</button>,
}));
vi.mock("./CreateDocumentDialog", () => ({
  CreateDocumentDialog: () => null,
}));
vi.mock("./CreateFolderDialog", () => ({
  CreateFolderDialog: () => null,
}));

import { ContentExplorer } from "~/components/explorer/ContentExplorer";
import type { FolderEntry, ItemEntry } from "~/lib/explorer/entries";
import type { DocumentItem } from "~/lib/documents/explorer";
import { TooltipProvider } from "~/components/ui/tooltip";
import { documentsExplorerAdapter } from "./documentsExplorerAdapter";

const folder: FolderEntry = {
  kind: "folder",
  name: "guides",
  path: ["guides"],
  itemCount: 1,
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

describe("documentsExplorerAdapter", () => {
  it("provides a document-root reviewer action independently of the folder tree", () => {
    expect(
      renderToStaticMarkup(
        <>{documentsExplorerAdapter.rootActions?.({ projectId: "p1" })}</>,
      ),
    ).toContain("root reviewers");
  });
  it("matches the copy and identity the shared explorer relies on", () => {
    expect(documentsExplorerAdapter.copy.dropZoneTestId).toBe(
      "documents-drop-zone",
    );
    expect(documentsExplorerAdapter.listLabel).toBe("Documents and folders");
    expect(documentsExplorerAdapter.copy.workspaceLabel).toBe(
      "Document workspace",
    );
    expect(documentsExplorerAdapter.viewStorageKey).toBe(
      "weaver-documents-view",
    );
    expect(documentsExplorerAdapter.searchInputId).toBe("document-search");
    expect(documentsExplorerAdapter.itemNoun).toEqual([
      "document",
      "documents",
    ]);
  });

  it("shows three index lights for a document in list view", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ContentExplorer
          projectId="p1"
          folderPath={[]}
          entries={[folder, document]}
          view="list"
          searchActive={false}
          sort="title"
          dir="asc"
          onSortChange={() => undefined}
          onNavigateUp={() => undefined}
          folders={["guides"]}
          canEdit
          adapter={documentsExplorerAdapter}
        />
      </TooltipProvider>,
    );
    expect(html.match(/data-light=/g)).toHaveLength(3);
  });

  it("lists who created and last updated each document", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ContentExplorer
          projectId="p1"
          folderPath={[]}
          entries={[document]}
          view="list"
          searchActive={false}
          sort="title"
          dir="asc"
          onSortChange={() => undefined}
          onNavigateUp={() => undefined}
          folders={[]}
          canEdit={false}
          adapter={documentsExplorerAdapter}
        />
      </TooltipProvider>,
    );
    for (const header of ["Created", "Created by", "Updated", "Updated by"])
      expect(html).toContain(`>${header}<`);
    expect(html).not.toContain(">Last edited<");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Sven");
  });
});

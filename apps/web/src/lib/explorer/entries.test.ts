import { describe, expect, it } from "vitest";

import {
  folderDisplayName,
  folderExists,
  folderHref,
  folderPathLabel,
  listFolderEntries,
  parentFolder,
  parseFolderParam,
  relativeFolderLabel,
  searchFolderEntries,
  sortEntries,
  upDropTarget,
  type ExplorerTree,
} from "./entries";

const editor = { id: "u1", name: "Sven", email: "sven@example.test" };
const item = (id: string, title: string, path: string, at: string) => ({
  id,
  title,
  path,
  lastEditedAt: new Date(at),
  lastEditedBy: editor,
});
const tree: ExplorerTree<ReturnType<typeof item>> = {
  folders: ["guides", "guides/setup", "guides/setup/linux", "archive"],
  items: [
    item("d1", "Welcome", "welcome.md", "2026-09-01T10:00:00Z"),
    item(
      "d2",
      "Installing",
      "guides/setup/installing.md",
      "2026-09-12T14:02:00Z",
    ),
    item(
      "d3",
      "Troubleshooting",
      "guides/setup/troubleshooting.md",
      "2026-09-10T09:15:00Z",
    ),
    item(
      "d4",
      "Linux notes",
      "guides/setup/linux/notes.md",
      "2026-09-11T08:00:00Z",
    ),
    item("d5", "Guide index", "guides/index.md", "2026-09-02T08:00:00Z"),
  ],
};

describe("listFolderEntries", () => {
  it("lists direct children at the root with recursive folder counts", () => {
    const { folders, items } = listFolderEntries(tree, []);
    expect(folders.map((f) => [f.name, f.itemCount])).toEqual([
      ["archive", 0],
      ["guides", 4],
    ]);
    expect(items.map((d) => d.id)).toEqual(["d1"]);
  });

  it("lists direct children of a nested folder only", () => {
    const { folders, items } = listFolderEntries(tree, ["guides", "setup"]);
    expect(folders.map((f) => f.path)).toEqual([["guides", "setup", "linux"]]);
    expect(items.map((d) => d.id)).toEqual(["d2", "d3"]);
    expect(items[0]!.folderPath).toEqual(["guides", "setup"]);
  });

  it("keeps extra item fields on entries", () => {
    const tree = {
      folders: [],
      items: [
        {
          id: "t1",
          title: "Budget",
          path: "tables/budget.table",
          lastEditedAt: new Date("2026-09-01T00:00:00Z"),
          lastEditedBy: null,
          rowCount: 7,
        },
      ],
    };
    const { items } = listFolderEntries(tree, ["tables"]);
    expect(items[0]).toMatchObject({
      kind: "item",
      rowCount: 7,
      folderPath: ["tables"],
    });
  });
});

describe("searchFolderEntries", () => {
  it("matches titles case-insensitively below the folder, ignoring blank queries", () => {
    // "Troubleshooting" and "Guide index" also contain "in".
    expect(
      searchFolderEntries(tree, ["guides"], "IN").map((d) => d.id),
    ).toEqual(["d5", "d2", "d4", "d3"]);
    expect(searchFolderEntries(tree, [], "   ")).toEqual([]);
  });
});

describe("sortEntries", () => {
  const { items } = listFolderEntries(tree, ["guides", "setup"]);
  it("sorts by title and by last edited in both directions", () => {
    expect(sortEntries(items, "title", "desc").map((d) => d.id)).toEqual([
      "d3",
      "d2",
    ]);
    expect(sortEntries(items, "lastEditedAt", "desc").map((d) => d.id)).toEqual(
      ["d2", "d3"],
    );
    expect(sortEntries(items, "lastEditedAt", "asc").map((d) => d.id)).toEqual([
      "d3",
      "d2",
    ]);
  });
  it("sorts folders by name regardless of the sort key", () => {
    const { folders } = listFolderEntries(tree, []);
    expect(
      sortEntries(folders, "lastEditedAt", "desc").map((f) => f.name),
    ).toEqual(["guides", "archive"]);
  });
  it("always sorts folders before items in a mixed array", () => {
    const root = listFolderEntries(tree, []);
    const setup = listFolderEntries(tree, ["guides", "setup"]);
    const mixed = [...root.folders, ...root.items, ...setup.items];
    expect(sortEntries(mixed, "title", "desc").map((e) => e.kind)).toEqual([
      "folder",
      "folder",
      "item",
      "item",
      "item",
    ]);
    expect(
      sortEntries(mixed, "lastEditedAt", "asc").map((e) => e.kind),
    ).toEqual(["folder", "folder", "item", "item", "item"]);
  });
});

describe("path helpers", () => {
  it("builds folder hrefs", () => {
    expect(folderHref("/projects/p1/documents", [])).toBe(
      "/projects/p1/documents",
    );
    expect(folderHref("/projects/p1/documents", ["a", "b"])).toBe(
      "/projects/p1/documents?folder=a%2Fb",
    );
  });
  it("computes parents and existence", () => {
    expect(parentFolder(["guides", "setup"])).toEqual(["guides"]);
    expect(parentFolder([])).toEqual([]);
    expect(folderExists(tree, [])).toBe(true);
    expect(folderExists(tree, ["guides", "setup"])).toBe(true);
    expect(folderExists(tree, ["nope"])).toBe(false);
  });
  it("labels a search hit relative to the searched folder", () => {
    const hits = searchFolderEntries(tree, ["guides"], "linux");
    expect(relativeFolderLabel(hits[0]!, ["guides"])).toBe("setup / linux");
    const direct = searchFolderEntries(tree, ["guides"], "Guide index");
    expect(relativeFolderLabel(direct[0]!, ["guides"])).toBe("—");
  });
});

describe("parseFolderParam", () => {
  it("accepts a valid nested path", () => {
    expect(parseFolderParam("guides/setup")).toEqual(["guides", "setup"]);
  });
  it("rejects an uppercase segment", () => {
    expect(parseFolderParam("Guides")).toEqual([]);
  });
  it("rejects an empty segment from a doubled, leading, or trailing slash", () => {
    expect(parseFolderParam("a//b")).toEqual([]);
    expect(parseFolderParam("/a/b")).toEqual([]);
    expect(parseFolderParam("a/b/")).toEqual([]);
  });
  it("rejects a depth over 10", () => {
    expect(
      parseFolderParam(Array.from({ length: 11 }, () => "a").join("/")),
    ).toEqual([]);
  });
  it("treats undefined and array values as the root", () => {
    expect(parseFolderParam(undefined)).toEqual([]);
    expect(parseFolderParam(["guides", "setup"])).toEqual([]);
  });
});

describe("folder display names", () => {
  it("labels folders by their stored name and falls back to the slug", () => {
    const named = {
      ...tree,
      folderNames: { guides: "Guides", "guides/setup": "Setup & Install" },
    };
    const root = listFolderEntries(named, []);
    expect(root.folders.map((folder) => folder.name)).toEqual([
      "archive",
      "Guides",
    ]);
    expect(root.folders[1]?.path).toEqual(["guides"]);
    expect(folderDisplayName(named.folderNames, ["guides", "setup"])).toBe(
      "Setup & Install",
    );
    expect(folderDisplayName(named.folderNames, ["archive"])).toBe("archive");
    expect(folderDisplayName(named.folderNames, [])).toBe("");
    expect(
      folderPathLabel(named.folderNames, ["guides", "setup", "linux"]),
    ).toBe("Guides / Setup & Install / linux");
  });
});

describe("upDropTarget", () => {
  it("moves a search hit up from its own folder, not the viewed one", () => {
    const entries = searchFolderEntries(tree, ["guides"], "notes");
    expect(upDropTarget(entries, "d4")).toEqual(["guides", "setup"]);
  });

  it("moves a direct child to the viewed folder's parent", () => {
    const { folders, items } = listFolderEntries(tree, ["guides", "setup"]);
    expect(upDropTarget([...folders, ...items], "d2")).toEqual(["guides"]);
  });

  it("ignores unknown ids and folders", () => {
    const { folders, items } = listFolderEntries(tree, []);
    expect(upDropTarget([...folders, ...items], "missing")).toBeUndefined();
    expect(upDropTarget(folders, "guides")).toBeUndefined();
  });
});

describe("appearance entries", () => {
  it("carries folder and leaf appearance without exposing a root folder", () => {
    const appearance = { backgroundColor: "#000000" };
    const tree = {
      folders: ["guides"],
      folderAppearances: { "": appearance, guides: appearance },
      items: [
        {
          id: "d",
          title: "Doc",
          path: "guides/doc.md",
          lastEditedAt: new Date(),
          lastEditedBy: null,
          appearance,
        },
      ],
    };
    expect(listFolderEntries(tree, []).folders).toEqual([
      expect.objectContaining({ name: "guides", appearance }),
    ]);
    expect(listFolderEntries(tree, ["guides"]).items[0]?.appearance).toEqual(
      appearance,
    );
  });
});

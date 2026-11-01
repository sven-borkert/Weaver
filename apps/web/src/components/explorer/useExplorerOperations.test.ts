import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerEntry, ExplorerItem } from "~/lib/explorer/entries";

const mocked = vi.hoisted(() => ({
  documentGet: vi.fn(),
  permissions: vi.fn(),
  mark: vi.fn(),
  tableGet: vi.fn(),
  tableDelete: vi.fn(),
  documentMove: vi.fn(),
  folderMove: vi.fn(),
  tableFolderMove: vi.fn(),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      client: {
        document: {
          get: { query: mocked.documentGet },
          reviewPermissions: { query: mocked.permissions },
          markReviewed: { mutate: mocked.mark },
          move: { mutate: mocked.documentMove },
        },
        table: {
          get: { query: mocked.tableGet },
          delete: { mutate: mocked.tableDelete },
        },
        folder: { move: { mutate: mocked.folderMove } },
        tableFolder: { move: { mutate: mocked.tableFolderMove } },
      },
    }),
  },
}));
import { useExplorerOperations } from "./useExplorerOperations";

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

beforeEach(() => {
  vi.resetAllMocks();
});
describe("explorer operations", () => {
  it("previews only permitted documents and sends their captured revisions", async () => {
    mocked.permissions
      .mockResolvedValueOnce({ canMarkReviewed: true })
      .mockResolvedValueOnce({ canMarkReviewed: false });
    mocked.documentGet.mockResolvedValue({ baseCommitSha: "reviewed-sha" });
    const operations = useExplorerOperations("p1", "documents");
    const prepared = await operations.prepare("review", [
      folder,
      item,
      { ...item, id: "d2" },
    ]);
    expect([...prepared.keys]).toEqual(["item:d1"]);
    await operations.run("review", item, [], prepared.revisions);
    expect(mocked.mark).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      expectedHeadCommitSha: "reviewed-sha",
    });
    expect(mocked.documentGet).toHaveBeenCalledTimes(1);
  });
  it("keeps the previewed table revision for deletion and requires a preview", async () => {
    mocked.tableGet.mockResolvedValue({ baseCommitSha: "before-confirmation" });
    const operations = useExplorerOperations("p1", "tables");
    const prepared = await operations.prepare("delete", [item]);
    await operations.run("delete", item, [], prepared.revisions);
    expect(mocked.tableDelete).toHaveBeenCalledWith({
      projectId: "p1",
      tableId: "d1",
      expectedHeadCommitSha: "before-confirmation",
    });
    await expect(operations.run("delete", item, [], {})).rejects.toThrow(
      "preview required",
    );
    expect(mocked.tableDelete).toHaveBeenCalledTimes(1);
  });
  it.each(["documents", "tables"] as const)(
    "moves folders through the %s folder endpoint",
    async (kind) => {
      await useExplorerOperations("p1", kind).run(
        "move",
        folder,
        ["other"],
        {},
      );
      expect(
        kind === "documents" ? mocked.folderMove : mocked.tableFolderMove,
      ).toHaveBeenCalledWith({
        projectId: "p1",
        path: ["guides"],
        newParentPath: ["other"],
      });
      expect(mocked.documentMove).not.toHaveBeenCalled();
    },
  );
});

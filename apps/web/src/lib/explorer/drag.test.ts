import { describe, expect, it } from "vitest";

import {
  carriesExplorerItem,
  carriesFiles,
  EXPLORER_ITEM_MIME,
  readDraggedItem,
  setDragDownload,
  setDraggedItem,
} from "./drag";

function fakeTransfer(data: Record<string, string> = {}) {
  return {
    types: Object.keys(data),
    effectAllowed: "none",
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? "",
  };
}

describe("explorer drag payload", () => {
  it("round-trips an item of the same kind", () => {
    const transfer = fakeTransfer();
    setDraggedItem(transfer, { kind: "documents", id: "d1" });
    expect(transfer.effectAllowed).toBe("move");
    expect(transfer.getData(EXPLORER_ITEM_MIME)).toContain('"d1"');
    expect(readDraggedItem(transfer, "documents")).toEqual({
      kind: "documents",
      id: "d1",
    });
    expect(readDraggedItem(transfer, "tables")).toBeNull();
  });

  it("ignores foreign or malformed payloads and null transfers", () => {
    expect(
      readDraggedItem(fakeTransfer({ [EXPLORER_ITEM_MIME]: "{" }), "documents"),
    ).toBeNull();
    expect(
      readDraggedItem(fakeTransfer({ "text/plain": "x" }), "documents"),
    ).toBeNull();
    expect(readDraggedItem(null, "documents")).toBeNull();
  });

  it("distinguishes item drags from file drops", () => {
    expect(
      carriesExplorerItem(fakeTransfer({ [EXPLORER_ITEM_MIME]: "{}" })),
    ).toBe(true);
    expect(carriesExplorerItem(fakeTransfer({ Files: "" }))).toBe(false);
    expect(carriesFiles(fakeTransfer({ Files: "" }))).toBe(true);
    expect(carriesFiles(null)).toBe(false);
  });

  it("offers a file download next to the move payload", () => {
    const transfer = fakeTransfer();
    setDraggedItem(transfer, { kind: "documents", id: "d1" });
    setDragDownload(
      transfer,
      {
        fileName: "notes.md",
        href: "/weaver/api/documents/d1/markdown?projectId=p1",
      },
      "https://weaver.example",
    );
    expect(transfer.getData("DownloadURL")).toBe(
      "text/markdown:notes.md:https://weaver.example/weaver/api/documents/d1/markdown?projectId=p1",
    );
    expect(transfer.effectAllowed).toBe("copyMove");
    expect(readDraggedItem(transfer, "documents")).toEqual({
      kind: "documents",
      id: "d1",
    });
  });

  it("offers a download alone as a copy", () => {
    const transfer = fakeTransfer();
    setDragDownload(
      transfer,
      { fileName: "notes.md", href: "/api/documents/d1/markdown" },
      "https://weaver.example",
    );
    expect(transfer.effectAllowed).toBe("copy");
    expect(carriesExplorerItem(transfer)).toBe(false);
  });

  it("keeps the file name from splitting the DownloadURL fields", () => {
    const transfer = fakeTransfer();
    setDragDownload(
      transfer,
      { fileName: "a:b/c.md", href: "/x" },
      "https://weaver.example",
    );
    expect(transfer.getData("DownloadURL")).toBe(
      "text/markdown:a_b_c.md:https://weaver.example/x",
    );
  });
});

it("round-trips a folder and multiple items only within the originating project", async () => {
  const { setDraggedEntries, readDraggedEntries } = await import("./drag");
  const transfer = fakeTransfer();
  const entries = [
    { kind: "folder" as const, path: ["guides"] },
    { kind: "item" as const, id: "d1" },
  ];
  setDraggedEntries(transfer, "documents", "p1", entries);
  expect(readDraggedEntries(transfer, "documents", "p1")).toEqual(entries);
  expect(readDraggedEntries(transfer, "documents", "p2")).toEqual([]);
  expect(readDraggedEntries(transfer, "tables", "p1")).toEqual([]);
  expect(
    readDraggedEntries(
      fakeTransfer({
        [EXPLORER_ITEM_MIME]:
          '{"kind":"documents","projectId":"p1","entries":[{"kind":"folder","path":[null]}]}',
      }),
      "documents",
      "p1",
    ),
  ).toEqual([]);
});

import { describe, expect, it } from "vitest";
import {
  applySelectionGesture,
  canMoveEntries,
  entryKey,
  moveRoots,
  runEntryBatch,
  selectionGesture,
} from "./selection";
import type { ExplorerEntry, ExplorerItem } from "./entries";

const folder: ExplorerEntry<ExplorerItem> = {
  kind: "folder",
  name: "Guides",
  path: ["guides"],
  itemCount: 1,
};
const item: ExplorerEntry<ExplorerItem> = {
  kind: "item",
  id: "d1",
  title: "Intro",
  path: "guides/intro.md",
  folderPath: ["guides"],
  lastEditedAt: new Date(),
  lastEditedBy: null,
};

describe("explorer selection", () => {
  it("moves selected folders once without separately moving their descendants", () => {
    expect(
      moveRoots([item, folder, { ...folder, path: ["guides", "nested"] }]),
    ).toEqual([folder]);
  });
  it("rejects self and descendant destinations without confusing sibling prefixes", () => {
    expect(canMoveEntries([folder], ["guides"])).toBe(false);
    expect(canMoveEntries([folder], ["guides", "nested"])).toBe(false);
    expect(canMoveEntries([folder], ["guides-other"])).toBe(true);
    expect(canMoveEntries([folder], [])).toBe(false);
    expect(canMoveEntries([item], ["guides"])).toBe(false);
  });
  it("runs serially, keeps failures retryable, and continues after errors", async () => {
    const other = { ...item, id: "d2" };
    const visited: string[] = [];
    const result = await runEntryBatch([item, other], async (entry) => {
      visited.push(entryKey(entry));
      if (entry === item) throw new Error("changed");
    });
    expect(visited).toEqual(["item:d1", "item:d2"]);
    expect(result.succeeded).toEqual(["item:d2"]);
    expect(result.failed).toEqual(["item:d1"]);
  });
});

describe("selection gestures", () => {
  const entries: ExplorerEntry<ExplorerItem>[] = [
    folder,
    { ...folder, name: "Nested", path: ["guides", "nested"] },
    item,
    { ...item, id: "d2", title: "Outro" },
  ];

  it("maps modifiers to gestures and leaves plain clicks alone", () => {
    expect(
      selectionGesture({ ctrlKey: false, metaKey: false, shiftKey: false }),
    ).toBeUndefined();
    expect(
      selectionGesture({ ctrlKey: true, metaKey: false, shiftKey: false }),
    ).toBe("toggle");
    expect(
      selectionGesture({ ctrlKey: false, metaKey: true, shiftKey: false }),
    ).toBe("toggle");
    expect(
      selectionGesture({ ctrlKey: true, metaKey: false, shiftKey: true }),
    ).toBe("range");
  });

  it("toggles one entry without touching the rest", () => {
    const selected = new Set(["folder:guides"]);
    expect(
      applySelectionGesture(entries, selected, undefined, "item:d1", "toggle"),
    ).toEqual(new Set(["folder:guides", "item:d1"]));
    expect(
      applySelectionGesture(
        entries,
        selected,
        undefined,
        "folder:guides",
        "toggle",
      ),
    ).toEqual(new Set());
  });

  it("adds the range between the anchor and the target in either direction", () => {
    expect(
      applySelectionGesture(
        entries,
        new Set(["item:d2"]),
        "folder:guides",
        "item:d1",
        "range",
      ),
    ).toEqual(
      new Set(["folder:guides", "folder:guides/nested", "item:d1", "item:d2"]),
    );
    expect(
      applySelectionGesture(
        entries,
        new Set(),
        "item:d1",
        "folder:guides",
        "range",
      ),
    ).toEqual(new Set(["folder:guides", "folder:guides/nested", "item:d1"]));
  });

  it("falls back to the target alone when the anchor is unknown or gone", () => {
    expect(
      applySelectionGesture(entries, new Set(), undefined, "item:d2", "range"),
    ).toEqual(new Set(["item:d2"]));
    expect(
      applySelectionGesture(
        entries,
        new Set(),
        "item:gone",
        "item:d2",
        "range",
      ),
    ).toEqual(new Set(["item:d2"]));
    expect(
      applySelectionGesture(
        entries,
        new Set(),
        "item:d1",
        "item:gone",
        "range",
      ),
    ).toEqual(new Set());
  });
});

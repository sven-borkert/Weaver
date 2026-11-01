import { describe, expect, it } from "vitest";

import {
  buildImportRows,
  filterImportRows,
  importButtonLabel,
  importPayload,
  importResultSummary,
  initialImportSelection,
  isRowSelectable,
  selectionForUpdateExisting,
  toggleVisibleSelection,
  type DiscoveredModelLike,
} from "./importModels";

function model(
  providerModelId: string,
  overrides: Partial<DiscoveredModelLike> = {},
): DiscoveredModelLike {
  return {
    providerModelId,
    displayName: providerModelId.toUpperCase(),
    contextWindow: null,
    maxOutputTokens: null,
    embeddingDimensions: null,
    capabilities: ["chat"],
    source: "inferred",
    ...overrides,
  };
}

const discovered = [
  model("chat-a", { contextWindow: 8192 }),
  model("embed-a", { capabilities: ["embedding"] }),
  model("declared", { maxOutputTokens: 100 }),
  model("chat-a", { displayName: "duplicate" }),
];

describe("buildImportRows", () => {
  it("marks declared models, drops duplicates, and keeps provider order", () => {
    const rows = buildImportRows(discovered, ["declared"]);
    expect(rows.map((row) => [row.providerModelId, row.declared])).toEqual([
      ["chat-a", false],
      ["embed-a", false],
      ["declared", true],
    ]);
    expect(rows[0]?.displayName).toBe("CHAT-A");
  });
});

describe("selection helpers", () => {
  const rows = buildImportRows(discovered, ["declared"]);

  it("preselects only undeclared rows", () => {
    expect([...initialImportSelection(rows)]).toEqual(["chat-a", "embed-a"]);
  });

  it("makes declared rows selectable only when updating existing models", () => {
    expect(isRowSelectable(rows[2]!, false)).toBe(false);
    expect(isRowSelectable(rows[2]!, true)).toBe(true);
    expect(isRowSelectable(rows[0]!, false)).toBe(true);
  });

  it("toggles only the visible, selectable rows", () => {
    const visible = filterImportRows(rows, "a");
    const selected = toggleVisibleSelection(new Set(), visible, false, true);
    expect([...selected]).toEqual(["chat-a", "embed-a"]);
    const cleared = toggleVisibleSelection(selected, [rows[0]!], false, false);
    expect([...cleared]).toEqual(["embed-a"]);
    const withDeclared = toggleVisibleSelection(new Set(), rows, true, true);
    expect([...withDeclared]).toEqual(["chat-a", "embed-a", "declared"]);
    expect([...toggleVisibleSelection(new Set(), rows, false, true)]).toEqual([
      "chat-a",
      "embed-a",
    ]);
  });

  it("adds or removes every declared row when the update option changes", () => {
    const base = new Set(["chat-a"]);
    expect([...selectionForUpdateExisting(base, rows, true)]).toEqual([
      "chat-a",
      "declared",
    ]);
    expect([
      ...selectionForUpdateExisting(
        new Set(["chat-a", "declared"]),
        rows,
        false,
      ),
    ]).toEqual(["chat-a"]);
  });
});

describe("filterImportRows", () => {
  const rows = buildImportRows(discovered, []);

  it("matches ids and display names case-insensitively and treats blank as all", () => {
    expect(filterImportRows(rows, "  ").length).toBe(3);
    expect(
      filterImportRows(rows, "EMBED").map((row) => row.providerModelId),
    ).toEqual(["embed-a"]);
    expect(
      filterImportRows(rows, "chat-A").map((row) => row.providerModelId),
    ).toEqual(["chat-a"]);
    expect(filterImportRows(rows, "zzz")).toEqual([]);
  });
});

describe("importPayload", () => {
  it("sends only the selected rows without UI-only fields, preserving nulls and order", () => {
    const rows = buildImportRows(discovered, ["declared"]);
    expect(importPayload(rows, new Set(["declared", "chat-a"]))).toEqual([
      {
        providerModelId: "chat-a",
        displayName: "CHAT-A",
        capabilities: ["chat"],
        contextWindow: 8192,
        maxOutputTokens: null,
        embeddingDimensions: null,
      },
      {
        providerModelId: "declared",
        displayName: "DECLARED",
        capabilities: ["chat"],
        contextWindow: null,
        maxOutputTokens: 100,
        embeddingDimensions: null,
      },
    ]);
  });
});

describe("labels", () => {
  it("pluralises the import button", () => {
    expect(importButtonLabel(1)).toBe("Import 1 model");
    expect(importButtonLabel(2)).toBe("Import 2 models");
    expect(importButtonLabel(0)).toBe("Import models");
  });

  it("summarises import results", () => {
    expect(importResultSummary({ created: 2, updated: 0 })).toBe(
      "Imported 2 models",
    );
    expect(importResultSummary({ created: 1, updated: 2 })).toBe(
      "Imported 1 model, updated 2",
    );
    expect(importResultSummary({ created: 0, updated: 1 })).toBe(
      "Updated 1 model",
    );
    expect(importResultSummary({ created: 0, updated: 0 })).toBe(
      "No models imported",
    );
  });
});

describe("models without a supported capability", () => {
  const rows = buildImportRows(
    [
      model("gpt-4o"),
      model("whisper-1", { capabilities: [] }),
      model("tts-1", { capabilities: [] }),
    ],
    ["tts-1"],
  );

  it("never selects them, so the default import stays valid", () => {
    expect([...initialImportSelection(rows)]).toEqual(["gpt-4o"]);
    expect(isRowSelectable(rows[1]!, true)).toBe(false);
    expect([...toggleVisibleSelection(new Set(), rows, true, true)]).toEqual([
      "gpt-4o",
    ]);
    expect([...selectionForUpdateExisting(new Set(), rows, true)]).toEqual([]);
    expect(
      importPayload(rows, new Set(["gpt-4o", "whisper-1"])).map(
        (entry) => entry.providerModelId,
      ),
    ).toEqual(["gpt-4o"]);
  });
});

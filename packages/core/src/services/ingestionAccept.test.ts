import { describe, expect, it } from "vitest";
import { inferColumnTypes } from "../ingestion/columnTypes";
import { buildAcceptOperation, type AcceptableDraft } from "./ingestionAccept";

const PROJECT = "11111111-1111-4111-8111-111111111111";

const draft: AcceptableDraft = {
  targetKind: "table",
  proposedTitle: "External records",
  proposedFolderPath: "",
  markdown: null,
  columns: [
    { name: "ID", type: "text" },
    { name: "Amount", type: "text" },
  ],
  rows: [
    ["9007199254740992", "0.1"],
    ["9007199254740993", "1.00"],
  ],
  links: [],
};

describe("buildAcceptOperation numeric conversion", () => {
  it("preserves inferred identifiers and converts ordinary decimal amounts", () => {
    const operation = buildAcceptOperation(PROJECT, {
      ...draft,
      columns: inferColumnTypes(draft.columns!, draft.rows!),
    });
    expect(operation).toMatchObject({
      kind: "table.create",
      columns: [
        { name: "ID", type: "text" },
        { name: "Amount", type: "number" },
      ],
    });
    if (operation.kind !== "table.create") throw new Error("unexpected kind");
    const id = operation.columns[0]?.id;
    const amount = operation.columns[1]?.id;
    if (!id || !amount) throw new Error("missing column ids");
    expect(operation.rows.map((row) => row.cells)).toEqual([
      { [id]: "9007199254740992", [amount]: 0.1 },
      { [id]: "9007199254740993", [amount]: 1 },
    ]);
  });

  it("rejects an explicitly numeric draft before building a lossy operation", () => {
    expect(() =>
      buildAcceptOperation(PROJECT, {
        ...draft,
        columns: [
          { name: "ID", type: "number" },
          { name: "Amount", type: "number" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "BAD_REQUEST",
        details: { field: "columns" },
        message: "column ID cannot be number: row 2",
      }),
    );
  });
});

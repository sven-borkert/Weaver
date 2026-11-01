import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareMachineChange } from "./changes";
describe("machine prospective changes", () => {
  const ids = {
    resourceId: randomUUID(),
    columnIds: [],
    rowIds: [],
    createdAt: new Date().toISOString(),
  };
  it("rejects managed document headers but preserves fenced examples", () => {
    expect(() =>
      prepareMachineChange(
        {
          kind: "document.create",
          title: "Audit",
          folder: { root: true },
          markdown: "<!-- weaver\nid: forged\n-->",
        },
        null,
        ids,
      ),
    ).toThrow();
    expect(() =>
      prepareMachineChange(
        {
          kind: "document.create",
          title: "Audit",
          folder: { root: true },
          markdown: "---\nid: forged\n---",
        },
        null,
        ids,
      ),
    ).toThrow();
    expect(
      prepareMachineChange(
        {
          kind: "document.create",
          title: "Audit",
          folder: { root: true },
          markdown: "```yaml\n---\nid: example\n---\n```",
        },
        null,
        ids,
      ).markdown,
    ).toContain("id: example");
  });
  it("applies canonical cell-size validation before a reservation can be made", () => {
    const id = randomUUID();
    const rowId = randomUUID();
    expect(() =>
      prepareMachineChange(
        {
          kind: "table.create",
          title: "Audit",
          folder: { root: true },
          columns: [{ id, name: "Account", type: "text" }],
          rows: [{ id: rowId, cells: { [id]: "x".repeat(10001) } }],
        },
        null,
        { ...ids, columnIds: [id], rowIds: [rowId] },
      ),
    ).toThrow();
  });
});

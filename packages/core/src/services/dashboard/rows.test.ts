import { describe, expect, it } from "vitest";
import {
  parseRecentRows,
  parseActivityRows,
  parseProjectRows,
  parseReportRows,
} from "./rows";
describe("dashboard runtime rows", () => {
  it("accepts empty statement envelopes and rejects unknown provider fields", () => {
    const envelope = [{ items: [], observedAt: new Date() }];
    expect(parseRecentRows(envelope)[0].items).toEqual([]);
    expect(parseReportRows(envelope)[0].items).toEqual([]);
    for (const parse of [
      parseRecentRows,
      parseActivityRows,
      parseProjectRows,
      parseReportRows,
    ]) {
      expect(() =>
        parse([{ ...envelope[0], secret: "provider secret" }]),
      ).toThrow("Invalid dashboard result");
      expect(() => parse([])).toThrow("Invalid dashboard result");
    }
  });
  it("rejects oversized arrays and invalid scalar shapes", () => {
    for (const items of [[{ id: "bad", title: "secret" }], Array(21).fill({})])
      expect(() =>
        parseRecentRows([{ items, observedAt: new Date() }]),
      ).toThrow("Invalid dashboard result");
  });
});

it("validates real-shaped content scalars and destination identity", () => {
  const id = "4507c3f4-86d6-4558-86d3-69213c6b2646";
  const row = {
    id,
    kind: "document",
    title: "A",
    projectId: id,
    projectName: "P",
    lastEditedAt: "2026-09-08T12:00:00",
    editorName: null,
    isOwnChange: false,
    documentKind: "markdown",
    destination: { kind: "document", projectId: id, documentId: id },
  };
  const parse = (item: unknown) =>
    parseRecentRows([{ items: [item], observedAt: new Date() }]);
  expect(parse(row)[0].items[0]?.lastEditedAt).toBe("2026-09-08T12:00:00.000Z");
  for (const invalid of [
    { ...row, id: "bad" },
    { ...row, title: "x".repeat(201) },
    { ...row, lastEditedAt: "invalid" },
    { ...row, isOwnChange: "false" },
    { ...row, editorName: 42 },
    { ...row, provider: "secret" },
    {
      ...row,
      destination: {
        ...row.destination,
        documentId: "00000000-0000-4000-8000-000000000000",
      },
    },
    { ...row, destination: { ...row.destination, body: "secret" } },
  ])
    expect(() => parse(invalid)).toThrow("Invalid dashboard result");
});

it("rejects active work in the completed activity relation", () => {
  const id = "4507c3f4-86d6-4558-86d3-69213c6b2646";
  const row = {
    id,
    source: "task",
    category: "work_result",
    title: "Task",
    projectId: id,
    projectName: "P",
    sortAt: "2026-09-08T12:00:00Z",
    occurredAt: null,
    editorName: null,
    isOwnChange: null,
    state: "queued",
    sourceStatus: "queued",
    destination: { kind: "task", projectId: id, taskId: id },
    currentReport: null,
  };
  expect(() =>
    parseActivityRows([
      {
        items: [row],
        asOf: new Date(),
        contentWindowStart: new Date(),
        workWindowStart: new Date(),
      },
    ]),
  ).toThrow("Invalid dashboard result");
});

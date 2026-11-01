import { decodeContentCursor } from "@weaver/core/services/contentCursors";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS } from "../contract";
import { pageListCell, pageTextCell } from "./tableReads";

describe("pageListCell", () => {
  const ids = Array.from(
    { length: 200 },
    (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
  );
  const labelById = new Map(ids.map((id, i) => [id, `Option ${i}`.repeat(10)]));

  it("returns everything in one page when it fits the budget", () => {
    const small = ids.slice(0, 3);
    const page = pageListCell(small, labelById, 0);
    expect(page.values).toEqual(small);
    expect(page.labels).toEqual(small.map((id) => labelById.get(id)));
    expect(page.nextOffset).toBeNull();
  });

  it("truncates a 200-option cell with 100-char labels instead of exceeding the output budget", () => {
    // Each label is a real 100-char option-label-sized string (columnSchema
    // caps a select/multiselect option label at 100 chars), so the full set
    // of 200 ids + labels is far larger than MAX_TOOL_OUTPUT_CHARS.
    const wideLabelById = new Map(
      ids.map((id, i) => [id, `Option ${i}`.padEnd(100, ".")]),
    );
    const page = pageListCell(ids, wideLabelById, 0);
    expect(page.values.length).toBeGreaterThan(0);
    expect(page.values.length).toBeLessThan(ids.length);
    expect(page.labels).toHaveLength(page.values.length);
    expect(page.nextOffset).not.toBeNull();
    expect(page.nextOffset!).toBe(page.values.length);
  });

  it("pages through the whole cell across several calls, in order, with no gaps or repeats", () => {
    const wideLabelById = new Map(
      ids.map((id, i) => [id, `Option ${i}`.padEnd(100, ".")]),
    );
    const collected: string[] = [];
    let offset: number | null = 0;
    let calls = 0;
    while (offset !== null) {
      calls += 1;
      expect(calls).toBeLessThan(20); // guards against an infinite loop on a regression
      const page = pageListCell(ids, wideLabelById, offset);
      expect(page.values.length).toBeGreaterThan(0);
      collected.push(...page.values);
      offset = page.nextOffset;
    }
    expect(calls).toBeGreaterThan(1);
    expect(collected).toEqual(ids);
  });

  it("charges CJK labels by their bytes", () => {
    const cjkLabelById = new Map(ids.map((id) => [id, "漢".repeat(100)]));
    const page = pageListCell(ids, cjkLabelById, 0);
    expect(page.values.length).toBeGreaterThan(0);
    expect(page.values.length).toBeLessThan(45);
    expect(
      Buffer.byteLength(
        JSON.stringify({ values: page.values, labels: page.labels }),
      ),
    ).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(page.nextOffset).toBe(page.values.length);
  });

  it("returns an empty page with no next offset for an already-exhausted cursor", () => {
    const page = pageListCell(ids.slice(0, 5), labelById, 5);
    expect(page).toEqual({ values: [], labels: [], nextOffset: null });
  });

  it("clamps a single label too large to fit any page, instead of returning an empty page forever", () => {
    const hugeId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000000";
    const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
    // Longer than the whole page budget by itself — built directly rather
    // than through columnSchema, whose 100-char option-label cap a stored
    // option could still exceed from data written before that cap existed.
    const hugeLabel = "x".repeat(20_000);
    const wideLabelById = new Map([
      [hugeId, hugeLabel],
      [otherId, "Normal"],
    ]);
    const page = pageListCell([hugeId, otherId], wideLabelById, 0);
    expect(page.values).toEqual([hugeId]);
    expect(page.labels).toHaveLength(1);
    expect(page.labels[0]!.length).toBeGreaterThan(0);
    expect(page.labels[0]!.length).toBeLessThan(hugeLabel.length);
    expect(hugeLabel.startsWith(page.labels[0]!)).toBe(true);
    // The cursor still advances past the oversized entry — offset 0 in,
    // offset 1 out — instead of repeating the same empty page forever.
    expect(page.nextOffset).toBe(1);

    const next = pageListCell(
      [hugeId, otherId],
      wideLabelById,
      page.nextOffset!,
    );
    expect(next).toEqual({
      values: [otherId],
      labels: ["Normal"],
      nextOffset: null,
    });
  });
});

describe("pageTextCell", () => {
  const binding = {
    kind: "cell" as const,
    projectId: "11111111-1111-4111-8111-111111111111",
    resourceId: "22222222-2222-4222-8222-222222222222",
    snapshotCommitSha: "a".repeat(40),
    query: "b".repeat(64),
  };
  const outer = {
    tableId: binding.resourceId,
    rowId: "33333333-3333-4333-8333-333333333333",
    columnId: "44444444-4444-4444-8444-444444444444",
    snapshotCommitSha: binding.snapshotCommitSha,
    baseCommitSha: "c".repeat(40),
  };

  beforeAll(() => {
    process.env.AUTH_SECRET ??= "unit-test-cursor-secret";
  });

  it("keeps a structured nextCursor for an all-quotes cell and reassembles it exactly", () => {
    const raw = '"'.repeat(20_000) + "😀tail";
    let collected = "";
    let offset = 0;
    let calls = 0;
    for (;;) {
      calls += 1;
      expect(calls).toBeLessThan(20);
      const value = pageTextCell(raw, offset, 8_000, binding, outer);
      expect(JSON.stringify({ ...outer, value }).length).toBeLessThanOrEqual(
        MAX_TOOL_OUTPUT_CHARS,
      );
      expect(value.offset).toBe(offset);
      expect(value.totalChars).toBe(raw.length);
      expect(value.text.length).toBeGreaterThan(0);
      collected += value.text;
      expect(value.hasMore).toBe(value.nextCursor !== null);
      if (value.nextCursor === null) break;
      offset = decodeContentCursor(value.nextCursor, binding).position;
      expect(offset).toBe(collected.length);
    }
    expect(calls).toBeGreaterThan(2);
    expect(collected).toBe(raw);
  });

  it("pages a CJK cell by bytes and reassembles it exactly", () => {
    const raw = "漢".repeat(20_000);
    let collected = "";
    let offset = 0;
    let calls = 0;
    for (;;) {
      calls += 1;
      expect(calls).toBeLessThan(20);
      const value = pageTextCell(raw, offset, 8_000, binding, outer);
      expect(
        Buffer.byteLength(JSON.stringify({ ...outer, value })),
      ).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      collected += value.text;
      if (value.nextCursor === null) break;
      offset = decodeContentCursor(value.nextCursor, binding).position;
    }
    expect(calls).toBeGreaterThan(3);
    expect(collected).toBe(raw);
  });

  it("returns an ordinary cell in one page", () => {
    const value = pageTextCell("hello", 0, 8_000, binding, outer);
    expect(value).toEqual({
      kind: "text",
      offset: 0,
      totalChars: 5,
      text: "hello",
      nextCursor: null,
      hasMore: false,
    });
  });
});

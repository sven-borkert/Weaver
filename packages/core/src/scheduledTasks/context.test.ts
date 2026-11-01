import { describe, expect, it } from "vitest";
import {
  computeTaskBudget,
  cutToBytes,
  fitWithinBudget,
  renderDigest,
  renderTableSample,
  selectWithinBudget,
  takeWithinBudget,
  TASK_MAX_OUTPUT_TOKENS,
} from "./context";

describe("computeTaskBudget", () => {
  it("subtracts the prompt overhead and caps the output allowance", () => {
    const budget = computeTaskBudget({
      contextWindow: 32000,
      maxOutputTokens: 8192,
      systemPrompt: "x".repeat(1000),
      instruction: "y".repeat(500),
    });
    expect(budget.maxOutputTokens).toBe(4000); // min(8192, 4096, 32000 / 8)
    expect(budget.inputBytes).toBe(32000 - 1000 - 500 - 1024 - 4000);
    expect(TASK_MAX_OUTPUT_TOKENS).toBe(4096);
  });

  it("defaults the context window and refuses a window that leaves nothing", () => {
    expect(
      computeTaskBudget({
        contextWindow: null,
        maxOutputTokens: null,
        systemPrompt: "",
        instruction: "",
      }).maxOutputTokens,
    ).toBe(4000);
    expect(() =>
      computeTaskBudget({
        contextWindow: 2000,
        maxOutputTokens: null,
        systemPrompt: "x".repeat(1500),
        instruction: "",
      }),
    ).toThrow(/context window/);
  });
});

describe("takeWithinBudget", () => {
  it("keeps whole blocks in order until the budget is spent and reports truncation", () => {
    const result = takeWithinBudget(["aaaa", "bbbb", "cccc"], 10);
    expect(result.blocks).toEqual(["aaaa", "bbbb"]);
    expect(result.truncated).toBe(true);
  });

  it("charges the two-byte joining separator between blocks", () => {
    expect(takeWithinBudget(["aaaa", "bbbb"], 9).blocks).toEqual(["aaaa"]);
    expect(takeWithinBudget(["aaaa", "bbbb"], 10).truncated).toBe(false);
    expect(takeWithinBudget(["aa"], 100)).toEqual({
      blocks: ["aa"],
      truncated: false,
    });
  });
});

describe("selectWithinBudget", () => {
  it("counts only the kept blocks, by kind", () => {
    const tagged = [
      { kind: "document" as const, text: "aaaa", truncated: false },
      { kind: "table" as const, text: "bbbb", truncated: false },
      { kind: "document" as const, text: "cccc", truncated: false },
    ];
    expect(selectWithinBudget(tagged, 10)).toEqual({
      blocks: ["aaaa", "bbbb"],
      documents: 1,
      tables: 1,
      truncated: true,
    });
    expect(selectWithinBudget(tagged, 1000)).toEqual({
      blocks: ["aaaa", "bbbb", "cccc"],
      documents: 2,
      tables: 1,
      truncated: false,
    });
  });
});

describe("fitWithinBudget", () => {
  const block = (title: string, size: number, truncated = false) => ({
    text: `## Document: ${title}\n${"x".repeat(size)}`,
    truncated,
  });

  it("keeps the head of the first block that does not fit, then stops", () => {
    const small = block("Small", 100);
    const result = fitWithinBudget(
      [small, block("Large", 5000), block("Later", 10)],
      1000,
    );
    expect(result.truncated).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toBe(small);
    const partial = result.blocks[1]!;
    expect(partial.truncated).toBe(true);
    expect(partial.text.startsWith("## Document: Large\n")).toBe(true);
    expect(partial.text.endsWith("_[truncated]_")).toBe(true);
    const joined = result.blocks.map((kept) => kept.text).join("\n\n");
    expect(Buffer.byteLength(joined, "utf8")).toBe(1000);
  });

  it("cuts an oversized only block instead of dropping it", () => {
    const result = fitWithinBudget([block("Huge", 32_000)], 2000);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.text).toContain("## Document: Huge");
    expect(Buffer.byteLength(result.blocks[0]!.text, "utf8")).toBe(2000);
    expect(result.truncated).toBe(true);
  });

  it("drops the block when the remaining room is below the minimum", () => {
    const first = block("First", 1000);
    const size = Buffer.byteLength(first.text, "utf8");
    const result = fitWithinBudget([first, block("Second", 1000)], size + 257);
    expect(result.blocks).toEqual([first]);
    expect(result.truncated).toBe(true);
    // 258 spare bytes leave 256 after the two-byte separator.
    expect(
      fitWithinBudget([first, block("Second", 1000)], size + 258).blocks,
    ).toHaveLength(2);
  });

  it("reports a kept block that was already cut at its source", () => {
    expect(fitWithinBudget([block("Cut", 10, true)], 1000).truncated).toBe(
      true,
    );
    expect(fitWithinBudget([block("Whole", 10)], 1000).truncated).toBe(false);
  });
});

describe("cutToBytes", () => {
  it("keeps a fitting string and cuts multi-byte text within the byte budget", () => {
    expect(cutToBytes("hello", 100)).toBe("hello");
    const text = "ä".repeat(200); // two bytes each
    const cut = cutToBytes(text, 64);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(64);
    expect(cut).toContain("_[truncated]_");
    expect(text.startsWith(cut.slice(0, cut.indexOf("\n\n")))).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(50); // four bytes, two UTF-16 units each
    const cut = cutToBytes(text, 40);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(40);
    expect(
      [...cut].every(
        (char) => char === "😀" || "\n\n_[truncated]_".includes(char),
      ),
    ).toBe(true);
  });
});

describe("renderDigest", () => {
  it("lists commits with their changed titles and excludes the output document", () => {
    const text = renderDigest(
      [
        {
          projectName: "Ops",
          commits: [
            {
              sha: "abc",
              date: new Date("2026-09-08T10:00:00Z"),
              authorName: "Alice",
              message: "update: runbook",
              changeSummary: null,
              documents: [
                { id: "d1", title: "Runbook", path: "runbook.md", status: "M" },
                { id: "out", title: "Digest", path: "digest.md", status: "M" },
              ],
              tables: [
                { id: "t1", title: "Hosts", path: "tables/hosts", status: "A" },
              ],
            },
          ],
          diffs: [
            {
              title: "Runbook",
              lines: ["+ restart nginx", "- restart apache"],
            },
          ],
        },
      ],
      { excludeDocumentId: "out" },
    );
    expect(text).toContain("Ops");
    expect(text).toContain("Runbook (modified)");
    expect(text).toContain("Hosts (added)");
    expect(text).not.toContain("Digest");
    expect(text).toContain("+ restart nginx");
  });

  it("appends a ready change summary to the commit message", () => {
    const commit = {
      sha: "def",
      date: new Date("2026-09-08T11:00:00Z"),
      authorName: "Bob",
      message: "update: runbook.md",
      documents: [
        { id: "d1", title: "Runbook", path: "runbook.md", status: "M" },
      ],
      tables: [],
    };
    const render = (
      changeSummary: {
        status: "pending" | "ready" | "failed" | "skipped";
        summary: string | null;
      } | null,
    ) =>
      renderDigest(
        [
          {
            projectName: "Ops",
            commits: [{ ...commit, changeSummary }],
            diffs: [],
          },
        ],
        { excludeDocumentId: null },
      );
    expect(
      render({ status: "ready", summary: "Clarify the rollback steps" }),
    ).toContain('"update: runbook.md — Clarify the rollback steps"');
    expect(render({ status: "pending", summary: null })).toContain(
      '"update: runbook.md"',
    );
    expect(render(null)).toContain('"update: runbook.md"');
  });
});

describe("renderTableSample", () => {
  it("renders a bounded Markdown table", () => {
    const text = renderTableSample(
      {
        title: "Hosts",
        columns: [{ name: "host" }, { name: "role" }],
        rows: [
          { host: "a", role: "db" },
          { host: "b", role: "web" },
        ],
      },
      1,
    );
    expect(text).toContain("| host | role |");
    expect(text).toContain("| a | db |");
    expect(text).not.toContain("| b | web |");
    expect(text).toContain("1 of 2 rows");
  });
});

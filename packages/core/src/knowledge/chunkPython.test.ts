import { describe, expect, it } from "vitest";
import { chunkPython } from "./chunkPython";

const base = {
  documentId: "11111111-1111-4111-8111-111111111111",
  sourceCommitSha: "a".repeat(40),
  title: "deploy_prod",
  maxChars: 200,
  overlapChars: 40,
};

const SRC =
  "import os\n\n\n@retry\ndef fetch():\n    return os.environ\n\n\nclass Tool:\n    def run(self):\n        pass\n";

describe("chunkPython", () => {
  it("is deterministic and splits at top-level definitions", () => {
    const chunks = chunkPython({ ...base, text: SRC });
    expect(chunkPython({ ...base, text: SRC })).toEqual(chunks);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["deploy_prod"],
      ["deploy_prod", "def fetch"],
      ["deploy_prod", "class Tool"],
    ]);
    expect(chunks[1]!.content.startsWith("@retry\ndef fetch():")).toBe(true);
    expect(chunks.every((chunk) => chunk.navigationAnchor === null)).toBe(true);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.id))).toBe(true);
  });
  const bigLines = Array.from(
    { length: 60 },
    (_, i) => `    x${i} = ${"v".repeat(20)}`,
  );
  const bigText = `def big():\n${bigLines.join("\n")}\n`;
  const carriedPrefix = (prev: string[], next: string[]): string[] => {
    for (let k = Math.min(prev.length, next.length); k >= 1; k--) {
      const tail = prev.slice(-k);
      if (tail.every((line, i) => line === next[i])) return tail;
    }
    return [];
  };

  it("splits an oversized group into line windows with overlap, never inside a line", () => {
    const chunks = chunkPython({
      ...base,
      text: bigText,
      maxChars: 300,
      overlapChars: 60,
    });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(300);
      expect(chunk.headingPath).toEqual(["deploy_prod", "def big"]);
      for (const line of chunk.content.split("\n"))
        expect(line === "" || /^(def big\(\):|    x\d+ = v+)$/.test(line)).toBe(
          true,
        );
    }
    for (let n = 1; n < chunks.length; n++) {
      const carried = carriedPrefix(
        chunks[n - 1]!.content.split("\n"),
        chunks[n]!.content.split("\n"),
      );
      expect(carried.length).toBeGreaterThanOrEqual(1);
      expect(carried.join("\n").length).toBeLessThanOrEqual(60);
    }
  });
  it("repeats no line between windows without overlap", () => {
    const chunks = chunkPython({
      ...base,
      text: bigText,
      maxChars: 300,
      overlapChars: 0,
    });
    expect(chunks.length).toBeGreaterThan(3);
    for (let n = 1; n < chunks.length; n++) {
      const previous = new Set(chunks[n - 1]!.content.split("\n"));
      for (const line of chunks[n]!.content.split("\n"))
        expect(previous.has(line)).toBe(false);
    }
  });
  it("hard-splits a single line longer than maxChars and enforces maxChunks", () => {
    const chunks = chunkPython({
      ...base,
      text: `x = "${"a".repeat(500)}"\n`,
      maxChars: 100,
      overlapChars: 0,
    });
    expect(chunks.every((chunk) => chunk.content.length <= 100)).toBe(true);
    expect(() => chunkPython({ ...base, text: SRC, maxChunks: 1 })).toThrow(
      RangeError,
    );
  });
  it("normalizes CRLF and skips empty preambles", () => {
    const chunks = chunkPython({ ...base, text: "def f():\r\n    pass\r\n" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("def f():\n    pass");
  });
  it("emits module-level code after a definition as its own block", () => {
    const text =
      'import sys\n\ndef main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n';
    const chunks = chunkPython({ ...base, text });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["deploy_prod"],
      ["deploy_prod", "def main"],
      ["deploy_prod"],
    ]);
    expect(chunks[1]!.content).toBe("def main():\n    pass");
    expect(chunks[2]!.content).toBe('if __name__ == "__main__":\n    main()');
    const covered = new Set(
      chunks.flatMap((chunk) => chunk.content.split("\n")),
    );
    for (const line of text.split("\n"))
      if (line.trim()) expect(covered.has(line)).toBe(true);
  });
});

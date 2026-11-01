import { describe, expect, it } from "vitest";

import {
  batchBlocked,
  classifyArtifactBatch,
  mergeReplacements,
  planArtifactUpload,
  replaceConfirmTitle,
  uploadedMessage,
} from "./artifactBatch";

const file = (name: string, size = 1) => new File([new Uint8Array(size)], name);

describe("classifyArtifactBatch", () => {
  it("flags oversize, in-batch duplicates (case-insensitive), replacements and unsafe names", () => {
    const rows = classifyArtifactBatch(
      [
        file("a.txt"),
        file("A.TXT"),
        file("big.bin", 11),
        file("Plan.md"),
        file(".hidden"),
      ],
      ["plan.md"],
      10,
    );
    expect(
      rows.map((r) => [
        r.file.name,
        r.duplicateInBatch,
        r.tooLarge,
        r.replacesExisting,
        r.invalidName,
      ]),
    ).toEqual([
      ["a.txt", true, false, false, false],
      ["A.TXT", true, false, false, false],
      ["big.bin", false, true, false, false],
      ["Plan.md", false, false, true, false],
      [".hidden", false, false, false, true],
    ]);
  });

  it("blocks duplicates, oversize, unsafe names, empty and over-20 batches; replacements alone do not block", () => {
    expect(
      batchBlocked(classifyArtifactBatch([file("Plan.md")], ["plan.md"], 10)),
    ).toBeNull();
    expect(
      batchBlocked(classifyArtifactBatch([file("a"), file("A")], [], 10)),
    ).toMatch(/same name/i);
    expect(
      batchBlocked(classifyArtifactBatch([file("b", 11)], [], 10)),
    ).toMatch(/larger than/i);
    expect(batchBlocked([])).toMatch(/choose at least one/i);
    expect(
      batchBlocked(
        classifyArtifactBatch(
          Array.from({ length: 21 }, (_, i) => file(`f${i}`)),
          [],
          10,
        ),
      ),
    ).toMatch(/up to 20/i);
  });

  it("names the offending file and the limit when one is given", () => {
    expect(
      batchBlocked(classifyArtifactBatch([file(".hidden")], [], 10)),
    ).toContain(".hidden");
    expect(
      batchBlocked(
        classifyArtifactBatch([file("big.bin", 2048)], [], 1024),
        1024,
      ),
    ).toBe("big.bin is larger than 1.0 KB.");
  });
});

describe("planArtifactUpload", () => {
  it("stops at a blocked batch before any confirmation", () => {
    const rows = classifyArtifactBatch(
      [file("Plan.md"), file("plan.MD")],
      ["plan.md"],
      10,
    );
    expect(planArtifactUpload(rows, 10)).toEqual({
      kind: "blocked",
      message: "Two selected files have the same name. Remove one of them.",
    });
  });

  it("asks for confirmation with the replacement names and uploads otherwise", () => {
    const replacing = classifyArtifactBatch(
      [file("Plan.md"), file("new.txt")],
      ["plan.md"],
      10,
    );
    expect(planArtifactUpload(replacing, 10)).toEqual({
      kind: "confirm",
      files: replacing.map((row) => row.file),
      names: ["Plan.md"],
    });
    const clean = classifyArtifactBatch([file("new.txt")], [], 10);
    expect(planArtifactUpload(clean, 10)).toEqual({
      kind: "upload",
      files: [clean[0]!.file],
    });
  });
});

describe("mergeReplacements", () => {
  it("adds server conflicts once, keeping the name already confirmed", () => {
    expect(mergeReplacements(["Plan.md"], ["plan.MD", "Notes.txt"])).toEqual([
      "Plan.md",
      "Notes.txt",
    ]);
    expect(mergeReplacements([], [])).toEqual([]);
  });
});

describe("confirmation and success copy", () => {
  it("counts files in singular and plural", () => {
    expect(replaceConfirmTitle(1)).toBe("Replace 1 existing file?");
    expect(replaceConfirmTitle(3)).toBe("Replace 3 existing files?");
    expect(uploadedMessage(1)).toBe("1 file uploaded");
    expect(uploadedMessage(2)).toBe("2 files uploaded");
  });
});

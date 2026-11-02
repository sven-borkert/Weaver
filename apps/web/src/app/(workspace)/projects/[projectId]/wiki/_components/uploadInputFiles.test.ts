import { describe, expect, it, vi } from "vitest";
import { suffixedName, uploadInputFiles } from "./uploadInputFiles";

describe("suffixedName", () => {
  it.each([
    ["report.pdf", 1, "report.pdf"],
    ["report.pdf", 2, "report-2.pdf"],
    ["archive.tar.gz", 3, "archive.tar-3.gz"],
    [".hidden", 2, ".hidden-2"],
    ["noext", 2, "noext-2"],
  ])("%s attempt %i is %s", (name, attempt, expected) => {
    expect(suffixedName(name, attempt)).toBe(expected);
  });
});

describe("uploadInputFiles", () => {
  it("retries a clash under a new name and never asks to replace", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ kind: "conflict", conflicts: ["a.md"] })
      .mockResolvedValueOnce({ kind: "uploaded", count: 1, ids: ["id-1"] });
    const result = await uploadInputFiles("p", [new File(["x"], "a.md")], {
      upload,
    });
    expect(result).toEqual({ kind: "uploaded", ids: ["id-1"] });
    const second = upload.mock.calls[1] as [string, File[]];
    expect(second[1][0]!.name).toBe("a-2.md");
    for (const call of upload.mock.calls) expect(call[2]).toEqual([]);
  });

  it("stops on an error and reports what already landed", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ kind: "uploaded", count: 1, ids: ["id-1"] })
      .mockResolvedValueOnce({
        kind: "error",
        message: "too big",
        accessDenied: false,
      });
    const result = await uploadInputFiles(
      "p",
      [new File(["x"], "a.md"), new File(["y"], "b.md")],
      { upload },
    );
    expect(result).toEqual({
      kind: "error",
      message: "too big",
      ids: ["id-1"],
    });
  });

  it("gives up after a bounded number of names", async () => {
    const upload = vi
      .fn()
      .mockResolvedValue({ kind: "conflict", conflicts: ["a.md"] });
    const result = await uploadInputFiles("p", [new File(["x"], "a.md")], {
      upload,
    });
    expect(result.kind).toBe("error");
    expect(upload).toHaveBeenCalledTimes(20);
  });
});

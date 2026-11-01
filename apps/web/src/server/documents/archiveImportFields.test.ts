import { describe, expect, it } from "vitest";
import { UploadProblem } from "~/server/ingestion/multipartUpload";
import { parseArchiveImportForm } from "./archiveImportFields";

function form(overrides: Record<string, string | null> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string | null> = {
    folderPath: JSON.stringify(["notes"]),
    folderNames: JSON.stringify({ notes: "Notes" }),
    mode: "create",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields))
    if (value !== null) data.set(key, value);
  data.set("markdown", new File(["# Plan\n"], "plan.md"));
  data.append("image", new File([new Uint8Array([1, 2])], "a.png"));
  data.append("image", new File([new Uint8Array([3])], "b.png"));
  return data;
}

describe("parseArchiveImportForm", () => {
  it("reads the fields, the Markdown and the images", async () => {
    const parsed = await parseArchiveImportForm(form());

    expect(parsed.folderPath).toEqual(["notes"]);
    expect(parsed.folderNames).toEqual({ notes: "Notes" });
    expect(parsed.target).toEqual({ mode: "create" });
    expect(parsed.fileName).toBe("plan.md");
    expect(parsed.kind).toBe("markdown");
    expect(parsed.text).toBe("# Plan\n");
    expect(parsed.images.map((image) => image.name)).toEqual([
      "a.png",
      "b.png",
    ]);
    expect([...parsed.images[0]!.bytes]).toEqual([1, 2]);
  });

  it("requires a target id for replace and forbids it for create", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(
      (
        await parseArchiveImportForm(
          form({
            mode: "replace",
            targetDocumentId: id,
            expectedHeadCommitSha: "a".repeat(40),
          }),
        )
      ).target,
    ).toEqual({
      mode: "replace",
      documentId: id,
      expectedHeadCommitSha: "a".repeat(40),
    });
    await expect(
      parseArchiveImportForm(form({ mode: "replace", targetDocumentId: id })),
    ).rejects.toBeInstanceOf(UploadProblem);
    await expect(
      parseArchiveImportForm(form({ mode: "replace" })),
    ).rejects.toBeInstanceOf(UploadProblem);
    await expect(
      parseArchiveImportForm(form({ targetDocumentId: id })),
    ).rejects.toBeInstanceOf(UploadProblem);
  });

  it("rejects malformed fields", async () => {
    const malformed: Array<Record<string, string | null>> = [
      { folderPath: "not json" },
      { folderPath: JSON.stringify(["Bad Segment"]) },
      { folderPath: JSON.stringify(Array(11).fill("a")) },
      { folderNames: JSON.stringify(["x"]) },
      { mode: "merge" },
      { mode: null },
    ];
    for (const bad of malformed)
      await expect(parseArchiveImportForm(form(bad))).rejects.toMatchObject({
        status: 400,
      });
  });

  it("requires exactly one Markdown file", async () => {
    const data = form();
    data.delete("markdown");
    await expect(parseArchiveImportForm(data)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("reads a python part and refuses a second document part", async () => {
    const data = form();
    data.delete("markdown");
    data.set("python", new File(["print(1)\n"], "run.py"));
    const parsed = await parseArchiveImportForm(data);
    expect(parsed).toMatchObject({
      kind: "python",
      fileName: "run.py",
      text: "print(1)\n",
    });
    data.set("markdown", new File(["# Plan\n"], "plan.md"));
    await expect(parseArchiveImportForm(data)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses a document part that is not UTF-8", async () => {
    const data = form();
    data.set(
      "markdown",
      new File([new Uint8Array([0xff, 0xfe, 0x00])], "x.md"),
    );
    await expect(parseArchiveImportForm(data)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("caps the image count", async () => {
    const data = form();
    for (let i = 0; i < 99; i++)
      data.append("image", new File([new Uint8Array([1])], `x${i}.png`));
    await expect(parseArchiveImportForm(data)).rejects.toMatchObject({
      status: 413,
    });
  });
});

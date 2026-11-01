import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { openZip, readZipAppearance, zipIconParts } from "./zip-import-read";

describe("openZip", () => {
  it("lists entries with their unpacked sizes and reads them", async () => {
    const zip = new JSZip();
    zip.file("notes/plan.md", "# Plan\n");
    zip.file("notes/plan.assets/a.png", new Uint8Array([1, 2, 3, 4]));
    const data = await zip.generateAsync({
      type: "arraybuffer",
      compression: "DEFLATE",
    });

    const opened = await openZip(data);

    expect(opened.entries).toEqual(
      expect.arrayContaining([
        { path: "notes/plan.md", size: 7, dir: false },
        { path: "notes/plan.assets/a.png", size: 4, dir: false },
        { path: "notes/", size: 0, dir: true },
      ]),
    );
    expect(await opened.text("notes/plan.md")).toBe("# Plan\n");
    const blob = await opened.blob("notes/plan.assets/a.png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it("rejects data that is not a ZIP", async () => {
    await expect(
      openZip(new TextEncoder().encode("nope").buffer),
    ).rejects.toThrow();
  });
});

it("validates icon hashes and rejects sanitized traversal", async () => {
  const zip = new JSZip();
  zip.file(`.weaver-icons/${"a".repeat(64)}.png`, new Uint8Array([1, 2, 3]));
  await expect(
    readZipAppearance(
      await openZip(await zip.generateAsync({ type: "arraybuffer" })),
    ),
  ).rejects.toThrow("Invalid icon");
  const traversal = new JSZip();
  traversal.file("../escape.md", "bad");
  await expect(
    openZip(await traversal.generateAsync({ type: "arraybuffer" })),
  ).rejects.toThrow("Unsafe ZIP path");
});

it("selects shared icon parts once and fails for missing referenced bytes", () => {
  const icon = {
    type: "image" as const,
    digest: "a".repeat(64),
    extension: "png" as const,
  };
  const blob = new Blob(["image"]);
  const icons = new Map([[`.weaver-icons/${icon.digest}.png`, blob]]);
  expect(zipIconParts([{ icon }, { icon }], icons)).toHaveLength(1);
  expect(() => zipIconParts([{ icon }], new Map())).toThrow("missing");
});

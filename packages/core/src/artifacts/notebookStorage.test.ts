import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotebookDirectory, readNotebookFile } from "./notebookStorage";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "weaver-notebook-storage-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
describe("Notebook cache paths", () => {
  it("refuses a parent symlink before creating directories through it", async () => {
    const outside = path.join(dataDir, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(dataDir, "notebooks"));
    await expect(
      createNotebookDirectory(
        dataDir,
        path.join(dataDir, "notebooks", "project", "claim"),
      ),
    ).rejects.toThrow("invalid_notebook_path");
    await expect(
      readFile(path.join(outside, "project", "claim")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("bounds reads and rejects file and parent symlinks", async () => {
    const target = path.join(dataDir, "notebooks", "claim", "manifest.json");
    await createNotebookDirectory(dataDir, path.dirname(target));
    await writeFile(target, "12345678");
    expect(await readNotebookFile(dataDir, target, 8)).toEqual(
      Buffer.from("12345678"),
    );
    await expect(readNotebookFile(dataDir, target, 7)).rejects.toThrow(
      "invalid_notebook_file",
    );
    await symlink(target, path.join(dataDir, "link"));
    await expect(
      readNotebookFile(dataDir, path.join(dataDir, "link"), 8),
    ).rejects.toThrow("invalid_notebook_path");
    await symlink(path.dirname(target), path.join(dataDir, "parent-link"));
    await expect(
      readNotebookFile(
        dataDir,
        path.join(dataDir, "parent-link", "manifest.json"),
        8,
      ),
    ).rejects.toThrow("invalid_notebook_path");
    await expect(
      readNotebookFile(dataDir, path.join(dataDir, "..", "manifest.json"), 8),
    ).rejects.toThrow("invalid_notebook_path");
  });
});

describe("Notebook snapshot validation", () => {
  it("returns the manifest and the bytes the snapshot occupies", async () => {
    const { createHash } = await import("node:crypto");
    const { validateNotebookSnapshot } = await import("./notebookStorage");
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0]);
    const assetId = createHash("sha256").update(image).digest("hex");
    const dir = path.join(dataDir, "notebooks", "claim");
    await createNotebookDirectory(dataDir, path.join(dir, "pages"));
    await createNotebookDirectory(dataDir, path.join(dir, "assets"));
    const manifest = JSON.stringify({
      schemaVersion: 2,
      sections: [
        {
          id: "s",
          title: "S",
          path: [],
          pages: [{ id: "p", title: "P", level: 0, text: "hello" }],
          warnings: [],
          content: "parsed",
        },
      ],
      assets: [
        { id: assetId, byteSize: image.length, contentType: "image/png" },
      ],
      warnings: [],
    });
    const page = JSON.stringify({
      id: "p",
      sectionId: "s",
      title: "P",
      level: 0,
      blocks: [{ kind: "text", text: "hello" }],
      warnings: [],
    });
    await writeFile(path.join(dir, "manifest.json"), manifest);
    await writeFile(path.join(dir, "pages", "p.json"), page);
    await writeFile(path.join(dir, "assets", assetId), image);

    const validated = await validateNotebookSnapshot(dataDir, dir);
    expect(validated.manifest.sections[0]?.id).toBe("s");
    expect(validated.byteSize).toBe(
      Buffer.byteLength(manifest) + Buffer.byteLength(page) + image.length,
    );
  });
});

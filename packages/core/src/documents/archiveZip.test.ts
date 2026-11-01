import type { Readable } from "node:stream";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ArchivePlan } from "./archive";
import { createArchiveStream } from "./archiveZip";

const PLAN: ArchivePlan = {
  files: [
    { path: "deep/idea.md", sha: "a", size: 5 },
    { path: "plan.assets/chart.png", sha: "b", size: 4 },
    { path: "plan.md", sha: "c", size: 6 },
  ],
  directories: ["archive"],
  totalBytes: 15,
};

const CONTENT: Record<string, Buffer> = {
  a: Buffer.from("idea\n"),
  b: Buffer.from([0x89, 0x50, 0x00, 0xff]),
  c: Buffer.from("# Plan"),
};

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("createArchiveStream", () => {
  it.each([
    "../outside",
    "a/../outside",
    "a/./b",
    "a\\..\\outside",
    "/absolute",
    "C:drive",
    "a\u0000b",
    "a\nb",
    "a//b",
  ])("rejects unsafe ZIP names %j at every boundary", (path) => {
    const options = {
      date: new Date(),
      readBlob: async () => Buffer.from("x"),
    };
    for (const plan of [
      { files: [{ path, sha: "a", size: 1 }], directories: [], totalBytes: 1 },
      { files: [], directories: [path], totalBytes: 0 },
    ])
      expect(() =>
        createArchiveStream({ ...options, plan, rootName: "safe" }),
      ).toThrow("Unsafe archive path");
    expect(() =>
      createArchiveStream({ ...options, plan: PLAN, rootName: path }),
    ).toThrow("Unsafe archive path");
  });

  it("stores every file byte for byte beneath the root directory", async () => {
    const stream = createArchiveStream({
      rootName: "notes",
      plan: PLAN,
      date: new Date("2026-09-01T10:00:00Z"),
      readBlob: (file) => Promise.resolve(CONTENT[file.sha]!),
    });

    const zip = await JSZip.loadAsync(await collect(stream));

    expect(Object.keys(zip.files).sort()).toEqual([
      "notes/",
      "notes/archive/",
      "notes/deep/",
      "notes/deep/idea.md",
      "notes/plan.assets/",
      "notes/plan.assets/chart.png",
      "notes/plan.md",
    ]);
    expect(zip.file("notes/archive")).toBeNull();
    expect(zip.files["notes/archive/"]?.dir).toBe(true);
    for (const file of PLAN.files) {
      const stored = await zip.file(`notes/${file.path}`)!.async("nodebuffer");
      expect(stored.equals(CONTENT[file.sha]!)).toBe(true);
    }
  });

  it("archives an empty folder as its root directory alone", async () => {
    const stream = createArchiveStream({
      rootName: "empty",
      plan: { files: [], directories: [], totalBytes: 0 },
      date: new Date("2026-09-01T10:00:00Z"),
      readBlob: () => Promise.reject(new Error("nothing to read")),
    });

    const zip = await JSZip.loadAsync(await collect(stream));

    expect(Object.keys(zip.files)).toEqual(["empty/"]);
  });

  it("reads blobs one at a time, only once the archive is consumed", async () => {
    let active = 0;
    let peak = 0;
    let reads = 0;
    const stream = createArchiveStream({
      rootName: "notes",
      plan: PLAN,
      date: new Date("2026-09-01T10:00:00Z"),
      readBlob: async (file) => {
        reads += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return CONTENT[file.sha]!;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(0);

    await collect(stream);

    expect(reads).toBe(3);
    expect(peak).toBe(1);
  });

  it("writes the files at the archive root when no root name is given", async () => {
    const stream = createArchiveStream({
      plan: {
        files: [
          { path: "plan.assets/chart.png", sha: "b", size: 4 },
          { path: "plan.md", sha: "c", size: 6 },
        ],
        directories: [],
        totalBytes: 10,
      },
      date: new Date("2026-09-01T10:00:00Z"),
      readBlob: (file) => Promise.resolve(CONTENT[file.sha]!),
    });

    const zip = await JSZip.loadAsync(await collect(stream));

    expect(Object.keys(zip.files).sort()).toEqual([
      "plan.assets/",
      "plan.assets/chart.png",
      "plan.md",
    ]);
  });

  it("fails the stream when a blob cannot be read", async () => {
    const stream = createArchiveStream({
      rootName: "notes",
      plan: PLAN,
      date: new Date("2026-09-01T10:00:00Z"),
      readBlob: () => Promise.reject(new Error("blob missing")),
    });

    await expect(collect(stream)).rejects.toThrow("blob missing");
  });
});

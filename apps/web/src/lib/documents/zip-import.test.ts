import { describe, expect, it } from "vitest";
import {
  analyzeZipEntries,
  describeZipDocument,
  findCollision,
  planImportTarget,
  type ZipDocument,
  type ZipEntryInfo,
} from "./zip-import";

const file = (path: string, size = 10): ZipEntryInfo => ({
  path,
  size,
  dir: false,
});
const dir = (path: string): ZipEntryInfo => ({ path, size: 0, dir: true });

describe("analyzeZipEntries", () => {
  it("pairs documents with the images of their sibling assets directory", () => {
    const analysis = analyzeZipEntries([
      dir("Notes/"),
      file("Notes/plan.md"),
      file("Notes/plan.assets/photo.JPG", 30),
      file("Notes/plan.assets/chart.png", 20),
      file("Notes/Deep Dive/idea.markdown"),
      file("scripts/deploy_prod.PY"),
      file("top.md"),
    ]);

    expect(analysis).toEqual({
      ok: true,
      folderEntries: [],
      iconEntries: [],
      documents: [
        {
          entryPath: "Notes/Deep Dive/idea.markdown",
          fileName: "idea.markdown",
          kind: "markdown",
          directories: ["Notes", "Deep Dive"],
          images: [],
        },
        {
          entryPath: "Notes/plan.md",
          fileName: "plan.md",
          kind: "markdown",
          directories: ["Notes"],
          images: [
            {
              entryPath: "Notes/plan.assets/chart.png",
              name: "chart.png",
              size: 20,
            },
            {
              entryPath: "Notes/plan.assets/photo.JPG",
              name: "photo.JPG",
              size: 30,
            },
          ],
        },
        {
          entryPath: "scripts/deploy_prod.PY",
          fileName: "deploy_prod.PY",
          kind: "python",
          directories: ["scripts"],
          images: [],
        },
        {
          entryPath: "top.md",
          fileName: "top.md",
          kind: "markdown",
          directories: [],
          images: [],
        },
      ],
      skipped: [],
    });
  });

  it("lists everything it will not import with a reason", () => {
    const analysis = analyzeZipEntries([
      file("plan.md"),
      file("plan.assets/vector.svg"),
      file("plan.assets/nested/deep.png"),
      file("orphan.assets/x.png"),
      file("readme.txt"),
      file("../escape.md"),
      file("__MACOSX/._plan.md"),
      file(".DS_Store"),
    ]);

    expect(analysis.ok && analysis.documents.map((d) => d.entryPath)).toEqual([
      "plan.md",
    ]);
    expect(analysis.ok && analysis.skipped).toEqual([
      { path: "../escape.md", reason: "unsafe path" },
      { path: ".DS_Store", reason: "system file" },
      { path: "__MACOSX/._plan.md", reason: "system file" },
      { path: "orphan.assets/x.png", reason: "no document for this image" },
      {
        path: "plan.assets/nested/deep.png",
        reason: "nested inside an assets directory",
      },
      { path: "plan.assets/vector.svg", reason: "unsupported image type" },
      { path: "readme.txt", reason: "not a document file or document image" },
    ]);
  });

  it("keeps a Markdown and a Python file of the same stem, images going to the Markdown", () => {
    const analysis = analyzeZipEntries([
      file("scripts/deploy.md"),
      file("scripts/deploy.py"),
      file("scripts/deploy.assets/a.png", 3),
    ]);
    expect(analysis.ok && analysis.skipped).toEqual([]);
    expect(
      analysis.ok &&
        analysis.documents.map((d) => [d.fileName, d.kind, d.images.length]),
    ).toEqual([
      ["deploy.md", "markdown", 1],
      ["deploy.py", "python", 0],
    ]);
  });

  it("skips a second document of the same kind and stem", () => {
    const analysis = analyzeZipEntries([file("a.markdown"), file("a.md")]);
    expect(analysis.ok && analysis.documents.map((d) => d.entryPath)).toEqual([
      "a.markdown",
    ]);
    expect(analysis.ok && analysis.skipped).toEqual([
      { path: "a.md", reason: "duplicate document name" },
    ]);
  });

  it("refuses an archive over the entry or size limit", () => {
    const many = Array.from({ length: 10_001 }, (_, i) => file(`d${i}.md`));
    expect(analyzeZipEntries(many)).toEqual({
      ok: false,
      error: "The ZIP holds more than 10,000 entries.",
    });
    expect(analyzeZipEntries([file("big.md", 1024 ** 3 + 1)])).toEqual({
      ok: false,
      error: "The ZIP unpacks to more than 1 GiB.",
    });
  });
});

describe("describeZipDocument", () => {
  const doc: ZipDocument = {
    entryPath: "Notes/trip-report.md",
    fileName: "trip-report.md",
    kind: "markdown",
    directories: ["Notes"],
    images: [
      { entryPath: "Notes/trip-report.assets/a.png", name: "a.png", size: 5 },
    ],
  };

  it("reads the title, the Weaver id and missing images", () => {
    const markdown = [
      "<!-- weaver",
      "id: 11111111-1111-4111-8111-111111111111",
      "created: 2026-01-01T00:00:00.000Z",
      "-->",
      "",
      "# Trip Report",
      "",
      "![A](trip-report.assets/a.png) ![B](trip-report.assets/b%20c.png)",
      "![Remote](https://example.test/x.png)",
    ].join("\n");

    expect(describeZipDocument(doc, markdown)).toEqual({
      title: "Trip Report",
      weaverId: "11111111-1111-4111-8111-111111111111",
      missingImages: ["b c.png"],
      problem: null,
    });
  });

  it("finds missing images written as img tags with a width", () => {
    const markdown = [
      "# Trip Report",
      "",
      '<img src="trip-report.assets/a.png" alt="A" width="300">',
      'Text <img src="trip-report.assets/gone.png" alt="B &amp; C" width="200"> more',
      '<img src="trip-report.assets/b%20c.png" width="64" />',
      '<img src="trip-report.assets/odd.png" onerror="x">',
    ].join("\n");
    expect(describeZipDocument(doc, markdown).missingImages).toEqual([
      "b c.png",
      "gone.png",
    ]);
  });

  it("falls back to the file name and flags oversize content", () => {
    expect(describeZipDocument(doc, "Just text.")).toMatchObject({
      title: "Trip report",
      weaverId: null,
    });
    expect(describeZipDocument(doc, "x".repeat(200_001)).problem).toBe(
      "file exceeds the import size limit",
    );
    const heavy = {
      ...doc,
      images: [{ entryPath: "x", name: "x.png", size: 64 * 1024 ** 2 + 1 }],
    };
    expect(describeZipDocument(heavy, "# T").problem).toBe(
      "images exceed 64 MiB in total",
    );
    const crowded = {
      ...doc,
      images: Array.from({ length: 101 }, (_, i) => ({
        entryPath: `x${i}`,
        name: `x${i}.png`,
        size: 1,
      })),
    };
    expect(describeZipDocument(crowded, "# T").problem).toBe(
      "more than 100 images",
    );
  });
});

describe("describeZipDocument with python", () => {
  const doc: ZipDocument = {
    entryPath: "tools/deploy_prod.py",
    fileName: "deploy_prod.py",
    kind: "python",
    directories: ["tools"],
    images: [],
  };

  it("uses the file stem verbatim and reports no images", () => {
    expect(
      describeZipDocument(doc, "![x](deploy_prod.assets/a.png)\n"),
    ).toEqual({
      title: "deploy_prod",
      weaverId: null,
      missingImages: [],
      problem: null,
    });
  });

  it("reads the title and Weaver id from a header after a shebang", () => {
    const text = [
      "#!/usr/bin/env python3",
      "# weaver",
      "# id: 11111111-1111-4111-8111-111111111111",
      '# title: "Deploy"',
      "# created: 2026-01-01T00:00:00.000Z",
      "# updated: 2026-01-01T00:00:00.000Z",
      "# /weaver",
      "",
      "pass",
      "",
    ].join("\n");
    expect(describeZipDocument(doc, text)).toMatchObject({
      title: "Deploy",
      weaverId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("flags images paired with a Python file", () => {
    const paired = {
      ...doc,
      images: [{ entryPath: "x", name: "x.png", size: 1 }],
    };
    expect(describeZipDocument(paired, "pass\n").problem).toBe(
      "a Python file carries no images",
    );
  });
});

describe("planImportTarget", () => {
  it("imports flat into the current folder", () => {
    expect(planImportTarget(["Notes", "Deep Dive"], ["inbox"], false)).toEqual({
      ok: true,
      folderPath: ["inbox"],
      folderNames: {},
    });
  });

  it("recreates the ZIP directories below the current folder", () => {
    expect(planImportTarget(["Notes", "Deep Dive"], ["inbox"], true)).toEqual({
      ok: true,
      folderPath: ["inbox", "notes", "deep-dive"],
      folderNames: {
        "inbox/notes": "Notes",
        "inbox/notes/deep-dive": "Deep Dive",
      },
    });
  });

  it("fails on too much depth", () => {
    const deep = Array.from({ length: 6 }, (_, i) => `d${i}`);
    expect(planImportTarget(deep, ["a", "b", "c", "d", "e"], true)).toEqual({
      ok: false,
      reason: "folder depth exceeds 10",
    });
  });
});

describe("findCollision", () => {
  const existing = [
    {
      id: "id-1",
      title: "Trip Report",
      path: "notes/trip-report.md",
      documentKind: "markdown" as const,
    },
    {
      id: "id-2",
      title: "Plan",
      path: "plan.md",
      documentKind: "markdown" as const,
    },
  ];

  it("prefers the document with the same Weaver id", () => {
    expect(
      findCollision(
        {
          weaverId: "id-2",
          title: "Trip Report",
          folderPath: ["notes"],
          documentKind: "markdown",
        },
        existing,
      ),
    ).toEqual({ kind: "id", existing: existing[1], replaceable: true });
  });

  it("matches a title in the target folder, ignoring case", () => {
    expect(
      findCollision(
        {
          weaverId: null,
          title: " trip report ",
          folderPath: ["notes"],
          documentKind: "markdown",
        },
        existing,
      ),
    ).toEqual({ kind: "title", existing: existing[0], replaceable: true });
    expect(
      findCollision(
        {
          weaverId: null,
          title: "Trip Report",
          folderPath: [],
          documentKind: "markdown",
        },
        existing,
      ),
    ).toBeNull();
  });

  it("marks a collision with a different file kind as not replaceable", () => {
    expect(
      findCollision(
        {
          weaverId: null,
          title: "Plan",
          folderPath: [],
          documentKind: "python",
        },
        existing,
      ),
    ).toEqual({ kind: "title", existing: existing[1], replaceable: false });
  });
});

it("recognizes reserved icons and empty-folder metadata without treating icons as content", () => {
  const icon = `.weaver-icons/${"a".repeat(64)}.png`;
  const analysis = analyzeZipEntries([file("notes/.folder.json"), file(icon)]);
  expect(analysis).toMatchObject({
    ok: true,
    documents: [],
    folderEntries: ["notes/.folder.json"],
    iconEntries: [icon],
    skipped: [],
  });
  expect(analyzeZipEntries([file("notes/.weaver-icons/x.md")]).ok).toBe(false);
  expect(
    analyzeZipEntries([
      file(`.weaver-icons/${"a".repeat(64)}.png`, 2 * 1024 * 1024 + 1),
    ]).ok,
  ).toBe(false);
});

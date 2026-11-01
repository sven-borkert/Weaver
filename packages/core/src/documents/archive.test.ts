import { describe, expect, it } from "vitest";

import { planDocumentArchive, planFolderArchive } from "./archive";

const blob = (path: string, size = 1) => ({ path, sha: `sha:${path}`, size });

const REPO = [
  blob("project.json"),
  blob("readme.md", 10),
  blob("readme.assets/logo.png", 20),
  blob("notes/.folder.json"),
  blob("notes/plan.md", 30),
  blob("notes/plan.assets/chart.png", 40),
  blob("notes/archive/.gitkeep", 0),
  blob("notes/deep/.folder.json"),
  blob("notes/deep/idea.md", 50),
  blob("notes/stray.txt"),
  blob("notes-other/x.md"),
  blob("tables/budget.table/schema.json"),
  blob("tables/budget.table/notes.md"),
];

describe("planFolderArchive", () => {
  it("collects a folder's documents and images relative to it", () => {
    expect(planFolderArchive(REPO, ["notes"])).toEqual({
      files: [
        { path: ".folder.json", sha: "sha:notes/.folder.json", size: 1 },
        {
          path: "deep/.folder.json",
          sha: "sha:notes/deep/.folder.json",
          size: 1,
        },
        { path: "deep/idea.md", sha: "sha:notes/deep/idea.md", size: 50 },
        {
          path: "plan.assets/chart.png",
          sha: "sha:notes/plan.assets/chart.png",
          size: 40,
        },
        { path: "plan.md", sha: "sha:notes/plan.md", size: 30 },
      ],
      directories: ["archive"],
      totalBytes: 122,
    });
  });

  it("archives the project root without tables or project metadata", () => {
    const plan = planFolderArchive(REPO, []);
    expect(plan?.files.map((file) => file.path)).toEqual([
      "notes-other/x.md",
      "notes/.folder.json",
      "notes/deep/.folder.json",
      "notes/deep/idea.md",
      "notes/plan.assets/chart.png",
      "notes/plan.md",
      "readme.assets/logo.png",
      "readme.md",
    ]);
    expect(plan?.directories).toEqual(["notes/archive"]);
  });

  it("keeps an empty folder as an archive without files", () => {
    expect(planFolderArchive(REPO, ["notes", "archive"])).toEqual({
      files: [],
      directories: [],
      totalBytes: 0,
    });
  });

  it("reports a folder no committed file lies in as absent", () => {
    expect(planFolderArchive(REPO, ["missing"])).toBeNull();
    // A sibling sharing the prefix is not the folder.
    expect(planFolderArchive(REPO, ["note"])).toBeNull();
    expect(planFolderArchive(REPO, ["readme.assets"])).toBeNull();
  });

  it("archives an empty project root", () => {
    expect(planFolderArchive([blob("project.json")], [])).toEqual({
      files: [],
      directories: [],
      totalBytes: 0,
    });
  });
});

describe("planDocumentArchive", () => {
  const blobs = [
    { path: "notes/plan.md", sha: "a", size: 10 },
    { path: "notes/plan.assets/chart.png", sha: "b", size: 20 },
    { path: "notes/plan.assets/photo.jpg", sha: "c", size: 30 },
    { path: "notes/planner.md", sha: "d", size: 5 },
    { path: "notes/planner.assets/x.png", sha: "e", size: 5 },
    { path: "plan.md", sha: "f", size: 5 },
  ];

  it("selects the document and its own images, relative to its folder", () => {
    expect(planDocumentArchive(blobs, "notes/plan.md")).toEqual({
      files: [
        { path: "plan.assets/chart.png", sha: "b", size: 20 },
        { path: "plan.assets/photo.jpg", sha: "c", size: 30 },
        { path: "plan.md", sha: "a", size: 10 },
      ],
      directories: [],
      totalBytes: 60,
    });
  });

  it("handles a root document without images", () => {
    expect(planDocumentArchive(blobs, "plan.md")).toEqual({
      files: [{ path: "plan.md", sha: "f", size: 5 }],
      directories: [],
      totalBytes: 5,
    });
  });

  it("is null when the file is not committed", () => {
    expect(planDocumentArchive(blobs, "notes/gone.md")).toBeNull();
  });
});

it("includes folder metadata but excludes arbitrary reserved-root files", () => {
  const plan = planFolderArchive(
    [
      blob("empty/.folder.json"),
      blob(".weaver-icons/evil.md"),
      blob(".weaver-icons/evil.assets/x.png"),
    ],
    [],
  );
  expect(plan?.files.map((file) => file.path)).toEqual(["empty/.folder.json"]);
});

it("includes Python documents but not other files", () => {
  const plan = planFolderArchive(
    [blob("scripts/deploy.py"), blob("scripts/notes.txt")],
    ["scripts"],
  );
  expect(plan?.files.map((file) => file.path)).toEqual(["deploy.py"]);
});

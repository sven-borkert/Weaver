import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const run = promisify(execFile);
const PROJECT_ID = "12121212-1212-4121-8121-121212121212";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
const PLAN = "<!-- weaver\nid: 1\n-->\n\n# Plan\n\nBody with ümlaut\r\n";

let dataDir: string;
let repoRoot: string;

async function git(...args: string[]): Promise<void> {
  await run("git", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.local",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.local",
    },
  });
}

async function commitFiles(files: Record<string, string | Buffer>) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), content);
  }
  await git("add", "-A", "-f");
  await git("commit", "-q", "-m", "update");
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function openReader() {
  const { openProjectRepo } = await import("@weaver/git-store");
  return (await openProjectRepo(PROJECT_ID))!;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "weaver-download-unit-"));
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://weaver:weaver@localhost/weaver_test",
  );
  vi.stubEnv("AUTH_SECRET", "test-secret-that-is-at-least-32-characters");
  vi.stubEnv("WEAVER_DATA_DIR", dataDir);
  repoRoot = path.join(dataDir, "git", PROJECT_ID);
  await mkdir(repoRoot, { recursive: true });
  await git("init", "-q", "-b", "main");
  await commitFiles({
    "project.json": "{}",
    ".gitattributes": "*.md export-subst\n",
    "readme.md": "# Readme $Format:%H$\n",
    "notes/.folder.json": '{"name":"My notes"}',
    "notes/plan.md": PLAN,
    "notes/plan.assets/chart.png": PNG,
    "notes/archive/.gitkeep": "",
    "tables/budget.table/notes.md": "# table",
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

describe("archiveFolderInRepo", () => {
  it("zips a folder's committed documents and images byte for byte", async () => {
    const { archiveFolderInRepo } = await import("./documentDownload");

    const stream = await archiveFolderInRepo(await openReader(), {
      folderPath: ["notes"],
      rootName: "notes",
    });
    const zip = await JSZip.loadAsync(await collect(stream));

    expect(Object.keys(zip.files).sort()).toEqual([
      "notes/",
      "notes/.folder.json",
      "notes/archive/",
      "notes/plan.assets/",
      "notes/plan.assets/chart.png",
      "notes/plan.md",
    ]);
    const plan = await zip.file("notes/plan.md")!.async("nodebuffer");
    expect(plan.equals(Buffer.from(PLAN))).toBe(true);
    const chart = await zip
      .file("notes/plan.assets/chart.png")!
      .async("nodebuffer");
    expect(chart.equals(PNG)).toBe(true);
  });

  it("zips the project root without tables, metadata, or attribute rewrites", async () => {
    const { archiveFolderInRepo } = await import("./documentDownload");

    const stream = await archiveFolderInRepo(await openReader(), {
      folderPath: [],
      rootName: "demo-project",
    });
    const zip = await JSZip.loadAsync(await collect(stream));

    expect(
      Object.keys(zip.files)
        .filter((name) => !name.endsWith("/"))
        .sort(),
    ).toEqual([
      "demo-project/notes/.folder.json",
      "demo-project/notes/plan.assets/chart.png",
      "demo-project/notes/plan.md",
      "demo-project/readme.md",
    ]);
    expect(await zip.file("demo-project/readme.md")!.async("string")).toBe(
      "# Readme $Format:%H$\n",
    );
  });

  it("answers NOT_FOUND for a folder that holds no committed file", async () => {
    const { archiveFolderInRepo } = await import("./documentDownload");
    const reader = await openReader();

    await expect(
      archiveFolderInRepo(reader, { folderPath: ["missing"], rootName: "x" }),
    ).rejects.toMatchObject({ name: "CoreError", code: "NOT_FOUND" });
    await expect(
      archiveFolderInRepo(reader, { folderPath: ["tables"], rootName: "x" }),
    ).rejects.toMatchObject({ name: "CoreError", code: "NOT_FOUND" });
    await expect(
      archiveFolderInRepo(reader, { folderPath: ["../x"], rootName: "x" }),
    ).rejects.toMatchObject({ name: "CoreError", code: "NOT_FOUND" });
  });

  it("refuses a folder over the file or byte limit", async () => {
    const { archiveFolderInRepo } = await import("./documentDownload");
    const reader = await openReader();

    await expect(
      archiveFolderInRepo(reader, {
        folderPath: ["notes"],
        rootName: "notes",
        limits: { maxFiles: 1, maxBytes: 1_000 },
      }),
    ).rejects.toMatchObject({
      name: "CoreError",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    });
    await expect(
      archiveFolderInRepo(reader, {
        folderPath: ["notes"],
        rootName: "notes",
        limits: { maxFiles: 10, maxBytes: PNG.byteLength },
      }),
    ).rejects.toMatchObject({
      name: "CoreError",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("keeps the revision it started from when a save lands mid-download", async () => {
    const { archiveFolderInRepo } = await import("./documentDownload");

    const stream = await archiveFolderInRepo(await openReader(), {
      folderPath: ["notes"],
      rootName: "notes",
    });
    await commitFiles({
      "notes/plan.md": "# Rewritten\n",
      "notes/later.md": "# Later\n",
    });
    const zip = await JSZip.loadAsync(await collect(stream));

    expect(zip.file("notes/later.md")).toBeNull();
    const plan = await zip.file("notes/plan.md")!.async("nodebuffer");
    expect(plan.equals(Buffer.from(PLAN))).toBe(true);
  });
});

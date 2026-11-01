import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNotebookParser } from "./runner";

const directories: string[] = [];
async function executable(body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "weaver-notebook-runner-"));
  directories.push(dir);
  const script = path.join(dir, "reader");
  await writeFile(script, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { dir, script };
}
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("isolated notebook parser", () => {
  it("passes source/output as separate arguments and completes successfully", async () => {
    const { script } = await executable(
      "if(process.argv.slice(2).join('|') !== '--source|source with spaces|--output|output with spaces') process.exit(3);",
    );
    await expect(
      createNotebookParser({ executable: script })({
        sourcePath: "source with spaces",
        outputDir: "output with spaces",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });
  it("never forwards native stderr or secrets from the parent environment", async () => {
    process.env.WEAVER_NOTEBOOK_TEST_SECRET = "private-notebook-content";
    const { script } = await executable(
      "console.error('private-notebook-content'); process.exit(process.env.WEAVER_NOTEBOOK_TEST_SECRET ? 0 : 7);",
    );
    try {
      await expect(
        createNotebookParser({ executable: script })({
          sourcePath: "a",
          outputDir: "b",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("The OneNote reader could not read this file.");
    } finally {
      delete process.env.WEAVER_NOTEBOOK_TEST_SECRET;
    }
  });
  it("kills an unresponsive reader at its deadline", async () => {
    const { script } = await executable("setInterval(() => {}, 1000);");
    await expect(
      createNotebookParser({ executable: script, timeoutMs: 100 })({
        sourcePath: "a",
        outputDir: "b",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Reading the notebook took too long.");
  });
  it("aborts a running reader and reports cancellation", async () => {
    const { script } = await executable("setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const read = createNotebookParser({ executable: script })({
      sourcePath: "a",
      outputDir: "b",
      signal: controller.signal,
    });
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });
  it("reports a missing executable without exposing filesystem paths", async () => {
    await expect(
      createNotebookParser({ executable: "/missing/private/path" })({
        sourcePath: "a",
        outputDir: "b",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("The OneNote reader is not installed on this worker.");
  });
});

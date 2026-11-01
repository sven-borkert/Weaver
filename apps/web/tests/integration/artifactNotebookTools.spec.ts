import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import { openUploadSink } from "@weaver/core/ingestion/blobStore";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { finalizeArtifactUpload } from "@weaver/core/services/artifacts";
import { createArtifactNotebookRunner } from "@weaver/core/services/artifactNotebookJobs";
import { notebookClaimDir } from "@weaver/core/artifacts/notebookStorage";
import type {
  NotebookManifest,
  NotebookPage,
} from "@weaver/core/artifacts/notebookSchema";
import {
  MAX_TOOL_OUTPUT_CHARS,
  toolErrorFromUnknown,
  type ToolContext,
} from "@weaver/assistant-tools/contract";
import { toolByName } from "@weaver/assistant-tools/registry";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const dataDir = process.env.WEAVER_DATA_DIR!;
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const assetId = createHash("sha256").update(image).digest("hex");
const body = "Grüße needle 😀\n".repeat(1800);
/** Page text as read_onenote renders it; images are importable references. */
const expectedText = (artifactId: string) =>
  `${body}\n\nKey\tValue\nOne\tTwo\n\n![Printed diagram](weaver-image:${artifactId}/${assetId})\n\n[Attachment: notes.pdf (1234 bytes)]`;

type Output = {
  artifact: { id: string; sha256: string };
  result: {
    status: string;
    error?: string;
    hint: string;
    retryAllowedAt?: string | null;
    retryRefused?: boolean;
    format: string;
    sections?: { id: string }[];
    pages?: { id: string }[];
    matches?: { pageId: string }[];
    total?: number;
    sectionCount?: number;
    pageCount?: number;
    sectionsTruncated?: boolean;
    hasMore?: boolean;
    nextCursor?: string | null;
    text?: string;
    offset?: number;
  };
};
async function call(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<Output> {
  const tool = toolByName(name)!;
  const result = await tool.execute(tool.inputSchema.parse(input), ctx);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(
    MAX_TOOL_OUTPUT_CHARS,
  );
  return result.output as Output;
}
function execute(name: string, input: unknown, ctx: ToolContext) {
  const tool = toolByName(name)!;
  return tool.execute(tool.inputSchema.parse(input), ctx);
}
async function fixture(
  options: {
    sectionCount?: number;
    pageCount?: number;
    hostile?: boolean;
  } = {},
) {
  const db = getPrisma();
  const project = await makeProject("Notebook tools");
  const owner = await makeUser("User", "notebook-tools-owner");
  const user = await makeUser("User", "notebook-tools-viewer");
  const outsider = await makeUser("Admin", "notebook-tools-outsider");
  await addMembership(project.id, owner.id, "Editor");
  await addMembership(project.id, user.id, "Viewer");
  const editor = securityContextFor(owner);
  const actor = securityContextFor(user);
  const scope = await resolveScopeSnapshot(db, actor, {
    kind: "project",
    projectId: project.id,
  });
  const ctx: ToolContext = {
    db,
    actor,
    scope,
    profile: { name: "Viewer", email: "viewer@test.local" },
    run: null,
  };
  const queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  async function upload(content = "original", filename = "Notebook.onepkg") {
    const uploadId = randomUUID();
    const sink = await openUploadSink(dataDir, project.id, uploadId, {
      minFreeBytes: 0,
    });
    await sink.write(Buffer.from(content));
    const { digest, byteSize } = await sink.finish();
    return (
      await finalizeArtifactUpload(
        db,
        editor,
        {
          projectId: project.id,
          files: [
            {
              uploadId,
              filename,
              contentDigest: digest,
              byteSize,
              replace: true,
            },
          ],
        },
        { dataDir },
      )
    ).artifacts[0]!;
  }
  const artifact = await upload();
  const input = { projectId: project.id, filename: artifact.filename };
  const hostile = options.hostile ? "\u0000".repeat(500) : null;
  const warnings = Array.from(
    { length: 10 },
    () => hostile ?? "Some embedded content is unsupported.",
  );
  const manifest: NotebookManifest = {
    schemaVersion: 2,
    sections: [],
    assets: [{ id: assetId, contentType: "image/png", byteSize: image.length }],
    warnings,
  };
  const pages: NotebookPage[] = [];
  for (let section = 0; section < (options.sectionCount ?? 2); section++) {
    const sectionId = `section_${section}`;
    const summaries = [];
    for (let p = 0; p < (section === 0 ? (options.pageCount ?? 55) : 1); p++) {
      const id = `page_${section}_${p}`;
      const title = hostile ? hostile + hostile : `Page ${section} ${p}`;
      summaries.push({
        id,
        title,
        level: p % 2,
        text: `needle Page ${section} ${p}`,
      });
      pages.push({
        id,
        sectionId,
        title,
        level: p % 2,
        blocks: [
          { kind: "text", text: hostile ? "\u0000\n😀".repeat(5000) : body },
          {
            kind: "table",
            rows: [
              ["Key", "Value"],
              ["One", "Two"],
            ],
          },
          { kind: "image", assetId, alt: "Printed diagram" },
          { kind: "attachment", name: "notes.pdf", byteSize: 1234 },
        ],
        warnings,
      });
    }
    manifest.sections.push({
      id: sectionId,
      title: hostile ? hostile + hostile : `Section ${section}`,
      path: hostile
        ? Array.from({ length: 20 }, () => hostile.slice(0, 255))
        : ["Notebook"],
      pages: summaries,
      warnings,
      content: "parsed",
    });
  }
  const runner = createArtifactNotebookRunner({
    db,
    dataDir,
    runNotebookParser: async ({ outputDir }) => {
      await mkdir(path.join(outputDir, "pages"));
      await mkdir(path.join(outputDir, "assets"));
      await writeFile(
        path.join(outputDir, "manifest.json"),
        JSON.stringify(manifest),
      );
      for (const page of pages)
        await writeFile(
          path.join(outputDir, "pages", `${page.id}.json`),
          JSON.stringify(page),
        );
      await writeFile(path.join(outputDir, "assets", assetId), image);
    },
  });
  async function prepare() {
    await call("get_artifact_overview", input, ctx);
    await runner(
      {
        projectId: project.id,
        artifactId: artifact.id,
        contentDigest: artifact.contentDigest,
      },
      {
        jobId: "notebook-test",
        retryCount: 0,
        signal: new AbortController().signal,
      },
    );
  }
  return {
    db,
    project,
    actor,
    ctx,
    outsider: securityContextFor(outsider),
    artifact,
    input,
    queue,
    prepare,
    upload,
  };
}

describe("OneNote assistant tools", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  it.each(["get_artifact_overview", "search_artifact_text", "read_onenote"])(
    "%s explains how to rebuild a lost manifest through read_onenote",
    async (name) => {
      const f = await fixture({ pageCount: 1 });
      await f.prepare();
      const state = await f.db.artifactNotebook.findUniqueOrThrow({
        where: { artifactId: f.artifact.id },
      });
      const dir = notebookClaimDir(
        dataDir,
        f.project.id,
        f.artifact.id,
        state.contentDigest,
        state.parserVersion,
        state.claimToken!,
      );
      await rm(path.join(dir, "manifest.json"));
      const result = await call(
        name,
        { ...f.input, query: "needle", action: "sections" },
        f.ctx,
      );
      expect(result.result).toMatchObject({
        status: "failed",
        error: "snapshot_unavailable",
      });
      expect(result.result.hint).toContain("read_onenote");
      expect(result.result.hint).toContain("retry=true");
      expect(result.result.hint).toContain('action="sections"');
      // A lost cache is exempt from the retry cooldown: rebuild at once.
      expect(result.result.retryAllowedAt).toBeNull();
      expect(result.result.hint).not.toContain("allowed after");
      const retry = await call(
        "read_onenote",
        { ...f.input, action: "sections", retry: true },
        f.ctx,
      );
      expect(retry.result.status).toBe("queued");
      expect(retry.result.retryRefused).toBe(false);
      expect(retry.result.hint).toContain("Do not retry");
      await f.prepare();
      const recovered = await call(
        "read_onenote",
        { ...f.input, action: "page", pageId: "page_0_0" },
        f.ctx,
      );
      expect(recovered.result.status).toBe("ready");
      expect(recovered.result.text).toContain("Grüße needle");
    },
  );

  it.each(["missing", "corrupt"])(
    "provides actionable recovery for %s page data",
    async (damage) => {
      const f = await fixture({ pageCount: 1 });
      await f.prepare();
      const state = await f.db.artifactNotebook.findUniqueOrThrow({
        where: { artifactId: f.artifact.id },
      });
      const dir = notebookClaimDir(
        dataDir,
        f.project.id,
        f.artifact.id,
        state.contentDigest,
        state.parserVersion,
        state.claimToken!,
      );
      const page = path.join(dir, "pages/page_0_0.json");
      if (damage === "missing") await rm(page);
      else await writeFile(page, "invalid JSON");
      const error = await execute(
        "read_onenote",
        { ...f.input, action: "page", pageId: "page_0_0" },
        f.ctx,
      ).then(
        () => {
          throw new Error("Expected an unavailable-cache error");
        },
        (error: unknown) => toolErrorFromUnknown(error),
      );
      expect(error).toMatchObject({
        code: "CONFLICT",
        reason: "SNAPSHOT_UNAVAILABLE",
      });
      expect(error.message).toContain("read_onenote");
      expect(error.message).toContain("retry=true");
      expect(error.message).toContain('action="sections"');
      expect(error.message).toContain("instead of looping");
      await call(
        "read_onenote",
        { ...f.input, action: "sections", retry: true },
        f.ctx,
      );
      await f.prepare();
      expect(
        (
          await call(
            "read_onenote",
            { ...f.input, action: "page", pageId: "page_0_0" },
            f.ctx,
          )
        ).result.text,
      ).toContain("Grüße needle");
    },
  );

  it("reports preparation, deduplicates repeated access and exposes ready overview/search", async () => {
    const f = await fixture();
    expect(
      (await call("get_artifact_overview", f.input, f.ctx)).result,
    ).toMatchObject({ format: "onenote", status: "queued" });
    expect(
      (await call("read_onenote", { ...f.input, action: "sections" }, f.ctx))
        .result.status,
    ).toBe("queued");
    expect(
      (
        await call(
          "search_artifact_text",
          { ...f.input, query: "needle" },
          f.ctx,
        )
      ).result.status,
    ).toBe("queued");
    expect(
      f.queue.jobs.filter((j) => j.name === "artifact.notebook.prepare"),
    ).toHaveLength(1);
    await f.prepare();
    expect(
      (await call("get_artifact_overview", f.input, f.ctx)).result,
    ).toMatchObject({ status: "ready", sectionCount: 2, pageCount: 56 });
    expect(
      (
        await call(
          "search_artifact_text",
          { ...f.input, query: "NEEDLE", limit: 2 },
          f.ctx,
        )
      ).result,
    ).toMatchObject({
      status: "ready",
      total: 56,
      matches: [{ pageId: "page_0_0" }, { pageId: "page_0_1" }],
    });
    expect(
      (
        await call(
          "search_artifact_text",
          { ...f.input, query: " needle " },
          f.ctx,
        )
      ).result,
    ).toMatchObject({ total: 0, matches: [] });
    expect(
      (
        await call(
          "search_artifact_text",
          { ...f.input, query: "NEEDLE", matchCase: true },
          f.ctx,
        )
      ).result,
    ).toMatchObject({ total: 0, matches: [] });
  });

  it("paginates section, page and search listings without omissions", async () => {
    const f = await fixture({ sectionCount: 55, pageCount: 55 });
    await f.prepare();
    for (const action of ["sections", "pages", "search"] as const) {
      const input = {
        ...f.input,
        action,
        ...(action === "search" ? { query: "needle" } : {}),
        ...(action === "pages" ? { sectionId: "section_0" } : {}),
      };
      const seen: string[] = [];
      let cursor: string | null | undefined;
      let calls = 0;
      do {
        const { result } = await call(
          "read_onenote",
          { ...input, ...(cursor ? { cursor } : {}) },
          f.ctx,
        );
        seen.push(
          ...(result.sections ?? result.pages ?? []).map((row) => row.id),
        );
        cursor = result.nextCursor;
        if (++calls > 20) throw new Error("pagination did not advance");
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(action === "search" ? 109 : 55);
    }
  });

  it("reconstructs complete text, tables, images and attachment descriptions across page chunks", async () => {
    const f = await fixture({ pageCount: 1 });
    await f.prepare();
    let cursor: string | null | undefined;
    let text = "";
    let calls = 0;
    do {
      const { result } = await call(
        "read_onenote",
        {
          ...f.input,
          action: "page",
          pageId: "page_0_0",
          ...(cursor ? { cursor } : {}),
        },
        f.ctx,
      );
      expect(result.offset).toBe(text.length);
      text += result.text;
      cursor = result.nextCursor;
      if (++calls > 20) throw new Error("pagination did not advance");
    } while (cursor);
    expect(calls).toBeGreaterThan(1);
    expect(text).toBe(expectedText(f.artifact.id));
  });

  it("rejects tampered, mismatched-query and replaced-source signed cursors", async () => {
    const f = await fixture();
    await f.prepare();
    const input = { ...f.input, action: "search", query: "needle" };
    const first = await call("read_onenote", input, f.ctx);
    const cursor = first.result.nextCursor!;
    expect(cursor).toBeTruthy();
    await expect(
      execute("read_onenote", { ...input, cursor: `x${cursor}` }, f.ctx),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
    await expect(
      execute("read_onenote", { ...input, query: "Page", cursor }, f.ctx),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
    await expect(
      execute("read_onenote", { ...input, action: "pages", cursor }, f.ctx),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_CURSOR" },
    });
    await f.upload("replacement");
    await expect(
      execute("read_onenote", { ...input, cursor }, f.ctx),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "STALE_BASE" },
    });
  });

  it("bounds the complete JSON response with long titles, warnings and escaped control text", async () => {
    const f = await fixture({ hostile: true, pageCount: 4 });
    await f.prepare();
    await call("get_artifact_overview", f.input, f.ctx);
    await call("search_artifact_text", { ...f.input, query: "needle" }, f.ctx);
    for (const action of ["sections", "pages", "search"] as const) {
      let cursor: string | null | undefined;
      const seen: string[] = [];
      let calls = 0;
      do {
        const { result } = await call(
          "read_onenote",
          {
            ...f.input,
            action,
            query: "needle",
            ...(cursor ? { cursor } : {}),
          },
          f.ctx,
        );
        const items = result.sections ?? result.pages ?? [];
        expect(items.length).toBeGreaterThan(0);
        seen.push(...items.map((item) => item.id));
        expect(result.nextCursor).not.toBe(cursor);
        cursor = result.nextCursor;
        if (++calls > 20)
          throw new Error("hostile listing pagination did not advance");
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(action === "sections" ? 2 : 5);
    }
    let cursor: string | null | undefined;
    let text = "";
    let calls = 0;
    do {
      const { result } = await call(
        "read_onenote",
        {
          ...f.input,
          action: "page",
          pageId: "page_0_0",
          ...(cursor ? { cursor } : {}),
        },
        f.ctx,
      );
      expect(result.offset).toBe(text.length);
      text += result.text;
      cursor = result.nextCursor;
      if (++calls > 100)
        throw new Error("hostile text pagination did not advance");
    } while (cursor);
    expect(text).toBe(
      `${"\u0000\n😀".repeat(5000)}\n\nKey\tValue\nOne\tTwo\n\n![Printed diagram](weaver-image:${f.artifact.id}/${assetId})\n\n[Attachment: notes.pdf (1234 bytes)]`,
    );
  });

  it("checks scope and current membership on every notebook tool entry", async () => {
    const f = await fixture({ pageCount: 1 });
    await f.prepare();
    const entries = [
      { name: "get_artifact_overview", args: {} },
      { name: "search_artifact_text", args: { query: "needle" } },
      { name: "read_onenote", args: { action: "page", pageId: "page_0_0" } },
    ];
    for (const entry of entries) {
      await expect(
        execute(
          entry.name,
          { ...f.input, ...entry.args, projectId: randomUUID() },
          f.ctx,
        ),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        details: { reason: "SCOPE_VIOLATION" },
      });
      await expect(
        execute(
          entry.name,
          { ...f.input, ...entry.args },
          { ...f.ctx, actor: f.outsider },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await f.db.member.deleteMany({ where: { userId: f.actor.userId } });
    for (const entry of entries)
      await expect(
        execute(entry.name, { ...f.input, ...entry.args }, f.ctx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects wrong formats and missing page/search parameters", async () => {
    const f = await fixture({ pageCount: 1 });
    await f.upload('{"a":1}', "data.json");
    // Uploading the notebook queued its own preparation; rejected calls add none.
    f.queue.jobs.splice(0);
    await expect(
      execute(
        "read_onenote",
        { ...f.input, filename: "data.json", action: "sections" },
        f.ctx,
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "read_onenote reads OneNote files; for a JSON file use query_json_artifact",
    });
    await expect(
      execute("read_onenote", { ...f.input, action: "page" }, f.ctx),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "pageId is required for action=page",
    });
    await expect(
      execute("read_onenote", { ...f.input, action: "search" }, f.ctx),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "query is required for action=search",
    });
    expect(
      f.queue.jobs.filter((j) => j.name === "artifact.notebook.prepare"),
    ).toHaveLength(0);
  });
});

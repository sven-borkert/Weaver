import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blobExists,
  deleteBlob,
  openBlobStream,
  openUploadSink,
  promoteUpload,
  readBlob,
  sweepTmp,
} from "./blobStore";
import { blobPath, tmpPath } from "./paths";

const PROJECT = "11111111-1111-4111-8111-111111111111";
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "weaver-blob-"));
});

afterEach(async () => {
  await rm(dataDir, { force: true, recursive: true });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function stage(value: string): Promise<{
  uploadId: string;
  digest: string;
}> {
  const uploadId = randomUUID();
  const sink = await openUploadSink(dataDir, PROJECT, uploadId);
  await sink.write(new TextEncoder().encode(value));
  const { digest } = await sink.finish();
  return { uploadId, digest };
}

describe("blobStore", () => {
  it("ingestion review: failed promotion leaves the tmp file eligible for cleanup", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const staged = await stage("broken promotion");
      const target = blobPath(dataDir, PROJECT, staged.digest);
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(target);
      await expect(
        promoteUpload(dataDir, PROJECT, staged.uploadId, staged.digest),
      ).rejects.toThrow();
      const old = new Date(Date.now() - 120000);
      await utimes(tmpPath(dataDir, PROJECT, staged.uploadId), old, old);
      await vi.advanceTimersByTimeAsync(20000);
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        await sweepTmp(dataDir, PROJECT, new Date(Date.now() - 60000)),
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ingestion review: refuses writes that would cross the free-space floor", async () => {
    const uploadId = randomUUID();
    const sink = await openUploadSink(dataDir, PROJECT, uploadId, {
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    try {
      await expect(sink.write(Buffer.from("body"))).rejects.toThrow(
        /free space/i,
      );
      expect((await stat(tmpPath(dataDir, PROJECT, uploadId))).size).toBe(0);
    } finally {
      await sink.abort();
    }
  });

  it("streams an upload, reports its digest and size, and promotes it", async () => {
    const uploadId = randomUUID();
    const sink = await openUploadSink(dataDir, PROJECT, uploadId);
    await sink.write(new TextEncoder().encode("hello "));
    await sink.write(new TextEncoder().encode("world"));
    const { digest, byteSize } = await sink.finish();

    expect(digest).toBe(sha256("hello world"));
    expect(byteSize).toBe(11);

    await promoteUpload(dataDir, PROJECT, uploadId, digest);
    expect(await blobExists(dataDir, PROJECT, digest)).toBe(true);
    expect((await readBlob(dataDir, PROJECT, digest)).toString()).toBe(
      "hello world",
    );
    await expect(stat(tmpPath(dataDir, PROJECT, uploadId))).rejects.toThrow();
  });

  it("waits for large writes before finishing the staged upload", async () => {
    const uploadId = randomUUID();
    const first = Buffer.alloc(1024 * 1024, 0x61);
    const second = Buffer.alloc(1024 * 1024, 0x62);
    const sink = await openUploadSink(dataDir, PROJECT, uploadId);

    await Promise.all([sink.write(first), sink.write(second)]);
    const result = await sink.finish();

    expect(result).toEqual({
      digest: sha256(Buffer.concat([first, second])),
      byteSize: first.length + second.length,
    });
    const stored = await readFile(tmpPath(dataDir, PROJECT, uploadId));
    expect(stored.equals(Buffer.concat([first, second]))).toBe(true);
  });

  it("promoting an already stored digest is a no-op that clears tmp", async () => {
    const first = await stage("dup");
    await promoteUpload(dataDir, PROJECT, first.uploadId, first.digest);

    const second = await stage("dup");
    await promoteUpload(dataDir, PROJECT, second.uploadId, second.digest);

    expect((await readBlob(dataDir, PROJECT, first.digest)).toString()).toBe(
      "dup",
    );
    await expect(
      stat(tmpPath(dataDir, PROJECT, second.uploadId)),
    ).rejects.toThrow();
  });

  it("atomically promotes concurrent uploads of the same digest", async () => {
    const first = await stage("same bytes");
    const second = await stage("same bytes");

    await Promise.all([
      promoteUpload(dataDir, PROJECT, first.uploadId, first.digest),
      promoteUpload(dataDir, PROJECT, second.uploadId, second.digest),
    ]);

    expect((await readBlob(dataDir, PROJECT, first.digest)).toString()).toBe(
      "same bytes",
    );
    await expect(
      stat(tmpPath(dataDir, PROJECT, first.uploadId)),
    ).rejects.toThrow();
    await expect(
      stat(tmpPath(dataDir, PROJECT, second.uploadId)),
    ).rejects.toThrow();
  });

  it("does not discard staging when a non-blob blocks promotion", async () => {
    const staged = await stage("keep me");
    await mkdir(blobPath(dataDir, PROJECT, staged.digest), { recursive: true });

    await expect(
      promoteUpload(dataDir, PROJECT, staged.uploadId, staged.digest),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      stat(tmpPath(dataDir, PROJECT, staged.uploadId)),
    ).resolves.toBeTruthy();
  });

  it("aborting removes the staged file", async () => {
    const uploadId = randomUUID();
    const sink = await openUploadSink(dataDir, PROJECT, uploadId);
    await sink.write(new TextEncoder().encode("partial"));
    await sink.abort();
    await expect(stat(tmpPath(dataDir, PROJECT, uploadId))).rejects.toThrow();
  });

  it("rejects writes after the sink is finished", async () => {
    const sink = await openUploadSink(dataDir, PROJECT, randomUUID());
    await sink.finish();

    await expect(sink.write(new Uint8Array([1]))).rejects.toThrow(
      /not writable/,
    );
  });

  it("propagates filesystem errors other than missing paths", async () => {
    await writeFile(path.join(dataDir, "files"), "not a directory");
    const digest = sha256("blocked");

    await expect(blobExists(dataDir, PROJECT, digest)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(sweepTmp(dataDir, PROJECT, new Date())).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(
      openUploadSink(dataDir, PROJECT, randomUUID()),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("deleting a blob is idempotent", async () => {
    const digest = sha256("gone");
    await expect(deleteBlob(dataDir, PROJECT, digest)).resolves.toBeUndefined();
    expect(await blobExists(dataDir, PROJECT, digest)).toBe(false);
  });

  it("reading a missing blob throws ENOENT", async () => {
    await expect(
      readBlob(dataDir, PROJECT, sha256("absent")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps only tmp entries older than the cutoff", async () => {
    const stale = await stage("stale");
    const fresh = await stage("fresh");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(tmpPath(dataDir, PROJECT, stale.uploadId), old, old);

    const removed = await sweepTmp(
      dataDir,
      PROJECT,
      new Date(Date.now() - 30 * 60 * 1000),
    );

    expect(removed).toBe(1);
    await expect(
      stat(tmpPath(dataDir, PROJECT, stale.uploadId)),
    ).rejects.toThrow();
    await expect(
      stat(tmpPath(dataDir, PROJECT, fresh.uploadId)),
    ).resolves.toBeTruthy();
  });

  it("sweeping a project that never uploaded anything removes nothing", async () => {
    expect(await sweepTmp(dataDir, PROJECT, new Date())).toBe(0);
  });

  describe("openBlobStream", () => {
    async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    }

    it("reports the size and streams the stored bytes", async () => {
      const staged = await stage("stream me");
      await promoteUpload(dataDir, PROJECT, staged.uploadId, staged.digest);

      const opened = await openBlobStream(dataDir, PROJECT, staged.digest, 64);
      expect(opened.size).toBe(9);
      expect((await collect(opened.stream)).toString()).toBe("stream me");
    });

    it("refuses a blob larger than the read limit without streaming it", async () => {
      const staged = await stage("eleven bytes");
      await promoteUpload(dataDir, PROJECT, staged.uploadId, staged.digest);

      await expect(
        openBlobStream(dataDir, PROJECT, staged.digest, 5),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("throws ENOENT for a missing blob", async () => {
      await expect(
        openBlobStream(dataDir, PROJECT, sha256("absent"), 64),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a symlink or directory in place of a blob", async () => {
      const outside = path.join(dataDir, "outside.txt");
      await writeFile(outside, "not a blob");
      const linked = blobPath(dataDir, PROJECT, sha256("linked"));
      await mkdir(path.dirname(linked), { recursive: true });
      await symlink(outside, linked);
      await expect(
        openBlobStream(dataDir, PROJECT, sha256("linked"), 64),
      ).rejects.toMatchObject({ code: "ELOOP" });

      const dir = blobPath(dataDir, PROJECT, sha256("dir"));
      await mkdir(dir, { recursive: true });
      await expect(
        openBlobStream(dataDir, PROJECT, sha256("dir"), 64),
      ).rejects.toThrow(/not a regular file/);
    });
  });
});

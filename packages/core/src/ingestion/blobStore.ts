import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants, createWriteStream, type ReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readdir,
  open,
  rm,
  unlink,
  utimes,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { UUID_RE, blobPath, projectFilesDir, tmpDir, tmpPath } from "./paths";

const uploadHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

function stopUploadHeartbeat(target: string) {
  const timer = uploadHeartbeats.get(target);
  if (timer) clearInterval(timer);
  uploadHeartbeats.delete(target);
}

export class UploadStorageCapacityError extends Error {}

export type UploadSink = {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ digest: string; byteSize: number }>;
  abort(): Promise<void>;
};

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("upload stream failed", { cause: error });
}

export async function openUploadSink(
  dataDir: string,
  projectId: string,
  uploadId: string,
  options: { minFreeBytes?: number } = {},
): Promise<UploadSink> {
  const target = tmpPath(dataDir, projectId, uploadId);
  await mkdir(path.dirname(target), { recursive: true });
  const stream = createWriteStream(target, { flags: "wx" });
  await once(stream, "open");
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(target, now, now).catch(() => stopUploadHeartbeat(target));
  }, 10_000);
  heartbeat.unref();
  uploadHeartbeats.set(target, heartbeat);

  const hash = createHash("sha256");
  let byteSize = 0;
  let state: "active" | "finishing" | "finished" | "aborted" | "failed" =
    "active";
  let streamFailure: Error | undefined;
  let writeTail = Promise.resolve();
  let finishPromise: Promise<{ digest: string; byteSize: number }> | undefined;
  let abortPromise: Promise<void> | undefined;

  stream.on("error", (error) => {
    streamFailure ??= error;
  });

  const ensureWritable = () => {
    if (state !== "active") throw new Error("upload sink is not writable");
  };

  const throwIfStreamFailed = () => {
    const failure = streamFailure;
    if (failure) throw failure;
  };

  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    throwIfStreamFailed();
    const space = await statfs(path.dirname(target));
    if (
      space.bavail * space.bsize - chunk.byteLength <
      (options.minFreeBytes ?? 1024 ** 3)
    )
      throw new UploadStorageCapacityError(
        "Upload storage has insufficient free space",
      );
    await new Promise<void>((resolve, reject) => {
      stream.write(chunk, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
    throwIfStreamFailed();
    hash.update(chunk);
    byteSize += chunk.byteLength;
  };

  return {
    async write(chunk) {
      ensureWritable();
      const ownedChunk = Buffer.from(chunk);
      const operation = writeTail.then(() => writeChunk(ownedChunk));
      writeTail = operation.catch((error: unknown) => {
        streamFailure ??= asError(error);
        state = "failed";
      });
      return operation;
    },
    async finish() {
      if (finishPromise) return finishPromise;
      ensureWritable();
      state = "finishing";
      finishPromise = (async () => {
        await writeTail;
        throwIfStreamFailed();
        stream.end();
        await finished(stream, { cleanup: true });
        throwIfStreamFailed();
        state = "finished";
        return { digest: hash.digest("hex"), byteSize };
      })().catch((error: unknown) => {
        state = "failed";
        throw asError(error);
      });
      return finishPromise;
    },
    async abort() {
      if (abortPromise) return abortPromise;
      state = "aborted";
      stopUploadHeartbeat(target);
      abortPromise = (async () => {
        if (!stream.closed) {
          const closed = new Promise<void>((resolve) => {
            stream.once("close", () => resolve());
          });
          stream.destroy();
          await closed;
        }
        await writeTail;
        await rm(target, { force: true });
      })();
      return abortPromise;
    },
  };
}

export async function promoteUpload(
  dataDir: string,
  projectId: string,
  uploadId: string,
  digest: string,
): Promise<void> {
  const source = tmpPath(dataDir, projectId, uploadId);
  const target = blobPath(dataDir, projectId, digest);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await link(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const existing = await lstat(target);
      if (!existing.isFile()) throw error;
    }
    await rm(source);
  } finally {
    stopUploadHeartbeat(source);
  }
}

/** @internal Storage fixture assertion. */
export async function blobExists(
  dataDir: string,
  projectId: string,
  digest: string,
): Promise<boolean> {
  try {
    return (await lstat(blobPath(dataDir, projectId, digest))).isFile();
  } catch (error) {
    ignoreMissing(error);
    return false;
  }
}

export async function readBlob(
  dataDir: string,
  projectId: string,
  digest: string,
  maxBytes = Infinity,
): Promise<Buffer> {
  const file = await open(blobPath(dataDir, projectId, digest), "r");
  try {
    if ((await file.stat()).size > maxBytes)
      throw new RangeError("Original exceeds parser input limit");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** Opens a blob for streaming; the caller owns the stream and must consume or destroy it. */
export async function openBlobStream(
  dataDir: string,
  projectId: string,
  digest: string,
  maxBytes: number,
): Promise<{ size: number; stream: ReadStream }> {
  const file = await open(
    blobPath(dataDir, projectId, digest),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let info;
  try {
    info = await file.stat();
    if (!info.isFile()) throw new Error("blob is not a regular file");
    if (info.size > maxBytes)
      throw new RangeError("Original exceeds parser input limit");
  } catch (error) {
    await file.close();
    throw error;
  }
  return {
    size: info.size,
    stream: file.createReadStream({ highWaterMark: 1 << 20 }),
  };
}

export async function deleteBlob(
  dataDir: string,
  projectId: string,
  digest: string,
): Promise<void> {
  await rm(blobPath(dataDir, projectId, digest), { force: true });
}

async function directoryEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    ignoreMissing(error);
    return [];
  }
}

async function removeOldFile(
  target: string,
  olderThan: Date,
): Promise<boolean> {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.mtime >= olderThan) return false;
    await unlink(target);
    return true;
  } catch (error) {
    ignoreMissing(error);
    return false;
  }
}

export async function sweepTmp(
  dataDir: string,
  projectId: string,
  olderThan: Date,
): Promise<number> {
  const dir = tmpDir(dataDir, projectId);
  let removed = 0;
  for (const entry of await directoryEntries(dir)) {
    if (await removeOldFile(path.join(dir, entry.name), olderThan))
      removed += 1;
  }
  return removed;
}

/** Enumerates canonical blob names without following directory symlinks. */
export async function listBlobDigests(
  dataDir: string,
  projectId: string,
): Promise<string[]> {
  const root = projectFilesDir(dataDir, projectId);
  const digests: string[] = [];
  for (const shard of await directoryEntries(root)) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
    for (const entry of await directoryEntries(path.join(root, shard.name))) {
      if (
        entry.isFile() &&
        /^[a-f0-9]{64}$/.test(entry.name) &&
        entry.name.startsWith(shard.name)
      )
        digests.push(entry.name);
    }
  }
  return digests;
}

/** Caller holds the project lifecycle lock and has checked digest references. */
export async function deleteBlobIfOlderThan(
  dataDir: string,
  projectId: string,
  digest: string,
  olderThan: Date,
): Promise<boolean> {
  return removeOldFile(blobPath(dataDir, projectId, digest), olderThan);
}

export async function listStoredProjectIds(dataDir: string): Promise<string[]> {
  return (await directoryEntries(path.join(dataDir, "files")))
    .filter((entry) => entry.isDirectory() && UUID_RE.test(entry.name))
    .map((entry) => entry.name);
}

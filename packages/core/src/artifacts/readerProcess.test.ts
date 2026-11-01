import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { blobPath } from "../ingestion/paths";
import { MAX_READER_RESULT_BYTES } from "./readerOperations";
import {
  activeReaderCount,
  parseChildMessage,
  runArtifactReader,
} from "./readerProcess";

const PROJECT_ID = "5f8b7a10-1f8c-4a6e-9c2d-0d4f6b2a1e33";
const MAX_BYTES = 64 * 1024 * 1024;

let dataDir: string;

const digestOf = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function writeBlob(bytes: Buffer, digest = digestOf(bytes)) {
  const target = blobPath(dataDir, PROJECT_ID, digest);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return digest;
}

const request = (
  contentDigest: string,
  operation: Parameters<typeof runArtifactReader>[0]["operation"],
  input: unknown = {},
) => ({
  dataDir,
  projectId: PROJECT_ID,
  contentDigest,
  maxBytes: MAX_BYTES,
  operation,
  input,
});

/** ~60,000 long keys: enough parsing work that a 1 ms deadline always
 *  expires while the child is still running. */
const wideJson = Buffer.from(
  `{${Array.from(
    { length: 60_000 },
    (_, index) => `"key-${String(index).padStart(12, "0")}-padding":${index}`,
  ).join(",")}}`,
);

/** One 3 MiB string: the readers window and cap their own lists, so a single
 *  JSON match larger than the cap is what is left to trip it. */
const hugeMatchJson = Buffer.from(
  JSON.stringify({ blob: "x".repeat(3 * 1024 * 1024) }),
);

const bulkyJson = Buffer.from(
  JSON.stringify({
    items: Array.from(
      { length: 120_000 },
      (_, index) => `row-${index}-${"x".repeat(40)}`,
    ),
  }),
);

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "weaver-reader-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  expect(activeReaderCount()).toBe(0);
});

it("reads a stored JSON blob in a child process", async () => {
  const digest = await writeBlob(
    Buffer.from(JSON.stringify({ alpha: [1, 2, 3], beta: { one: 1 } })),
  );
  expect(await runArtifactReader(request(digest, "json.overview"))).toEqual({
    ok: true,
    value: {
      sizeBytes: expect.any(Number) as number,
      rootType: "object",
      rootCount: 2,
      topLevel: [
        { key: "alpha", type: "array", count: 3 },
        { key: "beta", type: "object", count: 1 },
      ],
      truncated: false,
    },
  });
}, 30_000);

it("refuses bytes whose digest no longer matches", async () => {
  const digest = digestOf(Buffer.from('{"a":1}'));
  await writeBlob(Buffer.from('{"a":2}'), digest);
  expect(await runArtifactReader(request(digest, "json.overview"))).toEqual({
    ok: false,
    failure: { code: "not_found", message: "file content is no longer stored" },
  });
}, 30_000);

it("reports a missing blob as not found", async () => {
  const digest = digestOf(Buffer.from("never stored"));
  expect(await runArtifactReader(request(digest, "json.overview"))).toEqual({
    ok: false,
    failure: { code: "not_found", message: "file content is no longer stored" },
  });
}, 30_000);

it("passes a reader's own error code and message through", async () => {
  const digest = await writeBlob(Buffer.from("{not json"));
  const result = await runArtifactReader(request(digest, "json.overview"));
  expect(result).toMatchObject({
    ok: false,
    failure: { code: "malformed" },
  });
  expect(result.ok ? "" : result.failure.message).toMatch(
    /artifact is not valid JSON/,
  );
}, 30_000);

it("rejects an unknown operation without spawning a child", async () => {
  const digest = digestOf(Buffer.from("unused"));
  await expect(
    runArtifactReader({
      ...request(digest, "json.overview"),
      operation: "json.nonsense" as Parameters<
        typeof runArtifactReader
      >[0]["operation"],
    }),
  ).rejects.toThrow(/unknown reader operation/);
  expect(activeReaderCount()).toBe(0);
});

it("kills the child and rejects when the caller aborts", async () => {
  const digest = await writeBlob(bulkyJson);
  const controller = new AbortController();
  const pending = runArtifactReader(request(digest, "json.overview"), {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
}, 30_000);

it("reports a read that outlives its deadline as unavailable", async () => {
  const digest = await writeBlob(wideJson);
  expect(
    await runArtifactReader(request(digest, "json.overview"), {
      timeoutMs: 1,
    }),
  ).toEqual({
    ok: false,
    failure: {
      code: "unavailable",
      cause: "timeout",
      message: "reading the file took too long",
    },
  });
}, 30_000);

it("refuses a reader result larger than the transfer cap", async () => {
  const digest = await writeBlob(hugeMatchJson);
  expect(
    await runArtifactReader(request(digest, "json.query", { path: "$.blob" })),
  ).toEqual({
    ok: false,
    failure: {
      code: "resource_limit",
      message: "the file is too large or complex to read",
    },
  });
}, 60_000);

it("reports a reader that throws anything but a read error as a crash", async () => {
  const digest = await writeBlob(Buffer.from(JSON.stringify({ a: 1 })));
  // queryJson reads input.fields before parsing, so a null input is a TypeError.
  expect(await runArtifactReader(request(digest, "json.query", null))).toEqual({
    ok: false,
    failure: {
      code: "unavailable",
      cause: "crashed",
      message: "reading the file failed",
      exitCode: 1,
      signal: null,
    },
  });
}, 30_000);

it("rejects a malformed file reference before reading anything", async () => {
  expect(
    await runArtifactReader(request("not-a-digest", "json.overview")),
  ).toEqual({
    ok: false,
    failure: { code: "invalid_input", message: "invalid file reference" },
  });
}, 30_000);

it("trusts nothing the child sends back", () => {
  expect(parseChildMessage(null)).toBeNull();
  expect(parseChildMessage("result")).toBeNull();
  expect(parseChildMessage({ kind: "progress" })).toBeNull();
  const crashed = {
    ok: false,
    failure: {
      code: "unavailable",
      cause: "crashed",
      message: "reading the file failed",
    },
  };
  expect(
    parseChildMessage({ kind: "result", ok: true, json: "{oops" }),
  ).toEqual(crashed);
  expect(parseChildMessage({ kind: "result", ok: true, json: 7 })).toEqual(
    crashed,
  );
  expect(
    parseChildMessage({
      kind: "result",
      ok: true,
      json: `"${"x".repeat(MAX_READER_RESULT_BYTES)}"`,
    }),
  ).toEqual(crashed);
  expect(
    parseChildMessage({
      kind: "result",
      ok: false,
      failure: { code: "made_up", message: "no" },
    }),
  ).toEqual(crashed);
  // "busy" and "unavailable" are parent-only codes (queue saturation, timeout,
  // memory kill, crash) — a child claiming either is untrusted like any other
  // code it never legitimately produces.
  expect(
    parseChildMessage({
      kind: "result",
      ok: false,
      failure: { code: "busy", message: "no" },
    }),
  ).toEqual(crashed);
  expect(
    parseChildMessage({
      kind: "result",
      ok: false,
      failure: { code: "unavailable", message: "no" },
    }),
  ).toEqual(crashed);
  expect(parseChildMessage({ kind: "result", ok: false })).toEqual(crashed);
  expect(
    parseChildMessage({
      kind: "result",
      ok: false,
      failure: { code: "malformed", message: "y".repeat(10_000) },
    }),
  ).toEqual({
    ok: false,
    failure: { code: "malformed", message: "y".repeat(500) },
  });
  expect(
    parseChildMessage({ kind: "result", ok: true, json: '{"a":[1]}' }),
  ).toEqual({ ok: true, value: { a: [1] } });
});

it("never runs more than two reader children at once", async () => {
  const digest = await writeBlob(bulkyJson);
  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, activeReaderCount());
  }, 5);
  try {
    const pending = [
      runArtifactReader(request(digest, "json.overview")),
      runArtifactReader(request(digest, "json.overview")),
      runArtifactReader(request(digest, "json.overview")),
    ];
    expect(activeReaderCount()).toBe(2);
    const results = await Promise.all(pending);
    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
  } finally {
    clearInterval(sampler);
  }
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(2);
}, 120_000);

it("drops an aborted waiter without letting it take a slot", async () => {
  const digest = await writeBlob(bulkyJson);
  const controller = new AbortController();
  const running = [
    runArtifactReader(request(digest, "json.overview")),
    runArtifactReader(request(digest, "json.overview")),
  ];
  const cancelled = runArtifactReader(request(digest, "json.overview"), {
    signal: controller.signal,
  });
  const queued = runArtifactReader(request(digest, "json.overview"));
  expect(activeReaderCount()).toBe(2);
  controller.abort();
  expect(activeReaderCount()).toBe(2);
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(activeReaderCount()).toBe(2);
  const results = await Promise.all([...running, queued]);
  expect(results.map((result) => result.ok)).toEqual([true, true, true]);
}, 120_000);

// A read that never started is a busy server, not a file Weaver cannot read:
// the caller gets the retryable answer, not "this file took too long".
it("reports a deadline that expires while waiting for a slot as busy", async () => {
  const digest = await writeBlob(bulkyJson);
  const running = [
    runArtifactReader(request(digest, "json.overview")),
    runArtifactReader(request(digest, "json.overview")),
  ];
  expect(
    await runArtifactReader(request(digest, "json.overview"), {
      timeoutMs: 1,
    }),
  ).toEqual({
    ok: false,
    failure: {
      code: "busy",
      message: "too many file reads are in progress; try again",
    },
  });
  expect(activeReaderCount()).toBe(2);
  expect((await Promise.all(running)).map((result) => result.ok)).toEqual([
    true,
    true,
  ]);
}, 120_000);

it("refuses a read once the wait queue is full", async () => {
  const digest = await writeBlob(Buffer.from(JSON.stringify({ small: true })));
  const accepted = Array.from({ length: 10 }, () =>
    runArtifactReader(request(digest, "json.overview")),
  );
  const refused = runArtifactReader(request(digest, "json.overview"));
  expect(await refused).toEqual({
    ok: false,
    failure: {
      code: "busy",
      message: "too many file reads are in progress; try again",
    },
  });
  expect((await Promise.all(accepted)).every((result) => result.ok)).toBe(true);
}, 120_000);

// V8 ends a heap-limit fatal with abort(): that is the file's fault, reported
// like the RSS watchdog, while any other signal death stays a crash.
it("reports a child that aborts itself as a memory failure", async () => {
  const digest = await writeBlob(Buffer.from(JSON.stringify({ a: 1 })));
  expect(
    await runArtifactReader(
      request(digest, "json.overview", { __crashForTest: "abort" }),
    ),
  ).toEqual({
    ok: false,
    failure: {
      code: "unavailable",
      cause: "memory",
      message: "reading the file needed too much memory",
      exitCode: null,
      signal: "SIGABRT",
    },
  });
}, 30_000);

it("reports a child killed by any other signal as a crash", async () => {
  const digest = await writeBlob(Buffer.from(JSON.stringify({ a: 1 })));
  expect(
    await runArtifactReader(
      request(digest, "json.overview", { __crashForTest: "segv" }),
    ),
  ).toEqual({
    ok: false,
    failure: {
      code: "unavailable",
      cause: "crashed",
      message: "reading the file failed",
      exitCode: null,
      signal: "SIGSEGV",
    },
  });
}, 30_000);

it("measures the result cap in bytes, not UTF-16 code units", () => {
  // 1.5 M two-byte characters: under the cap in code units, 3 MB in UTF-8.
  const multibyte = `"${"é".repeat(1.5 * 1024 * 1024)}"`;
  expect(multibyte.length).toBeLessThan(MAX_READER_RESULT_BYTES);
  expect(
    parseChildMessage({ kind: "result", ok: true, json: multibyte }),
  ).toEqual({
    ok: false,
    failure: {
      code: "unavailable",
      cause: "crashed",
      message: "reading the file failed",
    },
  });
  const fits = `"${"é".repeat(1024)}"`;
  expect(parseChildMessage({ kind: "result", ok: true, json: fits })).toEqual({
    ok: true,
    value: "é".repeat(1024),
  });
});

it("clips escaped text inside the child with exact CRLF positions and touched line counts", async () => {
  const digest = await writeBlob(Buffer.from("😀abcd\r\nnext"));
  const first = await runArtifactReader(
    request(digest, "text.read", { serializedTextBytes: 12 }),
  );
  expect(first).toMatchObject({
    ok: true,
    value: {
      text: "😀abcd\r",
      start: { line: 1, charOffset: 0 },
      end: { line: 1, charOffset: 7 },
      lineCount: 1,
      nextPosition: { line: 1, charOffset: 7 },
    },
  });
  const second = await runArtifactReader(
    request(digest, "text.read", {
      position: { line: 1, charOffset: 7 },
      serializedTextBytes: 12,
    }),
  );
  expect(second).toMatchObject({
    ok: true,
    value: { text: "\nnext", lineCount: 2, nextPosition: null },
  });
});

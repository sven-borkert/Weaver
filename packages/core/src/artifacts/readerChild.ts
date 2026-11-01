/** One artifact read per process: load the blob, verify it, run one reader,
 *  send back its serialized result. Nothing here may reach the database, the
 *  configuration, or the network. */
import { createHash } from "node:crypto";
import type { TextReadInput } from "@weaver/artifact-readers/text";
import { ArtifactReadError } from "@weaver/artifact-readers/errors";
import { readBlob } from "../ingestion/blobStore";
import { DIGEST_RE, UUID_RE } from "../ingestion/paths";
import {
  isReaderOperation,
  MAX_READER_RESULT_BYTES,
  type ReaderOperation,
} from "./readerOperations";
import type { ReaderFailure, ReaderRequest } from "./readerProcess";

const MISSING_CONTENT = "file content is no longer stored";
const TOO_LARGE = "the file is too large or complex to read";

/** `never` accepts every reader's own input type; the tool layer validates the
 *  shape each operation needs. */
type Reader = (data: Uint8Array, input: never) => unknown;

const json = () => import("@weaver/artifact-readers/json");
const pdf = () => import("@weaver/artifact-readers/pdf");
const excel = () => import("@weaver/artifact-readers/excel");
const text = () => import("@weaver/artifact-readers/text");
const csv = () => import("@weaver/artifact-readers/csv");
const yaml = () => import("@weaver/artifact-readers/yaml");
const word = () => import("@weaver/artifact-readers/word");

const READERS = {
  "word.outline": async () => (await word()).readWordOutline,
  "word.tableInventory": async () => (await word()).readWordTableInventory,
  "word.chapter": async () => (await word()).readWordChapter,
  "word.blocks": async () => (await word()).readWordBlocks,
  "word.instructions": async () => (await word()).readWordInstructions,
  "word.findTables": async () => (await word()).findWordTables,
  "word.table": async () => (await word()).readWordTable,
  "word.dropdowns": async () => (await word()).readWordDropdowns,
  "word.search": async () => (await word()).searchWordText,
  "excel.overview": async () => (await excel()).readExcelOverview,
  "excel.sheet": async () => (await excel()).readExcelSheet,
  "excel.workbook": async () => (await excel()).readExcelWorkbook,
  "pdf.summary": async () => (await pdf()).readPdfSummary,
  "pdf.pages": async () => (await pdf()).readPdfPages,
  "pdf.search": async () => (await pdf()).searchPdfText,
  "json.overview": async () => (await json()).readJsonOverview,
  "json.query": async () => (await json()).queryJson,
  "json.structure": async () => (await json()).inspectJson,
  "yaml.overview": async () => (await yaml()).readYamlOverview,
  "yaml.query": async () => (await yaml()).queryYaml,
  "yaml.structure": async () => (await yaml()).inspectYaml,
  "text.overview": async () => (await text()).readTextOverview,
  "text.read": async () => boundedTextRead,
  "text.search": async () => (await text()).searchText,
  "csv.overview": async () => (await csv()).readCsvOverview,
  "csv.rows": async () => (await csv()).readCsv,
  "csv.search": async () => (await csv()).searchCsv,
} as const satisfies Record<ReaderOperation, () => Promise<Reader>>;

async function boundedTextRead(
  data: Uint8Array,
  input: TextReadInput & {
    serializedTextBytes?: number;
  },
) {
  const reader = await text();
  const result = reader.readText(data, input);
  if (input.serializedTextBytes === undefined) return result;
  const budget = input.serializedTextBytes;
  if (!Number.isSafeInteger(budget) || budget < 8 || budget > 16_000)
    throw new ArtifactReadError("invalid_input", "invalid text output budget");
  let low = 0;
  let high = result.text.length;
  let end = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let candidate = middle;
    const previous = result.text.charCodeAt(candidate - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) candidate--;
    if (
      Buffer.byteLength(JSON.stringify(result.text.slice(0, candidate))) <=
      budget
    ) {
      end = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (end === result.text.length) return result;
  const position = reader.textPositionAfterPrefix(
    result.start,
    result.text,
    end,
  );
  const last =
    end > 0
      ? reader.textPositionAfterPrefix(
          result.start,
          result.text,
          end -
            (result.text.charCodeAt(end - 1) >= 0xdc00 &&
            result.text.charCodeAt(end - 1) <= 0xdfff
              ? 2
              : 1),
        )
      : result.start;
  return {
    ...result,
    text: result.text.slice(0, end),
    end: position,
    lineCount: end === 0 ? 0 : last.line - result.start.line + 1,
    nextPosition: position,
  };
}

async function loadBytes(request: ReaderRequest): Promise<Buffer> {
  if (
    !UUID_RE.test(request.projectId) ||
    !DIGEST_RE.test(request.contentDigest)
  )
    throw new ArtifactReadError("invalid_input", "invalid file reference");
  let bytes: Buffer;
  try {
    bytes = await readBlob(
      request.dataDir,
      request.projectId,
      request.contentDigest,
      request.maxBytes,
    );
  } catch (cause) {
    if (cause instanceof RangeError)
      throw new ArtifactReadError("resource_limit", TOO_LARGE);
    throw new ArtifactReadError("not_found", MISSING_CONTENT);
  }
  if (
    createHash("sha256").update(bytes).digest("hex") !== request.contentDigest
  )
    throw new ArtifactReadError("not_found", MISSING_CONTENT);
  return bytes;
}

/** Test-only seam: lets readerProcess.test.ts provoke a signal death without
 *  a real out-of-memory. Ignored outside NODE_ENV=test. */
function crashForTest(input: unknown): void {
  if (process.env.NODE_ENV !== "test" || typeof input !== "object" || !input)
    return;
  const how = (input as { __crashForTest?: unknown }).__crashForTest;
  if (how === "abort") process.abort();
  if (how === "segv") process.kill(process.pid, "SIGSEGV");
}

async function read(request: ReaderRequest): Promise<string> {
  if (!isReaderOperation(request.operation))
    throw new ArtifactReadError("invalid_input", "unknown reader operation");
  crashForTest(request.input);
  const bytes = await loadBytes(request);
  const reader = await READERS[request.operation]();
  const value = await reader(bytes, request.input as never);
  const serialized = JSON.stringify(value) ?? "null";
  if (Buffer.byteLength(serialized) > MAX_READER_RESULT_BYTES)
    throw new ArtifactReadError("resource_limit", TOO_LARGE);
  return serialized;
}

let started = false;
process.on("message", (message: { kind?: string; request?: ReaderRequest }) => {
  if (message.kind !== "read" || !message.request || started) return;
  started = true;
  const request = message.request;
  void read(request).then(
    (json) => process.send?.({ kind: "result", ok: true, json }),
    (cause: unknown) => {
      if (!(cause instanceof ArtifactReadError)) process.exit(1);
      const failure: ReaderFailure = {
        code: cause.code,
        message: cause.message,
      };
      process.send?.({ kind: "result", ok: false, failure });
    },
  );
});
process.on("disconnect", () => process.exit(0));

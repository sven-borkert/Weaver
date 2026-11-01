import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import busboy from "busboy";
import { isCoreError } from "@weaver/core/errors";
import {
  openUploadSink,
  UploadStorageCapacityError,
  type UploadSink,
} from "@weaver/core/ingestion/blobStore";
import {
  contentTypeMatches,
  isAllowedMimeType,
} from "@weaver/core/ingestion/mimeTypes";
import {
  normalizedLabel,
  validateUploadFileName,
  type FinalizeUploadFile,
} from "@weaver/core/services/ingestion";

const SNIFF_BYTES = 16;
const MAX_FIELDS = 2;
const MAX_FIELD_NAME_BYTES = 64;
const MAX_FIELD_BYTES = 4_096;
const MULTIPART_OVERHEAD_BYTES = 65_536;

export class UploadProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UploadProblem";
  }
}

export class UploadInternalError extends Error {
  constructor(cause: unknown) {
    super("upload storage failed", { cause });
    this.name = "UploadInternalError";
  }
}

export type StagedUpload = FinalizeUploadFile & { sink: UploadSink };

export type MultipartUploadOptions = {
  /** Resolves the canonical project id before file bytes reach disk. */
  authorize: (projectId: string) => Promise<{ projectId: string }>;
  maxFiles: number;
  maxFileBytes: number;
  minFreeBytes?: number;
  beforeWrite?: (bytes: number) => Promise<void>;
  dataDir: string;
  /** Extra text fields a caller accepts; return false to reject the field name. */
  beforeFile?: () => Promise<void>;
  extraField?: (name: string, value: string) => boolean;
  maxExtraFields?: number;
  /** Validates a file part's name and returns the content type its bytes must match. */
  resolveContentType?: (info: { filename: string; mimeType: string }) => {
    contentType: string;
    matches: (head: Uint8Array) => boolean;
  };
};

export function problem(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { error: message, ...extra },
    { status, ...(headers ? { headers } : {}) },
  );
}

export function asError(
  value: unknown,
  message = "multipart upload failed",
): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

export function statusForCoreError(code: string): number {
  if (code === "INTERNAL_SERVER_ERROR") return 500;
  if (code === "CONFLICT") return 409;
  if (code === "PRECONDITION_FAILED") return 412;
  if (code === "NOT_FOUND") return 404;
  if (code === "FORBIDDEN") return 403;
  if (code === "UNAUTHORIZED") return 401;
  if (code === "TOO_MANY_REQUESTS") return 429;
  return 400;
}

export function uploadErrorResponse(error: unknown): Response {
  if (error instanceof UploadProblem)
    return problem(error.status, error.message);
  if (isCoreError(error)) {
    return problem(statusForCoreError(error.code), error.message);
  }
  if (error instanceof UploadInternalError) throw asError(error.cause);
  throw error;
}

function requestByteLimit(maxFileBytes: number, maxFiles: number): number {
  return maxFileBytes * maxFiles + MULTIPART_OVERHEAD_BYTES;
}

function byteLimitTransform(maxBytes: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        callback(new UploadProblem(413, "multipart request is too large"));
        return;
      }
      callback(null, chunk);
    },
  });
}

export async function abortStaged(
  staged: readonly StagedUpload[],
): Promise<void> {
  await Promise.allSettled(staged.map(({ sink }) => sink.abort()));
}

async function storeFile(input: {
  stream: Readable & { truncated?: boolean };
  sink: UploadSink;
  fileName: string;
  mimeType: string;
  maxBytes: number;
  matches: (head: Uint8Array) => boolean;
  beforeWrite?: (bytes: number) => Promise<void>;
}): Promise<{ digest: string; byteSize: number }> {
  const head = Buffer.allocUnsafe(SNIFF_BYTES);
  let headBytes = 0;
  let written = 0;
  let validated = false;

  const write = async (chunk: Uint8Array) => {
    await input.beforeWrite?.(chunk.byteLength);
    try {
      await input.sink.write(chunk);
    } catch (error) {
      if (error instanceof UploadStorageCapacityError)
        throw new UploadProblem(507, error.message);
      throw new UploadInternalError(error);
    }
  };
  const validateHead = () => {
    if (!input.matches(head.subarray(0, headBytes))) {
      throw new UploadProblem(
        415,
        `${input.fileName} is not a valid ${input.mimeType}`,
      );
    }
    validated = true;
  };

  for await (const rawChunk of input.stream.iterator({
    destroyOnReturn: false,
  })) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    written += chunk.byteLength;
    if (written > input.maxBytes) {
      throw new UploadProblem(
        413,
        `${input.fileName} exceeds ${input.maxBytes} bytes`,
      );
    }
    if (validated) {
      await write(chunk);
      continue;
    }
    const needed = SNIFF_BYTES - headBytes;
    const captured = Math.min(needed, chunk.byteLength);
    chunk.copy(head, headBytes, 0, captured);
    headBytes += captured;
    if (headBytes < SNIFF_BYTES) continue;
    validateHead();
    await write(head.subarray(0, headBytes));
    if (captured < chunk.byteLength) await write(chunk.subarray(captured));
  }

  if (input.stream.truncated || written > input.maxBytes) {
    throw new UploadProblem(
      413,
      `${input.fileName} exceeds ${input.maxBytes} bytes`,
    );
  }
  if (!validated) {
    validateHead();
    await write(head.subarray(0, headBytes));
  }
  try {
    return await input.sink.finish();
  } catch (error) {
    throw new UploadInternalError(error);
  }
}

function ingestionContentType(info: { filename: string; mimeType: string }) {
  validateUploadFileName(info.filename);
  if (!isAllowedMimeType(info.mimeType))
    throw new UploadProblem(
      415,
      `unsupported content type: ${info.mimeType || "unknown"}`,
    );
  return {
    contentType: info.mimeType,
    matches: (head: Uint8Array) => contentTypeMatches(info.mimeType, head),
  };
}

/** Streams and stages one multipart submission. */
export async function parseMultipartUpload(
  req: Request,
  options: MultipartUploadOptions,
): Promise<{
  projectId: string;
  label?: string;
  staged: StagedUpload[];
}> {
  if (!req.body) throw new UploadProblem(400, "multipart body is required");
  const { maxFileBytes, maxFiles } = options;
  const maxFields = MAX_FIELDS + (options.maxExtraFields ?? 0);
  const maxParts = maxFields + maxFiles;
  const maxRequestBytes = requestByteLimit(maxFileBytes, maxFiles);
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > maxRequestBytes
    ) {
      throw new UploadProblem(413, "multipart request is too large");
    }
  }

  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: Object.fromEntries(req.headers),
      defParamCharset: "utf8",
      limits: {
        fieldNameSize: MAX_FIELD_NAME_BYTES,
        fieldSize: MAX_FIELD_BYTES,
        fields: maxFields,
        fileSize: maxFileBytes + 1,
        files: maxFiles,
        // Busboy emits partsLimit when the count equals the configured value.
        parts: maxParts + 1,
      },
    });
  } catch {
    throw new UploadProblem(400, "invalid multipart content type");
  }

  const source = Readable.fromWeb(
    req.body as unknown as NodeReadableStream<Uint8Array>,
  );
  const staged: StagedUpload[] = [];
  const tasks: Array<Promise<void>> = [];
  let projectId: string | undefined;
  let label: string | undefined;
  let authorization: Promise<{ projectId: string }> | undefined;
  let failure: unknown;
  let fileTail = Promise.resolve();

  const fail = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error;
    source.destroy(asError(error));
  };

  parser.on("error", () => undefined);

  parser.on("field", (name, value, info) => {
    if (info.nameTruncated || info.valueTruncated) {
      fail(new UploadProblem(413, "multipart field is too large"));
      return;
    }
    if (name === "projectId") {
      if (projectId !== undefined) {
        fail(new UploadProblem(400, "projectId must appear exactly once"));
        return;
      }
      projectId = value;
      authorization = options.authorize(value);
      void authorization.catch(fail);
      return;
    }
    if (name === "label") {
      if (label !== undefined) {
        fail(new UploadProblem(400, "label must appear at most once"));
        return;
      }
      try {
        normalizedLabel(value);
      } catch (error) {
        fail(error);
        return;
      }
      label = value;
      return;
    }
    if (options.extraField?.(name, value)) return;
    fail(new UploadProblem(400, `unexpected multipart field: ${name}`));
  });

  parser.on("file", (name, stream, info) => {
    stream.pause();
    stream.on("error", () => undefined);
    const fileAuthorization = authorization;
    const fileProjectId = projectId;
    const task = fileTail.then(async () => {
      try {
        if (failure !== undefined) throw asError(failure);
        if (name !== "file") {
          throw new UploadProblem(
            400,
            `unexpected multipart file field: ${name}`,
          );
        }
        if (!fileAuthorization || fileProjectId === undefined) {
          throw new UploadProblem(400, "projectId must precede file parts");
        }
        const resolved = options.resolveContentType
          ? options.resolveContentType({
              filename: info.filename,
              mimeType: info.mimeType,
            })
          : ingestionContentType(info);
        const authorized = await fileAuthorization;
        await options.beforeFile?.();
        const uploadId = randomUUID();
        let sink: UploadSink;
        try {
          sink = await openUploadSink(
            options.dataDir,
            authorized.projectId,
            uploadId,
            { minFreeBytes: options.minFreeBytes },
          );
        } catch (error) {
          if (error instanceof UploadStorageCapacityError)
            throw new UploadProblem(507, error.message);
          throw new UploadInternalError(error);
        }
        const entry: StagedUpload = {
          sink,
          uploadId,
          fileName: info.filename,
          mimeType: resolved.contentType,
          byteSize: 0,
          contentDigest: "",
        };
        staged.push(entry);
        const stored = await storeFile({
          stream,
          sink,
          fileName: info.filename,
          mimeType: resolved.contentType,
          maxBytes: maxFileBytes,
          matches: resolved.matches,
          beforeWrite: options.beforeWrite,
        });
        entry.byteSize = stored.byteSize;
        entry.contentDigest = stored.digest;
      } catch (error) {
        stream.resume();
        throw error;
      }
    });
    fileTail = task.catch(() => undefined);
    tasks.push(task);
    void task.catch(fail);
  });
  parser.on("fieldsLimit", () =>
    fail(
      new UploadProblem(400, `no more than ${maxFields} fields are allowed`),
    ),
  );
  parser.on("filesLimit", () =>
    fail(
      new UploadProblem(
        413,
        `no more than ${maxFiles} ${maxFiles === 1 ? "file is" : "files are"} allowed`,
      ),
    ),
  );
  parser.on("partsLimit", () =>
    fail(new UploadProblem(413, `no more than ${maxParts} parts are allowed`)),
  );

  let pipelineFailure: unknown;
  try {
    await pipeline(source, byteLimitTransform(maxRequestBytes), parser, {
      signal: req.signal,
    });
  } catch (error) {
    pipelineFailure = error;
  }
  await Promise.allSettled([
    ...tasks,
    ...(authorization ? [authorization] : []),
  ]);
  if (failure !== undefined) {
    await abortStaged(staged);
    if (
      pipelineFailure !== undefined &&
      !(failure instanceof UploadProblem) &&
      !(failure instanceof UploadInternalError) &&
      !isCoreError(failure)
    ) {
      throw new UploadProblem(400, "malformed or interrupted multipart body");
    }
    throw asError(failure);
  }
  if (pipelineFailure !== undefined) {
    await abortStaged(staged);
    if (pipelineFailure instanceof UploadProblem) throw pipelineFailure;
    throw new UploadProblem(400, "malformed or interrupted multipart body");
  }
  if (!authorization || projectId === undefined) {
    await abortStaged(staged);
    throw new UploadProblem(400, "projectId is required");
  }
  let authorized: { projectId: string };
  try {
    authorized = await authorization;
  } catch (error) {
    await abortStaged(staged);
    throw error;
  }
  if (staged.length === 0) {
    await abortStaged(staged);
    throw new UploadProblem(400, "at least one file is required");
  }
  return {
    projectId: authorized.projectId,
    ...(label === undefined ? {} : { label }),
    staged,
  };
}

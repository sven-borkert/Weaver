import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import busboy from "busboy";
import { sniffImageType } from "@weaver/core/documents/images";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { UploadProblem, asError } from "~/server/ingestion/multipartUpload";

const SNIFF_BYTES = 16;
const MULTIPART_OVERHEAD_BYTES = 65_536;
const MAX_FIELD_BYTES = 256;

export type ParsedImageUpload = {
  projectId: string;
  fileName: string | null;
  bytes: Buffer;
};

export type ImageUploadOptions = {
  maxFileBytes: number;
  /** Runs before any file bytes are buffered; throw a CoreError to refuse. */
  authorize: (projectId: string) => Promise<void>;
};

/** Reads `projectId` then exactly one `file` part into memory, bounded by the cap. */
export async function parseImageUpload(
  req: Request,
  options: ImageUploadOptions,
): Promise<ParsedImageUpload> {
  if (!req.body) throw new UploadProblem(400, "multipart body is required");
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    if (Number(contentLength) > options.maxFileBytes + MULTIPART_OVERHEAD_BYTES)
      throw new UploadProblem(413, "image exceeds the configured size limit");
  }
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: Object.fromEntries(req.headers),
      defParamCharset: "utf8",
      limits: {
        fieldSize: MAX_FIELD_BYTES,
        fields: 1,
        fileSize: options.maxFileBytes + 1,
        files: 1,
        parts: 3,
      },
    });
  } catch {
    throw new UploadProblem(400, "invalid multipart content type");
  }

  const source = Readable.fromWeb(
    req.body as unknown as NodeReadableStream<Uint8Array>,
  );
  let projectId: string | undefined;
  let authorization: Promise<void> | undefined;
  let file:
    | {
        fileName: string | null;
        declaredType: string;
        chunks: Buffer[];
        bytes: number;
      }
    | undefined;
  let failure: unknown;
  let fileTask: Promise<void> = Promise.resolve();

  const fail = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error;
    source.destroy(asError(error));
    parser.destroy(asError(error));
  };

  parser.on("error", () => undefined);
  parser.on("field", (name, value) => {
    if (name !== "projectId" || projectId !== undefined) {
      fail(new UploadProblem(400, "projectId must appear exactly once"));
      return;
    }
    if (!UUID_RE.test(value)) {
      fail(new UploadProblem(404, "not found"));
      return;
    }
    projectId = value;
    authorization = options.authorize(value);
    void authorization.catch(fail);
  });
  parser.on("file", (name, stream, info) => {
    stream.on("error", () => undefined);
    const pending = authorization;
    fileTask = (async () => {
      if (name !== "file" || !pending) {
        stream.resume();
        throw new UploadProblem(400, "projectId must precede the file part");
      }
      try {
        await pending;
      } catch (error) {
        stream.resume();
        throw error;
      }
      const current = {
        fileName: info.filename || null,
        declaredType: info.mimeType.split(";", 1)[0]!.trim().toLowerCase(),
        chunks: [] as Buffer[],
        bytes: 0,
      };
      file = current;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        current.bytes += buffer.byteLength;
        if (current.bytes > options.maxFileBytes) {
          stream.resume();
          throw new UploadProblem(
            413,
            "image exceeds the configured size limit",
          );
        }
        current.chunks.push(buffer as Buffer<ArrayBufferLike>);
        if (current.bytes >= SNIFF_BYTES && current.chunks.length === 1) {
          if (!sniffImageType(buffer.subarray(0, SNIFF_BYTES))) {
            stream.resume();
            throw new UploadProblem(415, "unsupported image type");
          }
        }
      }
      if ((stream as { truncated?: boolean }).truncated) {
        throw new UploadProblem(413, "image exceeds the configured size limit");
      }
    })();
    void fileTask.catch(fail);
  });
  parser.on("filesLimit", () =>
    fail(new UploadProblem(400, "exactly one file is allowed")),
  );
  parser.on("fieldsLimit", () =>
    fail(new UploadProblem(400, "unexpected multipart field")),
  );

  let pipelineFailure: unknown;
  try {
    await pipeline(source, parser, { signal: req.signal });
  } catch (error) {
    pipelineFailure = error;
  }
  await fileTask.catch(() => undefined);
  if (failure !== undefined) throw asError(failure);
  if (pipelineFailure !== undefined)
    throw new UploadProblem(400, "malformed or interrupted multipart body");
  if (!projectId || !authorization)
    throw new UploadProblem(400, "projectId is required");
  await authorization;
  if (!file) throw new UploadProblem(400, "a file is required");
  const bytes = Buffer.concat(file.chunks);
  const sniffed = sniffImageType(bytes.subarray(0, SNIFF_BYTES));
  if (!sniffed) throw new UploadProblem(415, "unsupported image type");
  const declared = file.declaredType;
  if (
    declared &&
    declared !== "application/octet-stream" &&
    declared !== sniffed
  )
    throw new UploadProblem(
      415,
      `declared ${declared} but the bytes are ${sniffed}`,
    );
  return { projectId, fileName: file.fileName, bytes };
}

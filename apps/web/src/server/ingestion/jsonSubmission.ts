import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  openUploadSink,
  UploadStorageCapacityError,
  type UploadSink,
} from "@weaver/core/ingestion/blobStore";
import { MAX_EXTERNAL_JSON_FILE_BYTES } from "@weaver/core/ingestion/limits";
import {
  contentTypeMatches,
  isAllowedMimeType,
  normalizeMimeType,
} from "@weaver/core/ingestion/mimeTypes";
import {
  normalizedLabel,
  validateUploadFileName,
} from "@weaver/core/services/ingestion";

import {
  UploadInternalError,
  UploadProblem,
  type StagedUpload,
} from "./multipartUpload";

const JSON_OVERHEAD_BYTES = 4_096;
const SNIFF_BYTES = 16;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const projectSchema = z.object({ projectId: z.uuid() });
const submissionSchema = z.object({
  projectId: z.uuid(),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(128),
  label: z.string().max(200).optional(),
  content: z.string().min(1),
});

export type JsonSubmissionOptions = {
  authorize: (projectId: string) => Promise<{ projectId: string }>;
  maxFileBytes: number;
  minFreeBytes?: number;
  beforeWrite?: (bytes: number) => Promise<void>;
  dataDir: string;
};

export function jsonFileByteLimit(maxFileBytes: number): number {
  return Math.min(maxFileBytes, MAX_EXTERNAL_JSON_FILE_BYTES);
}

export function jsonRequestByteLimit(maxFileBytes: number): number {
  return (
    Math.ceil((jsonFileByteLimit(maxFileBytes) * 4) / 3) + JSON_OVERHEAD_BYTES
  );
}

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw new UploadProblem(413, "JSON request is too large");
    }
  }
  if (!req.body) throw new UploadProblem(400, "JSON body is required");
  if (req.signal.aborted)
    throw new UploadProblem(400, "malformed or interrupted JSON body");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  req.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (req.signal.aborted) {
        throw new UploadProblem(400, "malformed or interrupted JSON body");
      }
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new UploadProblem(413, "JSON request is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof UploadProblem) throw error;
    throw new UploadProblem(400, "malformed or interrupted JSON body");
  } finally {
    req.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (req.signal.aborted)
    throw new UploadProblem(400, "malformed or interrupted JSON body");
  return Buffer.concat(chunks);
}

function firstIssue(error: z.ZodError): UploadProblem {
  const issue = error.issues[0];
  const path = issue?.path.join(".");
  return new UploadProblem(
    400,
    `${path && path.length > 0 ? path : "body"}: ${issue?.message ?? "invalid"}`,
  );
}

/** Parses, authorizes, validates, and stages the bounded external JSON form. */
export async function parseJsonSubmission(
  req: Request,
  options: JsonSubmissionOptions,
): Promise<{ projectId: string; label?: string; staged: StagedUpload[] }> {
  const maxFileBytes = jsonFileByteLimit(options.maxFileBytes);
  const body = await readBoundedBody(
    req,
    jsonRequestByteLimit(options.maxFileBytes),
  );
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    throw new UploadProblem(400, "malformed JSON body");
  }
  const project = projectSchema.safeParse(raw);
  if (!project.success) throw firstIssue(project.error);
  const authorized = await options.authorize(project.data.projectId);
  const parsed = submissionSchema.safeParse(raw);
  if (!parsed.success) throw firstIssue(parsed.error);

  const { fileName, label } = parsed.data;
  validateUploadFileName(fileName);
  if (label !== undefined) normalizedLabel(label);
  const mimeType = normalizeMimeType(parsed.data.contentType);
  if (!isAllowedMimeType(mimeType)) {
    throw new UploadProblem(
      415,
      `unsupported content type: ${mimeType || "unknown"}`,
    );
  }
  const encoded = parsed.data.content.replace(/\s+/g, "");
  if (encoded.length % 4 !== 0 || !BASE64_RE.test(encoded)) {
    throw new UploadProblem(400, "content must be standard base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0) throw new UploadProblem(400, "content is empty");
  if (bytes.byteLength > maxFileBytes) {
    throw new UploadProblem(413, `${fileName} exceeds ${maxFileBytes} bytes`);
  }
  if (!contentTypeMatches(mimeType, bytes.subarray(0, SNIFF_BYTES))) {
    throw new UploadProblem(415, `${fileName} is not a valid ${mimeType}`);
  }

  await options.beforeWrite?.(bytes.byteLength);
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
    fileName,
    mimeType,
    byteSize: 0,
    contentDigest: "",
  };
  try {
    await sink.write(bytes);
    const stored = await sink.finish();
    entry.byteSize = stored.byteSize;
    entry.contentDigest = stored.digest;
  } catch (error) {
    await sink.abort().catch(() => undefined);
    if (error instanceof UploadStorageCapacityError)
      throw new UploadProblem(507, error.message);
    throw new UploadInternalError(error);
  }
  return {
    projectId: authorized.projectId,
    ...(label === undefined ? {} : { label }),
    staged: [entry],
  };
}

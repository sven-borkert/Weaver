/** Reads inside a stored artifact: Viewer access check, format gate, then one
 *  isolated reader call. Imports the reader child runner, so this module must
 *  never be reached from the web app's src tree or from services/artifacts.ts
 *  — see scripts/package-boundaries.test.mjs. */
import { parseServerEnv } from "@weaver/config/server";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  artifactFormatOf,
  READER_OPERATIONS,
  type ArtifactFormat,
  type ReaderOperation,
} from "../artifacts/readerOperations";
import {
  runArtifactReader,
  type ReaderFailure,
} from "../artifacts/readerProcess";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { getArtifact, type ArtifactSummary } from "./artifacts";
import type { ProjectActor } from "./projectAccess";

type Db = PrismaClient | Prisma.TransactionClient;

export type ArtifactEnvelope = {
  id: string;
  projectId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  updatedAt: string;
};

function toEnvelope(artifact: ArtifactSummary): ArtifactEnvelope {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    filename: artifact.filename,
    contentType: artifact.contentType,
    byteSize: artifact.byteSize,
    sha256: artifact.contentDigest,
    updatedAt: artifact.updatedAt.toISOString(),
  };
}

const READER_FAILED = "reading the file failed on the server";

/** @internal exported only for artifactReads.test.ts. */
export function toCoreError(failure: ReaderFailure): CoreError {
  if (failure.code === "not_found")
    return new CoreError("NOT_FOUND", failure.message);
  if (failure.code === "busy")
    return new CoreError("TOO_MANY_REQUESTS", failure.message);
  if (failure.code === "unavailable")
    // A crash or a reader that never started is the server's failure, not a
    // caller error the model could fix by asking differently.
    return failure.cause === "crashed" || failure.cause === "not_started"
      ? new CoreError("INTERNAL_SERVER_ERROR", READER_FAILED)
      : new CoreError("BAD_REQUEST", failure.message, {
          reason: "PAYLOAD_TOO_LARGE",
        });
  if (failure.code === "resource_limit")
    return new CoreError("BAD_REQUEST", failure.message, {
      reason: "PAYLOAD_TOO_LARGE",
    });
  return new CoreError("BAD_REQUEST", failure.message);
}

/** The caller only learns that the read failed, so the cause (and the child's
 *  exit status) has to be recorded here. Never the filename or any content.
 *  A child that aborted on its heap limit is the file's fault and only worth a
 *  warning; a crash or a fork that never started is the server's error.
 *  @internal exported only for artifactReads.test.ts. */
export function reportOperationalFailure(
  failure: ReaderFailure,
  operation: ReaderOperation,
  artifact: Pick<ArtifactSummary, "id" | "projectId">,
): void {
  if (failure.code !== "unavailable") return;
  const aborted = failure.cause === "memory" && failure.signal === "SIGABRT";
  if (
    !aborted &&
    failure.cause !== "crashed" &&
    failure.cause !== "not_started"
  )
    return;
  emitDiagnostic({
    event: "artifact.reader.failed",
    severity: aborted ? "warn" : "error",
    outcome: "error",
    message: aborted
      ? "artifact reader ran out of memory"
      : "artifact reader failed",
    projectId: artifact.projectId,
    details: {
      cause: failure.cause,
      operation,
      artifactId: artifact.id,
      ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
      ...(failure.signal === undefined ? {} : { signal: failure.signal }),
    },
  });
}

export async function describeArtifact(
  db: Db,
  actor: ProjectActor,
  target: { projectId: string; filename: string },
): Promise<{ artifact: ArtifactEnvelope; format: ArtifactFormat | null }> {
  const artifact = await getArtifact(db, actor, target);
  return {
    artifact: toEnvelope(artifact),
    format: artifactFormatOf(artifact.contentType, artifact.filename),
  };
}

export async function readArtifact(
  db: Db,
  actor: ProjectActor,
  target: { projectId: string; filename: string },
  operation: ReaderOperation,
  input: unknown,
  options: {
    signal?: AbortSignal;
    /** @internal test seam, not part of the documented interface. */
    runReader?: typeof runArtifactReader;
  } = {},
): Promise<{ artifact: ArtifactEnvelope; value: unknown }> {
  const artifact = await getArtifact(db, actor, target);
  const expectedFormat = READER_OPERATIONS[operation];
  const actualFormat = artifactFormatOf(
    artifact.contentType,
    artifact.filename,
  );
  if (
    actualFormat === null ||
    !(expectedFormat as readonly ArtifactFormat[]).includes(actualFormat)
  )
    throw new CoreError(
      "BAD_REQUEST",
      "this file type cannot be read with this operation",
      {
        expectedFormat:
          expectedFormat.length === 1 ? expectedFormat[0] : expectedFormat,
        actualFormat,
      },
    );

  const env = parseServerEnv(process.env);
  const runner = options.runReader ?? runArtifactReader;
  const result = await runner(
    {
      dataDir: env.WEAVER_DATA_DIR,
      projectId: artifact.projectId,
      contentDigest: artifact.contentDigest,
      maxBytes: env.WEAVER_ARTIFACT_MAX_FILE_BYTES,
      operation,
      input:
        operation.startsWith("text.") &&
        typeof input === "object" &&
        input !== null
          ? { ...input, markdown: actualFormat === "markdown" }
          : input,
    },
    { signal: options.signal },
  );
  options.signal?.throwIfAborted();
  if (!result.ok) {
    reportOperationalFailure(result.failure, operation, artifact);
    throw toCoreError(result.failure);
  }
  return { artifact: toEnvelope(artifact), value: result.value };
}

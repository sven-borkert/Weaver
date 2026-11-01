import { checkUploadRateLimit } from "@weaver/core/ingestion/rateLimit";
import { createSlidingWindowLimiter } from "@weaver/core/security/rateLimit";
import { randomUUID } from "node:crypto";
import { db } from "@weaver/db";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { isCoreError } from "@weaver/core/errors";
import { normalizeMimeType } from "@weaver/core/ingestion/mimeTypes";
import { requestKnowledgeJob } from "@weaver/core/jobs/queue";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { resolveApiKeySecurityContext } from "@weaver/core/security/bearer";
import {
  hasCapability,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  authorizeIngestionUpload,
  finalizeUploadBatch,
} from "@weaver/core/services/ingestion";
import type { NextRequest } from "next/server";

import { env } from "~/env";
import { createUploadBudget } from "~/server/ingestion/uploadBudget";
import { getBearerVerifiers } from "~/server/auth/bearer";
import { externalIngestionLimiter } from "~/server/ingestion/externalLimiter";
import { parseJsonSubmission } from "~/server/ingestion/jsonSubmission";
import {
  abortStaged,
  parseMultipartUpload,
  problem,
  statusForCoreError,
  uploadErrorResponse,
  type StagedUpload,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

const attempts = createSlidingWindowLimiter({ limit: 120, windowMs: 60_000 });

type Submission = { projectId: string; label?: string; staged: StagedUpload[] };

function credentialErrorResponse(error: unknown): Response | undefined {
  if (!isCoreError(error)) return undefined;
  const status = statusForCoreError(error.code);
  return problem(
    status,
    error.message,
    {},
    status === 429 ? { "retry-after": "60" } : undefined,
  );
}

/** Accepts a single external feed file through a personal API key. */
export async function POST(req: NextRequest): Promise<Response> {
  const address = env.WEAVER_AUTH_TRUST_PROXY
    ? (req.headers.get("x-real-ip") ?? "unknown")
    : "direct";
  const attempt = attempts.check(address);
  if (!attempt.allowed)
    return problem(
      429,
      "rate limit exceeded",
      {},
      { "retry-after": String(attempt.retryAfterSeconds) },
    );
  const requestId = randomUUID();
  const started = Date.now();
  let actor: SecurityContext;
  try {
    actor = await resolveApiKeySecurityContext(
      db,
      getBearerVerifiers(),
      req.headers.get("authorization"),
    );
  } catch (error) {
    const response = credentialErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const principal = {
    requestId,
    userId: actor.userId,
    credentialId: actor.credentialId,
  };
  if (!hasCapability(actor, "ingest:external")) {
    emitDiagnostic({
      ...principal,
      event: "ingestion.external.submitted",
      severity: "warn",
      message: "external submission refused: ingest:external is required",
      outcome: "denied",
      statusCode: 403,
      durationMs: Date.now() - started,
    });
    return problem(403, "the ingest:external capability is required");
  }
  const decision = externalIngestionLimiter().check(
    `key:${actor.credentialId}`,
  );
  if (!decision.allowed) {
    return problem(
      429,
      "rate limit exceeded",
      {},
      { "retry-after": String(decision.retryAfterSeconds) },
    );
  }
  const sharedDecision = await checkUploadRateLimit(
    db,
    actor.userId,
    "external",
    env.WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE,
  );
  if (!sharedDecision.allowed)
    return problem(
      429,
      "rate limit exceeded",
      {},
      { "retry-after": String(sharedDecision.retryAfterSeconds) },
    );
  if (!parseKnowledgeConfig(process.env).jobsEnabled)
    return problem(503, "jobs are disabled");

  const budget = createUploadBudget(req, actor.userId);
  const form = normalizeMimeType(req.headers.get("content-type") ?? "");
  const options = {
    authorize: async (projectId: string) => {
      const authorized = await authorizeIngestionUpload(
        db,
        actor,
        projectId,
        "external",
      );
      await budget.reserve(authorized.projectId);
      return authorized;
    },
    maxFileBytes: env.WEAVER_INGESTION_MAX_FILE_BYTES,
    minFreeBytes: env.WEAVER_INGESTION_MIN_FREE_BYTES,
    beforeWrite: budget.beforeWrite,
    dataDir: env.WEAVER_DATA_DIR,
  };
  let submission: Submission | undefined;
  let durable = false;
  try {
    if (form === "multipart/form-data")
      submission = await parseMultipartUpload(req, { ...options, maxFiles: 1 });
    else if (form === "application/json")
      submission = await parseJsonSubmission(req, options);
    else
      return problem(
        415,
        "content type must be multipart/form-data or application/json",
      );
    const staged = submission.staged[0]!;
    const finalized = await finalizeUploadBatch(
      db,
      actor,
      {
        projectId: submission.projectId,
        origin: "external",
        ...(submission.label === undefined ? {} : { label: submission.label }),
        files: submission.staged.map(({ sink: _sink, ...file }) => file),
      },
      {
        dataDir: env.WEAVER_DATA_DIR,
        projectQuotaBytes: env.WEAVER_INGESTION_PROJECT_QUOTA_BYTES,
      },
    );
    durable = true;
    const stored = finalized.files[0]!;
    const file = {
      id: stored.id,
      fileName: stored.fileName,
      status: stored.status,
    };
    const details = {
      batchId: finalized.batchId,
      fileId: stored.id,
      form,
      mimeType: staged.mimeType,
      byteSize: staged.byteSize,
    };
    try {
      const jobId = await requestKnowledgeJob("ingestion.parse", {
        fileId: stored.id,
        projectId: finalized.projectId,
        contentDigest: stored.contentDigest,
        baseAttemptCount: 0,
      });
      if (!jobId) throw new Error("queue did not accept ingestion.parse");
    } catch {
      emitDiagnostic({
        ...principal,
        projectId: finalized.projectId,
        event: "ingestion.external.submitted",
        severity: "error",
        message: "external submission stored but parse job publication failed",
        outcome: "error",
        statusCode: 503,
        durationMs: Date.now() - started,
        details,
      });
      return problem(503, "file stored but parse job publication failed", {
        batchId: finalized.batchId,
        file,
      });
    }
    emitDiagnostic({
      ...principal,
      projectId: finalized.projectId,
      event: "ingestion.external.submitted",
      message: "external submission accepted",
      outcome: "ok",
      statusCode: 201,
      durationMs: Date.now() - started,
      details,
    });
    return Response.json({ batchId: finalized.batchId, file }, { status: 201 });
  } catch (error) {
    if (!durable && submission) await abortStaged(submission.staged);
    return uploadErrorResponse(error);
  } finally {
    await budget.release();
  }
}

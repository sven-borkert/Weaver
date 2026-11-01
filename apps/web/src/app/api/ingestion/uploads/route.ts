import { checkUploadRateLimit } from "@weaver/core/ingestion/rateLimit";
import { db } from "@weaver/db";
import { MAX_INGESTION_UPLOAD_FILES } from "@weaver/core/ingestion/limits";
import { requestKnowledgeJob } from "@weaver/core/jobs/queue";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import {
  authorizeIngestionUpload,
  finalizeUploadBatch,
} from "@weaver/core/services/ingestion";
import type { NextRequest } from "next/server";

import { env } from "~/env";
import { createUploadBudget } from "~/server/ingestion/uploadBudget";
import { getSessionUser } from "~/server/auth";
import { sameOrigin } from "~/server/http/sameOrigin";
import {
  abortStaged,
  parseMultipartUpload,
  problem,
  uploadErrorResponse,
  type StagedUpload,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  if (!sameOrigin(req)) return problem(403, "same-origin request required");
  const rate = await checkUploadRateLimit(db, user.id, "browser", 10);
  if (!rate.allowed)
    return problem(
      429,
      "upload rate limit exceeded",
      {},
      { "retry-after": String(rate.retryAfterSeconds) },
    );
  if (!parseKnowledgeConfig(process.env).jobsEnabled) {
    return problem(503, "jobs are disabled");
  }

  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  const budget = createUploadBudget(req, user.id);
  let parsed:
    { projectId: string; label?: string; staged: StagedUpload[] } | undefined;
  let durable = false;
  try {
    parsed = await parseMultipartUpload(req, {
      authorize: async (projectId: string) => {
        const authorized = await authorizeIngestionUpload(
          db,
          actor,
          projectId,
          "upload",
        );
        await budget.reserve(authorized.projectId);
        return authorized;
      },
      maxFiles: MAX_INGESTION_UPLOAD_FILES,
      maxFileBytes: env.WEAVER_INGESTION_MAX_FILE_BYTES,
      minFreeBytes: env.WEAVER_INGESTION_MIN_FREE_BYTES,
      beforeWrite: budget.beforeWrite,
      dataDir: env.WEAVER_DATA_DIR,
    });
    const finalized = await finalizeUploadBatch(
      db,
      actor,
      {
        projectId: parsed.projectId,
        origin: "upload",
        ...(parsed.label === undefined ? {} : { label: parsed.label }),
        files: parsed.staged.map(({ sink: _sink, ...file }) => file),
      },
      {
        dataDir: env.WEAVER_DATA_DIR,
        projectQuotaBytes: env.WEAVER_INGESTION_PROJECT_QUOTA_BYTES,
      },
    );
    durable = true;
    const responseFiles = finalized.files.map(
      ({ contentDigest: _contentDigest, ...file }) => file,
    );
    try {
      for (const file of finalized.files) {
        const jobId = await requestKnowledgeJob("ingestion.parse", {
          fileId: file.id,
          projectId: finalized.projectId,
          contentDigest: file.contentDigest,
          baseAttemptCount: 0,
        });
        if (!jobId) throw new Error("queue did not accept ingestion.parse");
      }
    } catch {
      return problem(503, "files stored but parse job publication failed", {
        batchId: finalized.batchId,
        files: responseFiles,
      });
    }
    return Response.json(
      { batchId: finalized.batchId, files: responseFiles },
      { status: 201 },
    );
  } catch (error) {
    if (!durable && parsed) await abortStaged(parsed.staged);
    return uploadErrorResponse(error);
  } finally {
    await budget.release();
  }
}

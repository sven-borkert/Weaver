import { statfs } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import {
  artifactContentMatches,
  contentTypeForFilename,
} from "@weaver/core/artifacts/contentTypes";
import {
  artifactFilenameKey,
  validateArtifactFilename,
} from "@weaver/core/artifacts/filenames";
import { isCoreError } from "@weaver/core/errors";
import { MAX_INGESTION_UPLOAD_FILES } from "@weaver/core/ingestion/limits";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { checkUploadRateLimit } from "@weaver/core/ingestion/rateLimit";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import {
  authorizeArtifactUpload,
  finalizeArtifactUpload,
} from "@weaver/core/services/artifacts";

import { env } from "~/env";
import { createUploadBudget } from "~/server/ingestion/uploadBudget";
import { getSessionUser } from "~/server/auth";
import { sameOrigin } from "~/server/http/sameOrigin";
import {
  abortStaged,
  parseMultipartUpload,
  problem,
  statusForCoreError,
  UploadProblem,
  uploadErrorResponse,
  type StagedUpload,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  if (!sameOrigin(req)) return problem(403, "same-origin request required");
  const { projectId: pathProjectId } = await ctx.params;
  if (!UUID_RE.test(pathProjectId)) return problem(404, "not found");
  const rate = await checkUploadRateLimit(db, user.id, "browser", 10);
  if (!rate.allowed)
    return problem(
      429,
      "upload rate limit exceeded",
      {},
      {
        "retry-after": String(rate.retryAfterSeconds),
      },
    );
  const space = await statfs(env.WEAVER_DATA_DIR);
  if (space.bavail * space.bsize < env.WEAVER_INGESTION_MIN_FREE_BYTES)
    return problem(507, "insufficient storage");

  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  const budget = createUploadBudget(req, user.id);
  const replaceKeys = new Set<string>();
  let reserved = false;
  let staged: StagedUpload[] = [];
  let durable = false;
  try {
    const parsed = await parseMultipartUpload(req, {
      // Must stay async: the parser calls this synchronously in a busboy
      // "field" handler and only attaches .catch to the returned promise.
      authorize: async (projectId) => {
        if (projectId !== pathProjectId)
          throw new UploadProblem(
            400,
            "projectId does not match the request path",
          );
        return authorizeArtifactUpload(db, actor, projectId);
      },
      maxFiles: MAX_INGESTION_UPLOAD_FILES,
      maxFileBytes: env.WEAVER_ARTIFACT_MAX_FILE_BYTES,
      minFreeBytes: env.WEAVER_INGESTION_MIN_FREE_BYTES,
      beforeFile: async () => {
        if (!reserved) {
          await budget.reserve(pathProjectId);
          reserved = true;
        }
      },
      beforeWrite: budget.beforeWrite,
      dataDir: env.WEAVER_DATA_DIR,
      maxExtraFields: MAX_INGESTION_UPLOAD_FILES,
      extraField: (name, value) => {
        if (name !== "replace") return false;
        replaceKeys.add(artifactFilenameKey(value));
        return true;
      },
      resolveContentType: ({ filename }) => {
        validateArtifactFilename(filename);
        const contentType = contentTypeForFilename(filename);
        return {
          contentType,
          matches: (head) => artifactContentMatches(contentType, head),
        };
      },
    });
    staged = parsed.staged;
    const result = await finalizeArtifactUpload(
      db,
      actor,
      {
        projectId: parsed.projectId,
        files: staged.map((file) => ({
          uploadId: file.uploadId,
          filename: file.fileName,
          contentDigest: file.contentDigest,
          byteSize: file.byteSize,
          replace: replaceKeys.has(artifactFilenameKey(file.fileName)),
        })),
      },
      {
        dataDir: env.WEAVER_DATA_DIR,
        projectQuotaBytes: env.WEAVER_INGESTION_PROJECT_QUOTA_BYTES,
      },
    );
    durable = true;
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (!durable) await abortStaged(staged);
    if (isCoreError(error) && error.code === "CONFLICT")
      return problem(409, error.message, {
        conflicts: error.details?.conflicts ?? [],
      });
    if (isCoreError(error))
      return problem(statusForCoreError(error.code), error.message);
    return uploadErrorResponse(error);
  } finally {
    await budget.release();
  }
}

import { statfs } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { checkUploadRateLimit } from "@weaver/core/ingestion/rateLimit";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import { assertProjectRole } from "@weaver/core/services/projectAccess";

import { env } from "~/env";
import { withBasePath } from "~/lib/basePath";
import { getSessionUser } from "~/server/auth";
import { parseImageUpload } from "~/server/documents/imageUpload";
import { sameOrigin } from "~/server/http/sameOrigin";
import {
  problem,
  statusForCoreError,
  uploadErrorResponse,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

function encodePath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  if (!sameOrigin(req)) return problem(403, "same-origin request required");
  const { documentId } = await ctx.params;
  if (!UUID_RE.test(documentId)) return problem(404, "not found");
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

  const actor = {
    ...createSessionSecurityContext({
      userId: user.id,
      globalRole: user.role,
      sessionId: user.sessionId,
    }),
    name: user.name ?? null,
    email: user.email,
  };
  try {
    const parsed = await parseImageUpload(req, {
      maxFileBytes: env.WEAVER_DOCUMENT_IMAGE_MAX_BYTES,
      authorize: async (projectId) => {
        await assertProjectRole(db, projectId, actor, "Editor");
      },
    });
    const stored = await storeDocumentImage(
      db,
      { ...parsed, documentId },
      actor,
    );
    return Response.json(
      {
        ...stored,
        url: withBasePath(
          `/api/projects/${parsed.projectId}/files/${encodePath(stored.path)}`,
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    if (isCoreError(error))
      return problem(statusForCoreError(error.code), error.message);
    return uploadErrorResponse(error);
  }
}

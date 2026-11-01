import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { readDocumentFile } from "@weaver/core/services/documentDownload";

import { attachmentDisposition } from "~/lib/http/contentDisposition";
import { getSessionUser } from "~/server/auth";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  const { documentId } = await ctx.params;
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!UUID_RE.test(documentId) || !UUID_RE.test(projectId))
    return problem(404, "not found");
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  try {
    const { bytes, fileName, mimeType } = await readDocumentFile(
      db,
      { projectId, documentId },
      actor,
    );
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": `${mimeType}; charset=utf-8`,
        "content-length": String(bytes.byteLength),
        "content-disposition": attachmentDisposition(fileName),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (isCoreError(error)) {
      const status = statusForCoreError(error.code);
      return status === 403 || status === 404
        ? problem(404, "not found")
        : problem(status, error.message);
    }
    throw error;
  }
}

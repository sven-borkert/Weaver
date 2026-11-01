import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { readProjectImage } from "@weaver/core/services/documentImages";

import { getSessionUser } from "~/server/auth";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; path: string[] }> },
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  const { projectId, path } = await ctx.params;
  if (!UUID_RE.test(projectId)) return problem(404, "not found");
  const atParam = new URL(req.url).searchParams.get("at");
  if (atParam !== null && !COMMIT_SHA_RE.test(atParam))
    return problem(404, "not found");
  const at = atParam ?? undefined;
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  let image;
  try {
    image = await readProjectImage(
      db,
      {
        projectId,
        segments: path,
        at,
        ifNoneMatch: req.headers.get("if-none-match"),
      },
      actor,
    );
  } catch (error) {
    if (isCoreError(error))
      return problem(
        statusForCoreError(error.code) === 403
          ? 404
          : statusForCoreError(error.code),
        "not found",
      );
    throw error;
  }
  if (!image) return problem(404, "not found");
  const etag = `"${image.blobSha}"`;
  const headers: Record<string, string> = {
    etag,
    // Pinned URLs revalidate too, so every read passes the access check above.
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  };
  if ("notModified" in image)
    return new Response(null, { status: 304, headers });
  const fileName = image.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      ...headers,
      "content-type": image.contentType,
      "content-length": String(image.bytes.byteLength),
      "content-disposition": `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(image.fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    },
  });
}

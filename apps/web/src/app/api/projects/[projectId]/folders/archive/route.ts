import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { createFolderArchive } from "@weaver/core/services/documentDownload";

import { attachmentDisposition } from "~/lib/http/contentDisposition";
import { getSessionUser } from "~/server/auth";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  const { projectId } = await ctx.params;
  if (!UUID_RE.test(projectId)) return problem(404, "not found");
  // The empty path is the project root.
  const folderPath = (new URL(req.url).searchParams.get("path") ?? "")
    .split("/")
    .filter((segment) => segment.length > 0);
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  try {
    const { stream, fileName } = await createFolderArchive(
      db,
      { projectId, folderPath },
      actor,
    );
    req.signal.addEventListener("abort", () => stream.destroy(), {
      once: true,
    });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": attachmentDisposition(fileName),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (isCoreError(error)) {
      if (error.details?.reason === "PAYLOAD_TOO_LARGE")
        return problem(413, error.message);
      const status = statusForCoreError(error.code);
      return status === 403 || status === 404
        ? problem(404, "not found")
        : problem(status, error.message);
    }
    throw error;
  }
}

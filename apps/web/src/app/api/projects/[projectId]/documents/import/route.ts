import { statfs } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import {
  importArchiveFolders,
  importDocumentArchiveEntry,
} from "@weaver/core/services/documentImport";
import { assertProjectRole } from "@weaver/core/services/projectAccess";

import { env } from "~/env";
import { getSessionUser } from "~/server/auth";
import {
  MAX_ARCHIVE_IMPORT_BODY_BYTES,
  parseArchiveImportForm,
} from "~/server/documents/archiveImportFields";
import { sameOrigin } from "~/server/http/sameOrigin";
import {
  problem,
  uploadErrorResponse,
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
  const { projectId } = await ctx.params;
  if (!UUID_RE.test(projectId)) return problem(404, "not found");
  // The body is buffered, so its declared length is the only bound before reading.
  const length = req.headers.get("content-length");
  if (!length || !/^\d+$/.test(length))
    return problem(411, "content-length is required");
  if (Number(length) > MAX_ARCHIVE_IMPORT_BODY_BYTES)
    return problem(413, "document exceeds the import size limit");
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
    await assertProjectRole(db, projectId, actor, "Editor");
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return problem(400, "malformed multipart body");
    }
    const parsed = await parseArchiveImportForm(form);
    if (parsed.target.mode === "folders") {
      const result = await importArchiveFolders(
        db,
        { projectId, ...parsed },
        actor,
      );
      return Response.json(result, { status: 201 });
    }
    const document = await importDocumentArchiveEntry(
      db,
      { projectId, ...parsed, target: parsed.target },
      actor,
    );
    return Response.json(
      { id: document.id, title: document.title, path: document.path },
      { status: 201 },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { MAX_ICON_BYTES } from "@weaver/core/services/appearanceAssets";
import { setContentAppearance } from "@weaver/core/services/contentAppearance";
import { assertProjectRole } from "@weaver/core/services/projectAccess";
import { setAppearanceInput } from "~/server/api/schemas/appearance";
import { getSessionUser } from "~/server/auth";
import { sameOrigin } from "~/server/http/sameOrigin";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = MAX_ICON_BYTES + 65_536;

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
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
      return problem(413, "icon upload is too large");
    if (!req.body) return problem(400, "multipart body is required");
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return problem(413, "icon upload is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let form: FormData;
    try {
      form = await new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: Buffer.concat(chunks),
      }).formData();
    } catch {
      return problem(400, "invalid multipart body");
    }
    const keys = [...form.keys()];
    if (
      keys.length !== 4 ||
      new Set(keys).size !== 4 ||
      keys.some(
        (key) => !["target", "expectedRevision", "patch", "file"].includes(key),
      )
    )
      return problem(400, "send target, expectedRevision, patch, and one file");
    const file = form.get("file");
    if (!(file instanceof File))
      return problem(400, "one image file is required");
    if (file.size > MAX_ICON_BYTES)
      return problem(413, "icon images must be at most 2 MiB");
    const target = form.get("target");
    const patch = form.get("patch");
    const expectedRevision = form.get("expectedRevision");
    if (
      typeof target !== "string" ||
      typeof patch !== "string" ||
      typeof expectedRevision !== "string"
    )
      return problem(400, "invalid appearance fields");
    let raw: unknown;
    try {
      raw = {
        target: JSON.parse(target) as unknown,
        expectedRevision,
        patch: JSON.parse(patch) as unknown,
      };
    } catch {
      return problem(400, "invalid appearance fields");
    }
    const parsed = setAppearanceInput.safeParse(raw);
    if (!parsed.success) return problem(400, "invalid appearance fields");
    if (parsed.data.target.projectId.toLowerCase() !== projectId.toLowerCase())
      return problem(400, "target project does not match upload path");
    const result = await setContentAppearance(db, parsed.data, actor, {
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (isCoreError(error))
      return problem(statusForCoreError(error.code), error.message, {
        field: error.details?.field,
      });
    throw error;
  }
}

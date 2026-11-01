import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { isIconAssetPath } from "@weaver/core/appearance/icons";
import type { ImageIcon } from "@weaver/core/appearance/metadata";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { readAppearanceAsset } from "@weaver/core/services/appearanceAssets";
import { getSessionUser } from "~/server/auth";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; filename: string }> },
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  const { projectId, filename } = await ctx.params;
  if (!UUID_RE.test(projectId) || !isIconAssetPath(`.weaver-icons/${filename}`))
    return problem(404, "not found");
  const [digest, extension] = filename.split(".");
  const icon: ImageIcon = {
    type: "image",
    digest: digest!,
    extension: extension as ImageIcon["extension"],
  };
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  try {
    const image = await readAppearanceAsset(
      db,
      {
        projectId,
        icon,
        at: new URL(req.url).searchParams.get("at") ?? undefined,
        ifNoneMatch: req.headers.get("if-none-match") ?? undefined,
      },
      actor,
    );
    if (!image) return problem(404, "not found");
    const headers = {
      etag: `"${image.blobSha}"`,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    };
    if ("notModified" in image)
      return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        ...headers,
        "content-type": image.contentType,
        "content-length": String(image.bytes.length),
      },
    });
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
}

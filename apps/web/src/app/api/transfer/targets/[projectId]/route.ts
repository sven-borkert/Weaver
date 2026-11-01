import { db } from "@weaver/db";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { transferTargetFolders } from "@weaver/core/services/remoteInstances";
import { problem } from "~/server/ingestion/multipartUpload";
import { resolveTransferActor } from "~/server/transfer/actor";
import { transferError } from "~/server/transfer/respond";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  try {
    const actor = await resolveTransferActor(req);
    const { projectId } = await ctx.params;
    if (!UUID_RE.test(projectId)) return problem(404, "not found");
    return Response.json(await transferTargetFolders(db, actor, projectId));
  } catch (error) {
    return transferError(error);
  }
}

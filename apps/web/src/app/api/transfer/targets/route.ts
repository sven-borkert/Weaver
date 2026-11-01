import { db } from "@weaver/db";
import { listTransferTargets } from "@weaver/core/services/remoteInstances";
import { resolveTransferActor } from "~/server/transfer/actor";
import { transferError } from "~/server/transfer/respond";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const actor = await resolveTransferActor(req);
    return Response.json({ projects: await listTransferTargets(db, actor) });
  } catch (error) {
    return transferError(error);
  }
}

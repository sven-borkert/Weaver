import { db } from "@weaver/db";
import { appPublicUrl } from "@weaver/config/publicUrls";
import { receiveTransferredTable } from "@weaver/core/services/remoteInstances";
import { env } from "~/env";
import { problem } from "~/server/ingestion/multipartUpload";
import { resolveTransferActor } from "~/server/transfer/actor";
import { readBoundedJson } from "~/server/transfer/body";
import { transferError } from "~/server/transfer/respond";
import { transferTableInput } from "~/server/transfer/schemas";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const actor = await resolveTransferActor(req);
    const parsed = transferTableInput.safeParse(await readBoundedJson(req));
    if (!parsed.success)
      return problem(
        400,
        parsed.error.issues[0]?.message ?? "invalid payload",
        { field: parsed.error.issues[0]?.path.join(".") },
      );
    const created = await receiveTransferredTable(db, actor, {
      ...parsed.data,
      fromClientId: actor.clientId,
    });
    return Response.json(
      {
        ...created,
        url: `${appPublicUrl(env)}/projects/${parsed.data.projectId}/tables/${created.id}`,
      },
      { status: 201 },
    );
  } catch (error) {
    return transferError(error);
  }
}

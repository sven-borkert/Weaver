import { resolveTransferActor } from "~/server/transfer/actor";
import { transferError } from "~/server/transfer/respond";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const actor = await resolveTransferActor(req);
    return Response.json({
      capabilities: { contentAppearance: 1, documentProperties: 1 },
      userId: actor.userId,
      name: actor.name,
      email: actor.email,
    });
  } catch (error) {
    return transferError(error);
  }
}

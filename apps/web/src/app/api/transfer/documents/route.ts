import { db } from "@weaver/db";
import { appPublicUrl } from "@weaver/config/publicUrls";
import {
  receiveTransferredDocument,
  TRANSFER_MAX_IMAGES,
} from "@weaver/core/services/remoteInstances";
import { env } from "~/env";
import { problem } from "~/server/ingestion/multipartUpload";
import { resolveTransferActor } from "~/server/transfer/actor";
import { readBoundedJson } from "~/server/transfer/body";
import { transferError } from "~/server/transfer/respond";
import { transferDocumentInput } from "~/server/transfer/schemas";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const actor = await resolveTransferActor(req);
    const raw = (await readBoundedJson(req)) as { images?: unknown } | null;
    if (Array.isArray(raw?.images) && raw.images.length > TRANSFER_MAX_IMAGES)
      return problem(413, `at most ${TRANSFER_MAX_IMAGES} images per document`);
    const parsed = transferDocumentInput.safeParse(raw);
    if (!parsed.success)
      return problem(
        400,
        parsed.error.issues[0]?.message ?? "invalid payload",
        { field: parsed.error.issues[0]?.path.join(".") },
      );
    const { images, ...rest } = parsed.data;
    const created = await receiveTransferredDocument(
      db,
      actor,
      {
        ...rest,
        fromClientId: actor.clientId,
        images: images.map((image) => ({
          name: image.name,
          contentType: image.contentType,
          bytes: Buffer.from(image.bytes, "base64"),
        })),
      },
      { maxImageBytes: env.WEAVER_DOCUMENT_IMAGE_MAX_BYTES },
    );
    return Response.json(
      {
        ...created,
        url: `${appPublicUrl(env)}/projects/${rest.projectId}/documents/${created.id}`,
      },
      { status: 201 },
    );
  } catch (error) {
    return transferError(error);
  }
}

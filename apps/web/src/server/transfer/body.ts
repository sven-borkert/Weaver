import { TRANSFER_BODY_MAX_BYTES } from "@weaver/core/services/remoteInstances";

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the transfer size limit");
  }
}

export async function readBoundedJson(
  req: Request,
  maxBytes = TRANSFER_BODY_MAX_BYTES,
): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

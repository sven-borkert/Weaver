import { CoreError } from "@weaver/core/errors";
import { PROJECT_API_MAX_BODY_BYTES } from "@weaver/core/projectApi/constants";
export function checkProjectApiDeclaredSize(
  req: Request,
  maxBytes = PROJECT_API_MAX_BODY_BYTES,
) {
  const length = req.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
  )
    throw new CoreError("BAD_REQUEST", "Invalid Content-Length");
  if (length !== null && Number(length) > maxBytes)
    throw new CoreError("BAD_REQUEST", "Body too large", { status: 413 });
}
export async function readProjectApiJson(
  req: Request,
  maxBytes = PROJECT_API_MAX_BODY_BYTES,
): Promise<unknown> {
  checkProjectApiDeclaredSize(req, maxBytes);
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers.get("content-type") ?? "",
    )
  )
    throw new CoreError("BAD_REQUEST", "JSON required", { status: 415 });
  const reader = req.body?.getReader();
  if (!reader) throw new CoreError("BAD_REQUEST", "Body required");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new CoreError("BAD_REQUEST", "Body too large", { status: 413 });
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CoreError) throw error;
    throw new CoreError("BAD_REQUEST", "Invalid JSON");
  } finally {
    reader.releaseLock();
  }
}
/** Bodiless methods: Next always supplies a stream, so only actual bytes are refused. */
export async function assertEmptyProjectApiBody(req: Request): Promise<void> {
  checkProjectApiDeclaredSize(req);
  if (Number(req.headers.get("content-length") ?? 0) > 0)
    throw new CoreError("BAD_REQUEST", "No body expected");
  const reader = req.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (chunk.value.byteLength > 0)
        throw new CoreError("BAD_REQUEST", "No body expected");
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CoreError) throw error;
    throw new CoreError("BAD_REQUEST", "Invalid body");
  } finally {
    reader.releaseLock();
  }
}

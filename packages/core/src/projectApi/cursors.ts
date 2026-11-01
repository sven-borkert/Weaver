import { createHmac, timingSafeEqual } from "node:crypto";
import { CoreError } from "../errors";
const sign = (value: string) => {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new CoreError("INTERNAL_SERVER_ERROR");
  return createHmac("sha256", secret)
    .update("weaver-project-api-cursor\0" + value)
    .digest("base64url");
};
export function encodeMachineCursor(binding: string, after: string): string {
  const payload = Buffer.from(JSON.stringify({ binding, after })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}
export function decodeMachineCursor(cursor: string, binding: string): string {
  if (cursor.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(cursor))
    throw new CoreError("BAD_REQUEST", "Invalid cursor");
  const [payload, signature] = cursor.split(".") as [string, string];
  const expected = Buffer.from(sign(payload));
  const supplied = Buffer.from(signature);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    throw new CoreError("BAD_REQUEST", "Invalid cursor");
  let data: { binding?: unknown; after?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      binding?: unknown;
      after?: unknown;
    };
  } catch {
    throw new CoreError("BAD_REQUEST", "Invalid cursor");
  }
  if (data.binding !== binding)
    throw new CoreError("CONFLICT", "Cursor is stale", {
      reason: "CURSOR_STALE",
    });
  if (typeof data.after !== "string" || data.after.length > 256)
    throw new CoreError("BAD_REQUEST", "Invalid cursor");
  return data.after;
}

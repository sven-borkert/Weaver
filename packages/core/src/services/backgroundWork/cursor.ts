import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../../errors";
import {
  BACKGROUND_WORK_KINDS,
  BACKGROUND_WORK_LIMITS,
  backgroundWorkListInput,
  type BackgroundWorkListInput,
} from "../../jobs/backgroundWorkSchema";

const cursorSchema = z
  .object({
    version: z.literal(1),
    actorId: z.uuid(),
    filters: z.string().max(1000),
    asOf: z.iso.datetime(),
    windowStart: z.iso.datetime(),
    last: z
      .object({
        sortAt: z.iso.datetime(),
        kind: z.enum(BACKGROUND_WORK_KINDS),
        id: z.uuid(),
      })
      .strict(),
  })
  .strict();
export type WorkCursor = z.infer<typeof cursorSchema>;
export function workFilterIdentity(input: BackgroundWorkListInput): string {
  const parsed = backgroundWorkListInput.parse(input);
  return JSON.stringify([
    parsed.audience,
    parsed.projectId ?? null,
    parsed.kind ?? null,
    parsed.view,
    parsed.state ?? null,
  ]);
}
function signature(payload: string, secret = process.env.AUTH_SECRET): Buffer {
  if (!secret)
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "Cursor signing is unavailable",
    );
  return createHmac("sha256", secret)
    .update("weaver-background-work-v1:")
    .update(payload)
    .digest();
}
export function encodeWorkCursor(cursor: WorkCursor, secret?: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}
export function decodeWorkCursor(
  value: string,
  actorId: string,
  filters: string,
  secret?: string,
): WorkCursor {
  try {
    if (value.length > 2000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const [payload, supplied] = value.split(".") as [string, string];
    const expected = signature(payload, secret);
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (
      cursor.actorId !== actorId ||
      cursor.filters !== filters ||
      Date.parse(cursor.asOf) - Date.parse(cursor.windowStart) !==
        BACKGROUND_WORK_LIMITS.recentDays * 86400000 ||
      Date.parse(cursor.last.sortAt) > Date.parse(cursor.asOf)
    )
      throw new Error();
    return cursor;
  } catch {
    throw new CoreError("BAD_REQUEST", "Invalid background work cursor");
  }
}

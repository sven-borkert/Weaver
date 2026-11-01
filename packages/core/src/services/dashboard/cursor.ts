import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../../errors";
import {
  ACTIVITY_SOURCES,
  DASHBOARD_LIMITS,
  activityInput,
  type ActivityInput,
} from "../../dashboard/schema";

const cursorSchema = z
  .object({
    version: z.literal(1),
    actorId: z.uuid(),
    filters: z.string().max(1000),
    asOf: z.iso.datetime(),
    workWindowStart: z.iso.datetime(),
    contentWindowStart: z.iso.datetime(),
    last: z
      .object({
        sortAt: z.iso.datetime(),
        source: z.enum(ACTIVITY_SOURCES),
        id: z.uuid(),
      })
      .strict(),
  })
  .strict();
export type ActivityCursor = z.infer<typeof cursorSchema>;
export function activityFilterIdentity(input: ActivityInput): string {
  const parsed = activityInput.parse(input);
  return JSON.stringify([
    parsed.audience,
    parsed.projectId ?? null,
    parsed.view,
  ]);
}
function signature(payload: string, secret = process.env.AUTH_SECRET): Buffer {
  if (!secret)
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "Cursor signing is unavailable",
    );
  return createHmac("sha256", secret)
    .update("weaver-dashboard-activity-v1:")
    .update(payload)
    .digest();
}
export function encodeActivityCursor(
  cursor: ActivityCursor,
  secret?: string,
): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}
export function decodeActivityCursor(
  value: string,
  actorId: string,
  filters: string,
  secret?: string,
): ActivityCursor {
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
      Date.parse(cursor.asOf) - Date.parse(cursor.workWindowStart) !==
        DASHBOARD_LIMITS.workResultDays * 86400000 ||
      Date.parse(cursor.asOf) - Date.parse(cursor.contentWindowStart) !==
        DASHBOARD_LIMITS.contentActivityDays * 86400000 ||
      Date.parse(cursor.last.sortAt) > Date.parse(cursor.asOf)
    )
      throw new Error();
    return cursor;
  } catch {
    throw new CoreError("BAD_REQUEST", "Invalid dashboard activity cursor");
  }
}

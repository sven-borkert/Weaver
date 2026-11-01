import { type NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { listRunEvents } from "@weaver/core/services/assistantRuns";
import { auth, getSessionUser } from "~/server/auth";
import { createRunEventStream } from "~/server/assistant/eventStream";

export const dynamic = "force-dynamic";

const activeStreams = new Map<string, number>();
const MAX_STREAMS_PER_USER = 6;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Absent, blank, or unparseable cursors return null so the caller can fall back. */
function parseCursor(raw: string | null): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= -1 && value <= 2_147_483_647
    ? value
    : null;
}

/** `?after=` wins; otherwise EventSource's automatic `Last-Event-ID`; otherwise replay from the start. */
function resolveAfter(req: NextRequest): number {
  return (
    parseCursor(req.nextUrl.searchParams.get("after")) ??
    parseCursor(req.headers.get("last-event-id")) ??
    -1
  );
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) {
  const user = await getSessionUser(req.headers);
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.mustChangePassword)
    return new Response("password change required", { status: 403 });
  const { runId } = await ctx.params;
  // A malformed id must read exactly like an unknown one — never a 500 from
  // Postgres rejecting the uuid cast.
  if (!UUID_RE.test(runId)) return new Response("not found", { status: 404 });
  const after = resolveAfter(req);
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  try {
    // Ownership check before opening the stream; a run the caller does not own
    // and a run that does not exist both surface as NOT_FOUND.
    await listRunEvents(db, actor, { runId, after, limit: 1 });
  } catch (error) {
    if (isCoreError(error) && error.code === "NOT_FOUND")
      return new Response("not found", { status: 404 });
    if (isCoreError(error) && error.code === "FORBIDDEN")
      return new Response("forbidden", { status: 403 });
    throw error;
  }
  const count = activeStreams.get(user.id) ?? 0;
  if (count >= MAX_STREAMS_PER_USER)
    return new Response("too many streams", {
      status: 429,
      headers: { "retry-after": "15" },
    });
  activeStreams.set(user.id, count + 1);
  let checkedAt = Date.now();
  const stream = createRunEventStream({
    runId,
    fetchPage: async (cursor) => {
      if (Date.now() - checkedAt >= 15_000) {
        const current = await auth.api.getSession({ headers: req.headers });
        if (
          current?.session.id !== user.sessionId ||
          current.user.mustChangePassword ||
          (current.user.banned &&
            (!current.user.banExpires || current.user.banExpires > new Date()))
        ) {
          throw new Error("Session revoked");
        }
        checkedAt = Date.now();
      }
      return listRunEvents(db, actor, { runId, after: cursor });
    },
    onClose: () => {
      const remaining = (activeStreams.get(user.id) ?? 1) - 1;
      if (remaining > 0) activeStreams.set(user.id, remaining);
      else activeStreams.delete(user.id);
    },
    after,
    signal: req.signal,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

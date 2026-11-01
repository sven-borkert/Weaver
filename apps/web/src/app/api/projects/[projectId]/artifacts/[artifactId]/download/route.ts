import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import {
  getArtifact,
  openArtifactStream,
} from "@weaver/core/services/artifacts";

import { env } from "~/env";
import { attachmentDisposition } from "~/lib/http/contentDisposition";
import { getSessionUser } from "~/server/auth";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

const activeDownloads = new Map<string, number>();
const MAX_DOWNLOADS_PER_USER = 4;

function acquireSlot(userId: string): (() => void) | null {
  const count = activeDownloads.get(userId) ?? 0;
  if (count >= MAX_DOWNLOADS_PER_USER) return null;
  activeDownloads.set(userId, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeDownloads.get(userId) ?? 1) - 1;
    if (remaining > 0) activeDownloads.set(userId, remaining);
    else activeDownloads.delete(userId);
  };
}

/** Releases the slot once the body is drained, fails, or is cancelled. */
function guarded(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const onAbort = () => {
    done();
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const done = () => {
    signal.removeEventListener("abort", onAbort);
    release();
  };
  if (signal.aborted) onAbort();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          done();
        } else controller.enqueue(next.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    async cancel(reason) {
      done();
      await reader.cancel(reason);
    },
  });
}

async function download(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; artifactId: string }> },
  headOnly = false,
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  const { projectId, artifactId } = await ctx.params;
  if (!UUID_RE.test(projectId) || !UUID_RE.test(artifactId))
    return problem(404, "not found");
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  let release: (() => void) | null = null;
  try {
    const summary = await getArtifact(db, actor, { projectId, artifactId });
    const etag = `"${summary.contentDigest}"`;
    const headers = {
      etag,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    };
    if (req.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    if (summary.byteSize > env.WEAVER_ARTIFACT_MAX_FILE_BYTES)
      return problem(413, "file is larger than the download limit");
    if (headOnly)
      return new Response(null, {
        status: 200,
        headers: {
          ...headers,
          "content-type": summary.contentType,
          "content-length": String(summary.byteSize),
          "content-disposition": attachmentDisposition(summary.filename),
        },
      });
    req.signal.throwIfAborted();
    release = acquireSlot(user.id);
    if (!release)
      return problem(429, "too many downloads", {}, { "retry-after": "15" });
    const { artifact, size, body } = await openArtifactStream(
      db,
      actor,
      { projectId, artifactId },
      {
        dataDir: env.WEAVER_DATA_DIR,
        maxBytes: env.WEAVER_ARTIFACT_MAX_FILE_BYTES,
      },
    );
    return new Response(guarded(body, req.signal, release), {
      status: 200,
      headers: {
        ...headers,
        "content-type": artifact.contentType,
        "content-length": String(size),
        "content-disposition": attachmentDisposition(artifact.filename),
      },
    });
  } catch (error) {
    release?.();
    if (isCoreError(error)) {
      const status =
        error.details?.reason === "PAYLOAD_TOO_LARGE"
          ? 413
          : statusForCoreError(error.code);
      return problem(
        status === 403 ? 404 : status,
        status === 404 || status === 403
          ? "not found"
          : status >= 500
            ? "download failed"
            : error.message,
      );
    }
    throw error;
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; artifactId: string }> },
) {
  return download(req, ctx);
}

export async function HEAD(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; artifactId: string }> },
) {
  const response = await download(req, ctx, true);
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}

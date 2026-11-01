import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../errors";
import { invalidCursorError, signCursorPayload } from "./contentCursors";

const DOMAIN = "weaver-artifact-cursor-v1:";

const artifactCursorSchema = z
  .object({
    v: z.literal(1),
    tool: z.string().regex(/^[a-z][a-z0-9_]*$/),
    projectId: z.uuid(),
    artifactId: z.uuid(),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    query: z.string().regex(/^[0-9a-f]{64}$/),
    position: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9:_.-]*$/),
  })
  .strict();
type ArtifactCursor = z.infer<typeof artifactCursorSchema>;

export type ArtifactCursorBinding = {
  tool: string;
  projectId: string;
  artifactId: string;
  contentDigest: string;
  /** cursorQueryIdentity(...) from contentCursors.ts */
  query: string;
};

/** Exported so every "the file changed under us" check says the same thing. */
export function staleBaseError(): CoreError {
  return new CoreError(
    "BAD_REQUEST",
    "the file was replaced; start again from get_artifact_overview",
    { reason: "STALE_BASE" },
  );
}

/** A schema failure here means the server built a malformed cursor: a bug, not caller input, so it must never leak as a raw ZodError. */
function parseCursorForEncoding(cursor: ArtifactCursor): ArtifactCursor {
  try {
    return artifactCursorSchema.parse(cursor);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new CoreError(
        "INTERNAL_SERVER_ERROR",
        "built an invalid artifact cursor",
      );
    throw error;
  }
}

export function encodeArtifactCursor(
  binding: ArtifactCursorBinding,
  position: string,
  secret?: string,
): string {
  const cursor = parseCursorForEncoding({ v: 1, ...binding, position });
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${signCursorPayload(DOMAIN, payload, secret).toString("base64url")}`;
}

/** Returns the position. Digest mismatch (everything else in the binding matches) is BAD_REQUEST/STALE_BASE; any other mismatch or malformed input is BAD_REQUEST/INVALID_CURSOR. */
export function decodeArtifactCursor(
  value: string,
  binding: ArtifactCursorBinding,
  secret?: string,
): string {
  try {
    if (value.length > 2_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const [payload, supplied] = value.split(".") as [string, string];
    const expected = signCursorPayload(DOMAIN, payload, secret);
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    const cursor = artifactCursorSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (
      cursor.tool !== binding.tool ||
      cursor.projectId !== binding.projectId ||
      cursor.artifactId !== binding.artifactId ||
      cursor.query !== binding.query
    )
      throw new Error();
    if (cursor.contentDigest !== binding.contentDigest) throw staleBaseError();
    return cursor.position;
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw invalidCursorError();
  }
}

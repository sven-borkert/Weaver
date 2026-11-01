import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCoreError } from "../errors";
import {
  cursorQueryIdentity,
  encodeContentCursor,
  type ContentCursor,
} from "./contentCursors";
import {
  decodeArtifactCursor,
  encodeArtifactCursor,
  type ArtifactCursorBinding,
} from "./artifactCursors";

beforeEach(() => vi.stubEnv("AUTH_SECRET", "unit-artifact-cursor-secret"));
afterEach(() => vi.unstubAllEnvs());

const P = "11111111-1111-4111-8111-111111111111";
const A = "33333333-3333-4333-8333-333333333333";
const DIGEST = "d".repeat(64);
const query = cursorQueryIdentity({ sheet: "Sheet1" });
const binding: ArtifactCursorBinding = {
  tool: "read_excel_sheet",
  projectId: P,
  artifactId: A,
  contentDigest: DIGEST,
  query,
};

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
    return "no error";
  } catch (error) {
    return isCoreError(error)
      ? `${error.code}:${String(error.details?.reason)}`
      : "not core";
  }
}

describe("artifact cursors", () => {
  it("round-trips the position", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    expect(decodeArtifactCursor(encoded, binding)).toBe("row-42");
  });

  it("round-trips an empty position", () => {
    const encoded = encodeArtifactCursor(binding, "");
    expect(decodeArtifactCursor(encoded, binding)).toBe("");
  });

  it("rejects a tampered payload", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    const [payload, sig] = encoded.split(".") as [string, string];
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        v: 1,
        ...binding,
        position: "row-99",
      }),
    ).toString("base64url");
    expect(
      reason(() => decodeArtifactCursor(`${tamperedPayload}.${sig}`, binding)),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
    void payload;
  });

  it("rejects a tampered signature", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    const [payload, sig] = encoded.split(".") as [string, string];
    expect(
      reason(() =>
        decodeArtifactCursor(`${payload}.${sig.slice(0, -2)}xx`, binding),
      ),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("rejects a cursor issued for a different tool", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    expect(
      reason(() =>
        decodeArtifactCursor(encoded, {
          ...binding,
          tool: "read_word_outline",
        }),
      ),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("rejects a cursor issued for a different project", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    expect(
      reason(() => decodeArtifactCursor(encoded, { ...binding, projectId: A })),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("rejects a cursor issued for a different artifact", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    expect(
      reason(() =>
        decodeArtifactCursor(encoded, { ...binding, artifactId: P }),
      ),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("rejects a cursor issued for a different query", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    expect(
      reason(() =>
        decodeArtifactCursor(encoded, {
          ...binding,
          query: cursorQueryIdentity({ sheet: "Sheet2" }),
        }),
      ),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("raises STALE_BASE only when the digest is the sole mismatch", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    let caught: unknown;
    try {
      decodeArtifactCursor(encoded, {
        ...binding,
        contentDigest: "e".repeat(64),
      });
    } catch (error) {
      caught = error;
    }
    expect(isCoreError(caught) && caught.code).toBe("BAD_REQUEST");
    expect(isCoreError(caught) && caught.details?.reason).toBe("STALE_BASE");
    expect(isCoreError(caught) && caught.message).toBe(
      "the file was replaced; start again from get_artifact_overview",
    );
  });

  it("still raises INVALID_CURSOR when the digest AND another field mismatch", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    expect(
      reason(() =>
        decodeArtifactCursor(encoded, {
          ...binding,
          tool: "read_word_outline",
          contentDigest: "e".repeat(64),
        }),
      ),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("rejects an over-long or ill-formed cursor string", () => {
    expect(reason(() => decodeArtifactCursor("not-a-cursor", binding))).toBe(
      "BAD_REQUEST:INVALID_CURSOR",
    );
    expect(reason(() => decodeArtifactCursor("", binding))).toBe(
      "BAD_REQUEST:INVALID_CURSOR",
    );
    expect(
      reason(() => decodeArtifactCursor("a".repeat(2_001) + ".b", binding)),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("rejects a position over 200 characters or with disallowed characters", () => {
    expect(() => encodeArtifactCursor(binding, "x".repeat(201))).toThrow();
    expect(() => encodeArtifactCursor(binding, "row/42")).toThrow();
    expect(() => encodeArtifactCursor(binding, "row 42")).toThrow();
  });

  it("does not accept a content cursor as an artifact cursor", () => {
    const contentCursor: ContentCursor = {
      v: 1,
      kind: "rows",
      projectId: P,
      resourceId: A,
      snapshotCommitSha: "a".repeat(40),
      query,
      position: 5,
    };
    const foreign = encodeContentCursor(contentCursor);
    expect(reason(() => decodeArtifactCursor(foreign, binding))).toBe(
      "BAD_REQUEST:INVALID_CURSOR",
    );
  });

  it("does not accept an artifact cursor as a content cursor", async () => {
    const { decodeContentCursor } = await import("./contentCursors");
    const artifactCursorValue = encodeArtifactCursor(binding, "row-42");
    expect(
      reason(() =>
        decodeContentCursor(artifactCursorValue, {
          kind: "rows",
          projectId: P,
          resourceId: A,
          query,
        }),
      ),
    ).toBe("BAD_REQUEST:INVALID_CURSOR");
  });

  it("fails closed without a signing secret", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => encodeArtifactCursor(binding, "row-42")).toThrow();
    let caught: unknown;
    try {
      encodeArtifactCursor(binding, "row-42");
    } catch (error) {
      caught = error;
    }
    expect(isCoreError(caught) && caught.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("surfaces the missing secret on decode too", () => {
    const encoded = encodeArtifactCursor(binding, "row-42");
    vi.stubEnv("AUTH_SECRET", "");
    let caught: unknown;
    try {
      decodeArtifactCursor(encoded, binding);
    } catch (error) {
      caught = error;
    }
    expect(isCoreError(caught) && caught.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

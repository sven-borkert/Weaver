import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCoreError } from "../errors";
import {
  cursorQueryIdentity,
  decodeContentCursor,
  encodeContentCursor,
  type ContentCursor,
} from "./contentCursors";

beforeEach(() => vi.stubEnv("AUTH_SECRET", "unit-content-cursor-secret"));
afterEach(() => vi.unstubAllEnvs());

const P = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(40);
const query = cursorQueryIdentity({ select: ["x"], filters: undefined });
const cursor: ContentCursor = {
  v: 1,
  kind: "rows",
  projectId: P,
  resourceId: R,
  snapshotCommitSha: SHA,
  query,
  position: 50,
};
const binding = { kind: "rows" as const, projectId: P, resourceId: R, query };

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

describe("content cursors", () => {
  it("round-trips and fills the snapshot from the cursor when the caller omits it", () => {
    const encoded = encodeContentCursor(cursor);
    expect(decodeContentCursor(encoded, binding)).toEqual(cursor);
    expect(
      decodeContentCursor(encoded, { ...binding, snapshotCommitSha: SHA }),
    ).toEqual(cursor);
  });

  it("normalizes query identity independent of key order and undefined fields", () => {
    expect(cursorQueryIdentity({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      cursorQueryIdentity({ a: [{ c: 3, d: 2 }], b: 1, e: undefined }),
    );
    expect(cursorQueryIdentity({ limit: 10 })).not.toBe(
      cursorQueryIdentity({ limit: 20 }),
    );
  });

  it("rejects every binding mismatch with BAD_REQUEST/INVALID_CURSOR", () => {
    const encoded = encodeContentCursor(cursor);
    const expected = "BAD_REQUEST:INVALID_CURSOR";
    expect(
      reason(() =>
        decodeContentCursor(encoded, { ...binding, kind: "columns" }),
      ),
    ).toBe(expected);
    expect(
      reason(() => decodeContentCursor(encoded, { ...binding, projectId: R })),
    ).toBe(expected);
    expect(
      reason(() => decodeContentCursor(encoded, { ...binding, resourceId: P })),
    ).toBe(expected);
    expect(
      reason(() =>
        decodeContentCursor(encoded, {
          ...binding,
          query: cursorQueryIdentity({}),
        }),
      ),
    ).toBe(expected);
    expect(
      reason(() =>
        decodeContentCursor(encoded, {
          ...binding,
          snapshotCommitSha: "b".repeat(40),
        }),
      ),
    ).toBe(expected);
  });

  it("rejects tampered, foreign-secret, malformed, and legacy row-id cursors", () => {
    const encoded = encodeContentCursor(cursor);
    const expected = "BAD_REQUEST:INVALID_CURSOR";
    const [payload, sig] = encoded.split(".") as [string, string];
    expect(
      reason(() =>
        decodeContentCursor(`${payload}.${sig.slice(0, -2)}xx`, binding),
      ),
    ).toBe(expected);
    expect(
      reason(() =>
        decodeContentCursor(encodeContentCursor(cursor, "other"), binding),
      ),
    ).toBe(expected);
    expect(reason(() => decodeContentCursor("not-a-cursor", binding))).toBe(
      expected,
    );
    expect(reason(() => decodeContentCursor(R, binding))).toBe(expected);
    expect(reason(() => decodeContentCursor("", binding))).toBe(expected);
  });

  it("fails closed without a signing secret", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => encodeContentCursor(cursor)).toThrow();
  });

  it("wraps a malformed cursor as an internal CoreError instead of leaking a raw ZodError", () => {
    const malformed = { ...cursor, v: 2 } as unknown as ContentCursor;
    let caught: unknown;
    try {
      encodeContentCursor(malformed);
    } catch (error) {
      caught = error;
    }
    expect(isCoreError(caught) && caught.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("cursor kinds", () => {
  // Kind is compared by string value (z.enum, and a value check in
  // decodeContentCursor), not by array position, so reordering
  // CONTENT_CURSOR_KINDS would not itself break decoding of an
  // already-issued cursor. Appending is still this list's convention for
  // adding a kind; this test pins that convention.
  it("appends groups last", async () => {
    const { CONTENT_CURSOR_KINDS } = await import("./contentCursors");
    expect([...CONTENT_CURSOR_KINDS]).toEqual([
      "document",
      "rows",
      "columns",
      "options",
      "cell",
      "deleted",
      "groups",
    ]);
  });
});

describe("golden encoding (byte-identical across the signature refactor)", () => {
  it("produces the exact string a fixed cursor + secret produced before signCursorPayload existed", () => {
    const c: ContentCursor = {
      v: 1,
      kind: "rows",
      projectId: P,
      resourceId: R,
      snapshotCommitSha: SHA,
      query,
      position: 7,
    };
    const encoded = encodeContentCursor(c, "golden-secret-fixed");
    expect(encoded).toBe(
      "eyJ2IjoxLCJraW5kIjoicm93cyIsInByb2plY3RJZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsInJlc291cmNlSWQiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJzbmFwc2hvdENvbW1pdFNoYSI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJxdWVyeSI6IjcyOTM0MWQxNGMyZWI2MGFkOTE5ZjUyYTljODRjYzY0MDhjYTdjNDdhYmE1OTc2ZmM0M2RiMmFmN2JiYzg0MGIiLCJwb3NpdGlvbiI6N30.lhkf_r7FavR9lOzWiXJo-_3iL_i7lWogOxeFZvllhag",
    );
  });
});

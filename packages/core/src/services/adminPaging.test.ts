import { describe, expect, it } from "vitest";

import { CoreError } from "../errors";
import {
  clampLimit,
  decodeIdPageCursor,
  decodePageCursor,
  decodeTimestampIdPageCursor,
  decodeTimestampPageCursor,
  encodePageCursor,
} from "./adminPaging";

describe("admin paging", () => {
  it("round-trips cursors", () => {
    const cursor = encodePageCursor(["2026-09-04T00:00:00.000Z", "id-1"]);

    expect(decodePageCursor(cursor, 2)).toEqual([
      "2026-09-04T00:00:00.000Z",
      "id-1",
    ]);
  });

  it.each([
    ["invalid alphabet", "not-base64!", 2],
    ["invalid UTF-8", "WyL_Il0", 1],
    ["padding", "W10=", 0],
    ["non-canonical trailing bits", "W11", 0],
    ["wrong arity", encodePageCursor(["one"]), 2],
    [
      "non-string part",
      Buffer.from(JSON.stringify([1])).toString("base64url"),
      1,
    ],
    ["negative arity", encodePageCursor([]), -1],
    ["fractional arity", encodePageCursor([]), 0.5],
  ])("rejects %s", (_case, cursor, arity) => {
    expect(() => decodePageCursor(cursor, arity)).toThrowError(
      expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Invalid cursor",
      }),
    );
  });

  it("decodes a canonical timestamp into a Date for consumers", () => {
    const cursor = encodePageCursor(["2026-09-04T00:00:00.000Z", "id-1"]);

    expect(decodeTimestampPageCursor(cursor, 2)).toEqual([
      new Date("2026-09-04T00:00:00.000Z"),
      "id-1",
    ]);
  });

  it.each([
    "not-a-date",
    "2026-09-04",
    "2026-09-04T00:00:00Z",
    "2026-09-04T02:00:00.000+02:00",
  ])("rejects malformed or non-canonical timestamp %s", (timestamp) => {
    expect(() =>
      decodeTimestampPageCursor(encodePageCursor([timestamp, "id-1"]), 2),
    ).toThrowError(CoreError);
  });

  it("decodes UUID-only and timestamp-plus-UUID cursors", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(decodeIdPageCursor(encodePageCursor([id]))).toBe(id);
    expect(
      decodeTimestampIdPageCursor(
        encodePageCursor(["2026-09-04T00:00:00.000Z", id]),
      ),
    ).toEqual([new Date("2026-09-04T00:00:00.000Z"), id]);
  });

  it.each([
    encodePageCursor(["not-a-uuid"]),
    encodePageCursor(["11111111-1111-0111-8111-111111111111"]),
  ])("rejects an invalid UUID-only cursor", (cursor) => {
    expect(() => decodeIdPageCursor(cursor)).toThrowError(CoreError);
  });

  it("rejects an invalid UUID in a timestamp cursor", () => {
    expect(() =>
      decodeTimestampIdPageCursor(
        encodePageCursor(["2026-09-04T00:00:00.000Z", "not-a-uuid"]),
      ),
    ).toThrowError(CoreError);
  });

  it("clamps limits into the configured range with a default of 50", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(999)).toBe(200);
    expect(clampLimit(20.9, 10)).toBe(10);
  });
});

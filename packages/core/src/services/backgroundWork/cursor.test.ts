import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeWorkCursor,
  decodeWorkCursor,
  workFilterIdentity,
} from "./cursor";
beforeEach(() =>
  vi.stubEnv("AUTH_SECRET", "unit-background-work-signing-secret"),
);
afterEach(() => vi.unstubAllEnvs());
const actor = "4507c3f4-86d6-4558-86d3-69213c6b2646";
const filters = workFilterIdentity({});
const cursor = {
  version: 1 as const,
  actorId: actor,
  filters,
  asOf: "2026-09-08T12:00:00.000Z",
  windowStart: "2026-09-01T12:00:00.000Z",
  last: {
    sortAt: "2026-09-08T11:00:00.000Z",
    kind: "task" as const,
    id: actor,
  },
};
describe("background work cursors", () => {
  it("roundtrips exact tuples and ignores page size in filter identity", () => {
    expect(
      decodeWorkCursor(
        encodeWorkCursor(cursor),
        actor,
        workFilterIdentity({ limit: 50 }),
      ),
    ).toEqual(cursor);
    expect(workFilterIdentity({ view: "all", audience: "mine" })).toBe(filters);
  });
  it("rejects other actors, filters, malformed envelopes and timestamps", () => {
    expect(() =>
      decodeWorkCursor(
        encodeWorkCursor(cursor),
        "00000000-0000-4000-8000-000000000000",
        filters,
      ),
    ).toThrow();
    expect(() =>
      decodeWorkCursor(
        encodeWorkCursor(cursor),
        actor,
        workFilterIdentity({ view: "recent" }),
      ),
    ).toThrow();
    for (const value of [
      { ...cursor, version: 2 },
      { ...cursor, asOf: "invalid" },
      { ...cursor, windowStart: cursor.asOf },
      { ...cursor, last: { ...cursor.last, kind: "unknown" } },
      { ...cursor, extra: true },
    ]) {
      expect(() =>
        decodeWorkCursor(encodeWorkCursor(value as never), actor, filters),
      ).toThrow();
    }
    expect(() => decodeWorkCursor("x".repeat(2001), actor, filters)).toThrow();
    expect(() => decodeWorkCursor("%%%", actor, filters)).toThrow();
    const signed = encodeWorkCursor(cursor);
    const modified = {
      ...cursor,
      asOf: "2020-09-08T12:00:00.000Z",
      windowStart: "2020-09-01T12:00:00.000Z",
    };
    expect(() =>
      decodeWorkCursor(
        `${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signed.split(".")[1]}`,
        actor,
        filters,
      ),
    ).toThrow();
    expect(() =>
      decodeWorkCursor(signed, actor, filters, "other-secret"),
    ).toThrow();
  });
});

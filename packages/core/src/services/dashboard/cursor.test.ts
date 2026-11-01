import { encodeWorkCursor } from "../backgroundWork/cursor";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeActivityCursor,
  decodeActivityCursor,
  activityFilterIdentity,
} from "./cursor";
beforeEach(() =>
  vi.stubEnv("AUTH_SECRET", "unit-background-work-signing-secret"),
);
afterEach(() => vi.unstubAllEnvs());
const actor = "4507c3f4-86d6-4558-86d3-69213c6b2646";
const filters = activityFilterIdentity({});
const cursor = {
  version: 1 as const,
  actorId: actor,
  filters,
  asOf: "2026-09-08T12:00:00.000Z",
  workWindowStart: "2026-09-01T12:00:00.000Z",
  contentWindowStart: "2026-08-09T12:00:00.000Z",
  last: {
    sortAt: "2026-09-08T11:00:00.000Z",
    source: "task" as const,
    id: actor,
  },
};
describe("dashboard activity cursors", () => {
  it("roundtrips exact tuples and ignores page size in filter identity", () => {
    expect(
      decodeActivityCursor(
        encodeActivityCursor(cursor),
        actor,
        activityFilterIdentity({ limit: 50 }),
      ),
    ).toEqual(cursor);
    expect(activityFilterIdentity({ view: "all" })).toBe(filters);
  });
  it("binds activity cursors to the explicit audience", () => {
    const mine = activityFilterIdentity({ projectId: actor, audience: "mine" });
    expect(mine).toBe(activityFilterIdentity({ projectId: actor, limit: 50 }));
    const shared = activityFilterIdentity({
      projectId: actor,
      audience: "projects",
    });
    expect(shared).not.toBe(mine);
    const signed = encodeActivityCursor({ ...cursor, filters: mine });
    expect(() => decodeActivityCursor(signed, actor, shared)).toThrow(
      "Invalid dashboard activity cursor",
    );
    expect(decodeActivityCursor(signed, actor, mine).filters).toBe(mine);
  });
  it("rejects other actors, filters, malformed envelopes and timestamps", () => {
    expect(() =>
      decodeActivityCursor(
        encodeActivityCursor(cursor),
        "00000000-0000-4000-8000-000000000000",
        filters,
      ),
    ).toThrow();
    expect(() =>
      decodeActivityCursor(
        encodeActivityCursor(cursor),
        actor,
        activityFilterIdentity({ view: "results" }),
      ),
    ).toThrow();
    for (const value of [
      { ...cursor, version: 2 },
      { ...cursor, asOf: "invalid" },
      { ...cursor, workWindowStart: cursor.asOf },
      { ...cursor, contentWindowStart: cursor.asOf },
      { ...cursor, last: { ...cursor.last, source: "unknown" } },
      { ...cursor, extra: true },
    ]) {
      expect(() =>
        decodeActivityCursor(
          encodeActivityCursor(value as never),
          actor,
          filters,
        ),
      ).toThrow();
    }
    expect(() =>
      decodeActivityCursor("x".repeat(2001), actor, filters),
    ).toThrow();
    expect(() => decodeActivityCursor("%%%", actor, filters)).toThrow();
    expect(() =>
      decodeActivityCursor(
        encodeWorkCursor({
          version: 1,
          actorId: actor,
          filters,
          asOf: cursor.asOf,
          windowStart: cursor.workWindowStart,
          last: { sortAt: cursor.last.sortAt, kind: "task", id: actor },
        }),
        actor,
        filters,
      ),
    ).toThrow();
    expect(() =>
      decodeActivityCursor(
        encodeActivityCursor(cursor),
        actor,
        activityFilterIdentity({ projectId: actor }),
      ),
    ).toThrow();
    const signed = encodeActivityCursor(cursor);
    const modified = {
      ...cursor,
      asOf: "2020-09-08T12:00:00.000Z",
      workWindowStart: "2020-09-01T12:00:00.000Z",
    };
    expect(() =>
      decodeActivityCursor(
        `${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signed.split(".")[1]}`,
        actor,
        filters,
      ),
    ).toThrow();
    expect(() =>
      decodeActivityCursor(signed, actor, filters, "other-secret"),
    ).toThrow();
  });
});

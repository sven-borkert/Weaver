import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  activityInput,
  pinCandidatesInput,
  pinContentInput,
  projectOverviewInput,
  recentContentInput,
  unpinContentInput,
} from "./schema";

const projectId = randomUUID();
const resourceId = randomUUID();

describe("dashboard input contracts", () => {
  it("applies the bounded list defaults", () => {
    expect(activityInput.parse({})).toEqual({
      audience: "mine",
      view: "all",
      limit: 20,
    });
    expect(recentContentInput.parse({})).toEqual({ limit: 8 });
  });

  it("requires an explicit project for shared work and defaults project filters to mine", () => {
    expect(activityInput.parse({ projectId })).toMatchObject({
      audience: "mine",
      projectId,
    });
    expect(activityInput.safeParse({ audience: "projects" }).success).toBe(
      false,
    );
    expect(
      activityInput.safeParse({ projectId, audience: "projects" }).success,
    ).toBe(true);
    expect(
      activityInput.safeParse({ projectId, audience: "everyone" }).success,
    ).toBe(false);
  });
  it("accepts the documented upper bounds and rejects values outside them", () => {
    expect(
      activityInput.safeParse({ limit: 50, cursor: "x".repeat(2000) }).success,
    ).toBe(true);
    expect(activityInput.safeParse({ limit: 51 }).success).toBe(false);
    expect(activityInput.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(activityInput.safeParse({ cursor: "" }).success).toBe(false);
    expect(activityInput.safeParse({ cursor: "x".repeat(2001) }).success).toBe(
      false,
    );
    expect(recentContentInput.safeParse({ limit: 20 }).success).toBe(true);
    expect(recentContentInput.safeParse({ limit: 21 }).success).toBe(false);
  });

  it("rejects invalid views, kinds, UUIDs, and unknown caller identity fields", () => {
    expect(activityInput.safeParse({ userId: randomUUID() }).success).toBe(
      false,
    );
    expect(
      pinContentInput.safeParse({
        projectId,
        kind: "document",
        resourceId,
        userId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(activityInput.safeParse({ view: "mine" }).success).toBe(false);
    expect(activityInput.safeParse({ projectId: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(
      projectOverviewInput.safeParse({ projectId, userId: randomUUID() })
        .success,
    ).toBe(false);
    expect(
      pinContentInput.safeParse({ projectId, kind: "assistant", resourceId })
        .success,
    ).toBe(false);
    expect(
      pinContentInput.safeParse({
        projectId,
        kind: "document",
        resourceId: "bad",
      }).success,
    ).toBe(false);
    expect(
      unpinContentInput.safeParse({
        projectId,
        pinId: resourceId,
        userId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it("bounds candidate search and keeps every object strict", () => {
    expect(
      pinCandidatesInput.safeParse({ projectId, search: "x".repeat(200) })
        .success,
    ).toBe(true);
    expect(
      pinCandidatesInput.safeParse({ projectId, search: "x".repeat(201) })
        .success,
    ).toBe(false);
    expect(pinCandidatesInput.safeParse({ projectId, limit: 20 }).success).toBe(
      false,
    );
    expect(recentContentInput.safeParse({ userId: randomUUID() }).success).toBe(
      false,
    );
  });
});

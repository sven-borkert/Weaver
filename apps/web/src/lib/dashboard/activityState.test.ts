import { describe, expect, it } from "vitest";
import { activityReducer, initialActivityState } from "./activityState";

describe("activityReducer", () => {
  it("resets paging when filters or refresh change", () => {
    const paged = {
      view: "all" as const,
      projectId: undefined,
      cursors: [null, "first", "second"],
      page: 2,
    };
    expect(
      activityReducer(paged, {
        type: "filter",
        view: "others",
        projectId: "p1",
      }),
    ).toEqual({
      view: "others",
      projectId: "p1",
      cursors: [null],
      page: 0,
    });
    expect(activityReducer(paged, { type: "refresh" })).toEqual({
      ...paged,
      cursors: [null],
      page: 0,
    });
  });

  it("truncates forward history and clamps previous at zero", () => {
    const state = {
      view: "all" as const,
      projectId: undefined,
      cursors: [null, "a", "b"],
      page: 1,
    };
    expect(activityReducer(state, { type: "next", cursor: "c" })).toEqual({
      ...state,
      cursors: [null, "a", "c"],
      page: 2,
    });
    expect(
      activityReducer(initialActivityState(), { type: "previous" }).page,
    ).toBe(0);
  });
});

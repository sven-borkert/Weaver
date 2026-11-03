import { describe, expect, it } from "vitest";
import type { WikiRunView } from "@weaver/core/services/wikiInputs";
import {
  wikiHitLabel,
  wikiProcessCount,
  wikiRunNotice,
  wikiStatusLabel,
} from "./wikiInputPresentation";

const run = (over: Partial<WikiRunView>): WikiRunView => ({
  id: "r",
  kind: "ingest",
  status: "failed",
  errorCode: null,
  errorMessage: null,
  stopReason: null,
  startedAt: new Date(0),
  endedAt: new Date(0),
  items: 1,
  ...over,
});

describe("wikiRunNotice", () => {
  it("words the missing runner plainly and without the code", () => {
    const notice = wikiRunNotice(run({ errorCode: "RUNNER_UNAVAILABLE" }));
    expect(notice?.message).toMatch(/cannot run the wiki agent/);
    expect(notice?.message).toMatch(/back in the queue/);
    expect(notice?.message).not.toContain("RUNNER_UNAVAILABLE");
  });

  it("says no worker is consuming wiki runs", () => {
    expect(
      wikiRunNotice(run({ status: "cancelled", errorCode: "NO_WORKER" }))
        ?.message,
    ).toMatch(/No worker is consuming wiki runs/);
  });

  it("stays quiet on success and no run", () => {
    expect(wikiRunNotice(null)).toBeNull();
    expect(wikiRunNotice(run({ status: "succeeded" }))).toBeNull();
  });
});

describe("labels", () => {
  it("calls a held item what it is", () => {
    expect(wikiStatusLabel("held")).toBe("Possible secret");
  });
  it("names a hit by kind and location, and an unknown kind generically", () => {
    expect(
      wikiHitLabel({ kind: "github_token", location: "note, line 3" }),
    ).toBe("GitHub token (note, line 3)");
    expect(wikiHitLabel({ kind: "new", location: "file, line 1" })).toBe(
      "secret (file, line 1)",
    );
  });
});

describe("wikiProcessCount", () => {
  it("caps at the batch limit and reports what stays", () => {
    expect(wikiProcessCount(13, 0, 10)).toEqual({ take: 10, left: 3 });
    expect(wikiProcessCount(13, 2, 10)).toEqual({ take: 2, left: 11 });
    expect(wikiProcessCount(3, 0, 10)).toEqual({ take: 3, left: 0 });
  });
});

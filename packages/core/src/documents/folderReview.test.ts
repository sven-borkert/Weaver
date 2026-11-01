import { describe, expect, it } from "vitest";

import { closestFolderReviewDefault } from "./folderReview";
import type { ReviewerRef } from "./review";

const refs: ReviewerRef[] = [
  { type: "user", id: "7b0d5f0e-6a51-4d1c-9a43-1f1c6f0c8a11", name: "Ada" },
];

describe("folder review inheritance", () => {
  it("missing_defaults_inherit_but_empty_stops_inheritance", () => {
    expect(
      closestFolderReviewDefault(["guide", "sub"], {
        guide: { reviewers: refs },
      }),
    ).toEqual({ path: ["guide"], reviewers: refs });
    expect(
      closestFolderReviewDefault(["guide", "sub"], {
        guide: { reviewers: refs },
        "guide/sub": { reviewers: [] },
      }),
    ).toEqual({ path: ["guide", "sub"], reviewers: [] });
    expect(
      closestFolderReviewDefault(["guide", "sub", "deep"], {
        guide: { reviewers: refs },
        "guide/sub": { reviewers: [] },
      }),
    ).toEqual({ path: ["guide", "sub"], reviewers: [] });
  });

  it("uses_root_defaults_separately_from_visible_paths", () => {
    expect(
      closestFolderReviewDefault(["guide", "sub"], { "": { reviewers: refs } }),
    ).toEqual({ path: [], reviewers: refs });
    expect(closestFolderReviewDefault([], { "": { reviewers: [] } })).toEqual({
      path: [],
      reviewers: [],
    });
    expect(closestFolderReviewDefault(["guide"], {})).toBeNull();
    expect(
      closestFolderReviewDefault([], { guide: { reviewers: refs } }),
    ).toBeNull();
  });

  it("sibling_paths_do_not_match", () => {
    expect(
      closestFolderReviewDefault(["guide-other", "sub"], {
        guide: { reviewers: refs },
        "guide/sub": { reviewers: [] },
      }),
    ).toBeNull();
    expect(
      closestFolderReviewDefault(["guide", "sub-other"], {
        guide: { reviewers: refs },
        "guide/sub": { reviewers: [] },
      }),
    ).toEqual({ path: ["guide"], reviewers: refs });
  });
});

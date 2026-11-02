import { describe, expect, it } from "vitest";
import {
  GUIDE_MAX_BYTES,
  guideAdvisoryFlags,
  guideByteLength,
  normalizeGuideText,
} from "../guideText";
import { GUIDE_TEMPLATE_V1 } from "./guide-v1.md";

describe("guide template", () => {
  it("is already normalized, unflagged and well under the limit", () => {
    const result = normalizeGuideText(GUIDE_TEMPLATE_V1);
    expect(result.text).toBe(GUIDE_TEMPLATE_V1);
    expect(result.removed).toEqual([]);
    expect(guideAdvisoryFlags(GUIDE_TEMPLATE_V1)).toEqual([]);
    expect(guideByteLength(GUIDE_TEMPLATE_V1)).toBeLessThan(
      GUIDE_MAX_BYTES / 2,
    );
  });
});

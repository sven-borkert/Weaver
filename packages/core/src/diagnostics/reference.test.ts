import { describe, expect, it } from "vitest";
import {
  diagnosticReference,
  referenceIdBounds,
  withReference,
} from "./reference";

describe("diagnostic references", () => {
  it("takes the first eight hex characters of an event id", () => {
    expect(diagnosticReference("A3F9C2E1-0000-4000-8000-000000000000")).toBe(
      "a3f9c2e1",
    );
    expect(diagnosticReference(null)).toBeNull();
    expect(diagnosticReference("not-an-id")).toBeNull();
  });

  it("appends the suffix and keeps it inside a column cap", () => {
    expect(withReference("failed", "a3f9c2e1")).toBe("failed (ref a3f9c2e1)");
    expect(withReference("failed", null)).toBe("failed");
    expect(withReference("x".repeat(400), null, 300)).toHaveLength(300);
    const capped = withReference("x".repeat(400), "a3f9c2e1", 300);
    expect(capped).toHaveLength(300);
    expect(capped.endsWith(" (ref a3f9c2e1)")).toBe(true);
  });

  it("bounds a primary-key range for a reference", () => {
    expect(referenceIdBounds("a3f9c2e1")).toEqual({
      gte: "a3f9c2e1-0000-0000-0000-000000000000",
      lte: "a3f9c2e1-ffff-ffff-ffff-ffffffffffff",
    });
  });
});

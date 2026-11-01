import { describe, expect, it } from "vitest";
import { personalWorkspaceName } from "./personalWorkspace";

describe("personalWorkspaceName", () => {
  it("uses the trimmed user name", () => {
    expect(
      personalWorkspaceName({ name: "  Olivia Owner ", email: "o@x.test" }),
    ).toBe("Olivia Owner's workspace");
  });

  it("falls back to the email local part when the name is blank", () => {
    expect(personalWorkspaceName({ name: "   ", email: "olivia@x.test" })).toBe(
      "olivia's workspace",
    );
  });

  it("caps the name at 120 characters", () => {
    const long = "x".repeat(200);
    expect(personalWorkspaceName({ name: long, email: "a@b.c" }).length).toBe(
      120,
    );
  });
});

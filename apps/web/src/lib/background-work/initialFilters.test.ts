import { describe, expect, it } from "vitest";
import { initialBackgroundWorkFilters } from "./initialFilters";
const projectId = "12345678-1234-4234-8234-123456789abc";
describe("initial background work filters", () => {
  it("accepts a scalar audience and project", () => {
    expect(
      initialBackgroundWorkFilters({ audience: "projects", projectId }),
    ).toEqual({ audience: "projects", projectId });
  });
  it("defaults absent filters", () => {
    expect(initialBackgroundWorkFilters({})).toEqual({
      audience: "mine",
      projectId: "",
    });
  });
  it("rejects duplicate or malformed values independently", () => {
    expect(
      initialBackgroundWorkFilters({
        audience: ["projects", "mine"],
        projectId,
      }),
    ).toEqual({ audience: "mine", projectId });
    expect(
      initialBackgroundWorkFilters({
        audience: "projects",
        projectId: [projectId],
      }),
    ).toEqual({ audience: "projects", projectId: "" });
    expect(
      initialBackgroundWorkFilters({ audience: "admin", projectId: "bad" }),
    ).toEqual({ audience: "mine", projectId: "" });
  });
});

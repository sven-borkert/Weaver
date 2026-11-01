import { describe, expect, it } from "vitest";
import { applicableMachineActions } from "./policy";

describe("machine grant action choices", () => {
  it("offers independent actions and reserves document Create for folders", () => {
    expect(applicableMachineActions("document")).toEqual([
      "read",
      "update",
      "delete",
    ]);
    for (const kind of ["documentFolder", "table", "tableFolder"] as const)
      expect(applicableMachineActions(kind)).toEqual([
        "read",
        "create",
        "update",
        "delete",
      ]);
  });
});

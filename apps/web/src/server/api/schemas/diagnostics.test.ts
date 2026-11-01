import { describe, expect, it } from "vitest";
import { listDiagnosticEventsInput } from "./diagnostics";

describe("listDiagnosticEventsInput excludeDebug", () => {
  it("leaves existing callers unfiltered by default", () => {
    expect(listDiagnosticEventsInput.parse({})).toEqual({});
  });

  it.each([true, false])(
    "preserves the explicit boolean %s",
    (excludeDebug) => {
      expect(listDiagnosticEventsInput.parse({ excludeDebug })).toEqual({
        excludeDebug,
      });
    },
  );

  it("allows an explicit severity alongside the exclusion preference", () => {
    expect(
      listDiagnosticEventsInput.parse({
        severity: "debug",
        excludeDebug: true,
      }),
    ).toEqual({ severity: "debug", excludeDebug: true });
  });

  it.each(["true", "false", 0, 1, null])(
    "rejects a non-boolean %j",
    (excludeDebug) => {
      expect(
        listDiagnosticEventsInput.safeParse({ excludeDebug }).success,
      ).toBe(false);
    },
  );
});

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIAGNOSTICS_SETTINGS,
  DIAGNOSTIC_LEVELS,
  diagnosticsSettingsSchema,
  parseDiagnosticsSettings,
} from "./settings";

describe("diagnostics settings", () => {
  it("defaults to lifecycle events with a week of retention", () => {
    expect(DEFAULT_DIAGNOSTICS_SETTINGS).toEqual({
      level: "standard",
      retentionDays: 7,
      verboseRetentionHours: 24,
      maxRows: 1_000_000,
    });
  });

  it("orders the levels off, errors, standard, verbose", () => {
    expect(DIAGNOSTIC_LEVELS).toEqual(["off", "errors", "standard", "verbose"]);
    expect(
      diagnosticsSettingsSchema.safeParse({ level: "errors" }).success,
    ).toBe(true);
  });

  it("bounds every field and falls back to defaults for junk", () => {
    expect(
      diagnosticsSettingsSchema.safeParse({
        level: "verbose",
        retentionDays: 91,
      }).success,
    ).toBe(false);
    expect(
      diagnosticsSettingsSchema.safeParse({ maxRows: 9_999 }).success,
    ).toBe(false);
    expect(parseDiagnosticsSettings("nonsense")).toEqual(
      DEFAULT_DIAGNOSTICS_SETTINGS,
    );
    expect(parseDiagnosticsSettings({ level: "standard" })).toMatchObject({
      level: "standard",
      retentionDays: 7,
    });
  });
});

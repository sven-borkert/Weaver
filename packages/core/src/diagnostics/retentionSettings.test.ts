import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION_SETTINGS,
  parseRetentionSettings,
  retentionSettingsSchema,
} from "./retentionSettings";

describe("retention settings", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_RETENTION_SETTINGS).toEqual({
      ingestionDays: 30,
      assistantConversationDays: 90,
      taskRunDays: 30,
      aiUsageDays: 90,
    });
  });
  it("treats invalid stored values as defaults", () => {
    expect(parseRetentionSettings({ ingestionDays: 0 })).toEqual(
      DEFAULT_RETENTION_SETTINGS,
    );
    expect(parseRetentionSettings(null)).toEqual(DEFAULT_RETENTION_SETTINGS);
  });
  it("accepts 0 only for conversations", () => {
    expect(
      retentionSettingsSchema.safeParse({ assistantConversationDays: 0 })
        .success,
    ).toBe(true);
    expect(retentionSettingsSchema.safeParse({ taskRunDays: 0 }).success).toBe(
      false,
    );
  });
});

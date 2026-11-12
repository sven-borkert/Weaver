import { expect, it, vi } from "vitest";
import { createSessionSecurityContext } from "../security/context";
import {
  DEFAULT_RETENTION_SETTINGS,
  getRetentionSettingsAsAdmin,
} from "./retentionSettings";

it("requires system administration before reading retention settings", async () => {
  const findUnique = vi.fn(async () => null);
  const db = { systemSetting: { findUnique } } as never;
  await expect(
    getRetentionSettingsAsAdmin(
      db,
      createSessionSecurityContext({
        userId: "user",
        globalRole: "User",
        sessionId: "session",
      }),
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(findUnique).not.toHaveBeenCalled();
  await expect(
    getRetentionSettingsAsAdmin(
      db,
      createSessionSecurityContext({
        userId: "admin",
        globalRole: "Admin",
        sessionId: "session",
      }),
    ),
  ).resolves.toEqual(DEFAULT_RETENTION_SETTINGS);
});

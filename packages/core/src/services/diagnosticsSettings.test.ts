import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDiagnosticsSettings,
  invalidateDiagnosticsSettingsCache,
  peekDiagnosticsSettings,
  primeDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "./diagnosticsSettings";
import { createSessionSecurityContext } from "../security/context";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  invalidateDiagnosticsSettingsCache();
});

describe("diagnostics settings cache", () => {
  it("uses a fresh value and refreshes it after fifteen seconds", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        value: { level: "standard", retentionDays: 7 },
      })
      .mockResolvedValueOnce({
        value: { level: "verbose", retentionDays: 7 },
      });
    const db = { systemSetting: { findUnique } } as never;

    await expect(getDiagnosticsSettings(db, 0)).resolves.toMatchObject({
      level: "standard",
    });
    await expect(getDiagnosticsSettings(db, 14_999)).resolves.toMatchObject({
      level: "standard",
    });
    await expect(getDiagnosticsSettings(db, 15_000)).resolves.toMatchObject({
      level: "verbose",
    });

    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("retains the last value when a stale cache refresh fails", async () => {
    const findUnique = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));
    const db = { systemSetting: { findUnique } } as never;
    primeDiagnosticsSettingsCache(
      {
        level: "standard",
        retentionDays: 7,
        verboseRetentionHours: 24,
        maxRows: 1_000_000,
      },
      0,
    );

    await expect(getDiagnosticsSettings(db, 15_000)).resolves.toMatchObject({
      level: "standard",
    });
  });

  it("does not let an older refresh overwrite a completed settings update", async () => {
    const staleRow = deferred<{
      value: { level: "verbose"; retentionDays: number };
    }>();
    const findUnique = vi
      .fn()
      .mockReturnValueOnce(staleRow.promise)
      .mockResolvedValueOnce({
        value: { level: "standard", retentionDays: 7 },
      });
    const transactionClient = {
      $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
      systemSetting: {
        findUnique,
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    };
    const db = {
      ...transactionClient,
      $transaction: vi.fn(
        (operation: (tx: typeof transactionClient) => unknown) =>
          operation(transactionClient),
      ),
    } as never;
    const actor = createSessionSecurityContext({
      userId: "admin-id",
      globalRole: "Admin",
      sessionId: "session-id",
    });

    const staleRefresh = getDiagnosticsSettings(db, 0);
    await setDiagnosticsSettings(db, actor, { level: "off" });
    staleRow.resolve({ value: { level: "verbose", retentionDays: 7 } });
    await staleRefresh;

    expect(peekDiagnosticsSettings(0)?.value.level).toBe("off");
  });

  it("keeps the cache invalidated when an older refresh finishes", async () => {
    const staleRow = deferred<{
      value: { level: "verbose"; retentionDays: number };
    }>();
    const db = {
      systemSetting: { findUnique: vi.fn().mockReturnValue(staleRow.promise) },
    } as never;

    const staleRefresh = getDiagnosticsSettings(db, 0);
    invalidateDiagnosticsSettingsCache();
    staleRow.resolve({ value: { level: "verbose", retentionDays: 7 } });
    await staleRefresh;

    expect(peekDiagnosticsSettings(0)).toBeNull();
  });
});

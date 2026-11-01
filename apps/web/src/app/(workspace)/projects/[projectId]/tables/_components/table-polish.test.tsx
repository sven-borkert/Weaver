import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  focusTableDialogTrigger,
  tableDialogValuesForAccess,
  tableDialogValueForAccess,
  tableGridAccessibleName,
  tableQueryFailureKind,
  tableSaveFailurePresentation,
  tableSelectionAnnouncement,
} from "./table-polish";
import { WorkspaceRefreshError } from "./TableStates";

describe("table workflow polish", () => {
  it("recognizes only controlled BAD_REQUEST size markers", () => {
    const schemaLimit = tableSaveFailurePresentation(
      "BAD_REQUEST",
      "table schema too large",
    );
    expect(schemaLimit.kind).toBe("limit");
    expect(schemaLimit.message).not.toContain("table schema too large");
    expect(
      tableSaveFailurePresentation(
        "BAD_REQUEST",
        "Phase 2 tables are limited to 10,000 rows / 5 MB; larger tables arrive with the Phase 6 outbox path",
      ).kind,
    ).toBe("limit");
    expect(
      tableSaveFailurePresentation("BAD_REQUEST", "invalid table draft").kind,
    ).toBe("validation");
    expect(tableSaveFailurePresentation("BAD_REQUEST", {}).kind).toBe(
      "validation",
    );
    expect(
      tableSaveFailurePresentation(
        "INTERNAL_SERVER_ERROR",
        "table schema too large",
      ).kind,
    ).toBe("generic");
    expect(tableSaveFailurePresentation("INTERNAL_SERVER_ERROR").kind).toBe(
      "generic",
    );
  });

  it("makes cached access failures fatal while retaining transient cached data", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]) {
      expect(
        tableQueryFailureKind({
          error: { data: { code } },
          hasCachedData: true,
        }),
      ).toBe("access");
    }
    expect(
      tableQueryFailureKind({
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
        hasCachedData: true,
      }),
    ).toBe("cached-transient");
    expect(
      tableQueryFailureKind({
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
        hasCachedData: false,
      }),
    ).toBe("initial-transient");
  });

  it("makes controlled table corruption fatal even when table data is cached", () => {
    expect(
      tableQueryFailureKind({
        error: {
          data: { code: "INTERNAL_SERVER_ERROR" },
          message: "table files are corrupt; run rebuild or fix in git",
        },
        hasCachedData: true,
        detectCorruption: true,
      }),
    ).toBe("corrupt");
    expect(
      tableQueryFailureKind({
        error: {
          data: { code: "INTERNAL_SERVER_ERROR" },
          message: "unexpected corrupt response",
        },
        hasCachedData: true,
        detectCorruption: true,
      }),
    ).toBe("cached-transient");
  });

  it("invalidates dialog operations across permission transitions", () => {
    const originalGrant = {};
    const restoredGrant = {};
    const dialog = { accessToken: originalGrant, value: "rename" };

    expect(tableDialogValueForAccess(dialog, true, originalGrant)).toBe(
      "rename",
    );
    expect(tableDialogValueForAccess(dialog, false, restoredGrant)).toBe(
      undefined,
    );
    expect(tableDialogValueForAccess(dialog, true, restoredGrant)).toBe(
      undefined,
    );
  });

  it("invalidates every destructive table dialog across demotion and regrant", () => {
    const originalGrant = {};
    const restoredGrant = {};
    const operations = {
      tableMove: { accessToken: originalGrant, value: "table move" },
      tableDelete: { accessToken: originalGrant, value: "table delete" },
      folderRename: { accessToken: originalGrant, value: "folder rename" },
      folderMove: { accessToken: originalGrant, value: "folder move" },
      folderDelete: { accessToken: originalGrant, value: "folder delete" },
      restore: { accessToken: originalGrant, value: "restore" },
    };

    expect(tableDialogValuesForAccess(operations, true, originalGrant)).toEqual(
      {
        tableMove: "table move",
        tableDelete: "table delete",
        folderRename: "folder rename",
        folderMove: "folder move",
        folderDelete: "folder delete",
        restore: "restore",
      },
    );
    expect(
      tableDialogValuesForAccess(operations, false, restoredGrant),
    ).toEqual({
      tableMove: undefined,
      tableDelete: undefined,
      folderRename: undefined,
      folderMove: undefined,
      folderDelete: undefined,
      restore: undefined,
    });
    expect(tableDialogValuesForAccess(operations, true, restoredGrant)).toEqual(
      {
        tableMove: undefined,
        tableDelete: undefined,
        folderRename: undefined,
        folderMove: undefined,
        folderDelete: undefined,
        restore: undefined,
      },
    );
  });

  it("builds a grid name from the current table title", () => {
    expect(tableGridAccessibleName("  Launch plan  ")).toBe(
      "Launch plan table grid",
    );
    expect(tableGridAccessibleName("   ")).toBe("Untitled table grid");
  });

  it("announces the exact selected-row count", () => {
    expect(tableSelectionAnnouncement(0)).toBe("No rows selected");
    expect(tableSelectionAnnouncement(1)).toBe("1 row selected");
    expect(tableSelectionAnnouncement(3)).toBe("3 rows selected");
  });

  it("returns focus to a connected trigger after a triggerless dialog closes", () => {
    const focus = vi.fn();
    const schedule = vi.fn((callback: () => void) => callback());

    focusTableDialogTrigger({ isConnected: true, focus }, null, schedule);

    expect(schedule).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not focus a trigger that has left the document", () => {
    const focus = vi.fn();

    focusTableDialogTrigger({ isConnected: false, focus }, null, (callback) =>
      callback(),
    );

    expect(focus).not.toHaveBeenCalled();
  });

  it("focuses a connected stable fallback when the trigger was removed", () => {
    const primaryFocus = vi.fn();
    const fallbackFocus = vi.fn();

    focusTableDialogTrigger(
      { isConnected: false, focus: primaryFocus },
      { isConnected: true, focus: fallbackFocus },
      (callback) => callback(),
    );

    expect(primaryFocus).not.toHaveBeenCalled();
    expect(fallbackFocus).toHaveBeenCalledOnce();
  });

  it("renders a retryable cached-refresh alert", () => {
    const html = renderToStaticMarkup(
      <WorkspaceRefreshError
        title="Table could not refresh"
        description="Showing cached table data."
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Table could not refresh");
    expect(html).toContain("Showing cached table data.");
    expect(html).toContain(">Retry<");
  });
});

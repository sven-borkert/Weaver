type TableSaveFailurePresentation = {
  kind: "validation" | "limit" | "generic";
  message: string;
};

export function tableSaveFailurePresentation(
  code: string | undefined,
  message?: unknown,
): TableSaveFailurePresentation {
  if (code === "BAD_REQUEST") {
    if (
      message === "table schema too large" ||
      message ===
        "Phase 2 tables are limited to 10,000 rows / 5 MB; larger tables arrive with the Phase 6 outbox path"
    ) {
      return {
        kind: "limit",
        message:
          "The table draft exceeds a supported size or processing limit. Reduce it and try again; your draft is still available.",
      };
    }
    return {
      kind: "validation",
      message:
        "The table draft is not valid. Review the table data and try again; your draft is still available.",
    };
  }
  return {
    kind: "generic",
    message: "Could not save the table. Your draft is still available.",
  };
}

type TableQueryFailureKind =
  "access" | "corrupt" | "cached-transient" | "initial-transient" | null;

function tableErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return;
  const data = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) return;
  return typeof data.code === "string" ? data.code : undefined;
}

function tableErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("message" in error)) return;
  return typeof error.message === "string" ? error.message : undefined;
}

export function tableQueryFailureKind({
  error,
  hasCachedData,
  detectCorruption = false,
}: {
  error: unknown;
  hasCachedData: boolean;
  detectCorruption?: boolean;
}): TableQueryFailureKind {
  if (!error) return null;
  const code = tableErrorCode(error);
  if (["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"].includes(code ?? "")) {
    return "access";
  }
  const message = tableErrorMessage(error);
  if (
    detectCorruption &&
    code === "INTERNAL_SERVER_ERROR" &&
    (message === "table files are corrupt; run rebuild or fix in git" ||
      message === "table path is corrupt; run rebuild or fix in git")
  ) {
    return "corrupt";
  }
  return hasCachedData ? "cached-transient" : "initial-transient";
}

export function tableDialogValueForAccess<Value, AccessToken>(
  dialog: { accessToken: AccessToken; value: Value } | undefined,
  canEdit: boolean,
  currentAccessToken: AccessToken,
): Value | undefined {
  if (!canEdit || dialog?.accessToken !== currentAccessToken) return;
  return dialog.value;
}

type DialogValue<Dialog> = Dialog extends { value: infer Value }
  ? Value
  : never;

export function tableDialogValuesForAccess<
  AccessToken,
  Dialogs extends Record<
    string,
    { accessToken: AccessToken; value: unknown } | undefined
  >,
>(
  dialogs: Dialogs,
  canEdit: boolean,
  currentAccessToken: AccessToken,
): {
  [Key in keyof Dialogs]: DialogValue<NonNullable<Dialogs[Key]>> | undefined;
} {
  return Object.fromEntries(
    Object.entries(dialogs).map(([key, dialog]) => [
      key,
      tableDialogValueForAccess(dialog, canEdit, currentAccessToken),
    ]),
  ) as {
    [Key in keyof Dialogs]: DialogValue<NonNullable<Dialogs[Key]>> | undefined;
  };
}

export function tableGridAccessibleName(title: string): string {
  const normalizedTitle = title.trim();
  return normalizedTitle
    ? `${normalizedTitle} table grid`
    : "Untitled table grid";
}

export function tableSelectionAnnouncement(selectedRowCount: number): string {
  if (selectedRowCount === 0) return "No rows selected";
  return `${selectedRowCount} row${selectedRowCount === 1 ? "" : "s"} selected`;
}

type FocusTarget = Pick<HTMLElement, "focus" | "isConnected">;

export function focusTableDialogTrigger(
  target: FocusTarget | null,
  fallback: FocusTarget | null = null,
  schedule: (callback: () => void) => void = (callback) => {
    window.requestAnimationFrame(callback);
  },
): void {
  schedule(() => {
    if (target?.isConnected) target.focus();
    else if (fallback?.isConnected) fallback.focus();
  });
}

export const TABLE_CONTEXT_RAIL_KEY = "weaver:tables:context-rail";

type PanelPreferenceReader = Pick<Storage, "getItem">;
type PanelPreferenceWriter = Pick<Storage, "setItem">;

export function shouldMountTableContextData({
  railOpen,
  drawerOpen,
}: {
  railOpen: boolean;
  drawerOpen: boolean;
}): boolean {
  return railOpen || drawerOpen;
}

export function getTableHistoryEntryState(
  currentSha: string,
  selectedSha: string | undefined,
  entrySha: string,
): { current: boolean; selected: boolean } {
  const current = entrySha === currentSha;
  return { current, selected: !current && entrySha === selectedSha };
}

export function readTablePanelPreference(storage: PanelPreferenceReader) {
  try {
    const value = storage.getItem(TABLE_CONTEXT_RAIL_KEY);
    if (value === "open") return true;
    if (value === "closed") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeTablePanelPreference(
  storage: PanelPreferenceWriter,
  open: boolean,
) {
  try {
    storage.setItem(TABLE_CONTEXT_RAIL_KEY, open ? "open" : "closed");
    return true;
  } catch {
    return false;
  }
}

export const DOCUMENT_CONTEXT_RAIL_KEY = "weaver:documents:context-rail";

type PanelPreferenceReader = Pick<Storage, "getItem">;
type PanelPreferenceWriter = Pick<Storage, "setItem">;

export function parsePanelPreference(value: string | null) {
  if (value === "open") return true;
  if (value === "closed") return false;
  return undefined;
}

export function readPanelPreference(storage: PanelPreferenceReader) {
  try {
    return parsePanelPreference(storage.getItem(DOCUMENT_CONTEXT_RAIL_KEY));
  } catch {
    return undefined;
  }
}

export function writePanelPreference(
  storage: PanelPreferenceWriter,
  open: boolean,
) {
  try {
    storage.setItem(DOCUMENT_CONTEXT_RAIL_KEY, open ? "open" : "closed");
    return true;
  } catch {
    return false;
  }
}

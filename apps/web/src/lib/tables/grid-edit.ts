export type GridEditApi = {
  getEditingCells(): readonly unknown[];
  stopEditing(cancel?: boolean): void;
};

export type GridEditFrame = (callback: () => void) => void;

export async function commitPendingGridEdit(
  api: GridEditApi | null,
  nextFrame: GridEditFrame,
  editing = false,
): Promise<void> {
  if (!api) return;
  if (api.getEditingCells().length === 0) {
    if (editing) await new Promise<void>((resolve) => nextFrame(resolve));
    return;
  }
  api.stopEditing(false);
  await new Promise<void>((resolve) => nextFrame(resolve));
}

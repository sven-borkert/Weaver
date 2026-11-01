/** A toolbar group's box inside its wrapping row, relative to the row's padding box. */
export type ToolbarGroupBox = { top: number; right: number };

// Flex wraps in order, so every group after the first overflowing one overflows too.
export function visibleToolbarGroups(
  boxes: readonly ToolbarGroupBox[],
  rowWidth: number,
  tolerance = 1,
): number {
  const lineTop = boxes[0]?.top ?? 0;
  const index = boxes.findIndex(
    (box) => box.top > lineTop + tolerance || box.right > rowWidth + tolerance,
  );
  return index < 0 ? boxes.length : index;
}

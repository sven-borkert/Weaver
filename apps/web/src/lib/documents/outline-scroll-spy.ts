export type OutlineHeadingPosition = { anchor: string; top: number };

/** The section being read: the last heading at or above the reading line. */
export function currentOutlineAnchor({
  headings,
  readingLine,
  viewportBottom,
  atEnd,
}: {
  headings: readonly OutlineHeadingPosition[];
  readingLine: number;
  viewportBottom: number;
  /** Scrolled to the bottom, where the last sections can never reach the line. */
  atEnd: boolean;
}): string | undefined {
  let current: string | undefined;
  for (const heading of headings) {
    if (heading.top <= readingLine || (atEnd && heading.top < viewportBottom))
      current = heading.anchor;
  }
  return current;
}

/** The scroll offset that brings an item fully into view, or undefined when it already is. */
export function revealScrollTop({
  scrollTop,
  viewTop,
  viewBottom,
  itemTop,
  itemBottom,
}: {
  scrollTop: number;
  viewTop: number;
  viewBottom: number;
  itemTop: number;
  itemBottom: number;
}): number | undefined {
  if (itemTop < viewTop) return scrollTop - (viewTop - itemTop);
  if (itemBottom > viewBottom) return scrollTop + (itemBottom - viewBottom);
  return undefined;
}

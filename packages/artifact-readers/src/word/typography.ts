/** Heading signals beyond the Heading N style ids: declared outline levels
 *  and, for documents with none, typography. */
import {
  fontSizeValue,
  outlineLevelValue,
  type WordStyleIndex,
} from "./controls";
import {
  attr,
  directWordChild,
  directWordChildren,
  isWordElement,
  visitElements,
  type XmlElement,
} from "./package";

export type TypographyContext = { styles: WordStyleIndex; defaultSize: number };

const MAX_STYLE_DEPTH = 20;
const MAX_HEADING_CHARS = 120;
const MAX_BOLD_HEADING_CHARS = 80;
const MIN_SIZE_STEP = 2;
const MAX_SIZE_LEVELS = 4;
const MIN_HEADINGS = 2;
const MAX_HEADING_SHARE = 0.35;

type StyleEntry = NonNullable<ReturnType<WordStyleIndex["get"]>>;

/** First value found walking a style and its basedOn ancestors. */
function styleValue<T>(
  styles: WordStyleIndex,
  styleId: string | null,
  pick: (style: StyleEntry) => T | null | undefined,
): T | null {
  let id = styleId;
  for (let depth = 0; id && depth < MAX_STYLE_DEPTH; depth += 1) {
    const style = styles.get(id);
    if (!style) return null;
    const value = pick(style);
    if (value !== null && value !== undefined) return value;
    id = style.basedOn;
  }
  return null;
}

function childValue(parent: XmlElement | null, name: string): string | null {
  const child = parent ? directWordChild(parent, name) : null;
  return child ? attr(child, "val") : null;
}

function paragraphStyleId(paragraph: XmlElement): string | null {
  return childValue(directWordChild(paragraph, "pPr"), "pStyle");
}

/** Nearest declared 1-based heading level, explicit body text, or no declaration. */
export function declaredOutlineLevel(
  paragraph: XmlElement,
  styles: WordStyleIndex,
): number | "body" | null {
  const own = outlineLevelValue(
    childValue(directWordChild(paragraph, "pPr"), "outlineLvl"),
  );
  const level =
    own ??
    styleValue(
      styles,
      paragraphStyleId(paragraph),
      (style) => style.outlineLevel,
    );
  return level === 9 ? "body" : level === null ? null : level + 1;
}

function toggle(rPr: XmlElement | null, name: string): boolean | null {
  const element = rPr ? directWordChild(rPr, name) : null;
  if (!element) return null;
  const value = attr(element, "val");
  return value !== "0" && value?.toLowerCase() !== "false";
}

type Typography = { text: string; size: number; bold: boolean };

/** Smallest size and common boldness over the paragraph's text runs. */
function paragraphTypography(
  paragraph: XmlElement,
  context: TypographyContext,
): Typography | null {
  const paragraphStyle = paragraphStyleId(paragraph);
  let text = "";
  let size = Number.POSITIVE_INFINITY;
  let bold = true;
  visitElements(paragraph, (element) => {
    if (!isWordElement(element, "r")) return;
    const runText = directWordChildren(element, "t")
      .map((node) => node.textContent ?? "")
      .join("");
    if (!runText.trim()) return;
    const rPr = directWordChild(element, "rPr");
    const runStyle = childValue(rPr, "rStyle");
    const runSize =
      fontSizeValue(childValue(rPr, "sz")) ??
      styleValue(context.styles, runStyle, (style) => style.format.size) ??
      styleValue(
        context.styles,
        paragraphStyle,
        (style) => style.format.size,
      ) ??
      context.defaultSize;
    const runBold =
      toggle(rPr, "b") ??
      styleValue(context.styles, runStyle, (style) => style.format.bold) ??
      styleValue(
        context.styles,
        paragraphStyle,
        (style) => style.format.bold,
      ) ??
      false;
    text += runText;
    size = Math.min(size, runSize);
    bold &&= runBold;
  });
  const trimmed = text.trim();
  return trimmed ? { text: trimmed, size, bold } : null;
}

/** bodyIndex → 1-based level, or an empty map when the formatting does not
 *  look like an outline. Only called for documents with no declared heading. */
export function inferHeadingLevels(
  paragraphs: readonly { bodyIndex: number; element: XmlElement }[],
  context: TypographyContext,
): Map<number, number> {
  const measured = paragraphs.flatMap((paragraph) => {
    const typography = paragraphTypography(paragraph.element, context);
    return typography
      ? [
          {
            bodyIndex: paragraph.bodyIndex,
            ...typography,
            bodyText:
              declaredOutlineLevel(paragraph.element, context.styles) ===
              "body",
          },
        ]
      : [];
  });
  const charsBySize = new Map<number, number>();
  for (const item of measured)
    charsBySize.set(
      item.size,
      (charsBySize.get(item.size) ?? 0) + item.text.length,
    );
  let bodySize = context.defaultSize;
  let most = -1;
  for (const [size, chars] of charsBySize)
    if (chars > most || (chars === most && size < bodySize))
      [bodySize, most] = [size, chars];

  const candidates = measured.filter(
    (item) => !item.bodyText && item.text.length <= MAX_HEADING_CHARS,
  );
  const largerSizes = [
    ...new Set(
      candidates
        .filter((item) => item.size >= bodySize + MIN_SIZE_STEP)
        .map((item) => item.size),
    ),
  ].sort((a, b) => b - a);
  const sizeLevels = Math.min(largerSizes.length, MAX_SIZE_LEVELS);

  const levels = new Map<number, number>();
  for (const item of candidates) {
    const rank = largerSizes.indexOf(item.size);
    if (rank >= 0) {
      levels.set(item.bodyIndex, Math.min(rank + 1, MAX_SIZE_LEVELS));
    } else if (
      item.size === bodySize &&
      item.bold &&
      item.text.length <= MAX_BOLD_HEADING_CHARS &&
      !/[.,;:]$/.test(item.text)
    ) {
      levels.set(item.bodyIndex, sizeLevels + 1);
    }
  }
  if (
    levels.size < MIN_HEADINGS ||
    levels.size > measured.length * MAX_HEADING_SHARE
  )
    return new Map();
  return levels;
}

/**
 * Content controls and template guidance: dropdown/combo-box reading and the
 * style-driven instruction classification.
 */
import { normalizeLimit } from "../limits";
import {
  attr,
  directWordChild,
  directWordChildren,
  isWordElement,
  readOptionalPartDocument,
  textOf,
  visitElements,
  type WordPackage,
  type XmlElement,
} from "./package";
import {
  chapterIdForBlock,
  requireChapter,
  requireTable,
  tableCellEntries,
  tableRowElements,
  type BodyBlock,
  type DocumentStructure,
} from "./structure";

const DEFAULT_MAX_CONTROLS = 100;
const HARD_MAX_CONTROLS = 300;

/**
 * How a paragraph reads: real document content, template guidance
 * (instruction styles / italic light-blue runs), a mix of both, a heading
 * that opens a chapter, a table caption, or a table-of-contents field.
 */
export type WordParagraphKind =
  "content" | "instruction" | "mixed" | "heading" | "caption" | "toc";

/**
 * Template profile for instruction recognition: style names/ids matching
 * `styleNames` (case-insensitive substring) or runs that are italic AND
 * colored in one of `colors` count as instruction formatting. Configurable
 * per template version; the defaults match the default template (paragraph
 * style "guidance", italic + 7C9DBE).
 */
export interface WordInstructionProfile {
  styleNames: string[];
  colors: string[];
  coverageThreshold: number;
}

export const DEFAULT_INSTRUCTION_PROFILE: WordInstructionProfile = {
  styleNames: ["guidance", "instruction"],
  colors: ["7C9DBE"],
  coverageThreshold: 0.8,
};

export interface WordInstructionItem {
  chapterId: string | null;
  kind: "instruction" | "mixed";
  text: string;
  blockId?: string;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
}

export type WordDropdownControlType = "dropDownList" | "comboBox";

export interface WordDropdownOption {
  value: string;
  displayText: string;
}

export interface WordDropdownRead {
  controlId: string;
  controlType: WordDropdownControlType;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  chapterId?: string;
  alias?: string;
  tag?: string;
  selectedText: string;
  selectedValue: string | null;
  placeholderShown: boolean;
  optionCount: number;
  options?: WordDropdownOption[];
}

export interface WordDropdownsRead {
  controls: WordDropdownRead[];
  truncated: boolean;
}

interface DropdownLocation {
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  chapterId?: string;
}

interface DropdownTarget {
  sdt: XmlElement;
  list: XmlElement;
  controlType: WordDropdownControlType;
}

interface StyleFormat {
  italic?: boolean;
  color?: string;
  /** Half-points (w:sz). */
  size?: number;
  bold?: boolean;
}

interface WordStyleInfo {
  id: string;
  name: string;
  basedOn: string | null;
  format: StyleFormat;
  outlineLevel: number | null;
}

export type WordStyleIndex = Map<string, WordStyleInfo>;

export function collectDropdownControls(
  structure: DocumentStructure,
  input: {
    tableId?: string;
    chapterId?: string;
    includeOptions?: boolean;
    maxControls?: number;
  },
): WordDropdownsRead {
  if (input.tableId) requireTable(structure, input.tableId);
  if (input.chapterId) requireChapter(structure, input.chapterId);

  const includeOptions = input.includeOptions ?? true;
  const maxControls = normalizeLimit({
    value: input.maxControls,
    defaultValue: DEFAULT_MAX_CONTROLS,
    hardMax: HARD_MAX_CONTROLS,
    label: "maxControls",
  });
  const controls: WordDropdownRead[] = [];

  for (const block of structure.blocks) {
    const chapterId = chapterIdForBlock(structure, block);
    if (input.chapterId && chapterId !== input.chapterId) continue;
    if (input.tableId && block.blockId !== input.tableId) continue;

    if (block.type === "table") {
      controls.push(
        ...collectTableDropdownControls(block, structure, includeOptions),
      );
    } else {
      const found = collectDropdownsInElement(
        block.element,
        { chapterId: chapterId ?? undefined },
        includeOptions,
      );
      controls.push(...found);
    }
  }

  return {
    controls: controls.slice(0, maxControls),
    truncated: controls.length > maxControls,
  };
}

export function collectTableDropdownControls(
  tableBlock: BodyBlock,
  structure: DocumentStructure,
  includeOptions: boolean,
): WordDropdownRead[] {
  const controls: WordDropdownRead[] = [];
  const seen = new Set<XmlElement>();
  const chapterId = chapterIdForBlock(structure, tableBlock) ?? undefined;

  tableRowElements(tableBlock.element).forEach((row, rowIndex) => {
    tableCellEntries(row).forEach((entry, columnIndex) => {
      const location: DropdownLocation = {
        tableId: tableBlock.blockId,
        rowIndex: rowIndex + 1,
        columnIndex: columnIndex + 1,
        chapterId,
      };
      if (entry.wrapperSdt) {
        const read = parseDropdownControl(entry.wrapperSdt, location, {
          includeOptions,
        });
        if (read) {
          controls.push(read);
          seen.add(entry.wrapperSdt);
        }
      }
      visitElements(entry.cell, (element) => {
        if (!isWordElement(element, "sdt") || seen.has(element)) return;
        const read = parseDropdownControl(element, location, {
          includeOptions,
        });
        if (read) {
          controls.push(read);
          seen.add(element);
        }
      });
    });
  });
  return controls;
}

function collectDropdownsInElement(
  element: XmlElement,
  location: DropdownLocation,
  includeOptions: boolean,
): WordDropdownRead[] {
  const controls: WordDropdownRead[] = [];
  visitElements(element, (child) => {
    if (!isWordElement(child, "sdt")) return;
    const read = parseDropdownControl(child, location, { includeOptions });
    if (read) controls.push(read);
  });
  return controls;
}

function parseDropdownControl(
  sdt: XmlElement,
  location: DropdownLocation,
  options: { includeOptions: boolean },
): WordDropdownRead | null {
  const target = dropdownTargetFromSdt(sdt);
  if (!target) return null;
  const sdtPr = directWordChild(sdt, "sdtPr");
  if (!sdtPr) return null;
  const controlId = attr(directWordChild(sdtPr, "id") ?? sdtPr, "val");
  if (!controlId) return null;

  const listOptions = dropdownOptions(target.list);
  const content = directWordChild(sdt, "sdtContent") ?? sdt;
  const selectedText = textOf(content).trim();
  const placeholderShown = directWordChild(sdtPr, "showingPlcHdr") !== null;
  const selectedValue = placeholderShown
    ? null
    : (listOptions.find(
        (option) =>
          option.value === selectedText || option.displayText === selectedText,
      )?.value ?? null);
  const alias = attr(directWordChild(sdtPr, "alias") ?? sdtPr, "val");
  const tag = attr(directWordChild(sdtPr, "tag") ?? sdtPr, "val");

  return {
    controlId,
    controlType: target.controlType,
    ...(location.tableId ? { tableId: location.tableId } : {}),
    ...(location.rowIndex !== undefined ? { rowIndex: location.rowIndex } : {}),
    ...(location.columnIndex !== undefined
      ? { columnIndex: location.columnIndex }
      : {}),
    ...(location.chapterId ? { chapterId: location.chapterId } : {}),
    ...(alias ? { alias } : {}),
    ...(tag ? { tag } : {}),
    selectedText,
    selectedValue,
    placeholderShown,
    optionCount: listOptions.length,
    ...(options.includeOptions ? { options: listOptions } : {}),
  };
}

function dropdownTargetFromSdt(sdt: XmlElement): DropdownTarget | null {
  const sdtPr = directWordChild(sdt, "sdtPr");
  if (!sdtPr) return null;
  const dropDownList = directWordChild(sdtPr, "dropDownList");
  if (dropDownList) {
    return { sdt, list: dropDownList, controlType: "dropDownList" };
  }
  const comboBox = directWordChild(sdtPr, "comboBox");
  if (comboBox) {
    return { sdt, list: comboBox, controlType: "comboBox" };
  }
  return null;
}

function dropdownOptions(list: XmlElement): WordDropdownOption[] {
  return directWordChildren(list, "listItem").map((item) => {
    const value = attr(item, "value") ?? attr(item, "displayText") ?? "";
    return {
      value,
      displayText: attr(item, "displayText") ?? value,
    };
  });
}

const FALLBACK_DEFAULT_SIZE = 20;

/** Parse word/styles.xml (absent in minimal documents → empty index). */
export function loadStyleSheet(pkg: WordPackage): {
  index: WordStyleIndex;
  defaultSize: number;
} {
  const index: WordStyleIndex = new Map();
  let defaultSize = FALLBACK_DEFAULT_SIZE;
  const doc = readOptionalPartDocument(pkg.data, "word/styles.xml");
  const root = doc?.documentElement;
  if (!root) return { index, defaultSize };
  visitElements(root, (element) => {
    if (isWordElement(element, "rPrDefault")) {
      const rPr = directWordChild(element, "rPr");
      defaultSize = (rPr ? runPropsFormat(rPr).size : undefined) ?? defaultSize;
      return;
    }
    if (!isWordElement(element, "style")) return;
    const id = attr(element, "styleId");
    if (!id) return;
    const nameElement = directWordChild(element, "name");
    const basedOnElement = directWordChild(element, "basedOn");
    const rPr = directWordChild(element, "rPr");
    const pPr = directWordChild(element, "pPr");
    const outline = pPr ? directWordChild(pPr, "outlineLvl") : null;
    index.set(id, {
      id,
      name: (nameElement ? attr(nameElement, "val") : null) ?? id,
      basedOn: basedOnElement ? attr(basedOnElement, "val") : null,
      format: rPr ? runPropsFormat(rPr) : {},
      outlineLevel: outline ? outlineLevelValue(attr(outline, "val")) : null,
    });
  });
  return { index, defaultSize };
}

/** w:outlineLvl 0–8 is a heading level; 9 means body text. */
export function outlineLevelValue(value: string | null): number | null {
  if (value === null || !/^[0-9]$/.test(value)) return null;
  return Number(value);
}

/** w:sz in half-points; 0 and malformed values count as unset. */
export function fontSizeValue(value: string | null): number | null {
  if (value === null || !/^\d{1,4}$/.test(value)) return null;
  return Number(value) || null;
}

/** Italic, colour, bold and size from a w:rPr element (direct formatting or a style's rPr). */
function runPropsFormat(rPr: XmlElement): StyleFormat {
  const format: StyleFormat = {};
  const italic = directWordChild(rPr, "i");
  if (italic) {
    const value = attr(italic, "val");
    format.italic = value !== "0" && value?.toLowerCase() !== "false";
  }
  const color = directWordChild(rPr, "color");
  if (color) {
    const value = attr(color, "val");
    if (value && value.toLowerCase() !== "auto") {
      format.color = value.toUpperCase();
    }
  }
  const bold = directWordChild(rPr, "b");
  if (bold) {
    const value = attr(bold, "val");
    format.bold = value !== "0" && value?.toLowerCase() !== "false";
  }
  const size = directWordChild(rPr, "sz");
  if (size) {
    const value = fontSizeValue(attr(size, "val"));
    if (value !== null) format.size = value;
  }
  return format;
}

/** Resolve a style chain (basedOn, nearest wins) to format + all names/ids. */
function resolveStyleChain(
  index: WordStyleIndex,
  styleId: string | null,
): { format: StyleFormat; names: string[] } {
  const format: StyleFormat = {};
  const names: string[] = [];
  let current = styleId;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const info = index.get(current);
    if (!info) {
      names.push(current.toLowerCase());
      break;
    }
    names.push(info.id.toLowerCase(), info.name.toLowerCase());
    if (format.italic === undefined && info.format.italic !== undefined) {
      format.italic = info.format.italic;
    }
    if (format.color === undefined && info.format.color !== undefined) {
      format.color = info.format.color;
    }
    current = info.basedOn;
  }
  return { format, names };
}

function paragraphStyleId(paragraph: XmlElement): string | null {
  const pPr = directWordChild(paragraph, "pPr");
  const pStyle = pPr ? directWordChild(pPr, "pStyle") : null;
  return pStyle ? attr(pStyle, "val") : null;
}

function matchesInstructionProfile(
  names: string[],
  format: StyleFormat,
  profile: WordInstructionProfile,
): boolean {
  if (
    names.some((name) =>
      profile.styleNames.some((styleName) =>
        name.includes(styleName.toLowerCase()),
      ),
    )
  ) {
    return true;
  }
  return (
    format.italic === true &&
    format.color !== undefined &&
    profile.colors.some((color) => color.toUpperCase() === format.color)
  );
}

/** Coverage-based paragraph classification per the instruction profile. */
export function classifyParagraph(
  paragraph: XmlElement,
  styles: WordStyleIndex,
  profile: WordInstructionProfile,
): "content" | "instruction" | "mixed" {
  const paragraphChain = resolveStyleChain(styles, paragraphStyleId(paragraph));
  if (matchesInstructionProfile(paragraphChain.names, {}, profile)) {
    return "instruction";
  }

  let totalChars = 0;
  let instructionChars = 0;
  visitElements(paragraph, (child) => {
    if (!isWordElement(child, "r")) return;
    const text = textOf(child).replace(/\s+/g, "");
    if (text.length === 0) return;
    totalChars += text.length;
    const rPr = directWordChild(child, "rPr");
    const rStyleElement = rPr ? directWordChild(rPr, "rStyle") : null;
    const runChain = resolveStyleChain(
      styles,
      rStyleElement ? attr(rStyleElement, "val") : null,
    );
    const direct = rPr ? runPropsFormat(rPr) : {};
    const effective: StyleFormat = {
      italic:
        direct.italic ?? runChain.format.italic ?? paragraphChain.format.italic,
      color:
        direct.color ?? runChain.format.color ?? paragraphChain.format.color,
    };
    if (matchesInstructionProfile(runChain.names, effective, profile)) {
      instructionChars += text.length;
    }
  });

  if (totalChars === 0 || instructionChars === 0) return "content";
  if (instructionChars / totalChars >= profile.coverageThreshold) {
    return "instruction";
  }
  return "mixed";
}

/** Full kind: toc/heading/caption take precedence over content classification. */
export function paragraphKindOf(
  block: BodyBlock,
  styles: WordStyleIndex,
  profile: WordInstructionProfile,
): WordParagraphKind {
  if (block.isToc) return "toc";
  if (block.headingLevel) return "heading";
  const chain = resolveStyleChain(styles, paragraphStyleId(block.element));
  if (chain.names.some((name) => name === "caption")) return "caption";
  if (chain.names.some((name) => /^toc ?\d+$/.test(name))) return "toc";
  return classifyParagraph(block.element, styles, profile);
}
